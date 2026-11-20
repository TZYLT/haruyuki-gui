/**
 * sequencer.ts - the single global issuer of frame sequence numbers.
 *
 * Contract source: the `seq` field of the frame envelope
 * (packages/protocol/src/frame/frame.ts), documented there as "Global
 * monotonic counter, assigned by the core's single sequencer". Arrival order is
 * guaranteed within one channel only, so drops, duplicates and reorders are
 * legal across channels.
 *
 * Why one counter for the whole process, and not one per sender
 *   The renderer has to answer one question about every frame it receives: is
 *   this newer than what I have already applied? It answers by comparing the
 *   frame's `seq` with the highest `seq` it has consumed. A per-sender counter
 *   (one per channel, or one per transport instance) answers a different
 *   question -- "how many frames has this sender emitted?" -- and the two
 *   questions only have the same answer while exactly one sender exists and
 *   never restarts.
 *
 *   Two silent failures follow from per-sender counters:
 *
 *   1. A sender that reconnects restarts at 1, 2, 3. The renderer compares
 *      those numbers with the watermark it kept from before the restart and
 *      classifies every one of them as stale, so exactly the frames it has not
 *      seen yet are the ones it discards as duplicates. The renderer can only
 *      tell "new session" from "old frame" through the handshake
 *      (`bridge.ready` / `bridge.accept`), which is where a fresh watermark is
 *      established -- so numbering must not depend on which sender emitted a
 *      frame. When the core process itself restarts, its counter restarts too
 *      and the handshake announces that new session; `seq` is therefore a
 *      per-session total order, which is precisely what it needs to be.
 *   2. Three channels drawing from three counters produce numbers that cannot
 *      be compared with each other at all: a `control` acknowledgement at seq 4
 *      next to a `bulk` page at seq 2 says nothing about emission order, so no
 *      consumer can reason about cross-channel state (a snapshot page that
 *      refers to terminal output, say) from the envelope alone.
 *
 *   With one issuer, `seq` is a total order over every frame this process
 *   emits, whatever its channel or sender, and it is the only ordering signal
 *   that survives the three channels' different arrival guarantees.
 *
 * Overflow
 *   `Number.MAX_SAFE_INTEGER` is a hard ceiling; reaching it throws a
 *   `RangeError` rather than doing something quiet. Every alternative is worse,
 *   for the same reason the issuer is single:
 *
 *   - wrapping back to 1 hands out numbers a still-connected renderer has
 *     already applied, so fresh frames would be dropped as duplicates forever;
 *   - clamping at the ceiling hands out one number repeatedly, making a
 *     distinct frame indistinguishable from a redelivery of an earlier one
 *     (the bridge fixtures keep `seq` unchanged on duplicate and reorder
 *     precisely because `seq` identifies a frame);
 *   - returning an inexact number (above the safe range) breaks equality, the
 *     `JSON` round-trip identity and any map keyed by `seq`.
 *
 *   Throwing is also the only option that cannot half-succeed: the ceiling is
 *   checked before the counter advances, so a throw leaves the last issued
 *   number exactly where it was. Nothing is recoverable afterwards -- a reset
 *   would renumber frames -- and that is the intended fail-closed behaviour: an
 *   exhausted sequencer is a broken bridge, and it says so at the point of
 *   failure instead of emitting ambiguous frames. The branch is unreachable in
 *   practice (at a million frames per second the ceiling lasts about 285
 *   years), so it is a correctness assertion, not a routine path.
 *
 * Test seam
 *   The frozen surface is `nextSeq` / `currentSeq` / `resetSeq`.
 *   `setSeqForTesting` is the one addition: a module-level counter cannot be
 *   driven to the ceiling from a unit test, so the overflow branch would
 *   otherwise be untestable and could silently rot. It follows the existing
 *   test-only setter convention (`setDevelopmentBuildForTesting` in
 *   packages/ui/src/i18n/format.ts) and is never called by production code.
 */

/**
 * The last sequence number this module hands out.
 *
 * Above `Number.MAX_SAFE_INTEGER` an integer is no longer exactly
 * representable, so `seq` values would stop being comparable.
 */
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * The last number issued, or 0 before the first issue.
 *
 * Module-level on purpose: this is the single issuer, so there is exactly one
 * of these per process and every channel and sender shares it.
 */
let issued = 0;

/**
 * Issue the next sequence number.
 *
 * Starts at 1 and increases by exactly one per call. The number is committed
 * before it is returned, so two calls can never observe the same value.
 *
 * @returns the next sequence number, in `1..=Number.MAX_SAFE_INTEGER`.
 * @throws RangeError when the ceiling has been reached; the counter is left
 *   unchanged in that case.
 */
export function nextSeq(): number {
  if (issued >= MAX_SEQ) {
    throw new RangeError(
      `seq exhausted: the last issued sequence number is ${MAX_SEQ}, the largest integer a JS ` +
        "number represents exactly, so no further frame can be numbered; wrapping or clamping " +
        "would hand out numbers the renderer has already applied",
    );
  }

  issued += 1;

  return issued;
}

/**
 * The last number issued, or 0 when nothing has been issued yet.
 *
 * Diagnostic only: callers decide "old or new" by comparing, they never reserve
 * numbers by peeking.
 */
export function currentSeq(): number {
  return issued;
}

/**
 * Return the issuer to its initial state.
 *
 * Test use only: production code must never reset, because a reset renumbers
 * frames and any watermark a renderer kept would then describe a different
 * sequence.
 */
export function resetSeq(): void {
  issued = 0;
}

/**
 * Force the last issued number, so the ceiling can be reached in a test.
 *
 * Test use only. The value is validated before it is stored, so a test cannot
 * put the issuer into a state a real run could never produce (a negative
 * number, a fraction, or a number above the safe range).
 *
 * @param value the number to record as already issued, in
 *   `0..=Number.MAX_SAFE_INTEGER`.
 * @throws RangeError when `value` is not a non-negative safe integer; the
 *   recorded number is left unchanged in that case.
 */
export function setSeqForTesting(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `invalid sequencer position: ${value}; a recorded position must be a non-negative safe ` +
        `integer up to ${MAX_SEQ}`,
    );
  }

  issued = value;
}
