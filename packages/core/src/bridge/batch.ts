/**
 * batch.ts - the batching window that turns a burst of small payloads into one
 * delivery.
 *
 * Why the window is measured in milliseconds, and where 15.6 comes from
 *   The host timer is quantized. Measured on this repository's engine, a request
 *   for 0, 1, 4, 8 or 12 ms all fire at about 15.5 ms; a request for 16 or 20 ms
 *   fires at about 31.0 ms; a request for 33 ms fires at about 46.5 ms. In other
 *   words only the 15.625 ms steps are honoured -- the host rounds a request up
 *   to the next whole quantum -- and every value between two steps is really a
 *   request for the step above it. That is a measured property of the runtime,
 *   not an implementation detail of this module, so it is recorded here instead
 *   of being rediscovered the next time somebody tunes the number.
 *
 *   The default is therefore one quantum: {@link BATCH_WINDOW_DEFAULT_MS} is
 *   15.6 ms, which the host snaps up to 15.625 ms and which measures at about
 *   15.5 ms. It is deliberately a hair under the exact quantum so that a host
 *   comparing with "up to the next whole multiple" still lands on the first
 *   step instead of the second.
 *
 *   A configured window must stay inside [8, 64] ms. Below 8 ms there is no
 *   step to land on -- the host spends a full quantum regardless -- so a smaller
 *   request buys no latency and only suggests a precision that does not exist.
 *   Above 64 ms the delay before a payload leaves the process becomes
 *   user-perceptible, which defeats the point of coalescing. An out-of-range
 *   value is REFUSED with a `RangeError`; a silent clamp would let a caller
 *   configure a window it never gets and never find out.
 *
 *   The benefit of coalescing is of the same order as counting frames, which is
 *   why the knob is a duration rather than a frame count: the host coalesces by
 *   time, and a frame-count window would have to assume a frame rate this layer
 *   does not know. The implementation simply does not forbid thinking in
 *   frames; it does not require it either.
 *
 * First frame goes straight through
 *   When a burst begins -- the buffer is empty and no first frame has been sent
 *   yet -- the payload is delivered synchronously and `submit` returns `true`.
 *   Waiting one window would only make a latency the user can already perceive
 *   worse, and there is nothing to coalesce with. Every later payload of the
 *   same burst is buffered until the window expires or the batch limit is
 *   reached, whichever comes first.
 *
 *   "A burst" therefore has to outlive the first delivery: the window remembers
 *   that a first frame went out (`firstFrameSent` in the closure). Without that
 *   memory the buffer would be empty again right after the direct send, and the
 *   second payload would take the direct path too -- which is exactly the
 *   batching this module exists to provide. The burst ends when it is flushed or
 *   reset, and the next payload after that is a first frame again.
 *
 * Arming is on demand, never a poller
 *   The timer is scheduled only while the buffer holds something, and every path
 *   that empties the buffer cancels it. There is no `setInterval` keeping the
 *   process awake, so an idle bridge owns no timer at all. Cancelling also bumps
 *   a generation counter, so a scheduler that still invokes a callback after
 *   `cancelSchedule` (an injected clock can) cannot flush a buffer it no longer
 *   owns.
 *
 * Overflow flushes immediately
 *   `maxBatch` is the ceiling a burst may reach before the window expires. When
 *   the buffer reaches it, the batch is delivered at once, because holding it
 *   longer would grow memory and add latency for no coalescing gain.
 *
 * What happens when `deliver` throws
 *   A buffered flush detaches the batch -- and disarms the window -- BEFORE
 *   calling `deliver`, so a throwing delivery leaves this window with nothing
 *   buffered, nothing pending, and the error propagating to whoever caused the
 *   flush (a window callback, `flush`, or the `submit` that crossed the batch
 *   limit).
 *
 *   A direct first frame has nothing buffered to lose, so it only has to keep
 *   the burst state honest: the "a first frame went out" flag is set before
 *   `deliver` (a reentrant `submit` from inside a delivery must not become a
 *   second first frame) and rolled back if `deliver` throws (the window is idle
 *   again, so the next `submit` is still a first frame).
 *
 *   Keeping the batch for a retry instead was rejected for two reasons:
 *
 *   1. A retry would re-deliver payloads the transport may already have
 *      accepted in part. On an ordered frame stream, duplication is worse than
 *      loss, and it is the buffer doing the duplicating.
 *   2. Keeping the array populated while `deliver` runs would let a reentrant
 *      `submit` append to the batch being delivered, so the emitted order would
 *      depend on what the failing consumer did.
 *
 *   The consequence callers must handle is explicit: a failed buffered delivery
 *   loses that batch and closes the burst, and a failed direct delivery just
 *   loses that one payload. A broken transport belongs to the caller to surface
 *   and tear down, not to a buffer to hide.
 *
 * Payloads are opaque strings: nothing here parses, validates or reinterprets
 * them, exactly like the bounded queue next to it.
 */

/** Default window: one host timer quantum, see the module header. */
export const BATCH_WINDOW_DEFAULT_MS = 15.6;

/**
 * Smallest accepted window.
 *
 * There is no host timer step below this value, so a smaller request still
 * costs a full quantum.
 */
export const BATCH_WINDOW_MIN_MS = 8;

/**
 * Largest accepted window.
 *
 * Past this the added delay is user-perceptible, so a coalescing window stops
 * being a latency optimisation.
 */
export const BATCH_WINDOW_MAX_MS = 64;

/**
 * Default overflow ceiling, used when `maxBatch` is not supplied.
 *
 * The number bounds how much a burst may accumulate inside one window rather
 * than expressing a target batch size: 32 small payloads are a few kilobytes,
 * and a burst larger than that is better delivered as two batches than held
 * until the window expires.
 */
const DEFAULT_MAX_BATCH = 32;

/** A batch window handle. */
export interface BatchWindow {
  /**
   * Submit one payload for delivery.
   *
   * @param payload the opaque payload, delivered verbatim.
   * @returns `true` only when this call delivered the payload synchronously as
   *   the first frame of a new burst. `false` means the payload was
   *   buffered -- including a batch that an overflow flushed inside this call,
   *   which is not a first frame. The boolean answers "was this a first frame",
   *   not "did any byte move"; a caller that needs the overflow signal can watch
   *   `deliver` or `size()`.
   */
  submit(payload: string): boolean;

  /**
   * Flush the current buffer and close the burst.
   *
   * @returns the payloads delivered by this call, in submit order; an empty
   *   array when nothing was buffered, in which case `deliver` is not called and
   *   no timer is armed. Flushing always closes the burst, so the next `submit`
   *   takes the direct first-frame path even when this call had nothing to send
   *   -- that is what makes "flush, then submit the important payload" mean the
   *   important payload is not queued behind a window.
   */
  flush(): readonly string[];

  /**
   * Drop the buffered payloads without delivering them and cancel the window.
   *
   * The window returns to its idle state, so the next `submit` is a first
   * frame again.
   */
  reset(): void;

  /** How many payloads are currently buffered. */
  size(): number;
}

/** Construction options for {@link createBatchWindow}. */
export interface BatchWindowOptions {
  /**
   * Window length in milliseconds, inside
   * [{@link BATCH_WINDOW_MIN_MS}, {@link BATCH_WINDOW_MAX_MS}].
   *
   * Defaults to {@link BATCH_WINDOW_DEFAULT_MS}. A value out of range, or not a
   * finite number, throws a `RangeError` at construction -- never a silent
   * clamp.
   */
  windowMs?: number;

  /**
   * Buffered payload count that triggers an immediate flush.
   *
   * Defaults to 32. Must be a positive safe integer.
   */
  maxBatch?: number;

  /** Actual delivery function. Called at most once per flush, with a snapshot. */
  deliver: (payloads: readonly string[]) => void;

  /**
   * Timer injection point, for a virtual clock in tests.
   *
   * Defaults to the host `setTimeout`. A scheduler that invokes the callback
   * synchronously is tolerated: the flush then happens inside `submit`, and that
   * call still reports `false` because it did not take the first-frame path.
   */
  schedule?: (callback: () => void, ms: number) => unknown;

  /**
   * Cancellation injection point, matching `schedule`.
   *
   * Defaults to the host `clearTimeout`. The handle passed back is whatever
   * `schedule` returned; a scheduler that returns `undefined` can skip the
   * cancel entirely, because the generation check still makes its late callback
   * a no-op.
   */
  cancelSchedule?: (handle: unknown) => void;
}

/**
 * Create a batch window.
 *
 * @param options delivery function, window length and timer injection points.
 * @returns a window whose buffer starts empty and whose timer starts unarmed.
 * @throws RangeError when `windowMs` is outside
 *   [{@link BATCH_WINDOW_MIN_MS}, {@link BATCH_WINDOW_MAX_MS}] or not finite, or
 *   when `maxBatch` is not a positive safe integer. Both guards run before any
 *   state exists, so a refused construction has no side effect.
 */
export function createBatchWindow(options: BatchWindowOptions): BatchWindow {
  const windowMs = resolveWindowMs(options.windowMs);
  const maxBatch = resolveMaxBatch(options.maxBatch);
  const deliver = options.deliver;
  const schedule = options.schedule ?? hostSchedule;
  const cancelSchedule = options.cancelSchedule ?? hostCancelSchedule;

  /** Payloads waiting for the window or the batch limit. Replaced, never shared. */
  let buffer: string[] = [];

  /**
   * Whether the current burst has already emitted its first frame directly.
   *
   * This is the state that makes V-2 a once-per-burst behaviour: after a direct
   * send the buffer is empty again, so without this flag the next payload would
   * also be "the first". Cleared by every flush and by `reset`.
   */
  let firstFrameSent = false;

  /** Whether a timer is currently scheduled for `buffer`. */
  let armed = false;

  /** Handle returned by `schedule`, meaningful only while `armed`. */
  let handle: unknown = undefined;

  /**
   * Monotonic window id.
   *
   * `arm` stamps its callback with the id it was created under and `disarm`
   * bumps the counter, so a callback a scheduler invokes after cancellation can
   * tell that its window is stale and must not flush. This matters because
   * `cancelSchedule` is an injection point: a fake clock, or a host timer
   * already queued, may still call back once the window is gone.
   */
  let generation = 0;

  return {
    submit(payload: string): boolean {
      if (buffer.length === 0 && !firstFrameSent) {
        // Nothing to coalesce with, so waiting a window would add latency
        // for no gain. The burst is marked started BEFORE the transport is
        // touched, so a reentrant `submit` from inside `deliver` buffers
        // instead of becoming a second "first" frame; the `catch` below undoes
        // that mark when the transport refuses the payload outright.
        firstFrameSent = true;

        try {
          deliver([payload]);
        } catch (error) {
          // Nothing reached the transport, so the window is idle again and the
          // next submit is a first frame. Resetting the flag only after a throw
          // keeps the reentrancy guard above intact for the successful case.
          firstFrameSent = false;

          throw error;
        }

        return true;
      }

      buffer.push(payload);

      if (buffer.length >= maxBatch) {
        // The ceiling already bounds batching, so waiting the window out would
        // only grow the buffer.
        flushBuffer();

        return false;
      }

      if (!armed) {
        arm();
      }

      return false;
    },

    flush(): readonly string[] {
      return flushBuffer();
    },

    reset(): void {
      // Cancel before dropping: an armed timer must never outlive the payloads
      // it was armed for.
      disarm();
      buffer = [];
      firstFrameSent = false;
    },

    size(): number {
      return buffer.length;
    },
  };

  /**
   * Cancel the pending window, if any.
   *
   * Bumps the generation first, so a callback already handed to the host cannot
   * flush a buffer this call is about to drop or replace.
   */
  function disarm(): void {
    if (!armed) {
      return;
    }

    const scheduled = handle;

    armed = false;
    handle = undefined;
    generation += 1;

    // An injected scheduler may have returned nothing; the generation bump
    // above is what neutralises its late callback in that case.
    if (scheduled !== undefined) {
      cancelSchedule(scheduled);
    }
  }

  /**
   * Detach and deliver the buffer.
   *
   * Detaching before delivering is what makes a throwing `deliver` leave an
   * empty, unarmed window, and what keeps a reentrant `submit` from appending to
   * the array that is being delivered.
   */
  function flushBuffer(): readonly string[] {
    const batch = buffer;

    // Disarm and cheap before the empty check on purpose: every flush closes the
    // burst, so the next payload after a flush is always a first frame. That
    // gives `flush` one meaning ("finish this burst") instead of a meaning that
    // depends on whether the buffer happened to hold anything.
    disarm();
    buffer = [];
    firstFrameSent = false;

    if (batch.length === 0) {
      // Empty flush: nothing is delivered. No timer is armed by it, and none had
      // to be cancelled, so the call is a clear no-op for an idle window.
      return [];
    }

    deliver(batch);

    return batch;
  }

  /** Schedule the window for a non-empty buffer. */
  function arm(): void {
    const ticket = generation + 1;

    armed = true;
    generation = ticket;

    const scheduled = schedule(() => {
      if (!armed || ticket !== generation) {
        // The window closed (flush or reset) after this callback was queued.
        return;
      }

      expire();
    }, windowMs);

    if (armed && ticket === generation) {
      handle = scheduled;
    }

    // Otherwise the injected scheduler ran the callback inline: that window has
    // already delivered and closed itself, so the handle is dead on arrival and
    // there is nothing left to cancel.
  }

  /** Deliver because the window expired. */
  function expire(): void {
    // The timer just fired, so there is nothing to cancel; only the flag and the
    // handle have to be dropped. The generation is left alone: the next arm
    // allocates a fresh ticket anyway.
    armed = false;
    handle = undefined;

    flushBuffer();
  }
}

/**
 * Validate and default the window length.
 *
 * @param windowMs the caller's value, or `undefined` for the default.
 * @returns the effective window in milliseconds.
 * @throws RangeError when the value is not a finite number inside the accepted
 *   range.
 */
function resolveWindowMs(windowMs: number | undefined): number {
  if (windowMs === undefined) {
    return BATCH_WINDOW_DEFAULT_MS;
  }

  // `NaN` and both infinities are "numbers" to TypeScript but cannot describe a
  // delay; they fail here rather than being compared against the bounds, where
  // `NaN` would silently pass every `<`/`>` test.
  if (!Number.isFinite(windowMs)) {
    throw new RangeError(
      `invalid batch window: ${String(windowMs)}; the window must be a finite number of ` +
        `milliseconds inside [${String(BATCH_WINDOW_MIN_MS)}, ${String(BATCH_WINDOW_MAX_MS)}]`,
    );
  }

  if (windowMs < BATCH_WINDOW_MIN_MS || windowMs > BATCH_WINDOW_MAX_MS) {
    throw new RangeError(
      `invalid batch window: ${String(windowMs)} ms is outside ` +
        `[${String(BATCH_WINDOW_MIN_MS)}, ${String(BATCH_WINDOW_MAX_MS)}] ms; the value is ` +
        "refused rather than clamped, because a clamped window is a setting the caller never " +
        "gets and never hears about",
    );
  }

  return windowMs;
}

/**
 * Validate and default the overflow ceiling.
 *
 * @param maxBatch the caller's value, or `undefined` for the default.
 * @returns the effective ceiling, at least 1.
 * @throws RangeError when the value is not a positive safe integer. Zero and
 *   negative counts cannot describe a batch, and a fractional one is a caller
 *   mistake rather than a request to round.
 */
function resolveMaxBatch(maxBatch: number | undefined): number {
  if (maxBatch === undefined) {
    return DEFAULT_MAX_BATCH;
  }

  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1) {
    throw new RangeError(
      `invalid batch limit: ${String(maxBatch)}; the limit must be a positive safe integer, ` +
        "because it is the payload count at which the buffer is flushed",
    );
  }

  return maxBatch;
}

/**
 * Default scheduler: the host timer.
 *
 * The host rounds the request up to the next 15.625 ms step, which the module
 * header documents; this wrapper exists only to give the injection point a
 * default with a concrete return type.
 *
 * @param callback the flush callback.
 * @param ms the requested window.
 * @returns the host timer handle.
 */
function hostSchedule(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(callback, ms);
}

/**
 * Default canceller: the host timer.
 *
 * @param handle a handle previously returned by {@link hostSchedule}.
 */
function hostCancelSchedule(handle: unknown): void {
  // No `any`: the injected scheduler's handle is `unknown` by contract, and the
  // host canceller accepts anything `setTimeout` may have produced.
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
