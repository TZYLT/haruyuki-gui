/**
 * The shell's only engine start/stop point.
 *
 * Ownership source: docs/33-D4 section 4.7 (`RD-02`, master `R-065`). This is a
 * thin process-lifetime seam, not an engine client: it owns spawn, stop, the
 * instance hand-off and the crash callback. Connection semantics, subscriptions,
 * command send, retries and reconnects belong to B2/B3, and this file does not
 * grow them.
 *
 * Why a separate module at all: `main.ts` must stay a composition root, and
 * B2/E4 must receive the *same* `Engine` instance instead of constructing a
 * second one. One module with one `new Engine()` call site is what makes the
 * "single engine host" invariant checkable.
 *
 * Spawn-spec resolution lives in `spawn-spec.ts`; this file is the lifetime
 * policy around it.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Engine, type EngineSpawnSpec } from "@haruyuki/core/engine";
import {
  RUNTIME_MARKER_FILE_NAME,
  isProcessAlive,
  type EngineMarker,
} from "@haruyuki/core/supervision";
import { TOKEN_FILE_NAME } from "@haruyuki/core/engine/token";

import { createEngineCrashWatcher } from "../crash/capture.js";
import { crashDirFor, type CrashRecord, type CrashVersions } from "../crash/records.js";
import type { SupervisionLog } from "./errors.js";
import { describeError } from "./errors.js";
import { writeMarkerEngine, clearMarkerAfterStop } from "./marker-write.js";
import {
  TOKEN_DIR_NAME,
  buildEngineSpawnSpec,
  resolveEngineBundle,
  resolveWatchdogPath,
  watchdogStatus,
} from "./spawn-spec.js";

/** Route default: the graceful stop budget is the quit budget (5 s). */
export const STOP_TIMEOUT_MS = 5_000;

/**
 * The engine process this shell owns, plus the marker facts a consumer needs.
 *
 * `engine` is the instance B2/E4 must use. The other fields are read-only
 * observations for diagnostics and the runtime marker; nothing here is a
 * connection handle.
 */
export interface EngineHost {
  readonly engine: Engine;
  readonly pid: number;
  readonly bundlePath: string;
  readonly watchdog: "active" | "inactive" | "unknown";
  readonly markerPath: string;
  readonly tokenFile: string;
  /** ISO 8601 UTC; the moment the marker was written, not the OS spawn time. */
  readonly startedAt: string;
  /**
   * Stop this host, then start once with the spec the user chose.
   *
   * Explicit only: `R-13/B3` forbids the shell from reviving a dead engine on
   * its own. This is the user's "pick an engine directory" path, which needs a
   * new process after a failed or missing bundle. It does not retry or schedule.
   */
  restartWithSpec(spec: EngineSpawnSpec): Promise<EngineHostResult>;
}

/** Why start-up did not produce a host. */
export type EngineHostFailureReason = "missing-bundle" | "start-failed" | "already-started";

/** A host, or a reason that is safe to log and to show in a diagnostics field. */
export type EngineHostResult =
  | { readonly ok: true; readonly host: EngineHost }
  | { readonly ok: false; readonly reason: EngineHostFailureReason; readonly detail?: string };

/** Dependency seams; production passes only the documented options. */
export interface EngineHostOptions {
  readonly userData: string;
  readonly appVersion: string;
  readonly bundlePath?: string;
  /** Extra root for the dev bundle search; `app.getAppPath()` in the shell. */
  readonly appPath?: string;
  readonly expectedEngineVersion?: string;
  readonly now?: () => Date;
  readonly onCrash?: (record: CrashRecord) => void;
  readonly onLog?: SupervisionLog;
  /** Test seam: replace the real `Engine` facade with a scripted stand-in. */
  readonly engineFactory?: () => Engine;
  /** Test seam: replaces the default cwd/appPath search roots. */
  readonly searchFrom?: readonly string[];
  /** Test seam: replaces the `@haruyuki/core` resolution of the watchdog file. */
  readonly resolveWatchdog?: () => string | null;
}

/** The one live host, so a second start cannot create a second engine. */
let activeHost: EngineHost | null = null;

/** Guards concurrent calls before the first one has produced a host. */
let startInFlight = false;

/** Crash subscriptions are private to the host; the public shape stays thin. */
const crashWatchers = new WeakMap<EngineHost, () => void>();

/** The start options a restart needs; kept off the public host shape. */
const restartContexts = new WeakMap<EngineHost, EngineHostOptions>();

/**
 * Resolve, spawn and hand off the engine.
 *
 * A missing bundle is a skip, not an error: `R-12`/`R-16` require the shell to
 * boot normally and only leave `supervision.engine.bootstrap skipped` in the
 * log. A start failure is also not a crash (`R-13`); it is logged and leaves no
 * marker engine.
 */
export async function startEngineHost(options: EngineHostOptions): Promise<EngineHostResult> {
  if (activeHost !== null || startInFlight) {
    // No automatic restart (R-13/B3). A caller that sees a host here must reuse
    // it; constructing another `Engine` would make the marker and the process
    // that actually runs disagree.
    return { ok: false, reason: "already-started" };
  }

  startInFlight = true;

  try {
    return await startEngineHostOnce(options);
  } finally {
    startInFlight = false;
  }
}

/** The body of one start; the exported wrapper owns the single-flight guard. */
async function startEngineHostOnce(
  options: EngineHostOptions,
  spawnSpecOverride?: EngineSpawnSpec,
): Promise<EngineHostResult> {
  const log = createLog(options.onLog);

  const bundlePath = spawnSpecOverride?.bundlePath ?? resolveEngineBundle(options, log);

  if (bundlePath === null) {
    log("supervision.engine.bootstrap", {
      state: "skipped",
      reason: "missing-bundle",
      searched: options.searchFrom ?? [
        process.cwd(),
        ...(options.appPath ? [options.appPath] : []),
      ],
    });

    return { ok: false, reason: "missing-bundle" };
  }

  const watchdogPath =
    spawnSpecOverride === undefined
      ? resolveWatchdogPath(options.resolveWatchdog)
      : options.resolveWatchdog !== undefined
        ? resolveWatchdogPath(options.resolveWatchdog)
        : watchdogPathFromSpec(spawnSpecOverride);
  const tokenDir = join(options.userData, TOKEN_DIR_NAME);
  const tokenFile = join(tokenDir, TOKEN_FILE_NAME);
  const markerPath = join(options.userData, RUNTIME_MARKER_FILE_NAME);
  const engine = options.engineFactory?.() ?? new Engine();
  const spawnSpec =
    spawnSpecOverride ??
    buildEngineSpawnSpec({
      userData: options.userData,
      bundlePath,
      watchdogPath,
    });

  try {
    // B1 treats `tokenDir` as an existing directory. Creating it here keeps the
    // start path independent of whichever module wrote `userData` first.
    await mkdir(tokenDir, { recursive: true });
  } catch (error) {
    const detail = describeError(error);

    log("supervision.engine.bootstrap", {
      state: "failed",
      reason: "token-dir",
      detail,
      bundlePath,
    });

    return failure("start-failed", detail);
  }

  // Install the crash watcher before `start` resolves: the child can die in the
  // window between "ready" and this function returning, and an engine crash
  // that happened is still a crash. The watcher ignores start failures because
  // `appServerInfo` is null until the handshake succeeded (`R-13`).
  // The watcher is installed before `start` resolves, so the watchdog verdict
  // does not exist yet. A getter lets the record see the verdict once it does.
  let engineWatchdog: "active" | "inactive" | "unknown" = "unknown";
  let unwatch: (() => void) | null = null;

  if (options.onCrash !== undefined) {
    try {
      unwatch = createEngineCrashWatcher(engine, {
        dir: crashDirFor(options.userData),
        versions: crashVersions(options.appVersion),
        onCrash: options.onCrash,
        watchdog: () => engineWatchdog,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    } catch (error) {
      // The engine is not started yet; a failed subscription is a diagnostics
      // gap. Report it and let the start proceed.
      log("supervision.engine.crash-watch", { state: "failed", detail: describeError(error) });
    }
  }

  try {
    await engine.start({
      spawnSpec,
      tokenDir,
      ...(options.expectedEngineVersion === undefined
        ? {}
        : { expectedEngineVersion: options.expectedEngineVersion }),
    });
  } catch (error) {
    const detail = describeError(error);

    unwatch?.();

    log("supervision.engine.bootstrap", {
      state: "failed",
      reason: "start",
      detail,
      bundlePath,
    });

    // `Engine.start` already cleans up on failure; this is idempotent and only
    // makes sure a half-started child cannot survive a bug in that path.
    await engine.stopGraceful(STOP_TIMEOUT_MS).catch(() => undefined);

    return failure("start-failed", detail);
  }

  const pid = engine.pid;

  if (pid === null) {
    const detail = "engine reported ready without a pid";

    unwatch?.();

    log("supervision.engine.bootstrap", { state: "failed", reason: "pid", detail, bundlePath });
    await engine.stopGraceful(STOP_TIMEOUT_MS).catch(() => undefined);

    return failure("start-failed", detail);
  }

  const watchdog = watchdogStatus(watchdogPath, engine);
  engineWatchdog = watchdog;
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const engineMarker: EngineMarker = {
    pid,
    startedAt,
    exePath: process.execPath,
    bundlePath,
    runToken: randomUUID(),
    watchdog,
    tokenFile,
    // B1 exposes no engine port, so the marker cannot record one (RD-07).
    port: null,
  };

  const markerWritten = await writeMarkerEngine(markerPath, engineMarker);

  if (!markerWritten) {
    // The engine is running; a marker failure must not stop it. The next boot
    // sees no engine, which is a worse orphan story, but stopping a working
    // engine over bookkeeping would be worse still.
    log("supervision.marker.write", { state: "failed", markerPath, pid });
  }

  const host: EngineHost = {
    engine,
    pid,
    bundlePath,
    watchdog,
    markerPath,
    tokenFile,
    startedAt,
    restartWithSpec: (spec) => restartHost(host, spec),
  };

  if (unwatch !== null) {
    crashWatchers.set(host, unwatch);
  }

  restartContexts.set(host, options);
  activeHost = host;

  log("supervision.engine.bootstrap", { state: "started", pid, bundlePath, watchdog });

  return { ok: true, host };
}

/**
 * Start one process from a caller-provided spec.
 *
 * Separate from `startEngineHost` because a restart must not re-resolve or
 * rebuild the spec the user just chose. It keeps the same single-host guard: a
 * second start while one is live is `already-started`, not a second process.
 */
async function startEngineHostWithSpec(
  options: EngineHostOptions,
  spec: EngineSpawnSpec,
): Promise<EngineHostResult> {
  if (activeHost !== null || startInFlight) {
    return { ok: false, reason: "already-started" };
  }

  startInFlight = true;

  try {
    return await startEngineHostOnce(options, spec);
  } finally {
    startInFlight = false;
  }
}

/** Extract the watchdog preload path from a spec we did not build. */
function watchdogPathFromSpec(spec: EngineSpawnSpec): string | null {
  const options = spec.env["NODE_OPTIONS"] ?? "";
  const match = /(?:^|\s)--require(?:=|\s+)(?:"([^"]+)"|(\S+))/.exec(options);

  return match?.[1] ?? match?.[2] ?? null;
}

/**
 * The explicit restart path.
 *
 * Stops the old process (using `stopEngineHost`, so the pid/liveness rule from
 * S1-3 is reused), clears the marker, and starts once with the new spec. A stop
 * that cannot prove the process gone is a failure: starting a second engine
 * while the old one lives is the orphan this module exists to prevent.
 *
 * No retry, no timer, no `exit` listener: `R-13/B3` forbids automatic revival.
 *
 * @param host the current host, whose engine may be ready, closed or failed
 * @param spec the spec the user's directory selection produced
 * @returns the new host, or a failure with the existing reason vocabulary
 */
async function restartHost(host: EngineHost, spec: EngineSpawnSpec): Promise<EngineHostResult> {
  const options = restartContexts.get(host);

  if (options === undefined) {
    return failure("start-failed", "this host has no restart context");
  }

  const stopped = await stopEngineHost(host);

  if (!stopped.stopped) {
    return failure(
      "start-failed",
      `the old engine could not be stopped: ${stopped.reason ?? "unknown"}`,
    );
  }

  // The old marker names a pid that is now dead. Clear it before the attempt so
  // a failed start cannot leave a marker pointing at the old process; a
  // successful start writes the new engine facts immediately.
  await clearMarkerAfterStop(
    options.userData,
    options.onLog === undefined ? {} : { onLog: options.onLog },
  );

  return startEngineHostWithSpec(
    { ...options, resolveWatchdog: () => watchdogPathFromSpec(spec) },
    spec,
  );
}

/**
 * Stop the host gracefully, then report whether the process is really gone.
 *
 * The caller (quit) may delete the marker only when `stopped` is true. A stop
 * that cannot prove the process is gone keeps the marker, so the next boot can
 * recognise and reclaim the orphan (requirement section 4.6 item 4).
 *
 * Never restarts anything, and never rejects: a quit path that rejects has no
 * one left to handle it.
 */
export async function stopEngineHost(
  host: EngineHost,
  timeoutMs: number = STOP_TIMEOUT_MS,
): Promise<{ stopped: boolean; reason?: string }> {
  let failure: string | null = null;

  try {
    await host.engine.stopGraceful(timeoutMs);
  } catch (error) {
    failure = describeError(error);
  }

  const state = host.engine.state;
  // `Engine.stopOnce` clears `engine.pid` before it stops the child, so reading
  // the facade's pid here would always report "gone" after a failed stop. The
  // host's pid is the process this shell actually spawned and is the only fact
  // that can still prove an orphan.
  const pid = host.pid;
  const gone = !isProcessAlive(pid);

  if (gone) {
    crashWatchers.get(host)?.();
    crashWatchers.delete(host);

    if (activeHost === host) activeHost = null;

    return { stopped: true };
  }

  const reason = failure ?? `engine state is ${state}`;

  return { stopped: false, reason };
}

/** The versions every crash record carries. */
function crashVersions(appVersion: string): CrashVersions {
  return {
    version: appVersion,
    electron: process.versions.electron ?? "unknown",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
}

/** Build a failure result without adding an `undefined` optional field. */
function failure(reason: EngineHostFailureReason, detail?: string): EngineHostResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/** Best-effort logger; a broken sink must not break start-up. */
function createLog(onLog: SupervisionLog | undefined): SupervisionLog {
  return (event, detail) => {
    try {
      onLog?.(event, detail);
    } catch {
      // Nothing useful is left to report to.
    }
  };
}
