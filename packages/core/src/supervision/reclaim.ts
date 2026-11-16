/**
 * Stale-engine decision and reclaim.
 *
 * The rule is intentionally narrow: a live PID alone is never proof, because
 * live PID alone is never proof, because PIDs are reused. The shell may reclaim
 * only when two independent facts agree, or when the one available identity fact
 * agrees AND the engine token file still exists. Anything less is `ambiguous`,
 * never killed.
 *
 * `ProcessEvidence.portListening` is not read here. B1 does not expose the
 * engine's port, so D4 writes `port: null` and `portListening: false` and the
 * decision deliberately has no port branch (RD-07).
 *
 * The decision function is pure and exported so it can be table-tested without
 * spawning anything. Killing lives beside it because both answers share the same
 * evidence vocabulary; neither function touches markers or token files, which is
 * the caller's job.
 */

import { execFile } from "node:child_process";

import type { EngineMarker, ProcessEvidence, ReclaimDecision } from "./types";

/** Route section 5.4 tolerance: spawn-to-ready plus clock granularity is below this. */
export const DEFAULT_TIME_TOLERANCE_MS = 120_000;

/** Total budget for one reclaim; route section 5.4 allows 2 s. */
const KILL_TOTAL_TIMEOUT_MS = 2_000;

/** Poll interval while waiting for a process to disappear. */
const KILL_POLL_INTERVAL_MS = 50;

/** Cap for a kill failure reason copied into `KillResult`. */
const REASON_LIMIT = 300;

/** The decision together with the prose that explains it. */
export type ReclaimEvaluation = {
  readonly decision: ReclaimDecision;
  /** English, human-readable, and never used for branching. */
  readonly reason: string;
};

/**
 * Result of {@link killStaleEngine}.
 *
 * `ok: false` means the process is still believed to be running after the
 * platform command failed; it deliberately does not expose a retryable code,
 * because route R-5 says a failed reclaim is reported and not retried in a loop.
 */
export type KillResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Route section 5.4, verbatim in behaviour.
 *
 * `toleranceMs` is the absolute distance allowed between the marker write time
 * and the OS creation time. Both timestamps are ISO strings; an unparseable one
 * fails the comparison rather than throwing, so a damaged marker can only ever
 * reach `ambiguous`.
 */
export function decideReclaim(
  marker: EngineMarker,
  evidence: ProcessEvidence,
  toleranceMs: number = DEFAULT_TIME_TOLERANCE_MS,
): ReclaimDecision {
  return evaluateReclaim(marker, evidence, toleranceMs).decision;
}

/**
 * Like {@link decideReclaim} but also returns why.
 *
 * `ProcessEvidence.matched` and `.reason` are computed from this result, and
 * `StaleEngineRecord.reason` uses the same text, so there is one implementation
 * of the explanation instead of three drifting copies.
 */
export function evaluateReclaim(
  marker: EngineMarker,
  evidence: ProcessEvidence,
  toleranceMs: number = DEFAULT_TIME_TOLERANCE_MS,
): ReclaimEvaluation {
  if (!evidence.alive) {
    return { decision: "gone", reason: "process is not running" };
  }

  const createdAt = evidence.createdAt;
  const imagePath = evidence.imagePath;

  if (createdAt !== null && imagePath !== null) {
    const timeMatches = withinTolerance(marker.startedAt, createdAt, toleranceMs);
    const imageMatches = samePath(imagePath, marker.exePath);

    if (timeMatches && imageMatches) {
      return { decision: "confident", reason: "createdAt and imagePath both match" };
    }

    if (!timeMatches && !imageMatches) {
      return { decision: "ambiguous", reason: "createdAt and imagePath do not match" };
    }

    return {
      decision: "ambiguous",
      reason: timeMatches
        ? "imagePath does not match"
        : "createdAt does not match within tolerance",
    };
  }

  if (createdAt !== null) {
    const timeMatches = withinTolerance(marker.startedAt, createdAt, toleranceMs);

    if (timeMatches && evidence.tokenFileExists) {
      return { decision: "confident", reason: "createdAt matches and the token file exists" };
    }

    return {
      decision: "ambiguous",
      reason: timeMatches
        ? "createdAt matches but the token file is missing"
        : "createdAt does not match within tolerance",
    };
  }

  if (imagePath !== null) {
    const imageMatches = samePath(imagePath, marker.exePath);

    if (imageMatches && evidence.tokenFileExists) {
      return { decision: "confident", reason: "imagePath matches and the token file exists" };
    }

    return {
      decision: "ambiguous",
      reason: imageMatches
        ? "imagePath matches but the token file is missing"
        : "imagePath does not match",
    };
  }

  return { decision: "ambiguous", reason: "only the pid is available" };
}

/**
 * True when `pid` names a live process this account can see.
 *
 * `process.kill(pid, 0)` performs the permission and existence check without
 * delivering a signal. `EPERM` means the process exists but belongs to somebody
 * else, which is still "alive" for reclaim purposes (and the identity commands
 * will almost certainly fail, leaving the decision `ambiguous`).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCodeOf(error) === "EPERM";
  }
}

/**
 * Kill the process tree described by `marker`, bounded by roughly 2 s.
 *
 * Windows uses `taskkill /PID <pid> /T /F`, the same tree-wide forced kill the
 * engine stop path uses. POSIX signals the process group first because a
 * detached engine leads its own group; a non-detached PID is not a group leader,
 * so an `ESRCH` from the group signal falls back to the single PID.
 *
 * Never throws. A process that is already gone is a success: the caller's goal
 * is "not running", and the race between evidence collection and the kill is
 * expected. The function does not delete the marker or the token file; route
 * section 5.4 gives marker lifecycle to P4.
 */
export async function killStaleEngine(marker: EngineMarker): Promise<KillResult> {
  const pid = marker.pid;

  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "invalid pid" };
  }

  if (!isProcessAlive(pid)) {
    return { ok: true };
  }

  const deadline = Date.now() + KILL_TOTAL_TIMEOUT_MS;

  try {
    return process.platform === "win32"
      ? await killOnWindows(pid, deadline)
      : await killOnPosix(pid, deadline);
  } catch (error) {
    return { ok: false, reason: summarizeError(error) };
  }
}

/** Windows branch: forced tree kill, then confirm the PID really disappeared. */
async function killOnWindows(pid: number, deadline: number): Promise<KillResult> {
  const command = await requestTaskkill(pid, remainingMs(deadline));

  // A failed taskkill often means "not found" (exit 128) or that the process
  // exited while the command was starting. The OS is the authority, not the
  // localized command text, so check liveness before reporting a failure.
  if (!isProcessAlive(pid)) {
    return { ok: true };
  }

  if (!command.ok) {
    // `taskkill /T` can fail when the caller is itself inside a job object (the
    // DSH host is), even though the PID is ours and still killable. Try the
    // direct signal before reporting failure; the tree claim still belongs to
    // taskkill, so a surviving child remains a failure rather than a success.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone or not ours; the liveness check below is authoritative.
    }

    if (await waitForExit(pid, remainingMs(deadline))) {
      return { ok: true };
    }

    return command;
  }

  return (await waitForExit(pid, remainingMs(deadline)))
    ? { ok: true }
    : { ok: false, reason: "process is still alive after taskkill" };
}

/** POSIX branch: group signal first, then the single PID as a fallback. */
async function killOnPosix(pid: number, deadline: number): Promise<KillResult> {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // A non-detached PID is not a group leader, so the negative form can fail
    // with ESRCH; the direct signal below is the documented fallback. A real
    // permission failure is retried once and then reported by the fallback.
    try {
      process.kill(pid, "SIGKILL");
    } catch (fallbackError) {
      if (errorCodeOf(fallbackError) === "ESRCH") {
        return { ok: true };
      }

      return { ok: false, reason: summarizeError(fallbackError) };
    }
  }

  return (await waitForExit(pid, remainingMs(deadline)))
    ? { ok: true }
    : { ok: false, reason: "process is still alive after SIGKILL" };
}

/** Run taskkill without a shell; resolve with its outcome instead of throwing. */
function requestTaskkill(pid: number, timeoutMs: number): Promise<KillResult> {
  return new Promise((resolvePromise) => {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: Math.max(1, timeoutMs) },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolvePromise({ ok: true });
          return;
        }

        const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr : error;
        resolvePromise({ ok: false, reason: summarizeError(detail) });
      },
    );
  });
}

/** Time left in the one total budget, never negative. */
function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** Poll until the PID is gone or the budget is spent. */
function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + timeoutMs;

    const poll = (): void => {
      if (!isProcessAlive(pid)) {
        resolvePromise(true);
        return;
      }

      if (Date.now() >= deadline) {
        resolvePromise(false);
        return;
      }

      setTimeout(poll, Math.min(KILL_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    };

    poll();
  });
}

/**
 * Compare the marker write time with the OS creation time within `toleranceMs`.
 *
 * Invalid timestamps are never "within tolerance"; that is what lets a damaged
 * marker fail closed into `ambiguous` instead of producing a confident kill.
 */
function withinTolerance(markerStartedAt: string, createdAt: string, toleranceMs: number): boolean {
  const markerTime = Date.parse(markerStartedAt);
  const createdTime = Date.parse(createdAt);

  if (!Number.isFinite(markerTime) || !Number.isFinite(createdTime)) {
    return false;
  }

  return Math.abs(markerTime - createdTime) <= Math.abs(toleranceMs);
}

/**
 * Path equality with the platform's own rules.
 *
 * Windows is case-insensitive and accepts both separators, so `C:/x/node.exe`
 * and `c:\x\node.exe` name the same image. POSIX paths are byte string
 * identity: two different strings are two different files.
 */
function samePath(left: string, right: string): boolean {
  if (process.platform !== "win32") {
    return left === right;
  }

  return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}

/** Fold separators and case for comparison only; never used as a path. */
function normalizeWindowsPath(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+/g, "\\").toLowerCase();
}

/** Node exposes the platform errno as `code`; anything else is unknown. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }

  return undefined;
}

/** One compact, capped reason line for a failed kill. */
function summarizeError(error: unknown): string {
  const record =
    typeof error === "object" && error !== null
      ? (error as { stderr?: unknown; message?: unknown; code?: unknown })
      : null;
  const stderr = typeof record?.stderr === "string" ? record.stderr : "";
  const message =
    typeof record?.message === "string"
      ? record.message
      : error === null
        ? "unknown"
        : String(error);
  const raw = stderr.trim() === "" ? message : stderr;
  const compact = raw.replace(/\s+/g, " ").trim();
  const code = record?.code;
  const prefix = typeof code === "number" ? `exit ${code}: ` : "";
  const summary = `${prefix}${compact === "" ? "command failed" : compact}`;

  return summary.length > REASON_LIMIT ? `${summary.slice(0, REASON_LIMIT)}...` : summary;
}
