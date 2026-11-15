/**
 * The frame entry: the renderer's receiver for one bridge frame stream.
 *
 * Frozen contract: the interface and its acceptance criteria -- the watermark,
 * the version guard, approval ordering and one page per cursor. The shape of
 * rule C5-R07 (one page per cursor). The shape of {@link FrameEntry} is frozen;
 * everything else here is implementation.
 *
 * Why the renderer owns a copy of the rules
 *   The core has the same rules for the streams it *sends* (it answers a
 *   mismatched `bridge.ready` with `bridge.reject` and then goes silent). The
 *   renderer has to be equally strict about what it *accepts*, because a
 *   corrupted or replayed socket is indistinguishable from a hostile one at
 *   this layer: a stale page, a duplicated page and a frame from another
 *   envelope version are all payloads the screen must not render twice. The
 *   two halves therefore agree by contract rather than by sharing a module --
 *   the renderer may not value-import the core package (rule R6), so a shared
 *   implementation is not available to it.
 *
 * Why the protocol version is injected instead of imported
 *   `FRAME_PROTOCOL_VERSION` is a value in `@haruyuki/protocol`, and the
 *   renderer may only `import type` from that package (rule R7). The constant
 *   still has to reach this module, so the host passes it as
 *   {@link FrameEntryOptions.frameProtocolVersion}; that is the only value the
 *   entry needs from the protocol package, and it is copied at creation so a
 *   later mutation of the caller's configuration cannot change a verdict that
 *   has already been acted on.
 *
 * What "silent after reject" means here
 *   Once the handshake is rejected the entry processes nothing at all: no
 *   channel counter, no `lastSeq`, no violation, no notification. The state
 *   machine in the core stops *sending*; this one stops *observing*. Both are
 *   needed, because a peer that keeps talking to a rejected bridge must not be
 *   able to grow the renderer's diagnostics without bound.
 *
 * One notification per payload
 *   Consumers subscribe to learn that a snapshot changed. A single frame can
 *   change several observable facts at once (a counter, `lastSeq`, a
 *   violation), so the entry settles the whole payload first and then notifies
 *   once, rather than once per field. A payload that changes nothing --
 *   including every payload after a reject -- notifies nobody.
 *
 * Arrival order is preserved, never repaired
 *   The contract says a `control` frame must arrive before the `bulk` page
 *   that depends on it. When an injected sequence inverts that order, this
 *   entry keeps what it was given: the `bulk` page is accepted, counted and
 *   inserted into the watermark/dedup books exactly as if it had arrived last,
 *   and the late `control` frame changes only the handshake verdict. It is
 *   deliberately NOT reported as a violation and NOT held back, because
 *   buffering pages to wait for an authorising frame is a reordering decision
 *   with no way back: the entry would have to choose a timeout, and a page it
 *   holds is a page the screen does not show. Acceptance on arrival is
 *   deterministic, and it is observable -- `perChannel` and `violations()`
 *   report exactly what the wire delivered, in the order it was delivered.
 *   Rejecting the inverted pair instead would be equally deterministic but
 *   would make acceptance depend on a frame that had not been seen yet, which
 *   no single-pass receiver can decide.
 *
 * What this layer does not do
 *   It does not decode `body` (a page, a terminal slice or an acknowledgement
 *   belongs to the layer that renders it), it does not answer the handshake
 *   (the sender half owns `bridge.accept`/`bridge.reject`), and it has no
 *   timers, no I/O and no logging channel. Its whole observable output is the
 *   snapshot plus the change notifications the caller subscribes to.
 */

import type { FrameChannel } from "@haruyuki/protocol";

/**
 * The three channels in a fixed order.
 *
 * Enumerated once so the membership test, the initial counters and
 * {@link FrameEntrySnapshot.perChannel} cannot drift apart: adding a channel to
 * `FrameChannel` makes the explicit `perChannel` literal fail to compile
 * instead of silently leaving that channel unobserved.
 */
const CHANNELS = ["control", "stream", "bulk"] as const satisfies readonly FrameChannel[];

/** Channel membership, used to reject a channel name this envelope cannot carry. */
const CHANNEL_NAMES: ReadonlySet<string> = new Set(CHANNELS);

/**
 * The only reject code the handshake produces.
 *
 * Declared here rather than imported: the constant lives in the core package,
 * which the renderer may not value-import (R6), and it is wire contract, so the
 * literal is stable (the reject body carries it verbatim). Duplicating a frozen
 * string is the price of the boundary; the code is compared, never formatted.
 */
const BRIDGE_VERSION_MISMATCH = "BRIDGE_VERSION_MISMATCH" as const;

/**
 * How many violations are kept verbatim.
 *
 * `snapshot().violations` counts every one ever recorded; this bounds only the
 * list `violations()` returns. A renderer stays up for days and a broken peer
 * can send junk at frame rate, so an unbounded diagnostic list is a memory leak
 * with a friendly name. The newest entries are the ones a reader needs.
 */
const MAX_RECORDED_VIOLATIONS = 256;

/** One side of the handshake verdict, as the frozen surface names it. */
type FrameEntryState = "waiting" | "accepted" | "rejected";

/**
 * One recorded rule breach.
 *
 * `kind` is a short stable identifier rather than a sentence, so a caller can
 * count and group them; `t` is present only where the breach names a frame
 * type, which is the case for an unregistered `t` and for nothing else (the
 * other kinds are already unambiguous about what was refused).
 */
interface Violation {
  kind: string;
  t?: string;
}

/**
 * The parts of an envelope this layer reads.
 *
 * `body` stays `unknown`: only the handshake reads it, and only the one field
 * it needs. `page` holds the bulk cursor when the frame carries one, because
 * the watermark/dedup rules run before the payload is counted.
 */
interface Envelope {
  ch: FrameChannel;
  seq: number;
  t: string;
  body: unknown;
  page: Record<string, unknown> | null;
}

/**
 * The outcome of reading one payload as an envelope.
 *
 * The two refusal verdicts are separate because they are different findings: a
 * payload that is not a frame at all is a producer or transport bug, while a
 * frame from another envelope version is a peer this entry cannot read. Both
 * are dropped, but they are counted under different kinds.
 */
type EnvelopeRead =
  | { verdict: "ok"; frame: Envelope }
  | { verdict: "malformed" }
  | { verdict: "protocol-version-mismatch" };

/** Options for {@link createFrameEntry}. */
export interface FrameEntryOptions {
  /** Optional frame type table; when absent only `ch` routes, `t` is not checked. */
  frameTypes?: ReadonlySet<string>;
  /** The bridge version this renderer speaks; a handshake must match it exactly. */
  expectedBridgeVersion: string;
  /**
   * The injected protocol version constant. Because the renderer may not
   * value-import `@haruyuki/protocol` (rule R7), the host passes the value of
   * `FRAME_PROTOCOL_VERSION` here; a frame whose `v` differs is refused.
   */
  frameProtocolVersion: number;
}

/** The receiver of one bridge frame stream. */
export interface FrameEntry {
  /**
   * Offer one raw payload, as the transport delivered it.
   *
   * The payload is a string on purpose: parsing belongs to this layer, so a
   * frames source can hand over the bytes it received without pre-judging
   * them. A payload that does not parse is recorded and ignored, never thrown.
   *
   * @param payload the raw JSON text of one frame
   */
  handle(payload: string): void;

  /** The current handshake verdict, with its code when it was a rejection. */
  status(): { state: "waiting" | "accepted" | "rejected"; code?: string };

  /** Every rule breach recorded so far, in arrival order. */
  violations(): readonly { kind: string; t?: string }[];

  /**
   * Observe changes.
   *
   * The listener is called after a payload has changed something observable,
   * and not on subscription itself -- read {@link FrameEntry.snapshot} for the
   * current value. Listeners are identified by function identity, and a
   * listener is never allowed to take another one down with it.
   *
   * @param listener called synchronously after a change, with no arguments
   * @returns a function that removes this listener; calling it twice is safe
   */
  subscribe(listener: () => void): () => void;

  /** A fresh copy of everything this entry has observed. */
  snapshot(): FrameEntrySnapshot;
}

/** What {@link FrameEntry.snapshot} reports. */
export interface FrameEntrySnapshot {
  bridge: { state: "waiting" | "accepted" | "rejected"; code?: string };
  lastSeq: number;
  perChannel: Record<FrameChannel, number>;
  violations: number;
}

/**
 * Create a frame entry for one bridge session.
 *
 * One entry per session: the handshake verdict is terminal, so reusing an entry
 * across a reconnection would keep rejecting a peer that has been fixed.
 *
 * @param options the local expectations, copied at creation time
 * @returns an entry that starts in `waiting` with every counter at zero
 * @throws RangeError when `frameProtocolVersion` is not a finite number, since
 *   a missing injection would otherwise refuse every frame and look like a
 *   protocol disagreement instead of the wiring bug it is
 */
export function createFrameEntry(options: FrameEntryOptions): FrameEntry {
  return new FrameEntryMachine(options);
}

/**
 * The state machine behind {@link createFrameEntry}.
 *
 * Kept private so no instance can be constructed with a hand-written state:
 * every entry starts in `waiting`, and only {@link FrameEntry.handle} moves it.
 */
class FrameEntryMachine implements FrameEntry {
  readonly #expectedBridgeVersion: string;
  readonly #frameProtocolVersion: number;

  /** The injected type table, copied; `null` means "do not check `t`". */
  readonly #frameTypes: ReadonlySet<string> | null;

  readonly #listeners = new Set<() => void>();

  #state: FrameEntryState = "waiting";
  #code: string | undefined;
  #lastSeq = 0;
  #perChannel: Record<FrameChannel, number> = { control: 0, stream: 0, bulk: 0 };
  #violations: Violation[] = [];

  /**
   * How many violations have been recorded, including ones no longer kept.
   *
   * `snapshot().violations` reports this rather than the array length, so the
   * count a diagnostic reads stays truthful while the list stays bounded.
   */
  #violationCount = 0;

  /** Highest accepted watermark, or `null` before the first cursored page. */
  #highestWatermark: number | null = null;

  /** `(watermark, token)` pairs already accepted, keyed as `${watermark}:${token}`. */
  #acceptedPages = new Set<string>();

  /** Bumped by every observable mutation; tells `handle` whether to notify. */
  #revision = 0;

  constructor(options: FrameEntryOptions) {
    if (!Number.isFinite(options.frameProtocolVersion)) {
      throw new RangeError(
        `invalid frameProtocolVersion: ${String(options.frameProtocolVersion)}; the host must ` +
          "inject the value of FRAME_PROTOCOL_VERSION (the renderer may not value-import it), " +
          "and a non-numeric injection would refuse every frame",
      );
    }

    this.#expectedBridgeVersion = options.expectedBridgeVersion;
    this.#frameProtocolVersion = options.frameProtocolVersion;
    this.#frameTypes = options.frameTypes === undefined ? null : new Set(options.frameTypes);
  }

  handle(payload: string): void {
    // Terminal and silent: no further frame goes on the wire after a
    // reject, so nothing that arrives anyway may grow a counter or a diagnostic.
    if (this.#state === "rejected") {
      return;
    }

    const before = this.#revision;

    this.#ingest(payload);

    // One notification per payload, after the whole payload has been settled:
    // a listener that reads the snapshot then sees every effect of this frame,
    // not a half-applied one.
    if (this.#revision !== before) {
      this.#emit();
    }
  }

  status(): { state: FrameEntryState; code?: string } {
    return this.#code === undefined
      ? { state: this.#state }
      : { state: this.#state, code: this.#code };
  }

  violations(): readonly Violation[] {
    // A fresh array every call: a caller that sorts or splices the result must
    // not be able to reorder what this entry recorded. The elements are frozen
    // at creation, so they cannot be edited through this handle either.
    return [...this.#violations];
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);

    let subscribed = true;

    return () => {
      if (!subscribed) {
        return;
      }

      subscribed = false;
      this.#listeners.delete(listener);
    };
  }

  snapshot(): FrameEntrySnapshot {
    // Every level is rebuilt: the caller owns the result, and a host that keeps
    // the previous snapshot for a diff must see it stay unchanged.
    return {
      bridge: this.status(),
      lastSeq: this.#lastSeq,
      perChannel: {
        control: this.#perChannel.control,
        stream: this.#perChannel.stream,
        bulk: this.#perChannel.bulk,
      },
      violations: this.#violationCount,
    };
  }

  /**
   * Apply one payload, in the order the rules require.
   *
   * The order is load-bearing rather than incidental:
   *
   * 1. the envelope is read and the protocol version is checked, because a
   *    frame from another envelope version may not even have `ch`/`seq` in the
   *    meaning this entry assumes;
   * 2. `lastSeq` advances for every admitted envelope, including one a later
   *    rule drops, because the counter is a property of the wire -- losing
   *    that record would turn "the transport delivered a stale page" into a
   *    silent gap;
   * 3. an unregistered `t` is refused before routing, since the injected table
   *    is what says the renderer can interpret the frame at all;
   * 4. the bulk cursor rules run before the channel counter, because a dropped
   *    page must not appear in `perChannel.bulk` -- that counter is what a test
   *    and a diagnostic read as "pages this entry took";
   * 5. routing and the handshake verdict come last, so the frame that caused a
   *    verdict is still counted on its channel.
   *
   * @param payload the raw JSON text of one frame
   */
  #ingest(payload: string): void {
    const parsed = parsePayload(payload);

    if (!parsed.ok) {
      this.#record({ kind: "malformed-payload" });
      return;
    }

    const read = readEnvelope(parsed.value, this.#frameProtocolVersion);

    if (read.verdict === "malformed") {
      this.#record({ kind: "malformed-payload" });
      return;
    }

    if (read.verdict === "protocol-version-mismatch") {
      this.#record({ kind: "protocol-version-mismatch" });
      return;
    }

    const frame = read.frame;

    this.#observeSeq(frame.seq);

    // The handshake runs before the type table, not after it. The table is
    // injected by the host and downstream items register only the types they
    // decode, so a table without `bridge.ready` is a legal configuration -- and
    // checking the table first meant that configuration silently switched the
    // version guard off, letting a peer on an incompatible bridge have its pages
    // routed and rendered. The verdict does not depend on whether this renderer
    // has a decoder for the ready frame; it decides whether anything should be
    // routed at all.
    if (frame.ch === "control" && frame.t === "bridge.ready") {
      this.#perChannel[frame.ch] += 1;
      this.#touch();
      this.#applyHandshake(frame.body);

      return;
    }

    if (this.#frameTypes !== null && !this.#frameTypes.has(frame.t)) {
      // No table entry means the renderer has no decoder for this payload, so
      // routing it would only make `perChannel` claim a frame nobody handled.
      this.#record({ kind: "unregistered-type", t: frame.t });
      return;
    }

    if (frame.ch === "bulk" && !this.#acceptBulkPage(frame)) {
      return;
    }

    this.#perChannel[frame.ch] += 1;
    this.#touch();
  }

  /**
   * Record the highest `seq` this entry has admitted.
   *
   * @param seq the frame's global counter
   */
  #observeSeq(seq: number): void {
    if (seq <= this.#lastSeq) {
      return;
    }

    this.#lastSeq = seq;
    this.#touch();
  }

  /**
   * Apply the bulk cursor rules: the watermark and one page per
   * cursor).
   *
   * A page with no cursor field at all is accepted and counted. The recorded
   * corpus contains such pages (`duplicate.jsonl`, `three-channels.jsonl` carry
   * `page.more` and nothing else), and its content is real: dropping a page for
   * a missing diagnostic field would lose data the user asked to see, while
   * keeping it costs only the two rules that need a cursor.
   *
   * A page that *carries* a cursor field of the wrong type is a different case
   * and is refused. Accepting it would be worse than dropping it: the rules below
   * are the only thing standing between a replayed or stale page and the screen,
   * and a peer that sends `watermark: "40"` would skip both of them while looking
   * like it had a cursor. This layer's whole job is to decide whether a payload
   * is interpretable, and a cursor it cannot compare is not.
   *
   * @param frame a frame already known to be on the bulk channel
   * @returns `true` when the page is admitted, `false` when it was dropped
   */
  #acceptBulkPage(frame: Envelope): boolean {
    const page = frame.page;

    const hasWatermark = page !== null && "watermark" in page;
    const hasToken = page !== null && "token" in page;

    const watermark = hasWatermark ? page?.["watermark"] : undefined;
    const token = hasToken ? page?.["token"] : undefined;

    if (!hasWatermark && !hasToken) {
      // No cursor at all: nothing to compare, so nothing to enforce.
      return true;
    }

    if (
      hasWatermark &&
      (typeof watermark !== "number" || !Number.isSafeInteger(watermark) || watermark < 0)
    ) {
      this.#record({ kind: "malformed-cursor" });

      return false;
    }

    if (hasToken && (typeof token !== "string" || token.length === 0)) {
      this.#record({ kind: "malformed-cursor" });

      return false;
    }

    const numericWatermark = hasWatermark ? (watermark as number) : null;
    const stringToken = hasToken ? (token as string) : null;

    const highest = this.#highestWatermark;

    // A page from behind the cursor is a replayed or reordered page. Equal
    // is accepted: several pages of one snapshot share a watermark and are
    // told apart by their token.
    if (numericWatermark !== null && highest !== null && numericWatermark < highest) {
      this.#record({ kind: "stale-watermark" });

      return false;
    }

    // C5-R07: the same cursor twice is the same page twice. Deduplication needs
    // both halves, so a page that names a watermark but no token is compared on
    // the watermark alone and is not deduplicated -- stated here because the
    // alternative (inventing a token) would make every such page a duplicate of
    // the first.
    if (numericWatermark !== null && stringToken !== null) {
      // The key cannot collide: the watermark half is a number literal and
      // therefore never contains the separator.
      const key = `${String(numericWatermark)}:${stringToken}`;

      if (this.#acceptedPages.has(key)) {
        this.#record({ kind: "duplicate-page" });

        return false;
      }

      this.#acceptedPages.add(key);
    }

    if (numericWatermark !== null && (highest === null || numericWatermark > highest)) {
      this.#highestWatermark = numericWatermark;

      // Pages of an older snapshot can never be admitted again, so their keys
      // are dead weight in a renderer that stays up for days.
      this.#forgetPagesBefore(numericWatermark);
    }

    return true;
  }

  /**
   * Drop dedup keys that belong to snapshots older than the current watermark.
   *
   * Calls arrive in watermark order often enough that this normally removes
   * everything anyway; the guard is that a page can still arrive for the
   * *current* watermark after it advances (pages of one snapshot interleave),
   * so keys equal to the current watermark stay.
   *
   * @param watermark the watermark that just became current
   */
  #forgetPagesBefore(watermark: number): void {
    for (const key of this.#acceptedPages) {
      const separator = key.indexOf(":");
      const keyed = Number(key.slice(0, separator));

      if (Number.isFinite(keyed) && keyed < watermark) {
        this.#acceptedPages.delete(key);
      }
    }
  }

  /**
   * Apply the handshake verdict for one `bridge.ready` body.
   *
   * The verdict is final: a second ready -- matching or not -- is routed and
   * counted but changes nothing, exactly like the sender half, which answers
   * once and then stays silent.
   *
   * A body with no usable version is a shape problem, not a version problem: it
   * is recorded as `malformed-ready` and the state stays `waiting`. Answering a
   * reject would claim the two sides disagree about a version that was never
   * announced, and the sender half deliberately leaves that counting to this
   * layer, where the frame and its channel are visible.
   *
   * @param body the frame body, unvalidated
   */
  #applyHandshake(body: unknown): void {
    if (this.#state !== "waiting") {
      return;
    }

    const record = asRecord(body);
    const announced = normalizeVersion(record === null ? undefined : record["bridgeVersion"]);

    if (announced === null) {
      this.#record({ kind: "malformed-ready" });
      return;
    }

    if (announced === this.#expectedBridgeVersion) {
      this.#state = "accepted";
      this.#touch();
      return;
    }

    this.#state = "rejected";
    this.#code = BRIDGE_VERSION_MISMATCH;
    this.#touch();
  }

  /**
   * Append one violation and mark the state dirty.
   *
   * The violation is frozen at creation so a caller that holds the array
   * returned by {@link violations} cannot rewrite what was recorded.
   *
   * @param violation the breach to record
   */
  #record(violation: Violation): void {
    const t = violation.t;

    this.#violationCount += 1;

    // The list is bounded and the count is not. A peer that keeps sending junk
    // is exactly the peer this module was written to survive, so it must not be
    // able to grow the renderer's memory by sending more of it: the newest
    // entries are the ones worth keeping, and the oldest are dropped.
    if (this.#violations.length >= MAX_RECORDED_VIOLATIONS) {
      this.#violations.shift();
    }

    this.#violations.push(
      t === undefined
        ? Object.freeze({ kind: violation.kind })
        : Object.freeze({ kind: violation.kind, t }),
    );
    this.#touch();
  }

  /** Mark the state dirty, so `handle` knows a notification is owed. */
  #touch(): void {
    this.#revision += 1;
  }

  /**
   * Call every listener once.
   *
   * The set is copied before iterating: a listener that subscribes or
   * unsubscribes during a notification then cannot change who receives the
   * notification it is part of, so every listener registered at this moment is
   * called exactly once. A throwing listener is swallowed on purpose -- the
   * entry has no logging channel (the renderer may not import a Node builtin),
   * and one consumer's bug must not stop the others or fail the frame.
   */
  #emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // See above: contained by design, not an oversight.
      }
    }
  }
}

/**
 * Parse one payload, reporting failure instead of throwing.
 *
 * `JSON.parse` throws a `SyntaxError` on malformed text, and that text is the
 * transport's input rather than a programming error, so the failure is data
 * here: the caller records a violation and keeps receiving.
 *
 * @param payload the raw payload
 * @returns the parsed value, or a failure marker
 */
function parsePayload(payload: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(payload) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Read one parsed value as an envelope, or say why it is not one.
 *
 * The checks are ordered from "is this a frame at all" to "is this the frame
 * shape this layer routes":
 *
 * - a non-object (including `null` and an array) is not a frame;
 * - a missing or non-numeric `v` is not a frame, while a numeric `v` that
 *   differs from the injected constant is a version refusal;
 * - `ch`, `seq` and `t` must have the types the router depends on.
 *
 * `body` is carried through untouched, and `page` is exposed as a plain record
 * when present so the bulk rules do not re-narrow the same value twice.
 *
 * @param value the parsed JSON value
 * @param expectedProtocolVersion the injected `FRAME_PROTOCOL_VERSION`
 * @returns the frame, or the refusal verdict
 */
function readEnvelope(value: unknown, expectedProtocolVersion: number): EnvelopeRead {
  const record = asRecord(value);

  if (record === null) {
    return { verdict: "malformed" };
  }

  const version = record["v"];

  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { verdict: "malformed" };
  }

  if (version !== expectedProtocolVersion) {
    return { verdict: "protocol-version-mismatch" };
  }

  const ch = record["ch"];

  if (typeof ch !== "string" || !CHANNEL_NAMES.has(ch)) {
    return { verdict: "malformed" };
  }

  const seq = record["seq"];

  // A safe non-negative integer, not merely a finite number. The issuer hands
  // out exactly those, so anything else is a producer bug: a negative number
  // routes but never advances `lastSeq` (a frame delivered yet unrecorded), and
  // a fraction makes every later comparison ambiguous.
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    return { verdict: "malformed" };
  }

  const t = record["t"];

  if (typeof t !== "string") {
    return { verdict: "malformed" };
  }

  return {
    verdict: "ok",
    frame: {
      ch: ch as FrameChannel,
      seq,
      t,
      body: record["body"],
      page: asRecord(record["page"]),
    },
  };
}

/**
 * Read a value as a plain record, or `null`.
 *
 * Arrays are refused even though `typeof` calls them objects: `[]` and `["v"]`
 * parse as valid JSON and are not frames, and treating one as a record would
 * let an array's index keys masquerade as envelope fields.
 *
 * @param value the candidate value
 * @returns the value as a record of unknowns, or `null`
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/**
 * Normalize an announced bridge version to the string form used for comparison.
 *
 * The recorded corpus carries both wire forms: `handshake-accept.jsonl` and
 * `version-mismatch.jsonl` use the frozen string (`"1"`, `"2"`), while the
 * frames header and the older fixtures (`watermark.jsonl`, `three-channels.jsonl`)
 * carry the number `1`. Both mean one version, so a number is compared as its
 * decimal string; the *form* never decides a verdict. The expected side stays
 * the caller's string, so a host that expects `"1.0.0"` still rejects a peer
 * that announces `1`.
 *
 * @param value the body field, unvalidated
 * @returns the announced version, or `null` when it is not a usable version
 */
function normalizeVersion(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}
