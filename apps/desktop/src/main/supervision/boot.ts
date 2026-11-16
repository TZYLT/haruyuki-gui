/**
 * Boot-time supervision: read the previous run's marker, decide, reclaim, replace.
 *
 * This module is the policy layer. `@haruyuki/core/supervision` owns the marker
 * file format, the process-evidence collection and the two-condition decision;
 * this file only chooses what a shell start-up does with those answers
 * (docs/33-D4 sections 4.4, 5.2 and 5.4).
 *
 * The order matters and is the requirement's, not an implementation preference:
 *
 *   1. read `runtime.json`; a missing or damaged file is a normal boot;
 *   2. no engine recorded -> overwrite the marker for this run;
 *   3. a recorded engine that is gone -> overwrite, never signal;
 *   4. evidence strong enough (`confident`) -> kill the tree, remove our token,
 *      overwrite the marker;
 *   5. evidence not strong enough (`ambiguous`) -> keep the old marker as
 *      `runtime-stale-<instanceId>.json` for the menu, overwrite the live one.
 *
 * Every failure here is logged and swallowed. A supervision file that cannot be
 * read or written must not stop the shell from opening its window (`R-16` and
 * requirement section 4.1: no new first-launch page, no dialog).
 */

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  clearRuntimeMarker,
  collectEvidence as collectEvidenceFromOs,
  evaluateReclaim,
  killStaleEngine,
  listStale,
  moveToStale,
  readRuntimeMarker,
  writeRuntimeMarker,
  type EngineMarker,
  type KillResult,
  type ProcessEvidence,
  type RuntimeMarker,
  type StaleEngineRecord,
  type StaleMarkerEntry,
} from "@haruyuki/core";

import { describeError, type SupervisionLog } from "./errors.js";

export { clearMarkerAfterStop, writeMarkerEngine } from "./marker-write.js";

/**
 * The shell's log sink.
 *
 * The event is a short stable identifier such as `supervision.reclaim.killed`;
 * the detail is structured and must never contain the engine token, the run
 * token, a key or session content.
 */
/**
 * One old marker that could not be dropped silently.
 *
 * `decision` is `confident` only when the kill itself failed: a confident kill
 * that succeeds goes to {@link BootSupervisionResult.reclaimed} instead, while a
 * failed one stays visible so the menu can offer the manual path (`R-5`).
 */
export interface StaleCandidate {
  readonly pid: number;
  readonly evidence: ProcessEvidence;
  readonly decision: "confident" | "ambiguous";
  readonly reason: string;
  /**
   * The `runtime-stale-*.json` this candidate came from, if any.
   *
   * Present for a candidate kept by this boot and for one loaded from an earlier
   * boot; the cleanup path uses it to delete the file only after the process is
   * confirmed gone. It is a file name, never a path from the marker.
   */
  readonly staleFile?: string;
}

/** What one boot scan found and what it did. */
export interface BootSupervisionResult {
  /** Candidates no automatic action was taken on; the menu lists these. */
  readonly stale: readonly StaleCandidate[];
  /** Leaked engines this boot reclaimed. */
  readonly reclaimed: readonly StaleCandidate[];
}

/** Dependency seams used by unit tests; production passes none of them. */
export interface BootSupervisionOptions {
  readonly userData: string;
  readonly appVersion: string;
  readonly now?: () => Date;
  readonly onLog?: SupervisionLog;
  readonly collectEvidence?: (marker: EngineMarker) => Promise<ProcessEvidence>;
  readonly kill?: (marker: EngineMarker) => Promise<KillResult>;
}

/** The only fixed name inside `userData`; the stale names derive from an id. */
const TOKEN_DIR_NAME = "engine-token";

/** B1's token file name (`packages/core/src/engine/token.ts`). */
const TOKEN_FILE_NAME = "engine-token";

/**
 * Read the previous marker, act on it, and write this run's marker.
 *
 * Returns value objects rather than throwing: a failed scan still lets the shell
 * boot, and the caller (main) logs the counts. The marker write for this run is
 * attempted on every path, because without it this run's engine would be
 * invisible to the next start-up -- which is the orphan this package exists to
 * prevent.
 */
export async function runBootSupervision(
  options: BootSupervisionOptions,
): Promise<BootSupervisionResult> {
  const stale: StaleCandidate[] = [];
  const reclaimed: StaleCandidate[] = [];
  const now = options.now?.() ?? new Date();
  const log = createLog(options.onLog);

  // Stale files are candidates from earlier boots. Loading them before the
  // runtime marker means a candidate survives a restart, as RD-08 requires;
  // the files are not deleted here because the process may still be alive.
  await loadStaleCandidates(options, log, stale);

  try {
    const read = await readRuntimeMarker(options.userData);

    if (!read.ok) {
      log("supervision.marker.read", {
        state: read.reason,
        ...(read.detail === undefined ? {} : { detail: read.detail }),
      });

      await writeFreshMarker(options, now, log);

      return { stale, reclaimed };
    }

    const marker = read.marker;

    // Nothing was started last run: the old marker carries no orphan, so it is
    // replaced rather than examined.
    if (marker.engine === null) {
      await replaceMarker(options, now, log);

      return { stale, reclaimed };
    }

    const engine = marker.engine;
    let evidence: ProcessEvidence;

    try {
      evidence = await (options.collectEvidence ?? collectEvidenceFromOs)(engine);
    } catch (error) {
      // A collector bug is not evidence of identity. Treat it as the weakest
      // possible answer so the marker is preserved for a human instead of being
      // overwritten as if the process were gone.
      log("supervision.reclaim.evidence-failed", {
        pid: engine.pid,
        detail: describeError(error),
      });

      evidence = unknownEvidence(engine, describeError(error));
    }

    const evaluation = evaluateReclaim(engine, evidence);

    if (evaluation.decision === "gone") {
      log("supervision.reclaim.gone", { pid: engine.pid });

      await replaceMarker(options, now, log);

      return { stale, reclaimed };
    }

    const candidate: StaleCandidate = {
      pid: engine.pid,
      evidence,
      decision: evaluation.decision,
      reason: evaluation.reason,
    };

    if (evaluation.decision === "ambiguous") {
      log("supervision.reclaim.skipped", { pid: engine.pid, reason: evaluation.reason });

      const staleFile = await keepStale(options, marker, evidence, evaluation.reason, now, log);

      await writeFreshMarker(options, now, log);

      stale.push({
        ...candidate,
        ...(staleFile === null ? {} : { staleFile }),
      });

      return { stale, reclaimed };
    }

    const kill = options.kill ?? killStaleEngine;
    const killed = await kill(engine).catch((error: unknown): KillResult => ({
      ok: false,
      reason: describeError(error),
    }));

    if (!killed.ok) {
      // `R-5`: report the failure and keep the evidence; do not loop. The
      // marker moves to stale so the next boot still knows what to clean.
      const reason = `kill failed: ${killed.reason}`;

      log("supervision.reclaim.failed", { pid: engine.pid, reason: killed.reason });

      const staleFile = await keepStale(options, marker, evidence, reason, now, log);

      await writeFreshMarker(options, now, log);

      stale.push({
        ...candidate,
        reason,
        ...(staleFile === null ? {} : { staleFile }),
      });

      return { stale, reclaimed };
    }

    await removeOurTokenFile(options.userData, engine.tokenFile, log);
    await replaceMarker(options, now, log);

    log("supervision.reclaim.killed", { pid: engine.pid });

    reclaimed.push(candidate);

    return { stale, reclaimed };
  } catch (error) {
    // The individual steps already log; this catches a programmer error or an
    // unexpected I/O failure so boot never turns into a crash page.
    log("supervision.boot.failed", { detail: describeError(error) });

    return { stale, reclaimed };
  }
}

/** Build a logger that cannot make the caller fail. */
function createLog(onLog: SupervisionLog | undefined): SupervisionLog {
  return (event, detail) => {
    try {
      onLog?.(event, detail);
    } catch {
      // Logging is best effort on a boot path that must not fail.
    }
  };
}

/** This run's marker with no engine yet. */
function freshMarker(appVersion: string, now: Date): RuntimeMarker {
  return {
    schemaVersion: 1,
    instanceId: randomUUID(),
    startedAt: now.toISOString(),
    appVersion,
    engine: null,
  };
}

/** Drop the old marker, then write this run's. */
async function replaceMarker(
  options: BootSupervisionOptions,
  now: Date,
  log: SupervisionLog,
): Promise<void> {
  try {
    await clearRuntimeMarker(options.userData);
  } catch (error) {
    // The write below overwrites atomically anyway; a failed unlink only means
    // one extra file operation was refused.
    log("supervision.marker.clear", { state: "failed", detail: describeError(error) });
  }

  await writeFreshMarker(options, now, log);
}

/** Write the `engine: null` marker for this run, logging but not throwing. */
async function writeFreshMarker(
  options: BootSupervisionOptions,
  now: Date,
  log: SupervisionLog,
): Promise<void> {
  try {
    await writeRuntimeMarker(options.userData, freshMarker(options.appVersion, now));
    log("supervision.marker.write", { state: "written" });
  } catch (error) {
    log("supervision.marker.write", { state: "failed", detail: describeError(error) });
  }
}

/**
 * Keep an old marker that was not safe to reclaim.
 *
 * The stale write is what preserves the evidence; the fresh live marker is
 * written by the caller afterwards. A failed transfer is logged and the live
 * marker still gets replaced, because this run needs a marker of its own.
 */
async function keepStale(
  options: BootSupervisionOptions,
  marker: RuntimeMarker,
  evidence: ProcessEvidence,
  reason: string,
  now: Date,
  log: SupervisionLog,
): Promise<string | null> {
  const record: StaleEngineRecord = {
    schemaVersion: 1,
    detectedAt: now.toISOString(),
    marker,
    evidence,
    reason,
  };

  try {
    const path = await moveToStale(options.userData, record);
    log("supervision.stale.keep", { pid: evidence.pid, reason });

    return basename(path);
  } catch (error) {
    log("supervision.stale.failed", { pid: evidence.pid, detail: describeError(error) });

    return null;
  }
}

/**
 * Load every `runtime-stale-*.json` left by an earlier boot.
 *
 * A damaged file is logged and skipped rather than deleted: it is evidence of a
 * writer bug, and the cleanup path is not allowed to guess at a process from an
 * unreadable record. A file with `engine: null` has no candidate to offer.
 */
async function loadStaleCandidates(
  options: BootSupervisionOptions,
  log: SupervisionLog,
  target: StaleCandidate[],
): Promise<void> {
  let entries;

  try {
    entries = await listStale(options.userData);
  } catch (error) {
    log("supervision.stale.load-failed", { detail: describeError(error) });

    return;
  }

  for (const entry of entries) {
    if (entry.record === null) {
      log("supervision.stale.unreadable", {
        file: basename(entry.path),
        detail: entry.detail ?? "unknown",
      });

      continue;
    }

    if (entry.record.marker.engine === null) continue;

    target.push({
      pid: entry.record.evidence.pid,
      evidence: entry.record.evidence,
      decision: entry.record.evidence.matched ? "confident" : "ambiguous",
      reason: entry.record.reason,
      staleFile: basename(entry.path),
    });
  }

  if (target.length > 0) log("supervision.stale.loaded", { count: target.length });
}

/**
 * Delete the token file only when it is exactly the one this shell owns.
 *
 * A marker is data from a previous run and could be damaged; a path that is not
 * `<userData>/engine-token/engine-token` is never deleted. This is the guard
 * that keeps a corrupt marker from turning reclaim into an arbitrary unlink.
 */
async function removeOurTokenFile(
  userData: string,
  tokenFile: string | null,
  log: SupervisionLog,
): Promise<void> {
  if (tokenFile === null) return;

  const ours = join(userData, TOKEN_DIR_NAME, TOKEN_FILE_NAME);

  if (!samePath(tokenFile, ours)) {
    log("supervision.token.skipped", { reason: "not this shell's token file" });

    return;
  }

  try {
    await unlink(ours);
    log("supervision.token.removed", {});
  } catch (error) {
    if (isMissingFileError(error)) return;

    log("supervision.token.remove-failed", { detail: describeError(error) });
  }
}

/** A deliberately weak evidence set for a collector that threw. */
function unknownEvidence(marker: EngineMarker, detail: string): ProcessEvidence {
  return {
    pid: marker.pid,
    alive: true,
    imagePath: null,
    createdAt: null,
    runToken: marker.runToken,
    tokenFileExists: false,
    portListening: false,
    matched: false,
    reason: `evidence collection failed: ${detail}`,
  };
}

/** Compare absolute paths the way the platform does. */
function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);

  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `ENOENT` means the token file is already gone, which is success here. */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
