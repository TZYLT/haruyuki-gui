/**
 * queue.ts - the three-channel bounded outbound queue.
 *
 * Shape source: the three physical channels of the frame envelope
 * (packages/protocol/src/frame/frame.ts): `control` carries ordered
 * acknowledged request/response traffic, `stream` carries byte progress where
 * dropping a frame is a correctness bug, and `bulk` carries paged snapshot
 * content. They are separate streams, so they get separate backlog budgets.
 *
 * Why overflow throws instead of blocking or dropping
 *   This is a measured ruling, not a preference. A queue whose producer blocks
 *   on a full buffer transfers backpressure into the process that owns the
 *   socket write, and the measurement on this repository's engine showed the
 *   engine stalling: the whole desktop shell freezes behind one slow channel.
 *   Silent dropping is no better, because the three channels are not
 *   interchangeable -- a dropped `control` frame loses a correlated response,
 *   and a dropped `stream` frame corrupts byte progress. So `push` refuses the
 *   payload with `BRIDGE_QUEUE_OVERFLOW`, leaves the channel's contents exactly
 *   as they were, and lets the caller decide how to degrade. Nothing is
 *   half-applied: the limit is checked before the payload is stored.
 *
 *   The consequence callers must handle is explicit: the frame that was
 *   refused was never queued and will never be queued by this module. It is not
 *   a retryable backpressure signal; it is a failure the caller has to surface
 *   (a session teardown, a degraded-mode notice) rather than loop on.
 *
 * Why the three channels are independent
 *   A `stream` failure must not be able to take `control` down with it. If the
 *   channels shared one buffer, a stalled terminal producer filling the stream
 *   budget would make `bridge.reject` for a *different* connection fail to
 *   queue, turning a local backlog into a handshake failure. Per-channel
 *   budgets also make the queue's behaviour explainable: `size("control")` is
 *   the control backlog, full stop.
 *
 * Default limits and where the numbers come from
 *   The three channels differ by frame size and by emission rate, so one shared
 *   number would be either far too small for one of them or a memory hazard for
 *   another. `DEFAULT_LIMITS` therefore holds one value per channel:
 *
 *   - `control` (2048): high frequency, smallest frames -- the handshake, the
 *     acknowledgements of in-flight requests, request/response echoes -- each a
 *     few hundred bytes. A deep backlog is cheap (well under a megabyte) and is
 *     what keeps acknowledgements flowing while another channel is congested.
 *   - `stream` (256): medium frequency, fixed 8 KB slices. 256 slices bound the
 *     backlog at roughly 2 MB, which is about the point where the renderer
 *     would rather see a truncation notice than consume ever-lagging progress.
 *   - `bulk` (64): low frequency, largest frames -- a snapshot page is orders of
 *     magnitude bigger than the other two, so the count is small on purpose.
 *     64 pages bound the backlog at a few megabytes while still absorbing a
 *     burst of pages that the renderer drains in one go.
 *
 *   These are defaults, not constants of nature: `createBoundedQueue` takes a
 *   partial override, so a shell with a different memory budget or a test that
 *   needs to reach the limit in three pushes can change any channel without
 *   touching the others. A limit of 0 is legal and means "this channel may
 *   never accumulate anything": `push` throws immediately and the queue stays
 *   empty. That is the honest way to say "this transport must not buffer this
 *   channel at all" -- the alternative, treating 0 as "unbounded" or silently
 *   substituting a default, would turn a deliberate refusal into a free-for-all.
 *
 * Nothing here serialises, validates or interprets a frame: payloads are opaque
 * strings, exactly as they will be handed to the transport. Validation belongs
 * to the bridge validator and parsing to the frame layer.
 */

import type { FrameChannel } from "@haruyuki/protocol";

/**
 * The single overflow marker.
 *
 * A producer that overflows gets an error carrying this value in its `code`
 * field, so a caller can branch on the marker without matching a message, and
 * the constant stays a plain string literal so it survives serialisation and
 * logging across process boundaries.
 */
export const BRIDGE_QUEUE_OVERFLOW = "BRIDGE_QUEUE_OVERFLOW" as const;

/**
 * The channels in a fixed order.
 *
 * Enumerated once so `DEFAULT_LIMITS`, the per-channel buffers and the
 * validity check cannot drift apart: adding a channel to `FrameChannel` makes
 * `DEFAULT_LIMITS` fail to typecheck (`satisfies` below) instead of silently
 * leaving that channel with no budget.
 */
const CHANNELS = ["control", "stream", "bulk"] as const satisfies readonly FrameChannel[];

/**
 * Per-channel backlog limits used when `createBoundedQueue` is given none.
 *
 * Frozen so a caller cannot mutate the shared defaults by accident and thereby
 * change the behaviour of a queue created somewhere else. See the module header
 * for why each number has the value it has.
 */
export const DEFAULT_LIMITS: Readonly<Record<FrameChannel, number>> = Object.freeze({
  control: 2048,
  stream: 256,
  bulk: 64,
} satisfies Record<FrameChannel, number>);

/**
 * The error `push` throws when a channel is at its limit.
 *
 * `code` is the exported marker; `channel`, `limit` and `queued` are diagnostic
 * and let a caller describe which channel gave up without inspecting a string.
 * The payload is not included: a frame payload can hold terminal bytes or
 * snapshot content, which must not end up in a log line by default.
 */
export class BridgeQueueOverflowError extends Error {
  /** Branch on this rather than on `message`. */
  readonly code: typeof BRIDGE_QUEUE_OVERFLOW = BRIDGE_QUEUE_OVERFLOW;

  /** The channel whose backlog is full. */
  readonly channel: FrameChannel;

  /** That channel's configured limit. */
  readonly limit: number;

  /** How many payloads the channel held when the push was refused. */
  readonly queued: number;

  /**
   * @param channel the full channel
   * @param limit that channel's configured limit
   * @param queued the channel's size at the moment of refusal
   */
  constructor(channel: FrameChannel, limit: number, queued: number) {
    super(
      `BRIDGE_QUEUE_OVERFLOW: the ${channel} backlog is at its limit of ${limit} payload(s) ` +
        `(${queued} queued); the new payload was refused and the backlog is unchanged. ` +
        "Blocking the producer would stall the engine and dropping silently would corrupt the " +
        "channel, so the caller must degrade or tear the session down instead",
    );
    this.name = "BridgeQueueOverflowError";
    this.channel = channel;
    this.limit = limit;
    this.queued = queued;
  }
}

/**
 * A queue with one bounded FIFO backlog per channel.
 *
 * Implementations are expected to keep `size` accurate at all times (it is what
 * `push` consults, so an inaccurate one is a correctness bug, not a reporting
 * bug).
 */
export interface BoundedQueue {
  /**
   * Append one payload to a channel.
   *
   * @throws BridgeQueueOverflowError when the channel already holds `limit`
   *   payloads; the channel's contents are untouched in that case.
   */
  push(channel: FrameChannel, payload: string): void;

  /**
   * Remove and return every payload of one channel, in push order.
   *
   * The returned array is a snapshot the caller owns; the channel is empty
   * afterwards. An empty or unknown-activity channel yields an empty array.
   */
  drain(channel: FrameChannel): readonly string[];

  /** How many payloads one channel currently holds. */
  size(channel: FrameChannel): number;

  /** How many payloads all channels hold together. */
  total(): number;

  /** Drop every payload on every channel; the limits and their configuration stay. */
  clear(): void;
}

/**
 * Create a queue with one bounded backlog per channel.
 *
 * @param limits per-channel overrides; a channel not named here uses its
 *   `DEFAULT_LIMITS` value. A value must be a non-negative safe integer, and 0
 *   means "no backlog is allowed on this channel" (the first push throws).
 * @throws RangeError when an override is not a non-negative safe integer; a
 *   negative, fractional, `NaN` or infinite limit has no meaning for a count,
 *   and guessing one would hide the caller's mistake behind a working queue.
 */
export function createBoundedQueue(limits?: Partial<Record<FrameChannel, number>>): BoundedQueue {
  const effectiveLimits = resolveLimits(limits);

  /**
   * The live backlogs.
   *
   * A `Map` rather than an object literal because a channel key is looked up
   * with a value that, at runtime, may be anything at all: `Map.get` returns
   * `undefined` for an unknown channel, which is what makes the guard below
   * honest instead of a comparison the compiler already knows is impossible.
   */
  const buffers = new Map<FrameChannel, string[]>(
    CHANNELS.map((channel) => [channel, [] as string[]] as const),
  );

  /** Running total, so `total()` stays O(1) and cannot disagree with `size`. */
  let queued = 0;

  return {
    push(channel: FrameChannel, payload: string): void {
      const buffer = bufferOf(channel);
      const limit = effectiveLimits[channel];

      if (buffer.length >= limit) {
        // Checked before the payload is stored: a refused push must not leave a
        // partially advanced queue behind.
        throw new BridgeQueueOverflowError(channel, limit, buffer.length);
      }

      buffer.push(payload);
      queued += 1;
    },

    drain(channel: FrameChannel): readonly string[] {
      const taken = bufferOf(channel);

      // Swap the buffer rather than emptying it: the returned array is the
      // caller's, and no later push can reach it.
      buffers.set(channel, []);
      queued -= taken.length;

      return taken;
    },

    size(channel: FrameChannel): number {
      return bufferOf(channel).length;
    },

    total(): number {
      return queued;
    },

    clear(): void {
      for (const channel of CHANNELS) {
        buffers.set(channel, []);
      }

      queued = 0;
    },
  };

  /**
   * The live buffer for one channel.
   *
   * A `FrameChannel` is exhaustive at compile time, but a JavaScript caller or
   * a cast can hand over anything, and an unknown channel must not be silently
   * treated as one of the three: it would create a fourth, unbudgeted backlog
   * that `total()` and `clear()` never see.
   *
   * @param channel the channel to look up
   * @returns that channel's buffer
   * @throws RangeError for a channel outside the three.
   */
  function bufferOf(channel: FrameChannel): string[] {
    const buffer = buffers.get(channel);

    if (buffer === undefined) {
      throw new RangeError(
        `unknown frame channel: ${String(channel)}; expected one of ${CHANNELS.join(", ")}`,
      );
    }

    return buffer;
  }
}

/**
 * Merge the caller's overrides over `DEFAULT_LIMITS`.
 *
 * @param limits optional per-channel overrides
 * @returns one limit per channel, validated
 * @throws RangeError for an override that is not a non-negative safe integer
 */
function resolveLimits(
  limits: Partial<Record<FrameChannel, number>> | undefined,
): Record<FrameChannel, number> {
  if (limits === undefined) {
    return { ...DEFAULT_LIMITS };
  }

  const resolved: Record<FrameChannel, number> = { ...DEFAULT_LIMITS };

  for (const channel of CHANNELS) {
    const override = limits[channel];

    if (override === undefined) {
      continue;
    }

    if (!Number.isSafeInteger(override) || override < 0) {
      throw new RangeError(
        `invalid limit for the ${channel} channel: ${String(override)}; a backlog limit must be ` +
          "a non-negative safe integer, and 0 means this channel may never accumulate payloads",
      );
    }

    resolved[channel] = override;
  }

  return resolved;
}
