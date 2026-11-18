/**
 * The frame type table: every frame type this repository itself emits.
 *
 * The table is data, not behaviour:
 * C1, E* and D3 each append rows for their own frame types, and the rows are
 * what `scripts/check-frame.mjs` scans source literals against. Two properties
 * are load-bearing:
 *
 * 1. APPEND-ONLY. A `t` value becomes wire contract the moment it lands:
 *   downstream items write it into fixtures and hosts branch on it, so a row
 *   is never renamed or removed.
 * 2. STATICALLY READABLE. The gate parses this file's AST and expects
 *   `FRAME_TYPES` to be initialised by an object literal. Wrapping the literal
 *   in `as const satisfies ...` is fine; building it with a loop, a spread or
 *   an IIFE is not, because the gate cannot then see the keys.
 *
 * `satisfies Record<string, FrameTypeSpec>` rather than `: Record<...>` is
 * deliberate: it proves each row's shape while keeping the literal key set
 * available to `keyof`, which is what makes `KnownFrameType` exact.
 */

import type { FrameChannel } from "./frame.js";

/**
 * When a burst of same-channel frames may be collapsed into one delivery.
 *
 * `"never"` is the only value in use so far. `"by-channel"` exists for future
 * high-frequency progress traffic, where the newest frame of a channel
 * supersedes the ones before it; it must never be chosen for a frame whose
 * individual occurrences are observable.
 */
export type FrameCoalescing = "never" | "by-channel";

/**
 * One row of the frame type table.
 *
 * Every field is required. `summary` is not decoration: it is printed in
 * diagnostics and in the unknown-frame fallback, so it is a single English
 * line with no line breaks and no trailing period.
 */
export interface FrameTypeSpec {
  readonly ch: FrameChannel;
  readonly coalescible: FrameCoalescing;
  readonly since: string;
  readonly summary: string;
}

export const FRAME_TYPES = {
  "bridge.ready": {
    ch: "control",
    coalescible: "never",
    since: "C5",
    summary: "renderer announces itself",
  },
  "bridge.accept": {
    ch: "control",
    coalescible: "never",
    since: "C5",
    summary: "core accepts the bridge version",
  },
  "bridge.reject": {
    ch: "control",
    coalescible: "never",
    since: "C5",
    summary: "core refuses the bridge version",
  },
  "bulk.page": { ch: "bulk", coalescible: "never", since: "C5", summary: "one page of a snapshot" },
  "term.output": {
    ch: "stream",
    coalescible: "never",
    since: "C5",
    summary: "terminal bytes, fixed 8 KB slices",
  },
  "layout.snapshot": {
    ch: "bulk",
    coalescible: "never",
    since: "C4",
    summary: "authoritative layout snapshot",
  },
  "delta.message": {
    ch: "stream",
    coalescible: "never",
    since: "C1",
    summary: "one assistant message increment",
  },
  "state.loop": {
    ch: "control",
    coalescible: "never",
    since: "C1",
    summary: "loop status snapshot",
  },
  "state.device": {
    ch: "control",
    coalescible: "never",
    since: "C1",
    summary: "device status snapshot",
  },
  "state.queue": {
    ch: "control",
    coalescible: "never",
    since: "C1",
    summary: "queue snapshot including removals",
  },
  "state.subagents": {
    ch: "control",
    coalescible: "never",
    since: "C1",
    summary: "subagent state snapshot",
  },
  terminal_spawned: {
    ch: "control",
    coalescible: "never",
    since: "E1",
    summary: "a terminal process appeared",
  },
  terminal_exited: {
    ch: "control",
    coalescible: "never",
    since: "E1",
    summary: "a terminal process exited",
  },
} as const satisfies Record<string, FrameTypeSpec>;

/**
 * The registered frame types.
 *
 * A closed union on purpose, but only as a convenience for this package and
 * its tests: `Frame["t"]` stays `string`, because a host may inject a table the
 * shared package has never heard of (C5-Q24).
 */
export type KnownFrameType = keyof typeof FRAME_TYPES;
