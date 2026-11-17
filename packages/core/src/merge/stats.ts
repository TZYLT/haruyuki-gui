/**
 * The bounded diagnostic counters behind `EventMerger.stats()`.
 *
 * Counters are diagnostics, not UI copy: nothing here becomes a label, and the
 * numbers are what the reconnect path and the diagnostics readers use to answer "did anything get lost, and where".
 * Three properties are load-bearing:
 *
 * 1. **Bounded.** The unknown-type distribution keeps at most `maxUnknownTypes`
 *    distinct names; the rest are folded into `"other"`. A hostile or upgraded
 *    engine cannot grow this table.
 * 2. **Snapshots are copies.** A caller that keeps a snapshot must not see later
 *    counts appear inside it; the same-object-twice check applies to the
 *    changes, and this rule keeps `stats()` equally stable.
 * 3. **Rebaselines are visible.** The fallback that heals a frozen watermark
 *    must leave a trace, or "it healed but nobody knows why it froze" becomes
 *    indistinguishable from "nothing happened".
 */

import type { MergeCounters, MergeStats, ResetReason } from "./types.js";

/** The counters a caller may bump; every one is a `number` in `MergeCounters`. */
export type CounterName = Exclude<
  keyof MergeCounters,
  "lastGapAt" | "lastGapFrom" | "lastGapTo" | "lastRebaselineAt"
>;

/** The writable side of the statistics table. */
export type MergeStatsTracker = {
  /** Bump one counter; `by` defaults to 1. */
  count(name: CounterName, by?: number): void;
  /** Record one gap covering the inclusive range `[from, to]`. */
  noteGap(from: number, to: number, at: number): void;
  /** Record one fallback rebaseline. */
  noteRebaseline(at: number): void;
  /** Record one unknown event type; folds overflow into `"other"`. */
  noteUnknown(type: string): void;
  /** Record the last reset, which the reconnect path reads. */
  markReset(reason: ResetReason, at: number): void;
  /** A copy of the current counts; later changes do not alter it. */
  snapshot(): MergeStats;
  /** A copy of the bounded unknown-type distribution (diagnostics only). */
  unknownTypeCounts(): ReadonlyMap<string, number>;
};

/** Which counters exist, so a typo is a type error rather than a silent zero. */
const COUNTERS = [
  "orderedFrames",
  "unorderedFrames",
  "duplicates",
  "late",
  "gaps",
  "missingFrames",
  "unknownTypes",
  "passthroughFrames",
  "incompleteMessages",
  "incompleteTurns",
  "rebaselines",
  "terminalDropped",
] as const satisfies readonly CounterName[];

type Counts = Record<CounterName, number> & {
  lastGapAt: number | null;
  lastGapFrom: number | null;
  lastGapTo: number | null;
  lastRebaselineAt: number | null;
};

/**
 * Build a tracker.
 *
 * @param maxUnknownTypes how many distinct unknown type names to keep
 */
export function createStats(maxUnknownTypes = 64): MergeStatsTracker {
  const counts: Counts = {
    orderedFrames: 0,
    unorderedFrames: 0,
    duplicates: 0,
    late: 0,
    gaps: 0,
    missingFrames: 0,
    unknownTypes: 0,
    passthroughFrames: 0,
    incompleteMessages: 0,
    incompleteTurns: 0,
    rebaselines: 0,
    terminalDropped: 0,
    lastGapAt: null,
    lastGapFrom: null,
    lastGapTo: null,
    lastRebaselineAt: null,
  };

  const unknown = new Map<string, number>();
  let resetAt: number | null = null;
  let resetReason: ResetReason | null = null;

  return {
    count(name, by = 1) {
      counts[name] += by;
    },
    noteGap(from, to, at) {
      counts.gaps += 1;
      counts.missingFrames += Math.max(0, to - from + 1);
      counts.lastGapAt = at;
      counts.lastGapFrom = from;
      counts.lastGapTo = to;
    },
    noteRebaseline(at) {
      counts.rebaselines += 1;
      counts.lastRebaselineAt = at;
    },
    noteUnknown(type) {
      counts.unknownTypes += 1;
      const key = unknown.has(type) ? type : unknown.size < maxUnknownTypes ? type : "other";
      unknown.set(key, (unknown.get(key) ?? 0) + 1);
    },
    markReset(reason, at) {
      resetAt = at;
      resetReason = reason;
    },
    snapshot() {
      const copy: MergeCounters = {
        orderedFrames: counts.orderedFrames,
        unorderedFrames: counts.unorderedFrames,
        duplicates: counts.duplicates,
        late: counts.late,
        gaps: counts.gaps,
        missingFrames: counts.missingFrames,
        unknownTypes: counts.unknownTypes,
        passthroughFrames: counts.passthroughFrames,
        incompleteMessages: counts.incompleteMessages,
        incompleteTurns: counts.incompleteTurns,
        rebaselines: counts.rebaselines,
        terminalDropped: counts.terminalDropped,
        lastGapAt: counts.lastGapAt,
        lastGapFrom: counts.lastGapFrom,
        lastGapTo: counts.lastGapTo,
        lastRebaselineAt: counts.lastRebaselineAt,
      };

      return Object.freeze({
        ...copy,
        resetAt,
        resetReason,
      }) as MergeStats;
    },
    unknownTypeCounts() {
      return new Map(unknown);
    },
  };
}
