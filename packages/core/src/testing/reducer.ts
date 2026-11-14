/**
 * reducer.ts - the reference frame reducer used only by the comparison layer
 * .
 *
 * Scope sources: docs/18-A3 section 3.4.4 (the frozen observation/comparison
 * shapes), section 4.2 (`contract`), section 5.1 rule 4 (the harness compares
 * frames; it must not become product behaviour) and section 7 `A3-Q02`.
 * Frame rules: docs/01-3 sections 3.1-3.3. Requirement side: docs/17-A3 sections
 * 4.3 ("a minimal reference reducer for self-proof") and 6.5.
 *
 * This is a comparison aid, not a product reducer. It folds one received frame
 * stream into an object two observations can be compared over and stops there:
 * no selectors, no UI state, and no `t` vocabulary of its own (that belongs to
 * C5). C2's `SessionStore` replaces it, so it is not exported as a business API.
 *
 * Semantics are exactly the three statements the bridge makes about the three
 * three channels, nothing more:
 *
 * - `control` frames are a log: appended in arrival order, never merged.
 * - `state.*` frames on `stream` are overwrite-style: a later body for the same
 *   suffix replaces the earlier one and intermediate bodies are intentionally
 *   lost. The body is replaced whole, never deep-merged, because the rule says
 *   doc says "overwrite", not "merge".
 * - every other `stream` frame is a log entry in arrival order. Terminal frames
 *   therefore never enter the folded `state`: an event is not state, and the
 *   the reducer does not try to tell a terminal frame apart from a text delta,
 *   because that vocabulary is not frozen yet.
 * - `bulk` pages are concatenated in arrival order; a page is never reordered or
 *   deduplicated here (INV-A3-8).
 *
 * Only `ch` and the `state.` prefix are read. `seq` and `t` are otherwise opaque.
 */

import type { BridgeFrame } from "./fixture";

/** Prefix that marks an overwrite-style state frame. */
const STATE_PREFIX = "state.";

/**
 * The comparable object one frame stream folds into.
 *
 * All four members are JSON-shaped; comparing two of these is comparing the
 * frames each transport delivered, not business state.
 */
export type ReducedState = {
  /** `control` frames in arrival order; a log, never merged. */
  control: BridgeFrame[];
  /** `stream` frames that are not `state.*`, in arrival order. */
  stream: BridgeFrame[];
  /** `bulk` pages in arrival order; later pages follow earlier ones. */
  bulk: BridgeFrame[];
  /** Last body per `state.<key>` suffix; a later frame replaces it whole. */
  state: Record<string, unknown>;
};

/**
 * Fold a frame stream into {@link ReducedState}.
 *
 * Pure and deterministic: the input array and the frames are not mutated, and
 * the same input always produces the same output. Cross-channel interleaving
 * does not matter, because each channel is folded into its own section.
 *
 * @param frames Frames in arrival order.
 */
export function reduce(frames: readonly BridgeFrame[]): ReducedState {
  const control: BridgeFrame[] = [];
  const stream: BridgeFrame[] = [];
  const bulk: BridgeFrame[] = [];
  const folded: Record<string, unknown> = {};

  for (const frame of frames) {
    if (frame.ch === "control") {
      control.push(frame);
    } else if (frame.ch === "bulk") {
      bulk.push(frame);
    } else if (frame.t.startsWith(STATE_PREFIX)) {
      folded[frame.t.slice(STATE_PREFIX.length)] = frame.body;
    } else {
      stream.push(frame);
    }
  }

  return { control, stream, bulk, state: folded };
}
