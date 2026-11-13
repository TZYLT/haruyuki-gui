/**
 * Engine process spawning and lifecycle.
 *
 * Scope: start a child from an `EngineSpawnSpec`, stop it gracefully, hard-kill
 * it, and expose its `exit` / `error` events. Nothing here reads or interprets
 * engine output: stdout/stderr are passed through untouched for the port
 * discovery layer (`port-discovery.ts`), token files belong to `token.ts`, and
 * state transitions belong to the facade (`engine.ts`).
 *
 * Platform contract for `stopGraceful`:
 *
 * - POSIX: SIGTERM, up to 2 s; then SIGKILL, up to 1 s.
 * - Windows: `taskkill /PID <pid> /T` without `/F` (tree-wide and graceful),
 *   up to 1.5 s; then `child.kill()`, which is TerminateProcess, up to 1 s.
 *
 * On Windows a console child cannot be closed by taskkill without `/F`
 * (measured on Windows 10.0.19045 / Node 24: exit code 128, "can only be
 * terminated forcefully"), so the hard-kill fallback is the normal path there.
 * The attempt is still made first: GUI-subsystem children honour it, and the
 * watchdog document treats force-kill as the last resort.
 *
 * `timeoutMs` is a total budget, not a per-stage one: every stage is capped by
 * whatever is left of the budget, so a caller asking for 500 ms never waits the
 * fixed 3 s. A budget of 0 signals both stages without waiting in between.
 */

import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { EngineSpawnSpec } from "./types";

/** Default total graceful-stop budget; mirrors Engine.stopGraceful (section 3.3(c)). */
const DEFAULT_STOP_TIMEOUT_MS = 5000;

/** POSIX: SIGTERM grace before escalating to SIGKILL. */
const POSIX_TERM_GRACE_MS = 2000;

/** POSIX: SIGKILL grace before giving up on the exit event. */
const POSIX_KILL_GRACE_MS = 1000;

/** Windows: tree-wide taskkill grace before TerminateProcess. */
const WINDOWS_TASKKILL_GRACE_MS = 1500;

/** Windows: TerminateProcess grace before giving up on the exit event. */
const WINDOWS_KILL_GRACE_MS = 1000;

type ProcessExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type ProcessExitListener = (info: ProcessExitInfo) => void;
type ProcessErrorListener = (error: Error) => void;

/**
 * In-flight graceful stops keyed by child. Two concurrent callers share one
 * sequence, so repeated stops cannot interleave signals or duplicate taskkill.
 * The entry is dropped once the sequence settles; a later call then re-checks
 * the exit flag and normally resolves without doing anything.
 */
const inFlightStops = new WeakMap<ChildProcess, Promise<void>>();

/**
 * Start the engine child described by `spec` and return it immediately.
 *
 * This is a thin, platform-free `spawn` wrapper: `argvPrefix` precedes
 * `bundlePath`, `env` is passed through verbatim (the spec already contains the
 * complete environment, callers must not merge `process.env` afterwards), and
 * stdio stays piped so the port discovery layer can read stdout and the
 * watchdog keeps a live stdin. The promise of readiness is deliberately absent:
 * the caller waits for the port line or for `onProcessError`, never for this
 * call.
 */
export function startEngineProcess(spec: EngineSpawnSpec): ChildProcess {
  const child = spawn(spec.exePath, [...spec.argvPrefix, spec.bundlePath], {
    env: spec.env,
    cwd: spec.cwd,
    stdio: spec.stdio,
    windowsHide: spec.windowsHide,
    detached: spec.detached,
  });

  // A failed spawn (ENOENT, EACCES, ...) emits `error`; with no listener Node
  // rethrows it as an uncaught exception and takes the host down. This sink is
  // the baseline that keeps the process alive. It does not consume the event:
  // EventEmitter calls every listener, so each `onProcessError` subscriber
  // still receives the same error object.
  child.on("error", () => {});

  return child;
}

/**
 * Stop the child gracefully and resolve once it is gone or the budget is spent.
 *
 * Idempotent per child: calling it again while a stop is in flight returns the
 * same promise, and calling it after the child exited resolves immediately. It
 * never rejects - a child that will not die is left to the caller's hard-kill
 * path instead of turning shutdown into a thrown error.
 */
export function stopGraceful(
  child: ChildProcess,
  timeoutMs: number = DEFAULT_STOP_TIMEOUT_MS,
): Promise<void> {
  if (hasExited(child)) {
    return Promise.resolve();
  }

  const pending = inFlightStops.get(child);
  if (pending !== undefined) {
    return pending;
  }

  const attempt = stopGracefulOnce(child, normalizeBudget(timeoutMs));
  inFlightStops.set(child, attempt);

  const forget = (): void => {
    inFlightStops.delete(child);
  };
  void attempt.then(forget, forget);

  return attempt;
}

/**
 * Hard-kill the child without any graceful stage.
 *
 * Windows has no signals, so `child.kill()` is TerminateProcess. POSIX asks for
 * SIGKILL explicitly because the default SIGTERM is not a hard kill there. Safe
 * to call on an already exited child, and it never throws.
 */
export function killProcess(child: ChildProcess): void {
  if (hasExited(child)) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill();
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // The child exited between the state check and the signal; nothing to do.
  }
}

/**
 * Subscribe to the child's `exit` event. Returns an unsubscribe function.
 *
 * The payload is only what Node reports: `code` is null when a signal ended the
 * process, `signal` is null on a normal exit. Classification (SPAWN_FAILED and
 * friends) belongs to the facade, which must also treat a process that exits
 * during start as a failed start.
 */
export function onProcessExit(child: ChildProcess, cb: ProcessExitListener): () => void {
  const listener = (code: number | null, signal: NodeJS.Signals | null): void => {
    cb({ code, signal });
  };

  child.on("exit", listener);

  return () => {
    child.removeListener("exit", listener);
  };
}

/**
 * Subscribe to the child's `error` event (ENOENT, EACCES, ...). Returns an
 * unsubscribe function. The sink installed by `startEngineProcess` stays, so
 * removing the last subscriber never re-arms the uncaught-exception path.
 */
export function onProcessError(child: ChildProcess, cb: ProcessErrorListener): () => void {
  const listener = (error: Error): void => {
    cb(error);
  };

  child.on("error", listener);

  return () => {
    child.removeListener("error", listener);
  };
}

/**
 * One graceful-stop sequence. Never rejects: each platform step degrades into
 * the next one, and the final result is always "resolved".
 */
async function stopGracefulOnce(child: ChildProcess, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;

  if (process.platform === "win32") {
    requestTaskkill(child);

    if (await waitForExit(child, stageTimeout(deadline, WINDOWS_TASKKILL_GRACE_MS))) {
      return;
    }

    killProcess(child);
    await waitForExit(child, stageTimeout(deadline, WINDOWS_KILL_GRACE_MS));
    return;
  }

  signal(child, "SIGTERM");

  if (await waitForExit(child, stageTimeout(deadline, POSIX_TERM_GRACE_MS))) {
    return;
  }

  signal(child, "SIGKILL");
  await waitForExit(child, stageTimeout(deadline, POSIX_KILL_GRACE_MS));
}

/**
 * Ask Windows to close the child and its process tree without `/F`.
 *
 * Failure is expected for console children (see the module comment) and is
 * swallowed on purpose: the caller falls through to the hard kill. The
 * execFile is fire-and-forget, but bounded by its own timeout so a wedged
 * taskkill cannot outlive the stop.
 */
function requestTaskkill(child: ChildProcess): void {
  const pid = child.pid;

  if (pid === undefined || hasExited(child)) {
    return;
  }

  try {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T"],
      { windowsHide: true, timeout: WINDOWS_TASKKILL_GRACE_MS },
      () => {
        // Non-zero exit or spawn failure is the normal downgrade path.
      },
    );
  } catch {
    // execFile itself failed; the caller's hard kill is the fallback.
  }
}

/**
 * Send one signal, tolerating the child having exited in the meantime.
 */
function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (hasExited(child)) {
    return;
  }

  try {
    child.kill(name);
  } catch {
    // Already gone; the wait below reports the outcome.
  }
}

/**
 * Wait until the child is gone, or until `timeoutMs` elapses.
 *
 * Resolves true when the child is gone, false on timeout. It listens to
 * `close` in addition to `exit` because a spawn failure emits `error` and then
 * `close` but never `exit` (verified on Node 24 / Windows); waiting only on
 * `exit` would burn the whole budget for a process that never existed.
 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }

  if (timeoutMs <= 0) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (exited: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onGone);
      child.removeListener("close", onGone);
      resolve(exited);
    };

    const onGone = (): void => {
      settle(true);
    };

    timer = setTimeout(() => {
      settle(hasExited(child));
    }, timeoutMs);

    child.once("exit", onGone);
    child.once("close", onGone);

    // The child can exit between the check above and the listener attach.
    if (hasExited(child)) {
      settle(true);
    }
  });
}

/**
 * True once Node has recorded an exit code or a terminating signal. A failed
 * spawn records a negative exit code when `close` arrives.
 */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Portion of the total budget still available for one stage, never negative.
 */
function stageTimeout(deadline: number, stageMs: number): number {
  return Math.min(stageMs, Math.max(0, deadline - Date.now()));
}

/**
 * Normalize a caller-supplied budget: negative means "no waiting", and a
 * non-finite value falls back to the documented default instead of producing a
 * zero-delay timer by accident.
 */
function normalizeBudget(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : DEFAULT_STOP_TIMEOUT_MS;
}
