/**
 * sender.ts - the producer-side assembly of the frame layer.
 *
 * Contract source: the frozen `FrameSenderOptions` and `FrameSender` shapes,
 * and the four error codes this module raises.
 * Every part this module talks to was written before it: `./validate` decides
 * transportability, `./sequencer` issues the one global counter, `./queue`
 * bounds each channel's backlog, `./page` splits a snapshot, `./batch` owns the
 * coalescing window. This file is therefore only the wiring, and its whole job
 * is to state the ORDER and the POLICY of that wiring. Anything that belongs to
 * a part stays inside that part: no frame is re-validated here, no page
 * boundary is recomputed here, and no backlog arithmetic is invented here.
 *
 * The order `send` applies its four rejections in, and why
 *   A frame can be refused by four different owners. The order below is chosen
 *   so that the most local, most actionable finding wins, and so that no check
 *   depends on state another check would have to change first:
 *
 *   1. `FRAME_NOT_SERIALIZABLE` (from `./validate`). It is the only check that
 *      can name a field path, and it answers the prior question "can this value
 *      become bytes at all?". A later check that reported, say, an unregistered
 *      `t` for a body holding a `Date` would be true but useless: the producer
 *      still has to fix the body first. Validating the whole envelope, not just
 *      `body`, also catches a non-JSON value smuggled into a cursor field.
 *   2. `UNREGISTERED_FRAME_TYPE`. This core is not allowed to emit a frame type
 *      it has no row for (`FRAME_TYPES` is append-only and statically checked),
 *      which is a contract/wiring bug independent of size or of runtime state.
 *   3. `BULK_OVER_LIMIT`. The frame is legal and registered, but this particular
 *      snapshot cannot be delivered at all: one item does not fit a page even on
 *      its own, and the pager answers such an item with an empty page instead of
 *      guessing (see `./page`). Still a producer error, still decided without
 *      looking at the runtime.
 *   4. `BRIDGE_QUEUE_OVERFLOW` (from `./queue`). The only rejection that depends
 *      on runtime backlog. It comes last on purpose: a program bug must be
 *      reported as itself instead of being masked by a transiently full queue,
 *      and a full queue is a condition the caller can actually do something
 *      about (drain, raise the limit, tear the session down).
 *
 *   The practical consequence, which the tests pin down: a frame that is both
 *   invalid and oversized is reported as invalid, and a frame that is both
 *   oversized and sent while a channel is full is reported as oversized.
 *
 *   One check sits between (2) and (3) and carries no code of its own: an
 *   unknown `ch` is a `RangeError`. `FrameChannel` is exhaustive at compile time
 *   but `Frame["ch"]` arrives from JavaScript callers and injected hosts too,
 *   and a channel outside the three has no backlog limit -- accepting it would
 *   bypass the hard cap this layer exists to enforce. It is placed after the
 *   type check because an unregistered `t` is the more likely mistake, and it
 *   cannot invent a fifth code: the four are the frozen vocabulary.
 *
 * Sequence numbers are assigned last, and a refused frame consumes none
 *   `seq` could be issued at the top of `send` and then thrown away on a
 *   rejection. The alternative chosen here is: every rejection that can happen
 *   is decided BEFORE `nextSeq()` is called, so a number exists only for a frame
 *   that is actually going to be staged.
 *
 *   Both designs are defensible, so the reason matters. A wasted number is
 *   harmless on its own -- `seq` is monotone, not dense, and the renderer
 *   compares numbers rather than counting them -- but "no gaps" is a stronger
 *   and cheaper property to keep: it makes `seq` an exact count of the frames
 *   this process has emitted (a diagnostic a human reads, and a fixture a test
 *   can assert), and it keeps a buggy producer from perturbing the ONE counter
 *   every other sender and channel in the process draws from. Validation is
 *   measured at well under a microsecond, so paying for it
 *   before numbering costs nothing.
 *
 *   The one place a number can still be spent without a delivery is the batch
 *   window: a coalescible frame is serialized (and therefore numbered) at
 *   submit time, because the window's contract is over payload strings, and
 *   `close()` drops what the window still holds. That is bounded by the burst
 *   in flight at teardown, and it is called out rather than hidden.
 *
 * One holding pen per channel: the bounded queue
 *   Every payload travels queue -> transport. `send` stages a whole unit (one
 *   immediate frame, one page of a snapshot, or one batch window's worth of
 *   coalesced payloads) and then pumps the channel. Staging first is what makes
 *   `BRIDGE_QUEUE_OVERFLOW` an atomic answer: a unit that does not fit is
 *   refused before any of it is stored and before any of it is numbered, so a
 *   refused snapshot never leaves half a snapshot in the backlog. The queue
 *   module's own "nothing is half-applied" guarantee is preserved rather than
 *   worked around.
 *
 *   The capacity check reads `DEFAULT_LIMITS` and the caller's overrides
 *   directly because the queue offers no "would this fit?" probe, and probing by
 *   pushing then rolling back would either consume numbers or briefly expose
 *   partial state. The queue remains the authority: it is constructed first (so
 *   an invalid override throws there, at construction), and `push` would refuse
 *   the same unit again. The duplication is arithmetic, not policy.
 *
 *   Pumping drains one payload at a time: the channel is drained, the tail is
 *   put straight back, and only then is the head handed to the transport. That
 *   ordering is what makes a failing transport leave an honest backlog --
 *   "payloads no transport has ever been offered" -- instead of losing pages
 *   that were already accepted. The payload that failed is NOT put back: the
 *   transport may have taken it, and on an ordered stream a duplicate is worse
 *   than a loss (the same rule `./batch` states for a failed delivery).
 *
 * The three channels do not share a policy
 *   - `control`: ordered, small, never coalesced, delivered synchronously inside
 *     `send`. Request/response correlation dies if an answer waits for a window.
 *   - `stream`: delivered synchronously inside `send` as well. `term.output`
 *     carries terminal bytes, and a dropped or delayed frame there is a
 *     correctness bug, not a latency trade-off. `flush()` is
 *     the port that forces the channel out, including anything an interrupted
 *     pump left behind.
 *   - `bulk`: never delivered as given. The body is split by `createPager` into
 *     pages of at most the default 1 MB budget, and every page becomes its own
 *     frame with its own number and its own cursor.
 *
 * Why the batching window is wired at all while it almost never fires
 *   Coalescing is a property of a frame type row, not of a channel: only a
 *   `coalescible: "by-channel"` row may be collapsed, because collapsing is only
 *   sound where the newest frame of a channel supersedes the ones before it and
 *   individual occurrences are not observable. All five rows in `FRAME_TYPES`
 *   are `"never"`, so today no frame is ever buffered, the window owns no timer,
 *   and `flush()` has nothing to flush beyond an interrupted pump.
 *
 *   It is wired anyway, for two reasons. The decision must live where the table
 *   is read, otherwise the first `"by-channel"` row (C1's high-frequency status
 *   traffic is the expected one) would silently take the immediate path and the
 *   only symptom would be a latency regression nobody attributes to this file.
 *   And the window is not a second queue: it is the one place where a payload is
 *   allowed to WAIT, so the hard limit has to count waiting payloads too --
 *   `submit` therefore checks capacity against `queue.size + window.size + 1`,
 *   which is what the channel will have to carry the moment the window expires.
 *
 * What happens when the transport throws
 *   The error propagates to whoever caused the delivery: `send`, `flush`, a
 *   window callback (where there is no caller, so it surfaces as an uncaught
 *   error -- swallowing it would hide a broken transport, which is worse). The
 *   payload that failed is dropped rather than retried (see the pump above), the
 *   rest of the unit stays queued, and `stats.sent` does not count the failure.
 *
 * `close()` and `send()` after it
 *   `close()` marks the sender closed first, so nothing can reopen it, and then
 *   flushes what was already accepted: a caller closes after it has finished
 *   producing, and the frames it already handed over were accepted. A transport
 *   failure during that final flush propagates from `close` (the sender is
 *   already closed, so the caller cannot mistake it for "try again"), and a
 *   later `flush()` can still pump what is left.
 *
 *   After `close`, `send` throws. It is a lifecycle error and deliberately
 *   carries NO code: the four codes are the frozen vocabulary for frame
 *   rejections, and inventing a fifth one would widen a contract this work
 *   package is not allowed to change. Dropping the frame silently was rejected
 *   for the same reason `send` throws on everything else: `send` never fails
 *   quietly.
 *
 * `stats` vocabulary
 *   `sent` counts PAYLOADS the transport accepted, not frames: one `bulk` frame
 *   may become several pages, and the number a diagnostic wants is "how many
 *   strings crossed the transport boundary". A delivery whose `transport` call
 *   throws is not counted -- that is the one case where this module cannot know
 *   whether the bytes crossed. `queued` is the live per-channel
 *   backlog (non-zero only between an interrupted pump and the next `flush`).
 *   `overflows` counts `BRIDGE_QUEUE_OVERFLOW` refusals, so a caller can tell a
 *   one-off mistake from a channel that is persistently behind.
 *
 * Bulk pages, cursors and tokens
 *   A page's `body` repeats the snapshot-level fields and carries the slice:
 *   `{ ...rest, page: <1-based>, items: [...] }`, which is exactly the shape the
 *   recorded corpus in `fixtures/bridge/` publishes. `page.watermark` identifies
 *   the snapshot: the caller's value is kept when it supplied one, otherwise the
 *   watermark is the `seq` of the snapshot's FIRST page, which makes a newer
 *   snapshot compare strictly greater than an older one for the renderer's
 *   stale-watermark rule.
 *
 *   `page.token` must differ per page, and that follows from the receiver rather
 *   than from taste. `packages/ui/src/bridge/entry.ts` deduplicates a page on the
 *   key `` `${watermark}:${token}` `` (rule C5-R07), and its comment on the
 *   watermark rule says the same thing from the other side: pages of one
 *   snapshot share a watermark and "are told apart by their token". Reusing one
 *   token across a snapshot would therefore make the renderer drop every page
 *   after the first as a duplicate of the first, and the snapshot would arrive
 *   one page long. So a multi-page snapshot mints `<base>#<n>` from the caller's
 *   token (or from the watermark when the caller supplied none).
 *
 *   A single-page snapshot keeps the caller's token unchanged: with one page
 *   there is nothing to tell apart, and rewriting a name a caller chose would be
 *   gratuitous. The alternative -- keep one token and bump the watermark per
 *   page -- was rejected: it breaks "all pages of one snapshot share a
 *   watermark", which is what the renderer's stale-watermark comparison
 *   depends on.
 *
 *   An empty snapshot is one page with no items and `more: false`, not silence:
 *   silence is indistinguishable from a stuck sender. A body that holds no page
 *   array at all (a scalar, or an object without `items`) is delivered whole as
 *   a single page with `more: false`; the pager is only asked to split what it
 *   was given as a list.
 */

import type { Frame, FrameChannel } from "@haruyuki/protocol";
import { FRAME_TYPES } from "@haruyuki/protocol";

import { BATCH_WINDOW_DEFAULT_MS, createBatchWindow } from "./batch";
import type { BatchWindow } from "./batch";
import { BULK_OVER_LIMIT, DEFAULT_PAGE_BUDGET_BYTES, createPager } from "./page";
import { BridgeQueueOverflowError, DEFAULT_LIMITS, createBoundedQueue } from "./queue";
import { nextSeq } from "./sequencer";
import { assertSerializable } from "./validate";

/**
 * The frame-layer code for a `t` this core has no `FRAME_TYPES` row for.
 *
 * Declared here, in the same shape as the other three codes (`BRIDGE_QUEUE_OVERFLOW`
 * in `./queue`, `FRAME_NOT_SERIALIZABLE` in `./validate`, `BULK_OVER_LIMIT` in
 * `./page`), because this module is the only place that can decide it: it is the
 * one that holds the type table for a given sender.
 */
export const UNREGISTERED_FRAME_TYPE = "UNREGISTERED_FRAME_TYPE" as const;

/**
 * Thrown by `send` when `t` is not in the sender's frame type set.
 *
 * `t` travels with the error because the whole failure is "this literal is not
 * registered", and a log line that omits it forces a second reproduction.
 */
export class UnregisteredFrameTypeError extends Error {
  /** Branch on this rather than on `message`. */
  readonly code = UNREGISTERED_FRAME_TYPE;

  /** The frame type that was refused, verbatim. */
  readonly t: string;

  /**
   * @param t the frame type that is not registered
   */
  constructor(t: string) {
    super(
      `unregistered frame type: "${t}"; every emitted "t" needs a FRAME_TYPES row (the table is ` +
        "append-only), and a row is added by the work package that owns the type, not by a sender",
    );
    this.name = "UnregisteredFrameTypeError";
    this.t = t;
  }
}

/**
 * Thrown by `send` for a bulk snapshot whose first unpaged item cannot fit a
 * page even on its own.
 *
 * The pager answers that case with an empty page and `more: true` (it cannot
 * know whether the caller can still make progress), so the decision -- and the
 * error code -- belong here, around the pager rather than inside it.
 */
export class BulkOverLimitError extends Error {
  /** Branch on this rather than on `message`. */
  readonly code = BULK_OVER_LIMIT;

  /** Index of the first item that does not fit a page on its own. */
  readonly offset: number;

  /** The page budget the item was measured against, in UTF-8 bytes. */
  readonly budget: number;

  /**
   * @param offset index of the offending item within the snapshot
   * @param budget the page budget it does not fit
   */
  constructor(offset: number, budget: number) {
    super(
      `bulk snapshot cannot be paged: the item at offset ${String(offset)} does not fit a page ` +
        `budget of ${String(budget)} bytes on its own, so no sequence of pages covers it; split ` +
        "the item itself, or send it as a page you know exceeds the budget",
    );
    this.name = "BulkOverLimitError";
    this.offset = offset;
    this.budget = budget;
  }
}

/** Construction options for {@link createFrameSender}. */
export interface FrameSenderOptions {
  /**
   * Hands one already-serialized payload to the shell.
   *
   * The payload is a complete JSON document: the shell only moves bytes and
   * must not rewrite the frame. A throw is treated as a failed
   * delivery, never as a retryable backpressure signal.
   */
  transport: (payload: string) => void;

  /**
   * The frame types this sender may emit.
   *
   * Defaults to the key set of `FRAME_TYPES`. When given, it REPLACES that
   * default rather than extending it: the set is the whole registration story
   * for this sender, which is what lets a host inject its own table (C5-Q24).
   * The set is copied, so mutating the caller's set later cannot change which
   * types this sender accepts.
   */
  frameTypes?: ReadonlySet<string>;

  /**
   * Coalescing window in milliseconds, inside `[8, 64]`.
   *
   * Defaults to `BATCH_WINDOW_DEFAULT_MS` (one host timer quantum). An
   * out-of-range value is refused by `./batch` with a `RangeError` at
   * construction, never clamped.
   */
  windowMs?: number;

  /**
   * Per-channel backlog overrides; an omitted channel keeps its
   * `DEFAULT_LIMITS` value.
   *
   * A limit of 0 is legal and means "this channel must not buffer anything",
   * so the first payload staged for it is refused with
   * `BRIDGE_QUEUE_OVERFLOW`.
   */
  limits?: Partial<Record<FrameChannel, number>>;
}

/** The sender a host holds for one bridge session. */
export interface FrameSender {
  /**
   * Validate, number, split and deliver one frame.
   *
   * @param frame the frame to emit; it is read, never mutated
   * @throws {FrameSerializationError} `FRAME_NOT_SERIALIZABLE`, with the path
   *   of the first value outside the JSON subset
   * @throws {UnregisteredFrameTypeError} `UNREGISTERED_FRAME_TYPE`
   * @throws {BulkOverLimitError} `BULK_OVER_LIMIT`
   * @throws {BridgeQueueOverflowError} `BRIDGE_QUEUE_OVERFLOW`
   * @throws {Error} when the sender is closed, or when the transport throws
   */
  send(frame: Frame): void;

  /**
   * Force out everything the sender is still holding.
   *
   * Flushes the coalescing window (which is idle for every registered type
   * today) and then pumps every channel, so payloads left by an interrupted
   * transport are delivered. Safe to call on an idle sender, and safe to call
   * after `close`.
   *
   * @throws whatever the transport throws; the remaining payloads stay queued
   */
  flush(): void;

  /**
   * Stop accepting frames, and deliver what was already accepted.
   *
   * Idempotent. After it returns, `send` throws and only `flush` can still
   * move a payload that a failed transport left behind.
   */
  close(): void;

  /** A fresh snapshot of the sender's counters; mutating it changes nothing. */
  readonly stats: { sent: number; queued: Record<FrameChannel, number>; overflows: number };
}

/**
 * The three channels, enumerated once.
 *
 * Adding a channel to `FrameChannel` makes the `queued` literal in `stats`
 * fail to compile instead of silently reporting `undefined` for it.
 */
const CHANNELS = ["control", "stream", "bulk"] as const satisfies readonly FrameChannel[];

/**
 * Channel membership, for the runtime guard `send` applies.
 *
 * `FrameChannel` is exhaustive at compile time, but `Frame["ch"]` reaches this
 * module from JavaScript callers and untrusted hosts too. An unknown channel
 * must not be silently filed as one of the three: it would be staged into a
 * fourth backlog whose limit does not exist, which is the one way to bypass the
 * hard cap this layer promises.
 */
const CHANNEL_NAMES: ReadonlySet<string> = new Set(CHANNELS);

/**
 * The registration set used when the caller supplies none.
 *
 * Built once from the table's keys, and never mutated: a sender's accepted set
 * is a copy of this or of the caller's set.
 */
const DEFAULT_FRAME_TYPES: ReadonlySet<string> = new Set(Object.keys(FRAME_TYPES));

/**
 * Coalescing policy per registered type.
 *
 * Read from the table, so the table stays the single source of truth. A type the
 * caller injected through `frameTypes` has no row and is therefore never
 * coalescible: an injected set names types, it does not carry policy, and
 * guessing "by-channel" for an unknown type would collapse frames whose
 * individual occurrences may be observable.
 */
const COALESCING: ReadonlyMap<string, string> = new Map(
  Object.entries(FRAME_TYPES).map(([type, spec]): [string, string] => [type, spec.coalescible]),
);

/**
 * The pager every snapshot uses.
 *
 * `createPager` returns a pure function with no state, so one instance serves
 * the whole process. The budget is the module default (1 MB), the hard cap of
 * cap; the frozen options have no budget field, so a caller that needs a
 * needs a different split pages the snapshot itself.
 */
const PAGER = createPager();

/** What one emitted frame needs from its plan, before a number is assigned. */
interface PlannedEmission {
  /** The body of this emission (already a page slice for a bulk frame). */
  readonly body: unknown;
  /** `more` of a bulk page; `null` means "this is not a bulk frame". */
  readonly more: boolean | null;
  /** The snapshot cursor the caller supplied, when it supplied a usable one. */
  readonly cursor: SnapshotCursor | null;
}

/** A caller-supplied snapshot cursor, with unusable halves widened to `null`. */
interface SnapshotCursor {
  readonly watermark: number | null;
  readonly token: string | null;
}

/**
 * Create the producer-side sender for one bridge session.
 *
 * @param options the transport, the accepted frame types, the window and the
 *   per-channel backlog overrides
 * @returns a sender whose queue and window start empty and idle
 * @throws RangeError when `windowMs` is outside `[8, 64]` or `limits` names a
 *   value that is not a non-negative safe integer; both guards run before any
 *   state exists, so a refused construction has no side effect
 * @throws TypeError when `transport` is not a function, because a sender with
 *   no transport could only buffer frames nobody ever receives
 */
export function createFrameSender(options: FrameSenderOptions): FrameSender {
  if (typeof options.transport !== "function") {
    throw new TypeError(
      "createFrameSender: options.transport must be a function that accepts one serialized " +
        "payload; a sender without a transport would buffer frames nobody ever receives",
    );
  }

  const transport = options.transport;

  /** Accepted types; copied from the caller's set so later mutation cannot widen it. */
  const frameTypes: ReadonlySet<string> =
    options.frameTypes === undefined ? DEFAULT_FRAME_TYPES : new Set(options.frameTypes);

  // Constructed first: it is the authority on whether `limits` is a usable
  // configuration, and a bad override must fail at construction, not at the
  // first send that happens to touch that channel.
  const queue = createBoundedQueue(options.limits);

  /** Resolved limits, for the staging pre-check only; see the module header. */
  const limits: Record<FrameChannel, number> = { ...DEFAULT_LIMITS };

  for (const channel of CHANNELS) {
    const override = options.limits === undefined ? undefined : options.limits[channel];

    if (override !== undefined) {
      limits[channel] = override;
    }
  }

  /** The one place a payload may wait. See the module header for why stream only. */
  const window = createBatchWindow({
    windowMs: options.windowMs ?? BATCH_WINDOW_DEFAULT_MS,
    deliver: (payloads) => {
      stageAndPump("stream", payloads);
    },
  });

  /**
   * Payloads the transport accepted, counted per payload rather than per frame.
   *
   * A delivery whose `transport` call throws is not counted: "sent" answers
   * "how many strings the transport took", and a failed call is exactly the
   * case where this module cannot know whether the bytes crossed.
   */
  let sent = 0;

  /** Refusals carrying `BRIDGE_QUEUE_OVERFLOW`. */
  let overflows = 0;

  /** Set by `close`; guards `send` and nothing else, so `flush` stays usable. */
  let closed = false;

  return {
    send,
    flush,
    close,

    get stats() {
      return {
        sent,
        queued: {
          control: queue.size("control"),
          stream: queue.size("stream"),
          bulk: queue.size("bulk"),
        },
        overflows,
      } satisfies { sent: number; queued: Record<FrameChannel, number>; overflows: number };
    },
  };

  /**
   * The send pipeline. See the module header for the order and its reasons.
   *
   * @param frame the frame to emit
   */
  function send(frame: Frame): void {
    if (closed) {
      throw closedError();
    }

    assertSerializable(frame);

    if (!frameTypes.has(frame.t)) {
      throw new UnregisteredFrameTypeError(frame.t);
    }

    if (!CHANNEL_NAMES.has(frame.ch)) {
      throw new RangeError(
        `unknown frame channel: ${String(frame.ch)}; expected one of ${CHANNELS.join(", ")}, ` +
          "because a channel outside the three has no backlog limit and would bypass the hard cap",
      );
    }

    if (waitsForWindow(frame)) {
      submitToWindow(frame);

      return;
    }

    // Planning can still refuse the frame (`BULK_OVER_LIMIT`), and the capacity
    // check can refuse the unit (`BRIDGE_QUEUE_OVERFLOW`); both run before a
    // single number is issued.
    const plan = planEmissions(frame);

    assertCapacity(frame.ch, plan.length);
    emit(frame, plan);
  }

  /**
   * Flush the window, then pump every channel.
   *
   * The window goes first so a payload that has been waiting is never overtaken
   * by one that was staged after it.
   */
  function flush(): void {
    window.flush();

    for (const channel of CHANNELS) {
      pump(channel);
    }
  }

  /**
   * Close the sender for writes and deliver what was accepted.
   *
   * The flag is set before the flush, so a throwing transport cannot leave a
   * half-open sender: after this call `send` refuses either way.
   */
  function close(): void {
    if (closed) {
      return;
    }

    closed = true;
    flush();
  }

  /**
   * Whether this frame may wait for the coalescing window.
   *
   * Three conditions, all required. The table must say `by-channel` (the only
   * value that permits collapsing); the channel must be `stream` (`control` is
   * ordered request/response traffic that must never be batched, and `bulk` is
   * paged, where every page is separately observable); and the type must be
   * registered at all, which the caller of this function has already checked.
   *
   * Everything else is delivered inside `send`. That is why, with the five
   * `"never"` rows of `FRAME_TYPES`, no sender owns a timer.
   *
   * @param frame a frame whose type is already known to be registered
   */
  function waitsForWindow(frame: Frame): boolean {
    return frame.ch === "stream" && COALESCING.get(frame.t) === "by-channel";
  }

  /**
   * Number one coalescible frame and offer it to the window.
   *
   * The payload is serialized here because the window's contract is over
   * payload strings; the consequence (a number spent on a frame that `close`
   * later drops) is stated in the module header. Capacity is checked against
   * the whole waiting backlog, so a full channel refuses the frame at the point
   * a caller can see the error rather than inside a timer callback.
   *
   * @param frame a frame that `waitsForWindow` accepted
   */
  function submitToWindow(frame: Frame): void {
    assertCapacity("stream", window.size() + 1);

    const seq = nextSeq();

    window.submit(toPayload({ ...frame, seq }));
  }

  /**
   * Turn one frame into the emissions it produces, without numbering any.
   *
   * A non-bulk frame is exactly one emission. A bulk frame is split by the
   * pager, which is the only part that decides where a page ends; this function
   * only decides what each page's body and cursor look like.
   *
   * @param frame a frame whose type is registered and whose value is serializable
   * @returns one emission per frame to send, never empty
   * @throws {BulkOverLimitError} when an item does not fit a page on its own
   */
  function planEmissions(frame: Frame): PlannedEmission[] {
    if (frame.ch !== "bulk") {
      return [{ body: frame.body, more: null, cursor: null }];
    }

    const cursor = readCursor(frame);
    const items = readPageItems(frame.body);

    if (items === null) {
      // Nothing to page: deliver the body as it stands, in one frame.
      return [{ body: frame.body, more: false, cursor }];
    }

    if (items.length === 0) {
      // An empty snapshot is one empty page, not silence.
      return [{ body: pageBody(frame.body, [], 1), more: false, cursor }];
    }

    const emissions: PlannedEmission[] = [];
    let offset = 0;

    while (offset < items.length) {
      const page = PAGER.paginate(items, offset);

      if (page.items.length === 0) {
        // The pager's only empty-with-more answer: the item at `offset` does not
        // fit a page on its own, so no page sequence covers this snapshot.
        throw new BulkOverLimitError(offset, DEFAULT_PAGE_BUDGET_BYTES);
      }

      emissions.push({
        body: pageBody(frame.body, page.items, emissions.length + 1),
        more: page.more,
        cursor,
      });
      offset += page.items.length;
    }

    return emissions;
  }

  /**
   * Number every emission, serialize it and stage the unit on its channel.
   *
   * Numbers are issued as a block, in emission order, because the sequence is
   * the only cross-channel ordering signal a consumer has: pages of one
   * snapshot must be numbered consecutively to read as one snapshot.
   *
   * @param frame the caller's frame, used for the envelope fields the emissions
   *   do not replace
   * @param plan the emissions, at least one
   */
  function emit(frame: Frame, plan: readonly PlannedEmission[]): void {
    const seqs: number[] = [];

    for (let index = 0; index < plan.length; index += 1) {
      seqs.push(nextSeq());
    }

    const firstSeq = seqs[0];

    if (firstSeq === undefined) {
      // Unreachable: `planEmissions` never returns an empty plan.
      return;
    }

    const payloads: string[] = [];

    for (let index = 0; index < plan.length; index += 1) {
      const planned = plan[index];
      const seq = seqs[index];

      if (planned === undefined || seq === undefined) {
        continue;
      }

      payloads.push(toPayload(toWire(frame, planned, seq, firstSeq, plan.length, index)));
    }

    stage(frame.ch, payloads);
    pump(frame.ch);
  }

  /**
   * Build the value that goes on the wire for one emission.
   *
   * The caller's frame is copied, never mutated: a producer may keep the object
   * it passed in, and a sender that rewrote it would make a retry emit a
   * different frame.
   *
   * @param frame the caller's frame
   * @param planned the emission being built
   * @param seq this emission's number
   * @param firstSeq the number of the snapshot's first page
   * @param count how many emissions this frame produces
   * @param index this emission's zero-based position
   * @returns a frame-shaped value with the sender's `seq` and, for bulk, a cursor
   */
  function toWire(
    frame: Frame,
    planned: PlannedEmission,
    seq: number,
    firstSeq: number,
    count: number,
    index: number,
  ): unknown {
    if (planned.more === null) {
      return { ...frame, seq };
    }

    const watermark =
      planned.cursor === null || planned.cursor.watermark === null
        ? firstSeq
        : planned.cursor.watermark;
    const base =
      planned.cursor === null || planned.cursor.token === null
        ? mintedToken(watermark)
        : planned.cursor.token;

    // Spread first, so envelope fields this module does not own (a control
    // frame's `reqId`, a future addition) survive even on a bulk frame; the keys
    // below are the ones the sender replaces.
    return {
      ...frame,
      seq,
      body: planned.body,
      page: {
        watermark,
        // One token per page: the renderer deduplicates on the
        // (watermark, token) pair, so a shared token would make it drop every
        // page after the first.
        token: count === 1 ? base : `${base}#${String(index + 1)}`,
        more: planned.more,
      },
    };
  }

  /**
   * Refuse a unit that would not fit the channel's backlog.
   *
   * Checked before anything is stored or numbered, which is what makes the
   * refusal atomic. See the module header for why the arithmetic lives here.
   *
   * @param channel the channel the unit would be staged on
   * @param count how many payloads the unit holds, at least 1
   * @throws {BridgeQueueOverflowError} when the backlog cannot take the unit
   */
  function assertCapacity(channel: FrameChannel, count: number): void {
    const limit = limits[channel];
    const queued = queue.size(channel);

    if (queued + count <= limit) {
      return;
    }

    overflows += 1;

    throw new BridgeQueueOverflowError(channel, limit, queued);
  }

  /**
   * Store a unit on its channel.
   *
   * Cannot normally refuse, because `assertCapacity` ran first; the guard is
   * kept so a future caller that forgets the pre-check gets the queue's own
   * refusal and a counted overflow rather than an uncounted throw.
   *
   * @param channel the channel to stage on
   * @param payloads the unit, in delivery order
   * @throws {BridgeQueueOverflowError} when the backlog refuses it
   */
  function stage(channel: FrameChannel, payloads: readonly string[]): void {
    for (const payload of payloads) {
      try {
        queue.push(channel, payload);
      } catch (error) {
        if (error instanceof BridgeQueueOverflowError) {
          overflows += 1;
        }

        throw error;
      }
    }
  }

  /**
   * Deliver one channel's backlog, in order, one payload at a time.
   *
   * The tail is put back before the transport runs, so a throwing transport
   * leaves exactly "payloads no transport has ever been offered" behind. See
   * the module header for why the failed payload itself is not put back.
   *
   * @param channel the channel to pump
   * @throws whatever the transport throws, after the backlog has been restored
   */
  function pump(channel: FrameChannel): void {
    for (;;) {
      const held = queue.drain(channel);
      const head = held[0];

      if (head === undefined) {
        return;
      }

      for (const payload of held.slice(1)) {
        queue.push(channel, payload);
      }

      transport(head);
      sent += 1;
    }
  }

  /**
   * Stage a unit and deliver it: the path every delivery goes through.
   *
   * @param channel the channel to use
   * @param payloads the unit, in delivery order
   */
  function stageAndPump(channel: FrameChannel, payloads: readonly string[]): void {
    assertCapacity(channel, payloads.length);
    stage(channel, payloads);
    pump(channel);
  }

  /** The lifecycle error `send` throws once the sender is closed. No code, by design. */
  function closedError(): Error {
    const error = new Error(
      "frame sender is closed: the transport edge is gone, so the frame was not sent; a close is " +
        "terminal and nothing in this module reopens it",
    );

    error.name = "BridgeSenderClosedError";

    return error;
  }
}

/**
 * Serialize one emission.
 *
 * `send` has already proved the value is inside the JSON subset, so the only
 * way out of here without a string is a value the whole-frame check would have
 * rejected; the guard keeps that from becoming `undefined` on the wire.
 *
 * @param value the frame to serialize
 * @returns the JSON text handed to the transport
 * @throws Error for a value `JSON.stringify` renders as nothing (unreachable)
 */
function toPayload(value: unknown): string {
  const payload = JSON.stringify(value);

  if (payload === undefined) {
    throw new Error(
      "cannot serialize a frame: JSON.stringify rendered it as nothing; the serializability " +
        "check runs before this point, so this is a bug in the sender rather than in a frame",
    );
  }

  return payload;
}

/**
 * The token this module mints for a snapshot the caller did not name.
 *
 * @param watermark the snapshot's watermark
 * @returns a token unique within that watermark
 */
function mintedToken(watermark: number): string {
  return `snap-${String(watermark)}`;
}

/**
 * Read the cursor a caller put on a bulk frame.
 *
 * A caller-supplied watermark and token are optional here: an unusable half is
 * widened to `null` and replaced at emission time, which keeps one bad field
 * from costing the whole snapshot.
 *
 * @param frame the caller's frame
 * @returns the readable halves, or `null` when the frame carries no cursor
 */
function readCursor(frame: Frame): SnapshotCursor | null {
  const candidate = (frame as Frame & { readonly page?: unknown }).page;

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const watermark = record["watermark"];
  const token = record["token"];

  return {
    watermark: typeof watermark === "number" && Number.isFinite(watermark) ? watermark : null,
    token: typeof token === "string" && token.length > 0 ? token : null,
  };
}

/**
 * The list of items a bulk body offers for paging.
 *
 * Two shapes are accepted: the body IS the array, or the body carries an
 * `items` array. Anything else has nothing to split and is delivered whole.
 *
 * @param body the caller's bulk body
 * @returns the items, or `null` when this body is not a list
 */
function readPageItems(body: unknown): readonly unknown[] | null {
  if (Array.isArray(body)) {
    return body as readonly unknown[];
  }

  if (body === null || typeof body !== "object") {
    return null;
  }

  const items = (body as Record<string, unknown>)["items"];

  return Array.isArray(items) ? (items as readonly unknown[]) : null;
}

/**
 * Build one page's body.
 *
 * Snapshot-level fields are repeated on every page so a page can be read on its
 * own -- a page is independently resumable, and a page that refers to fields it
 * does not carry is not. `page` and `items` are the two keys this layer owns, so
 * the caller's versions of them are replaced rather than inherited.
 *
 * @param original the caller's body
 * @param items this page's slice
 * @param page the 1-based page number
 * @returns the body to put on the wire
 */
function pageBody(
  original: unknown,
  items: readonly unknown[],
  page: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (!Array.isArray(original) && original !== null && typeof original === "object") {
    const record = original as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      if (key !== "items" && key !== "page") {
        body[key] = record[key];
      }
    }
  }

  body["page"] = page;
  body["items"] = items;

  return body;
}
