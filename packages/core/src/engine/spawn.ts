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
 * - POSIX: SIGTERM, up to 2 s; then SIGKILL, up to 1 s. When the child was
 *   spawned `detached` it leads its own process group, so both signals go to the
 *   GROUP (`kill(-pid)`): that is what the detached process group is for, and a
 *   `git` the engine started must not outlive it.
 * - Windows: `taskkill /PID <pid> /T` without `/F` (tree-wide and graceful),
 *   up to 1.5 s; then `taskkill /PID <pid> /T /F` (tree-wide and forced), up to
 *   1 s; then `child.kill()`, which is TerminateProcess on the direct child only,
 *   as the last resort.
 *
 * On Windows a console child cannot be closed by taskkill without `/F`
 * (measured on Windows 10.0.19045 / Node 24: exit code 128, "can only be
 * terminated forcefully"), so the forced tree kill is the normal path there. The
 * graceful attempt is still made first: GUI-subsystem children honour it, and
 * force-kill remains the last resort.
 *
 * `timeoutMs` is a total budget, not a per-stage one: every stage is capped by
 * whatever is left of the budget, so a caller asking for 500 ms never waits the
 * fixed 3 s. A budget of 0 signals both stages without waiting in between.
 *
 * Both output pipes are drained from the moment the child exists (see
 * `drainStream`). The engine writes `WATCHDOG_OK=<pid>` to stderr before it
 * starts listening, and it calls `console.error` in hundreds of places; a pipe
 * nobody reads fills up (64 KiB on Windows) and then blocks the engine's event
 * loop forever, which would look like "ready but silently dead".
 */

import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { EngineSpawnSpec } from "./types";

/** Default total graceful-stop budget; mirrors `Engine.stopGraceful`. */
const DEFAULT_STOP_TIMEOUT_MS = 5000;

/** POSIX: SIGTERM grace before escalating to SIGKILL. */
const POSIX_TERM_GRACE_MS = 2000;

/** POSIX: SIGKILL grace before giving up on the exit event. */
const POSIX_KILL_GRACE_MS = 1000;

/** Windows: tree-wide taskkill grace before TerminateProcess. */
const WINDOWS_TASKKILL_GRACE_MS = 1500;

/** Windows: forced tree-kill grace before the direct-child TerminateProcess. */
const WINDOWS_FORCE_TASKKILL_GRACE_MS = 1000;

/** Windows: TerminateProcess grace before giving up on the exit event. */
const WINDOWS_KILL_GRACE_MS = 1000;

type ProcessExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type ProcessExitListener = (info: ProcessExitInfo) => void;
type ProcessErrorListener = (error: Error) => void;
type ProcessStderrListener = (chunk: string) => void;

/**
 * Per-child spawn facts the stop path needs but `ChildProcess` does not carry.
 *
 * `detached` is the one that matters: on POSIX a detached child leads its own
 * process group, so the stop path must signal `-pid` to take the engine's own
 * descendants with it. Signalling `-pid` for a non-detached child would hit OUR
 * group instead, which is why this is remembered per child rather than guessed.
 */
const spawnFacts = new WeakMap<ChildProcess, { detached: boolean }>();

/** stderr subscribers per child; the baseline drain forwards to all of them. */
const stderrListeners = new WeakMap<ChildProcess, Set<ProcessStderrListener>>();

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
 * This is a thin, platform-free `spawn` wrapper: the child runs as
 * `<exePath> <bundlePath> <argvPrefix...>` (`node haruyuki.js server ...` in the
 * headless today), `env` is passed through verbatim (`EngineSpawnSpec` already contains
 * the complete environment, callers must not merge `process.env` afterwards),
 * and stdio stays piped so the port discovery layer can read stdout and the
 * watchdog keeps a live stdin. The promise of readiness is deliberately absent:
 * the caller waits for the port line or for `onProcessError`, never for this
 * call.
 */
export function startEngineProcess(spec: EngineSpawnSpec): ChildProcess {
  const child = spawn(spec.exePath, [spec.bundlePath, ...spec.argvPrefix], {
    env: spec.env,
    cwd: spec.cwd,
    stdio: spec.stdio,
    windowsHide: spec.windowsHide,
    detached: spec.detached,
  });

  spawnFacts.set(child, { detached: spec.detached });

  // A failed spawn (ENOENT, EACCES, ...) emits `error`; with no listener Node
  // rethrows it as an uncaught exception and takes the host down. This sink is
  // the baseline that keeps the process alive. It does not consume the event:
  // EventEmitter calls every listener, so each `onProcessError` subscriber
  // still receives the same error object.
  child.on("error", () => {});

  drainStream(child.stdout);
  drainStream(child.stderr, child);

  return child;
}

/**
 * Keep one output pipe flowing so the child can never block on a full pipe.
 *
 * The listener exists from the moment the child exists, before any subscriber,
 * because the engine may write at once: the watchdog marker on stderr arrives
 * before the engine even listens. `waitForWsUrl` attaches its own `data`
 * listener to the same stream, and EventEmitter delivers every chunk to every
 * listener, so draining here cannot starve it.
 *
 * `onProcessStderr` subscribers are forwarded from the same baseline listener,
 * so stderr has exactly one reader and a late subscriber still sees every chunk
 * that arrives after it subscribes.
 *
 * The `error` sink is separate from the `ChildProcess` sink: a stream-level
 * fault (EPIPE when the child dies mid-write, EIO) would otherwise be an
 * uncaught exception that takes the host down.
 */
function drainStream(stream: NodeJS.ReadableStream | null, child?: ChildProcess): void {
  if (stream === null) {
    return;
  }

  stream.on("error", () => {
    // The child is gone or the pipe broke; the exit event is the real signal.
  });

  stream.on("data", (chunk: unknown) => {
    if (child === undefined) {
      return;
    }

    const listeners = stderrListeners.get(child);

    if (listeners === undefined || listeners.size === 0) {
      return;
    }

    const text = typeof chunk === "string" ? chunk : String(chunk);

    for (const listener of [...listeners]) {
      try {
        listener(text);
      } catch {
        // A subscriber's exception must not abort the drain of the pipe.
      }
    }
  });
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
 * Windows has no signals, so the tree is forced through `taskkill /T /F`
 * (fire-and-forget, because this path must not wait) and `child.kill()` -
 * TerminateProcess - follows as the direct-child guarantee. POSIX asks for
 * SIGKILL explicitly because the default SIGTERM is not a hard kill there, and a
 * detached child is killed as a process group so its descendants go too. Safe to
 * call on an already exited child, and it never throws.
 */
export function killProcess(child: ChildProcess): void {
  if (hasExited(child)) {
    return;
  }

  try {
    if (process.platform === "win32") {
      requestTaskkill(child, true);
      child.kill();
    } else {
      signal(child, "SIGKILL");
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
 * Subscribe to the child's stderr as text chunks. Returns an unsubscribe
 * function.
 *
 * stderr is where the engine writes diagnostics and where the injected watchdog
 * writes its `WATCHDOG_OK=<pid>` self-check marker, so the
 * facade needs a way to see it without owning the pipe. The baseline drain
 * installed by `startEngineProcess` stays, so removing the last subscriber never
 * re-arms the "nobody reads stderr" blocking problem.
 */
export function onProcessStderr(child: ChildProcess, cb: ProcessStderrListener): () => void {
  let listeners = stderrListeners.get(child);

  if (listeners === undefined) {
    listeners = new Set();
    stderrListeners.set(child, listeners);
  }

  listeners.add(cb);

  return () => {
    listeners?.delete(cb);
  };
}

/**
 * One graceful-stop sequence. Never rejects: each platform step degrades into
 * the next one, and the final result is always "resolved".
 */
async function stopGracefulOnce(child: ChildProcess, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;

  if (process.platform === "win32") {
    requestTaskkill(child, false);

    if (await waitForExit(child, stageTimeout(deadline, WINDOWS_TASKKILL_GRACE_MS))) {
      return;
    }

    // Forced, still tree-wide: the parent-side fallback. `child.kill()` alone is
    // TerminateProcess on the direct child and would leave whatever the engine
    // started behind.
    requestTaskkill(child, true);

    if (await waitForExit(child, stageTimeout(deadline, WINDOWS_FORCE_TASKKILL_GRACE_MS))) {
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
 * Ask Windows to close the child, optionally forcing the whole tree.
 *
 * Without `/F` failure is expected for console children (see the module comment)
 * and is swallowed on purpose: the caller falls through to the forced stage.
 * With `/F` this is the documented tree-wide fallback, so it also covers the
 * descendants the engine started. The execFile is fire-and-forget, but bounded
 * by its own timeout so a wedged taskkill cannot outlive the stop.
 */
function requestTaskkill(child: ChildProcess, force: boolean): void {
  const pid = child.pid;

  if (pid === undefined || hasExited(child)) {
    return;
  }

  const args = force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];

  try {
    execFile("taskkill", args, { windowsHide: true, timeout: WINDOWS_TASKKILL_GRACE_MS }, () => {
      // Non-zero exit or spawn failure is the normal downgrade path.
    });
  } catch {
    // execFile itself failed; the caller's hard kill is the fallback.
  }
}

/**
 * Send one signal, tolerating the child having exited in the meantime.
 *
 * A detached child leads its own process group, so the signal goes to `-pid` to
 * take the engine's descendants with it. Signalling the
 * group of a non-detached child would hit our own process group, so the fallback
 * is the plain single-process signal.
 */
function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (hasExited(child)) {
    return;
  }

  const pid = child.pid;
  const detached = spawnFacts.get(child)?.detached === true;

  if (detached && pid !== undefined) {
    try {
      process.kill(-pid, name);
      return;
    } catch {
      // The group is already gone (ESRCH) or the platform refused; fall through
      // to the direct signal so the child still gets a chance to stop.
    }
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
