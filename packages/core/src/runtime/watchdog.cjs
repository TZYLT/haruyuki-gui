/**
 * Parent-death watchdog preloaded into the engine child process.
 *
 * The host injects this file with `NODE_OPTIONS=--require "<abs>"`, so it must
 * stay plain CommonJS: it is evaluated before the engine bundle, it cannot be
 * ESM, and it must not import any project TypeScript. It is shipped with the
 * package next to the engine code.
 *
 * Signals:
 *
 * - Primary: `process.stdin` `end` / `close`. The parent holds the write end of
 *   the pipe; when the parent dies that pipe closes. Zero polling, zero race.
 * - Auxiliary: `process.kill(ppid, 0)` every 5 s. This covers platforms where
 *   the pipe EOF is not delivered (for example an inherited handle).
 * - Dual condition: the process keeps running only while the parent probe
 *   succeeds AND stdin still counts as a heartbeat (the pipe is open, or a
 *   parent byte arrived within the heartbeat window). Anything else is treated
 *   as parent loss. A live-but-closed stdin is therefore not a reason to stay.
 *
 * Self-check: print `WATCHDOG_OK=<pid>` to stderr at startup. The host verifies
 * the marker; a missing marker means the injection was ignored (for example a
 * disabled `nodeOptions` fuse) and the host falls back to parent-side cleanup.
 * The marker deliberately goes to stderr so the engine stdout contract (the
 * `WebSocket:` port line) is never polluted.
 *
 * Exit: Windows terminates via `process.exit(1)` because a console child cannot
 * reliably self-signal; the parent-side `taskkill /T /F` is the backstop. POSIX
 * sends SIGTERM to itself, then SIGKILL two seconds later if the engine catches
 * and ignores SIGTERM. The decision is made once; repeated triggers are no-ops.
 */

"use strict";

/** Parent liveliness probe interval; mirrors the documented 5 s cadence. */
const PROBE_INTERVAL_MS = 5000;

/**
 * How long a byte written by the parent counts as a heartbeat. Kept shorter
 * than the probe interval so the worst case after stdin EOF is still <= 5 s.
 */
const HEARTBEAT_WINDOW_MS = 2000;

/** POSIX SIGTERM grace before escalating to SIGKILL. */
const TERM_GRACE_MS = 2000;

/** Parent pid captured at preload time; `process.ppid` is stable afterwards. */
const parentPid = process.ppid;

/** Set once stdin reports EOF; from then on only byte heartbeats can save us. */
let stdinEnded = false;

/** Timestamp of the last stdin byte, or -Infinity when no heartbeat ever came. */
let lastHeartbeatAt = -Infinity;

/** Guards the exit path so `end` + `close` + timers kill at most once. */
let exiting = false;

/** Liveliness probe timer; cleared on exit so it never fires after the decision. */
let probeTimer = null;

/** @returns {boolean} true when the parent process is still probeable. */
function parentAlive() {
  if (typeof parentPid !== "number" || parentPid <= 0) {
    return false;
  }
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user: still alive.
    return Boolean(error) && error.code === "EPERM";
  }
}

/**
 * Heartbeat check backing the PID-reuse guard: an open pipe counts as a live
 * heartbeat, and a recently received byte keeps counting after EOF.
 * @returns {boolean} true when stdin shows recent parent activity.
 */
function heartbeatFresh() {
  return !stdinEnded || Date.now() - lastHeartbeatAt <= HEARTBEAT_WINDOW_MS;
}

/** Terminate this process once, using the platform-specific strategy. */
function exitNow() {
  if (exiting) {
    return;
  }
  exiting = true;
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
  if (process.platform === "win32") {
    process.exit(1);
    return;
  }
  try {
    process.kill(process.pid, "SIGTERM");
  } catch {
    process.exit(1);
    return;
  }
  // Unref'ed: a pending escalation must not keep the engine alive by itself.
  setTimeout(() => {
    try {
      process.kill(process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  }, TERM_GRACE_MS).unref();
}

/**
 * Decide whether to keep running. Exit unless both signals still hold: the
 * parent is probeable AND stdin still counts as a recent heartbeat.
 */
function check() {
  if (exiting) {
    return;
  }
  if (!parentAlive() || !heartbeatFresh()) {
    exitNow();
  }
}

/** Record stdin EOF and re-evaluate immediately instead of waiting a tick. */
function onStdinGone() {
  if (exiting || stdinEnded) {
    return;
  }
  stdinEnded = true;
  check();
}

try {
  process.stderr.write("WATCHDOG_OK=" + process.pid + "\n");
} catch {
  // A closed stderr must not break the engine; the host will see no marker.
}

try {
  if (process.stdin && typeof process.stdin.on === "function") {
    process.stdin.on("end", onStdinGone);
    process.stdin.on("close", onStdinGone);
    // Only records heartbeats; the engine does not read its own stdin.
    process.stdin.on("data", () => {
      lastHeartbeatAt = Date.now();
    });
    // A paused stdin never reports EOF on Windows once the engine has other
    // active handles, so the pipe must flow; unref keeps the injection
    // transparent and lets the engine exit on its own when it has no work.
    if (typeof process.stdin.unref === "function") {
      process.stdin.unref();
    }
  }
} catch {
  // Fall through to the polling probe only.
}

probeTimer = setInterval(check, PROBE_INTERVAL_MS);
// Never hold the engine process open on our own account.
if (probeTimer && typeof probeTimer.unref === "function") {
  probeTimer.unref();
}
