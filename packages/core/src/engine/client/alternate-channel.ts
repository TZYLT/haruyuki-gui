/**
 * The second `ChannelPool` implementation, a counterpart of `pool.ts`.
 *
 * The frozen `ChannelPool` signature is the contract, and the claim this file
 * exists to test is: **swapping the pool implementation changes one layer and
 * nothing above it**. This file is a *comparison artifact* only - it lives under
 * `client/`, next to the suite that runs it, and is exported from no barrel.
 * Production keeps {@link EngineChannelPool}.
 *
 * This is not the "one connection, many subscriptions" pool an early sketch
 * proposed: the intended shape is "one connection per agent", so the alternate
 * must be *that same shape* with different machinery inside. The public surface
 * is the frozen {@link ChannelPool} interface and nothing else; every difference
 * below is invisible to a caller, which is exactly the claim the differential
 * suite exists to measure.
 *
 * ## The four deliberate differences from `pool.ts`
 *
 * 1. **Registry instead of map.** `pool.ts` keeps `Map<string, Channel>` plus a
 *    `Set<string>` of agents being built. This pool keeps one append-only
 *    array of {@link RegistryEntry} values and finds an agent with a
 *    newest-first linear scan. A closed entry is not deleted; it is marked
 *    `retired` and becomes a tombstone, so "which generation of this agent is
 *    live" is a property of the record rather than of a delete. Tombstones are
 *    swept only when enough of them accumulate ({@link COMPACT_AT}).
 *
 * 2. **Lazy materialization.** `pool.ts` builds the channel inside
 *    `getChannel`. Here `getChannel` only *enrols* an entry and hands back its
 *    facade; the endpoint is resolved and the factory called on the first
 *    operation that actually needs a connection (a send, a subscription, a
 *    capability read or a close that has something to close). A session that
 *    opens a channel it never uses therefore never touches the transport.
 *
 * 3. **A lease ledger for closing.** `pool.ts` deletes the entry and then calls
 *    `close()`. Here an entry carries a reference count: one lease for the
 *    registry slot, plus one while the factory is running. The inner channel is
 *    closed when the *last* lease is released, and a close request that arrives
 *    while the factory is still running is dropped rather than deferred - the
 *    slot does not belong to the pool yet, which is the same answer `pool.ts`
 *    gives by finding no entry at all (its entry is inserted after the factory
 *    returns).
 *
 * 4. **One subscription, fanned out.** `pool.ts` hands each consumer's callback
 *    straight to the channel. Here the facade owns at most one event
 *    subscription and one diagnostic subscription on the inner channel and fans
 *    the frames out itself, with the same snapshot iteration and per-subscriber
 *    isolation the kernel uses.
 *
 * ## What must *not* differ
 *
 * A caller holds a `Channel` and cannot tell which pool produced it. So:
 * `getChannel` is synchronous and returns the same instance per live agent; a
 * conversation id is a request scope, never a second connection; a self-closed
 * channel is replaced rather than handed out again; `channels()` is a fresh
 * snapshot in creation order; one agent's failure (a throwing resolver, a
 * throwing factory, a throwing `close()`) touches that agent only; `closeAll`
 * is not a terminal dispose; and every command failure is a value with the same
 * `code` and the same `NOT_CONNECTED` wording as the production pool. The
 * differential suite in `alternate-channel.test.ts` runs one scenario table
 * against both implementations and asserts exactly that.
 *
 * ## Vocabulary
 *
 * No wire id and no frame field name appears here: a channel is
 * addressed by agent id and an endpoint, and frames are opaque strings and
 * `unknown` values. The only engine-flavoured behaviour inherited is the
 * `NOT_CONNECTED` wording, which is built by `channel-errors.ts` - the single
 * home of that prose - rather than spelled again here.
 */

import { createChannel } from "./channel";
import { notConnectedError } from "./channel-errors";
import type { ChannelClock, ChannelReadiness, ChannelWriter } from "./channel";
import type { ChannelFactory, PoolOptions } from "./pool";
import type {
  CapabilitySnapshot,
  Channel,
  ChannelPool,
  CommandRequest,
  CommandResult,
  DiagnosticRecord,
  Endpoint,
  EngineEventFrame,
} from "./types";

/* ------------------------------------------------------------------------- */
/* Constants                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * How many fully released tombstones may accumulate before the registry is
 * swept.
 *
 * The number is not a contract and nothing observable depends on it: a tombstone
 * is invisible to `channels()` and `getChannel` either way, and a facade holds
 * its own entry alive independently of the array. It exists so a long-lived
 * session that opens and closes many agents does not grow an array forever.
 */
const COMPACT_AT = 16;

/**
 * The wording `EngineChannel` uses when a command is refused because it was
 * closed (see `channel.ts`).
 *
 * Quoted here only so the *un-materialized* refusal - a frame that was never
 * built, and so has no channel to ask - reaches a caller with the same phrase
 * the kernel would have used. It is a copy of kernel prose, not a second source
 * of truth: the suite in `channel.test.ts` pins the original.
 */
const CLOSED_PHRASE = "the channel is closed";

/** A never-ready readiness port, for the degraded stand-in (mirrors `pool.ts`). */
const NEVER_READY: () => ChannelReadiness = () => ({ ready: false, everReady: false });

/**
 * The writer of a channel that has no connection: unreachable by construction.
 *
 * `send` checks readiness before it writes, so this is never called; it throws
 * so that a future change which starts writing anyway fails loudly in a test
 * instead of dropping a command silently.
 */
const UNREACHABLE_WRITE: ChannelWriter = () => {
  throw new Error(
    "a channel with no endpoint wrote a command: readiness must refuse before the write",
  );
};

/** The reconnect-safe no-op returned when a closed facade is subscribed to. */
const NOOP = (): void => undefined;

/* ------------------------------------------------------------------------- */
/* Entry phases and helpers                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Where one registry entry stands.
 *
 * - `provisional` - enrolled by `getChannel`, nothing built yet. The factory has
 *   not been called, so nothing can be closed.
 * - `live` - a channel exists behind the facade.
 * - `retired` - the slot has been given up. The facade may still be held by a
 *   caller; it answers `NOT_CONNECTED` and ignores further sends.
 */
type Phase = "provisional" | "live" | "retired";

/** A channel that may report its own closure, as `pool.ts` also detects it. */
type ClosableChannel = Channel & { readonly isClosed?: () => boolean };

/**
 * Whether a channel closed itself, without the pool's help.
 *
 * A consumer may call `close()` on the facade; that retires the entry, so this
 * check is about a deeper case - a channel that closed *itself* (a transport
 * that gave up), which `pool.ts` also refuses to hand out again.
 *
 * @param channel the channel to inspect, or `null` when nothing is built
 * @returns `true` only when the channel both has the accessor and reports closed
 */
function isClosedNow(channel: Channel | null): boolean {
  if (channel === null) {
    return false;
  }
  const probe = (channel as ClosableChannel).isClosed;
  if (typeof probe !== "function") {
    return false;
  }
  return probe.call(channel) === true;
}

/**
 * Closes one channel, absorbing a throwing `close()`.
 *
 * Closing is best effort by design: the slot has already been given up when this
 * runs, so the channel is unreachable from the pool either way. A throw escaping
 * would let one broken channel stop `closeAll` from closing the rest, which is
 * the shared failure one-connection-per-agent removes for the user.
 *
 * @param channel the channel to close
 */
function closeQuietly(channel: Channel): void {
  try {
    channel.close();
  } catch {
    // A `close()` that throws cannot be allowed to strand the rest of the pool.
  }
}

/**
 * Rejects an agent id the pool cannot key on (same rule and error class as
 * `pool.ts`: a render-path caller must not have to catch anything else).
 *
 * @param agentId the value to check
 */
function assertAgentId(agentId: string): void {
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new TypeError("ChannelPool.getChannel needs a non-empty agent id");
  }
}

/**
 * Rejects a conversation id that was provided but is unusable.
 *
 * @param conversationId the value to check
 */
function assertConversationId(conversationId: string): void {
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new TypeError(
      "ChannelPool.getChannel needs a non-empty conversation id when it is given",
    );
  }
}

/* ------------------------------------------------------------------------- */
/* One registry slot                                                         */
/* ------------------------------------------------------------------------- */

/**
 * One agent's slot in the registry, plus the facade handed out for it.
 *
 * The facade is created with the entry rather than after it, so an entry is
 * always immediately usable and `getChannel` can return on enrolment without
 * building anything.
 */
class RegistryEntry {
  readonly agentId: string;
  /** The creation scope the first `getChannel` named, if it named one. */
  readonly conversationId: string | undefined;
  /** The handle every caller receives for this slot. */
  readonly facade: AlternateChannel;

  /** The built channel, once materialization ran. Closed channels stay here. */
  inner: Channel | null = null;
  phase: Phase = "provisional";
  /** Registry-slot lease plus a lease while the factory runs. See {@link AlternateChannelPool}. */
  leases = 1;
  /** `true` while the factory is running, which is what a close request collides with. */
  materializing = false;
  /**
   * `true` once a build attempt produced no channel.
   *
   * A slot is only enrolled when its endpoint resolved, so before the first
   * attempt `provisional` means "will build on first use". After a failed
   * attempt it means "tried and could not": the difference matters to
   * `channels()`, which must not report an agent as connected on the strength of
   * an attempt that produced nothing, and to `materialize`, which must retry.
   */
  degraded = false;

  constructor(agentId: string, conversationId: string | undefined, pool: AlternateChannelPool) {
    this.agentId = agentId;
    this.conversationId = conversationId;
    this.facade = new AlternateChannel(pool, this);
  }
}

/* ------------------------------------------------------------------------- */
/* The facade                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The `Channel` a caller holds: a placeholder that materializes on first use.
 *
 * Everything the frozen surface requires (send, subscriptions, the capability
 * snapshot, close) is implemented here, and almost all of it is a forced
 * materialization followed by a delegation, so the answer is the kernel's own
 * answer rather than a second implementation of it. The two exceptions are the
 * ones a placeholder must decide alone:
 *
 * - **A retired slot refuses without building.** Nothing was ever constructed,
 *   so there is no channel to ask; the refusal is built from
 *   `channel-errors.ts` so its wording matches the kernel's.
 * - **Subscriptions are fanned out here.** Consumers subscribe to the facade for
 *   its whole life, including across a materialization that happens later, so
 *   the facade keeps the subscriber sets and owns a single inner subscription.
 */
class AlternateChannel implements Channel {
  private readonly pool: AlternateChannelPool;
  private readonly entry: RegistryEntry;

  private readonly eventSubscribers = new Set<(frame: EngineEventFrame) => void>();
  private readonly diagnosticSubscribers = new Set<(record: DiagnosticRecord) => void>();
  private eventPump: (() => void) | null = null;
  private diagnosticPump: (() => void) | null = null;

  constructor(pool: AlternateChannelPool, entry: RegistryEntry) {
    this.pool = pool;
    this.entry = entry;
  }

  /** The agent this channel belongs to; a getter so the facade is one object for life. */
  get agentId(): string {
    return this.entry.agentId;
  }

  /**
   * Sends one command. Never rejects; every failure is the `ok: false` arm.
   *
   * A retired slot answers from the closed channel when one exists, so the
   * `NOT_CONNECTED` wording (readiness prefix included) is the kernel's; a slot
   * that was never built answers the same phrase with the "never came up"
   * prefix, because nothing was ever ready behind it.
   *
   * @param request the capability and body the caller stated
   * @returns the answer, or a classified failure
   */
  send(request: CommandRequest): Promise<CommandResult> {
    const entry = this.entry;
    if (entry.phase === "retired") {
      if (entry.inner !== null) {
        return entry.inner.send(request);
      }
      // Nothing was ever built, so there is no kernel channel to ask for its own
      // wording and this facade has to supply the readiness half itself. An
      // enrolled slot got here only because `getChannel` found an endpoint
      // (`canOpen`), and `degraded` is set only by a build attempt that produced
      // nothing - so a slot that is enrolled and not degraded is one the pool
      // found reachable. Reporting "never came up" for it would contradict the
      // production pool, which built eagerly and therefore always reports the
      // channel's own `everReady`.
      return Promise.resolve({
        ok: false,
        error: notConnectedError(!entry.degraded, CLOSED_PHRASE),
      });
    }
    const inner = this.pool.materialize(entry);
    // A build that finally succeeded may have happened after a subscriber asked
    // for a pump while the slot was still degraded, in which case no pump was
    // attached. Retry here, where a real channel is now known to exist.
    this.attachPumps();
    return inner.send(request);
  }

  /**
   * Subscribes to inbound events.
   *
   * @param subscriber called once per event frame, in arrival order
   * @returns an idempotent unsubscribe function
   */
  onEvent(subscriber: (frame: EngineEventFrame) => void): () => void {
    if (this.entry.phase === "retired") {
      return NOOP;
    }
    this.eventSubscribers.add(subscriber);
    this.startEventPump();
    return () => {
      this.eventSubscribers.delete(subscriber);
    };
  }

  /**
   * Subscribes to diagnostic records.
   *
   * @param subscriber called once per record from now on
   * @returns an idempotent unsubscribe function
   */
  onDiagnostic(subscriber: (record: DiagnosticRecord) => void): () => void {
    if (this.entry.phase === "retired") {
      return NOOP;
    }
    this.diagnosticSubscribers.add(subscriber);
    this.startDiagnosticPump();
    return () => {
      this.diagnosticSubscribers.delete(subscriber);
    };
  }

  /**
   * The capability snapshot, in one of its three states.
   *
   * @returns a fresh snapshot; mutating it cannot change the channel
   */
  capabilities(): CapabilitySnapshot {
    const entry = this.entry;
    if (entry.phase === "retired") {
      return entry.inner === null ? { state: "unknown" } : entry.inner.capabilities();
    }
    const inner = this.pool.materialize(entry);
    this.attachPumps();
    return inner.capabilities();
  }

  /** Whether this slot has been given up. Duck-typed by the pool, like the kernel's. */
  isClosed(): boolean {
    return this.entry.phase === "retired";
  }

  /**
   * Closes this agent's channel.
   *
   * Idempotent, and it never builds: closing a channel that was never used must
   * not open a connection in order to shut it.
   */
  close(): void {
    this.pool.surrender(this.entry);
  }

  /**
   * Attaches the single inner event subscription, once.
   *
   * Kept for the lifetime of the inner channel rather than removed when the last
   * consumer leaves: a consumer that unsubscribes and resubscribes must not pay
   * for a second attach, and the inner channel is closed with the entry anyway.
   */
  /**
   * Attaches whichever pumps are still missing.
   *
   * Called after any operation that may have produced a real channel, because the
   * moment a pump could be attached is not always the moment a subscriber asks
   * for one: a subscriber that attaches while the slot is degraded gets no pump
   * (there is nothing to attach to), and it must not lose the frames that start
   * arriving once the slot recovers. `startEventPump` and `startDiagnosticPump`
   * are idempotent, so calling this repeatedly costs nothing.
   */
  private attachPumps(): void {
    if (this.eventSubscribers.size > 0) {
      this.startEventPump();
    }
    if (this.diagnosticSubscribers.size > 0) {
      this.startDiagnosticPump();
    }
  }

  private startEventPump(): void {
    if (this.eventPump !== null) {
      return;
    }
    const inner = this.pool.materialize(this.entry);
    if (this.entry.inner === null) {
      // Nothing was built, so `inner` is a throwaway stand-in. Recording a pump
      // for it would be worse than doing nothing: the real channel, built on a
      // later use, would find `eventPump` already set and never get a subscriber,
      // so every event would be lost in exactly the state that recovers.
      return;
    }
    this.eventPump = inner.onEvent((frame) => {
      this.deliverEvent(frame);
    });
  }

  /** Attaches the single inner diagnostic subscription, once. */
  private startDiagnosticPump(): void {
    if (this.diagnosticPump !== null) {
      return;
    }
    const inner = this.pool.materialize(this.entry);
    if (this.entry.inner === null) {
      // Same reasoning as {@link startEventPump}: a stand-in gets no pump.
      return;
    }
    this.diagnosticPump = inner.onDiagnostic((record) => {
      this.deliverDiagnostic(record);
    });
  }

  /**
   * Fans one frame out to the current consumers.
   *
   * The iteration is over a snapshot of the set, which is what makes "removing a
   * subscriber affects only future deliveries" true even when a subscriber
   * unsubscribes from inside its own callback. Each delivery is wrapped, so a
   * consumer that throws loses its own frame and nothing else.
   *
   * @param frame the frame the inner channel reported
   */
  private deliverEvent(frame: EngineEventFrame): void {
    for (const subscriber of [...this.eventSubscribers]) {
      try {
        subscriber(frame);
      } catch {
        // A consumer that throws loses its own frame. It must not cost the next
        // subscriber its frame, nor the channel its next frame.
      }
    }
  }

  /**
   * Fans one diagnostic record out to the current consumers.
   *
   * @param record the record the inner channel reported
   */
  private deliverDiagnostic(record: DiagnosticRecord): void {
    for (const subscriber of [...this.diagnosticSubscribers]) {
      try {
        subscriber(record);
      } catch {
        // Same isolation rule as event delivery: a diagnostics panel that throws
        // must not stop the next panel, nor the channel.
      }
    }
  }
}

/* ------------------------------------------------------------------------- */
/* The pool                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The alternate `ChannelPool`: one channel per agent, built on first use.
 *
 * See the file comment for the four differences. The public surface is the
 * frozen {@link ChannelPool}; {@link materialize} and {@link surrender} are
 * public only because the facade is a separate class in this module, and they
 * are not part of any exported contract.
 */
export class AlternateChannelPool implements ChannelPool {
  private readonly factory: ChannelFactory;
  private readonly endpointOf: (agentId: string) => Endpoint | null | undefined;
  private readonly clock: ChannelClock | undefined;

  /**
   * Every slot ever enrolled, in enrolment order: oldest first, newest last.
   *
   * Never sorted, never keyed. A retired entry stays here as a tombstone until
   * {@link sweep} decides there are enough of them; the facade keeps its own
   * entry reachable regardless.
   */
  private readonly registry: RegistryEntry[] = [];

  /**
   * @param options the injected factory, endpoint resolver and clock
   */
  constructor(options: PoolOptions) {
    this.factory = options.createChannel;
    this.endpointOf = options.endpointOf;
    this.clock = options.clock;
  }

  /* --------------------------------------------------------------------- */
  /* Get                                                                   */
  /* --------------------------------------------------------------------- */

  /**
   * Returns the agent's channel, enrolling a slot on first use.
   *
   * **Synchronous, by contract**, and still cheap: enrolling does not construct
   * anything, so nothing on a render path can block here. It does resolve the
   * endpoint, because that is what decides whether the agent can be enrolled at
   * all - see below.
   *
   * Four decisions. The first three are the ones `pool.ts` documents: a
   * conversation id does not open a second channel (the first one stays the
   * creation scope), a channel that closed itself is replaced rather than
   * returned, and a failure to build degrades one agent only.
   *
   * The fourth is the one an earlier version of this file got wrong. **An agent
   * with no endpoint yet is not enrolled.** It gets a fresh stand-in, and the
   * stand-in is not remembered, so `channels()` stays empty and the next call
   * re-resolves. The endpoint is non-null only while the engine is ready, so "no
   * endpoint" is a few hundred milliseconds of normal startup, not a property of
   * the agent; enrolling it would turn that interval into a lifetime sentence
   * that the caller cannot distinguish from a dead transport.
   * The production pool had this defect and this file copied it - which is the
   * case the comment at the top of `alternate-channel.test.ts` records, because a
   * differential suite is structurally unable to catch two implementations that
   * agree on being wrong.
   *
   * @param agentId the agent to address; must be a non-empty string
   * @param conversationId the conversation this channel is being opened for
   * @returns the agent's channel, the same instance on every subsequent call
   * @throws TypeError when the agent id (or a provided conversation id) is unusable
   */
  getChannel(agentId: string, conversationId?: string): Channel {
    assertAgentId(agentId);
    if (conversationId !== undefined) {
      assertConversationId(conversationId);
    }

    const existing = this.newest(agentId);
    if (existing !== undefined) {
      if (!isClosedNow(existing.inner)) {
        return existing.facade;
      }
      // Closed from behind the facade: the slot is a zombie, so give it up
      // before enrolling its successor (mirroring the production pool's
      // delete-then-build order).
      this.retire(existing);
    }

    if (!this.canOpen(agentId)) {
      // Nothing to enrol against: hand out a stand-in this caller owns and leave
      // the registry untouched. A fresh object each time, so two calls cannot be
      // mistaken for one connection.
      return this.unconnected(agentId);
    }

    this.sweep();
    const entry = new RegistryEntry(agentId, conversationId, this);
    this.registry.push(entry);
    return entry.facade;
  }

  /* --------------------------------------------------------------------- */
  /* Read                                                                  */
  /* --------------------------------------------------------------------- */

  /**
   * The channels that are open right now, in creation order.
   *
   * A fresh array on every call, built by filtering the registry: holding it
   * does not keep a retired slot reachable, and a caller mutating it cannot
   * change the pool. Three kinds of slot are omitted, so the array answers "what
   * is connected", not "what did we ever enrol": retired ones, ones whose channel
   * closed itself, and ones whose build produced nothing. A slot that is merely
   * `provisional` **is** reported, because its endpoint resolved and the
   * connection exists as far as every caller is concerned - only the construction
   * is deferred.
   *
   * @returns a snapshot of the live channels
   */
  channels(): readonly Channel[] {
    const live: Channel[] = [];
    for (const entry of this.registry) {
      if (entry.phase === "retired" || entry.degraded || isClosedNow(entry.inner)) {
        continue;
      }
      live.push(entry.facade);
    }
    return live;
  }

  /* --------------------------------------------------------------------- */
  /* Close                                                                 */
  /* --------------------------------------------------------------------- */

  /**
   * Gives up one agent's slot and closes its channel.
   *
   * Only this agent: no other entry is touched, so a neighbour keeps its
   * subscribers, its in-flight requests and its timers. A slot
   * whose factory is running is *not* given up - the pool does not own it yet,
   * which is the same answer the production pool gives by finding no entry - and
   * a request for an agent the pool never enrolled is a no-op.
   *
   * @param agentId the agent whose channel to close
   */
  closeChannel(agentId: string): void {
    const entry = this.newest(agentId);
    if (entry === undefined) {
      return;
    }
    this.retire(entry);
  }

  /**
   * Gives up every slot and closes every channel.
   *
   * **Not a terminal dispose**: a later `getChannel` enrols a fresh slot, so a
   * window closing does not become a permanently dead client.
   *
   * Two phases on purpose. Every slot is marked `retired` *before* any channel
   * is closed, so a `close()` that calls back into the pool observes an empty
   * pool rather than a half-closed one - the behaviour `pool.ts` gets by
   * clearing the map first, reproduced here without a map to clear. Then the
   * leases are released one at a time, each close isolated from the next.
   */
  closeAll(): void {
    const retiring: RegistryEntry[] = [];
    for (const entry of this.registry) {
      if (entry.phase === "retired" || entry.materializing) {
        continue;
      }
      entry.phase = "retired";
      retiring.push(entry);
    }
    for (const entry of retiring) {
      this.release(entry);
    }
    this.sweep();
  }

  /* --------------------------------------------------------------------- */
  /* Materialization (internal)                                            */
  /* --------------------------------------------------------------------- */

  /**
   * Builds the entry's channel on first use, then returns it.
   *
   * Idempotent in one direction only: a channel that really was built is cached
   * in the slot, so a live connection is not rebuilt on every call and the caller
   * always sees one instance. A build that produced *no* channel - the endpoint
   * was not available yet, or the transport refused - is **not** cached and does
   * not set the slot `live`. It hands this caller a stand-in and leaves the slot
   * provisional, so the next call re-resolves and can connect.
   *
   * That asymmetry is the whole point. The endpoint is non-null only while the
   * engine is ready, and the engine is handshaking at startup, so "no endpoint
   * yet" describes a few hundred milliseconds of normal operation, not a property
   * of the agent. Caching the stand-in turns that interval into a lifetime
   * sentence: the agent answers `NOT_CONNECTED` until something closes it, and the
   * caller has no way to tell that from a genuinely dead transport.
   * The production pool had exactly this defect, and this implementation copied
   * it - see the note at the top of `alternate-channel.test.ts` on why a
   * differential suite could not catch it.
   *
   * The factory runs under a build lease, which is what makes a close request
   * arriving mid-build a dropped request rather than a channel closed immediately
   * after being handed out. The lease is released in `finally` whether or not a
   * channel was built, so a failed build cannot strand the slot: `release` finds
   * `inner === null` and leaves the registry lease alone.
   *
   * A use of the facade from inside its own factory cannot recurse: the slot is
   * flagged `materializing` and such a use gets a not-connected stand-in
   * instead. The production pool refuses that re-entry with an error; see the
   * file comment in `alternate-channel.test.ts` for why the two differ and why
   * the difference is a contract gap rather than a defect.
   *
   * @param entry the slot to materialize
   * @returns the built channel, or a fresh stand-in when nothing could be built
   */
  materialize(entry: RegistryEntry): Channel {
    const built = entry.inner;
    if (built !== null) {
      return built;
    }
    if (entry.materializing || entry.phase === "retired") {
      return this.unconnected(entry.agentId);
    }

    entry.materializing = true;
    entry.leases += 1;
    try {
      const inner = this.build(entry);
      if (inner === undefined) {
        // Nothing was built, so nothing is remembered: the slot stays
        // `provisional` and marked degraded, and the stand-in is this caller's
        // alone. A later use retries.
        entry.degraded = true;
        return this.unconnected(entry.agentId);
      }
      entry.inner = inner;
      entry.degraded = false;
      entry.phase = "live";
      return inner;
    } finally {
      entry.materializing = false;
      this.release(entry);
    }
  }

  /**
   * Gives up a slot on behalf of its facade.
   *
   * @param entry the slot the holder is done with
   */
  surrender(entry: RegistryEntry): void {
    this.retire(entry);
  }

  /* --------------------------------------------------------------------- */
  /* Retirement (internal)                                                 */
  /* --------------------------------------------------------------------- */

  /**
   * Marks a slot retired and releases its registry lease.
   *
   * @param entry the slot to retire
   */
  private retire(entry: RegistryEntry): void {
    if (entry.phase === "retired") {
      return;
    }
    if (entry.materializing) {
      return;
    }
    entry.phase = "retired";
    this.release(entry);
  }

  /**
   * Drops one lease, closing the channel when the last one goes.
   *
   * The inner channel is deliberately *not* forgotten: a caller still holding
   * the facade keeps asking the closed channel, which is what gives it the
   * kernel's own `NOT_CONNECTED` wording (readiness prefix included) instead of
   * this file's approximation of it.
   *
   * @param entry the slot whose lease is being returned
   */
  private release(entry: RegistryEntry): void {
    entry.leases -= 1;
    if (entry.leases > 0) {
      return;
    }
    if (entry.inner === null) {
      return;
    }
    closeQuietly(entry.inner);
  }

  /**
   * Drops fully released tombstones once enough have accumulated.
   *
   * Unobservable by design: a facade holds its entry, and the two pool members
   * skip `retired` records regardless of where they sit in the array.
   */
  private sweep(): void {
    let tombstones = 0;
    for (const entry of this.registry) {
      if (entry.phase === "retired" && entry.leases === 0) {
        tombstones += 1;
      }
    }
    if (tombstones < COMPACT_AT) {
      return;
    }
    for (let index = this.registry.length - 1; index >= 0; index -= 1) {
      const entry = this.registry[index];
      if (entry === undefined) {
        continue;
      }
      if (entry.phase === "retired" && entry.leases === 0) {
        this.registry.splice(index, 1);
      }
    }
  }

  /* --------------------------------------------------------------------- */
  /* Lookup (internal)                                                     */
  /* --------------------------------------------------------------------- */

  /**
   * The agent's newest slot that has not been given up.
   *
   * Newest-first is the whole point of the array: a rebuilt agent has several
   * records, and the last live one is its identity.
   *
   * @param agentId the agent to look for
   * @returns the slot, or `undefined` when the agent has none live
   */
  private newest(agentId: string): RegistryEntry | undefined {
    for (let index = this.registry.length - 1; index >= 0; index -= 1) {
      const entry = this.registry[index];
      if (entry === undefined || entry.agentId !== agentId) {
        continue;
      }
      if (entry.phase !== "retired") {
        return entry;
      }
    }
    return undefined;
  }

  /* --------------------------------------------------------------------- */
  /* Construction (internal)                                               */
  /* --------------------------------------------------------------------- */

  /**
   * Builds one channel, degrading to a not-connected one on a runtime failure.
   *
   * The catch is the endpoint seam's promise: whatever the resolver returns -
   * nothing yet, a wrongly shaped value, or a throw - the caller still gets a
   * `Channel`, and it answers `NOT_CONNECTED` with the "has not become ready"
   * wording a reconnect policy can tell apart from "dropped".
   *
   * @param entry the slot being built
   * @returns the built channel, or a degraded stand-in
   */
  /**
   * Whether this agent can be enrolled right now.
   *
   * A resolver that throws answers "not yet", exactly as a `null` does: the
   * engine is mid-handshake and an endpoint read can fail for reasons the caller
   * cannot act on. Treating a throw as fatal here would make `getChannel` - a
   * render-path call - the one place a caller has to catch.
   *
   * @param agentId the agent to resolve for
   * @returns `true` when an endpoint is available
   */
  private canOpen(agentId: string): boolean {
    try {
      return this.resolveEndpoint(agentId) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Builds one channel, or reports that there is nothing to build yet.
   *
   * Returns `undefined` for every "no channel could be built" case, so the caller
   * can hand out a stand-in *without* storing it. Keeping "build a channel" and
   * "decide whether it is worth remembering" separate is what lets
   * {@link materialize} treat a transient condition as transient.
   *
   * A throw from the resolver or the factory is treated as "this agent cannot be
   * opened right now" rather than propagated: the endpoint seam changes nothing
   * for the caller, so whatever the resolver does, the pool still hands out a
   * `Channel`.
   *
   * @param entry the slot to build for
   * @returns the built channel, or `undefined` when there is nothing to build yet
   */
  private build(entry: RegistryEntry): Channel | undefined {
    try {
      const endpoint = this.resolveEndpoint(entry.agentId);
      if (endpoint === null) {
        return undefined;
      }
      return this.factory({
        agentId: entry.agentId,
        conversationId: entry.conversationId,
        endpoint,
        clock: this.clock,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Reads the endpoint, treating every unavailable form as "nothing yet".
   *
   * @param agentId the agent to resolve for
   * @returns the endpoint, or `null` when there is nothing usable
   */
  private resolveEndpoint(agentId: string): Endpoint | null {
    const endpoint = this.endpointOf(agentId);
    if (endpoint === undefined || endpoint === null) {
      return null;
    }
    if (typeof endpoint.url !== "string" || typeof endpoint.token !== "string") {
      return null;
    }
    return endpoint;
  }

  /**
   * The stand-in channel for an agent that could not be connected.
   *
   * Built through the kernel's own factory so a degraded channel behaves like
   * every other one: `send` resolves `NOT_CONNECTED` instead of throwing,
   * subscriptions are accepted and never called, and `capabilities()` answers
   * `unknown`.
   *
   * @param agentId the agent this stand-in belongs to
   * @returns a channel that is never ready
   */
  private unconnected(agentId: string): Channel {
    const clock = this.clock;
    return createChannel({
      agentId,
      write: UNREACHABLE_WRITE,
      readiness: NEVER_READY,
      ...(clock === undefined ? {} : { clock }),
    });
  }
}

/**
 * Builds the comparison pool with the caller's ports filled in.
 *
 * Not exported from any barrel: production constructs
 * {@link EngineChannelPool} through `createChannelPool`.
 *
 * @param options the injected factory, endpoint resolver and clock
 * @returns a pool ready to hand out channels
 */
export function createAlternateChannelPool(options: PoolOptions): AlternateChannelPool {
  return new AlternateChannelPool(options);
}
