/**
 * Data shapes for stale-engine supervision.
 *
 * Shape source: the on-disk records -- `RuntimeMarker`, `EngineMarker`,
 * `ProcessEvidence` and `StaleEngineRecord`. These are on-disk contracts, not
 * just in-memory types: the writer and the reader run in
 * different processes, possibly different builds, so field names and semantics
 * cannot drift silently. Readers ignore unknown fields, which is what makes the
 * "fields may only grow" rule workable.
 *
 * One extension is deliberate. `ProcessEvidence.reason` explains the decision
 * (`decideReclaim`) next to the facts that produced it, so a stale file or a
 * diagnostics summary can be read without replaying the comparison. The reason
 * is prose for humans only; nothing branches on it.
 */

/**
 * One shell run. It is deleted on a clean quit and left behind after a crash,
 * which is exactly what lets the next start-up notice a leaked engine.
 */
export interface RuntimeMarker {
  schemaVersion: 1;
  /** Random id for this run; also names the stale file if it is kept. */
  instanceId: string;
  /** ISO 8601 UTC. */
  startedAt: string;
  appVersion: string;
  /** The engine this shell started; `null` when the shell ran without one. */
  engine: EngineMarker | null;
}

/**
 * The engine process as the shell knew it when it started.
 *
 * `startedAt` is the shell's write time, not the OS creation time. That is why
 * the OS creation time in `ProcessEvidence` is compared with a tolerance rather
 * than for equality: spawn-to-ready and clock granularity make an exact match
 * impossible.
 */
export interface EngineMarker {
  pid: number;
  /** ISO 8601 UTC; the moment the shell recorded this engine, not the OS time. */
  startedAt: string;
  exePath: string;
  bundlePath: string;
  /** Random token that correlates a marker with one shell run; local only. */
  runToken: string;
  watchdog: "active" | "inactive" | "unknown";
  /** Token file path; local only, never part of a diagnostics archive. */
  tokenFile: string | null;
  /** Engine port; always `null` because the shell exposes no port. */
  port: number | null;
}

/**
 * What the OS can still tell us about a PID from a previous run.
 *
 * "PID exists" is not an identity: PIDs are reused and the engine may have been
 * replaced by any process. The independent facts are the OS creation time and
 * the executable path; the token file is a third, weaker fact used only when one
 * of the two identity facts is unavailable. `runToken` correlates the evidence
 * with the marker but is never proof. `portListening` is always `false` and is
 * not part of the decision.
 */
export interface ProcessEvidence {
  pid: number;
  alive: boolean;
  imagePath: string | null;
  /** Operating-system creation time (UTC), not the marker write time. */
  createdAt: string | null;
  runToken: string | null;
  tokenFileExists: boolean;
  portListening: boolean;
  /** True only for a "confident" decision. */
  matched: boolean;
  /** English, human-readable explanation of the decision; not for branching. */
  reason: string;
}

/**
 * An old marker the shell could not safely reclaim: the evidence was not strong
 * enough to kill the process, so the record is kept across restarts for a human
 * decision instead of being silently discarded.
 */
export interface StaleEngineRecord {
  schemaVersion: 1;
  /** ISO 8601 UTC. */
  detectedAt: string;
  /** The old marker, unmodified. */
  marker: RuntimeMarker;
  /** The evidence the decision was based on. */
  evidence: ProcessEvidence;
  /** Why "confident" was not reached; English ASCII. */
  reason: string;
}

/**
 * The three outcomes of comparing a marker with evidence.
 *
 * - `gone`: the PID is not running, so only the marker file needs deleting.
 * - `ambiguous`: a PID exists but its identity is not proven; never kill.
 * - `confident`: at least two independent facts agree; reclaim is allowed.
 */
export type ReclaimDecision = "gone" | "ambiguous" | "confident";
