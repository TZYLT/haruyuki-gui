/**
 * The event merger's public surface: the merger, its changes and its
 * diagnostics.
 *
 * Consumers are the session store (all changes), the content model (message
 * changes), the reconnect path (`reset`/`watermark`/`stats`) and the
 * diagnostics readers (`stats`).
 *
 * Why this file is not a pure barrel: `scripts/check-module-ownership.mjs`
 * rejects a module whose every statement forwards. {@link MERGE_LAYER} is this
 * file's own declaration, matching the precedent of `CORE_PACKAGE_NAME` and
 * `PROTOCOL_PACKAGE_NAME`.
 */

/** Package-level identity, so a log line or an assertion can name this surface. */
export const MERGE_LAYER = "@haruyuki/core/merge" as const;

export { readEnvelope, readSeq, readString, asRecord } from "./envelope.js";
export type { EnvelopeFacts } from "./envelope.js";

export { createEventMerger } from "./event-merger.js";

export { createStats } from "./stats.js";
export type { CounterName, MergeStatsTracker } from "./stats.js";

export { MERGE_LIMITS, REBASELINE_THRESHOLD, REORDER_CAPACITY, TERM_SLICE_BYTES } from "./types.js";

export type {
  AssistantPart,
  ChangeBase,
  EventMerger,
  EventMergerOptions,
  MergeCounters,
  MergeStats,
  MergerChange,
  ResetReason,
  UsageSnapshot,
} from "./types.js";
