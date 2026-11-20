/**
 * Quit supervision: stop the engine, then delete the marker, then quit.
 *
 * Why `before-quit` and not `will-quit`: `will-quit` is not cancellable, so an
 * asynchronous stop there would be cut off. `before-quit` can hold the quit open
 * with `preventDefault()` until the engine has really stopped.
 *
 * The order is the requirement's, not a preference:
 *
 *   1. ask the engine to stop gracefully (5 s);
 *   2. clear `runtime.json` only when the stop was confirmed;
 *   3. let the quit proceed. A failed stop keeps the marker, so the next boot
 *      can identify and reclaim the orphan instead of hiding it.
 *
 * `runQuitSequence` is pure (its effects are injected) so the ordering and the
 * "keep the marker on failure" rule are testable without Electron.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import type { SupervisionLog } from "./errors.js";
import { STOP_TIMEOUT_MS, stopEngineHost, type EngineHost } from "./engine-host.js";
import { describeError } from "./errors.js";
import { clearMarkerAfterStop } from "./marker-write.js";

/** What a stop attempt reports; mirrors `stopEngineHost`. */
export interface QuitStopResult {
  readonly stopped: boolean;
  readonly reason?: string;
}

/** The three effects of a quit, injected so the sequence is a pure function. */
export interface QuitSequenceSteps {
  readonly stop: () => Promise<QuitStopResult>;
  readonly clearMarker: () => Promise<void>;
  readonly quit: () => void;
  readonly onLog?: SupervisionLog;
}

/** What the sequence did; tests assert on it instead of on Electron state. */
export interface QuitSequenceResult {
  readonly stopped: boolean;
  readonly markerCleared: boolean;
  readonly reason?: string;
}

/** The slice of Electron's `app` this module uses; keeps the module testable. */
export interface QuitApp {
  on(event: "before-quit", listener: (event: QuitEvent) => void): unknown;
  removeListener?(event: "before-quit", listener: (event: QuitEvent) => void): unknown;
  quit(): void;
}

/** The cancelable argument Electron passes to `before-quit`. */
export interface QuitEvent {
  preventDefault(): void;
}

/** Caller-supplied state; `host` may be null until the engine start resolves. */
export interface QuitSupervisorOptions {
  readonly host: EngineHost | null;
  readonly userData: string;
  readonly onLog?: SupervisionLog;
  /** Injected by `main.ts`; omitted only in tests that supply a fake app. */
  readonly app?: QuitApp;
}

/** Handle returned by {@link installQuitSupervisor}. */
export interface QuitSupervisor {
  /**
   * Attach the host once the asynchronous start has produced one.
   *
   * Returns `false` when the quit has already started or finished: the caller
   * must then stop the freshly started engine itself, because this supervisor's
   * stop step already ran with `host: null`. This closes the "quit while the
   * engine is still starting" race without a second `before-quit` pass.
   */
  setHost(host: EngineHost | null): boolean;
  /** True once the quit sequence has started or finished. */
  isQuitting(): boolean;
  /** Detach the listener; used by tests and by a future restart path. */
  remove(): void;
}

/** The one installed listener, so a second install cannot stack handlers. */
let installedSupervisor: {
  readonly listener: (event: QuitEvent) => void;
  readonly app: QuitApp;
  readonly supervisor: QuitSupervisor;
} | null = null;

/**
 * Stop, clear the marker if (and only if) the stop was confirmed, then quit.
 *
 * A failed stop still quits: an app that refuses to close because an engine
 * will not die is a worse failure than an orphan, which the next launch can
 * reclaim. The marker is left in place in that case.
 */
export async function runQuitSequence(steps: QuitSequenceSteps): Promise<QuitSequenceResult> {
  const log = (event: string, detail?: Record<string, unknown>): void => {
    try {
      steps.onLog?.(event, detail);
    } catch {
      // A broken log sink must not hold the quit open.
    }
  };

  let stopped = false;
  let reason: string | undefined;

  try {
    const result = await steps.stop();

    stopped = result.stopped;
    reason = result.reason;
  } catch (error) {
    reason = describeError(error);
  }

  let markerCleared = false;

  if (stopped) {
    try {
      await steps.clearMarker();
      markerCleared = true;
      log("supervision.engine.stop", { state: "stopped" });
    } catch {
      // `clearMarkerAfterStop` already logged the cause; the marker stays so the
      // next boot keeps the reclaim evidence.
      log("supervision.marker.clear", { state: "failed", detail: reason ?? "marker clear failed" });
    }
  } else {
    log("supervision.engine.stop", {
      state: "failed",
      ...(reason === undefined ? {} : { reason }),
    });
  }

  try {
    steps.quit();
  } catch {
    // Nothing can be done from a quit callback.
  }

  return reason === undefined ? { stopped, markerCleared } : { stopped, markerCleared, reason };
}

/**
 * Register the one `before-quit` handler.
 *
 * The handler is idempotent: a second call returns the existing supervisor.
 * Re-entry is guarded twice: while the stop is in flight, another `before-quit`
 * is prevented again (so the app cannot leave early); after `app.quit()` has
 * been requested, the event is allowed through (so the quit can actually
 * finish).
 */
export function installQuitSupervisor(options: QuitSupervisorOptions): QuitSupervisor {
  if (installedSupervisor !== null) return installedSupervisor.supervisor;

  const app = options.app ?? resolveElectronApp();
  let host = options.host;
  let running = false;
  let finished = false;

  const listener = (event: QuitEvent): void => {
    if (finished) return;

    if (running) {
      // A second quit request while the stop is in flight: hold it, but do not
      // start a second stop.
      event.preventDefault();

      return;
    }

    running = true;
    event.preventDefault();

    void runQuitSequence({
      stop: async () => (host === null ? { stopped: true } : stopEngineHost(host, STOP_TIMEOUT_MS)),
      clearMarker: async () => {
        const cleared = await clearMarkerAfterStop(options.userData, {
          ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
        });

        if (!cleared) throw new Error("runtime marker was not cleared");
      },
      quit: () => {
        finished = true;
        app.quit();
      },
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    }).catch((error: unknown) => {
      // `runQuitSequence` catches step failures itself; this is the last guard
      // against a programmer error pinning the app open.
      finished = true;

      try {
        options.onLog?.("supervision.quit.failed", { detail: describeError(error) });
      } catch {
        // Logging is best effort on the way down.
      }

      app.quit();
    });
  };

  app.on("before-quit", listener);

  const supervisor: QuitSupervisor = {
    setHost(next) {
      if (running || finished) return false;

      host = next;

      return true;
    },
    isQuitting() {
      return running || finished;
    },
    remove() {
      app.removeListener?.("before-quit", listener);

      if (installedSupervisor?.listener === listener) installedSupervisor = null;
    },
  };

  installedSupervisor = { listener, app, supervisor };

  return supervisor;
}

/**
 * Resolve Electron only when the caller did not inject it.
 *
 * `main.ts` passes the real `app`, so this fallback exists for completeness and
 * for a future composition that forgets to. The main-process bundle is CJS, so
 * `__dirname` is the usable anchor there; tests always pass a fake.
 */
function resolveElectronApp(): QuitApp {
  const anchor = typeof __dirname === "string" ? join(__dirname, "quit.cjs") : import.meta.url;
  const require = createRequire(anchor);

  return require("electron") as QuitApp;
}
