/**
 * Turns a stream of sequenced frames into a stream that can be delivered in
 * sequence order without waiting forever for a frame that will never arrive.
 *
 * The engine numbers its events, but the transport does not promise that they
 * arrive in that order, and it does not promise that every number arrives at
 * all. The gate answers both problems with one piece of state: the
 * **watermark**, the highest sequence number actually delivered so far. Every
 * frame is compared against it, and nothing is ever delivered out of order,
 * because the content model downstream appends text and an inserted frame would
 * land in the wrong place.
 *
 * Four behaviours follow from that single comparison, and each one exists
 * because the alternative loses frames or hangs:
 *
 * 1. **In order** (`seq === watermark + 1`): deliver, then deliver whatever the
 *    buffer was already holding contiguously. One late arrival can therefore
 *    release several frames at once, which is why `deliver` is a list rather
 *    than a single frame.
 * 2. **Ahead of order** (`seq > watermark + 1`): hold it. Holding is bounded,
 *    because an unbounded buffer is a memory leak driven by the engine. When the
 *    buffer exceeds its capacity, the missing range is declared a gap and the
 *    watermark jumps to just below the oldest held frame: waiting longer would
 *    stall the whole stream behind frames that are not coming.
 * 3. **Behind the watermark** (`seq <= watermark`): the frame is either a
 *    repeat or genuinely late. A repeat is reported as `duplicate`. A frame
 *    numbered below the watermark that was never delivered is reported as
 *    `late` and dropped -- the text it belongs to has already been appended, so
 *    inserting it now would put it after content that came later.
 * 4. **A run of late frames** is the one case where the sequence space itself
 *    may have moved: a reconnect can restart numbering under a new connection.
 *    A single late frame is noise; many in a row while nothing is deliverable
 *    means the watermark is ahead of a stream that can never catch up, so after
 *    `rebaselineThreshold` of them the watermark is pulled back to just below
 *    the current frame and that frame is delivered. The reset is reported as
 *    `rebaselined` so the diagnostics can show that the stream was healed
 *    rather than merely quiet.
 *
 * There is no timer here on purpose. Waiting for a frame is decided by how many
 * frames are buffered, not by how long the stream has been quiet: a clock would
 * make the merger's output depend on how fast the machine is, and a reproducible
 * test would become impossible.
 *
 * Everything is synchronous and non-throwing; the caller is the merge loop and
 * it must never fail on a frame.
 */

import { REBASELINE_THRESHOLD, REORDER_CAPACITY } from "./types.js";
import { createDedupe } from "./dedupe.js";

/** One value together with the sequence number the engine gave it. */
export type Sequenced<T> = { readonly seq: number; readonly value: T };

/** An inclusive run of sequence numbers that will never be delivered. */
export type GapRange = { readonly from: number; readonly to: number };

/** What one `accept` call did, as facts about that call only. */
export type OrderOutcome<T> = {
  /** Frames to deliver now, in ascending `seq` order; empty when nothing was released. */
  readonly deliver: readonly Sequenced<T>[];
  /** The frame had already been handled (delivered, or dropped as late). */
  readonly duplicate: boolean;
  /** The frame arrived below the watermark without ever having been handled, and was dropped. */
  readonly late: boolean;
  /** The watermark was pulled back to this frame's numbering and the frame was delivered. */
  readonly rebaselined: boolean;
  /** Missing ranges declared during this call, oldest first. */
  readonly gaps: readonly GapRange[];
};

/** The ordering state machine. Synchronous; no method throws. */
export type OrderGate<T> = {
  /** Offer one frame; returns everything that became deliverable because of it. */
  accept(seq: number, value: T): OrderOutcome<T>;
  /** Highest sequence number delivered in order, or `null` before the first delivery. */
  watermark(): number | null;
  /** How many frames are currently held waiting for the hole ahead of them. */
  buffered(): number;
  /** Forget everything, for a connection boundary that restarts numbering. */
  reset(): void;
};

/** An empty outcome, distinct per call so a caller may safely keep it. */
function nothing<T>(): OrderOutcome<T> {
  return { deliver: [], duplicate: false, late: false, rebaselined: false, gaps: [] };
}

/**
 * Build an ordering gate.
 *
 * @param options `capacity` bounds the reorder buffer in frames;
 *   `rebaselineThreshold` is the run of late frames that triggers the fallback
 */
export function createOrderGate<T>(
  options: { capacity?: number; rebaselineThreshold?: number } = {},
): OrderGate<T> {
  // Both bounds are counts of frames, so a nonsense value is corrected here
  // instead of being carried into a comparison that would then never fire.
  const requestedCapacity = options.capacity;
  const capacity =
    requestedCapacity !== undefined &&
    Number.isSafeInteger(requestedCapacity) &&
    requestedCapacity > 0
      ? requestedCapacity
      : REORDER_CAPACITY;

  const requestedThreshold = options.rebaselineThreshold;
  const rebaselineThreshold =
    requestedThreshold !== undefined &&
    Number.isSafeInteger(requestedThreshold) &&
    requestedThreshold > 0
      ? requestedThreshold
      : REBASELINE_THRESHOLD;

  /**
   * Delivered-but-not-yet-released frames by sequence number.
   *
   * The payload is wrapped in an object so that `get` can distinguish "absent"
   * from "a value that happens to be `undefined`": a frame's value is whatever
   * the caller handed over, and `undefined` is a legal one.
   */
  const buffer = new Map<number, { readonly value: T }>();

  /** Sequence numbers already accounted for; bounded, because the stream is endless. */
  const handled = createDedupe();

  /** Highest sequence number delivered in order, or `null` before the first delivery. */
  let mark: number | null = null;

  /** How many late frames have arrived in a row without anything being deliverable. */
  let lateRun = 0;

  /**
   * Whether the next sequenced frame starts a new numbering.
   *
   * A connection boundary can continue the stream's numbers or restart them,
   * and the merger cannot tell which from the value alone. Treating the first
   * frame after a reset as the new base is the only reading that works for both:
   * a continuation is accepted at its own number instead of stalling behind
   * numbers that will never be sent, and a restart begins at one, which is then
   * the same base. Without this, a reconnected stream that continues at 47 would
   * wait for 1..46 forever.
   */
  let awaitingBase = false;

  /**
   * Release everything the buffer holds contiguously from the watermark on.
   *
   * Stops at the first hole: the frames behind it are still ahead of order and
   * releasing them would put them in the wrong place.
   *
   * @param out collects the released frames, in ascending order
   */
  const drain = (out: Sequenced<T>[]): void => {
    for (;;) {
      const expected = (mark ?? 0) + 1;
      const held = buffer.get(expected);

      if (held === undefined) {
        return;
      }

      buffer.delete(expected);
      mark = expected;
      handled.add(String(expected));
      out.push({ seq: expected, value: held.value });
    }
  };

  return {
    accept(seq, value) {
      // A non-integer number cannot be placed by ordering at all. The envelope
      // reader refuses those before they get here, so this only protects the
      // call: silently buffering `NaN` would leave a frame nobody can release.
      if (!Number.isSafeInteger(seq) || seq < 0) {
        return nothing<T>();
      }

      let rebaselined = false;

      if (awaitingBase) {
        awaitingBase = false;
        // The frame becomes the base: everything below it belongs to the
        // generation that just ended.
        mark = seq - 1;
      }

      if (mark !== null && seq <= mark) {
        if (handled.seen(String(seq))) {
          return { deliver: [], duplicate: true, late: false, rebaselined: false, gaps: [] };
        }

        lateRun += 1;

        if (lateRun < rebaselineThreshold) {
          // Remember it even though it is dropped: a resend of the same stale
          // frame is a repeat, not another late arrival, so it must not push the
          // run toward a rebaseline on its own.
          handled.add(String(seq));

          return { deliver: [], duplicate: false, late: true, rebaselined: false, gaps: [] };
        }

        // The stream is numbering afresh: pull the watermark back so this frame
        // and everything after it can be delivered, and drop whatever the old
        // numbering left in the buffer.
        buffer.clear();
        mark = seq - 1;
        lateRun = 0;
        rebaselined = true;
      }

      const expected = (mark ?? 0) + 1;
      const out: Sequenced<T>[] = [];

      if (seq === expected) {
        mark = seq;
        handled.add(String(seq));
        out.push({ seq, value });
        drain(out);
        lateRun = 0;

        return { deliver: out, duplicate: false, late: false, rebaselined, gaps: [] };
      }

      // Ahead of order. The frame itself can also be a repeat, which the buffer
      // answers without ever reaching the watermark comparison.
      if (buffer.has(seq)) {
        return { deliver: [], duplicate: true, late: false, rebaselined: false, gaps: [] };
      }

      buffer.set(seq, { value });
      lateRun = 0;

      const gaps: GapRange[] = [];

      if (buffer.size > capacity) {
        // Give up on the hole rather than keep the stream waiting for it: the
        // watermark jumps to just below the oldest held frame, which is the
        // furthest point the buffer can prove was reached, and the held frames
        // are then released in order. The oldest held number is necessarily
        // ahead of the expectation: anything at or below it was delivered or
        // dropped before this frame could be buffered.
        const oldest = Math.min(...buffer.keys());

        gaps.push({ from: expected, to: oldest - 1 });
        mark = oldest - 1;
        drain(out);
      }

      return { deliver: out, duplicate: false, late: false, rebaselined: false, gaps };
    },

    watermark() {
      return mark;
    },

    buffered() {
      return buffer.size;
    },

    reset() {
      buffer.clear();
      mark = null;
      handled.clear();
      lateRun = 0;
      awaitingBase = true;
    },
  };
}
