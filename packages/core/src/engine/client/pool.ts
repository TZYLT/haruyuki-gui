/**
 * ChannelPool: the `agentId -> Channel` table, and the only place a channel is
 * built, dropped or kept.
 *
 * Shape source:  section 5.1 (the frozen `ChannelPool` signature),
 * section 3.1 (the layer split: the pool decides *who has how many connections*,
 * the channel decides *what happens on one*), section 3.3 (`pool.ts` is this
 * work package's file), section 6.2 (`the bridge`: build/close/local failure) and
 * section 3.6 (the endpoint seam). User-facing behaviour: docs/26 section 4.7
 * and the `` ruling - **one connection per agent**.
 *
 * The pool is deliberately thin, and the thinness is the design:
 *
 * - **It does not own a socket.** The connection, its handshake queue and its
 *   readiness live behind {@link ChannelFactory}, which the wiring
 *   (`wiring.ts`) connects to the transport. That keeps the pool replaceable:
 *   one-connection-many-subscriptions implementation changes this file only,
 *   because no channel code moves.
 * - **It holds no wire vocabulary.** No frame, no field name and no
 *   command name appears here; a channel is addressed by agent id and an
 *   endpoint, both of which are caller-side values.
 * - **It never holds the endpoint.** The endpoint is read once per creation and
 *   handed straight to the factory; it is not stored, not logged and not put in
 *   a diagnostic (the token is a plaintext leak surface). A pool that cached it
 *   leak surface). A pool that cached it would widen that surface from the life
 *   of one creation call to the life of the process.
 * - **It introduces no shared state between channels.** Each channel owns its
 *   own subscriber sets, in-flight table and diagnostics (`channel.ts`); the
 *   pool only keeps the map. There is no pool-level subscriber list to leak a
 *   frame from A to B, which is what `multichannel.test.ts` checks.
 *
 * Five rules the tests are built around, because each one has a user-visible
 * failure mode:
 *
 * 1. **One channel per agent** (``, INV-6). Two calls for one agent return
 *    the same instance; two agents never share one. This is also what makes
 *    "close C and A keeps running" possible at all: there is no shared socket
 *    to cancel . The pool itself 2.3 fact 14 - measured, A finished 10/10 after
 *    C's connection was closed).
 * 2. **A conversation id is not a connection key.** It is a request scope
 *    (documented on the frozen `ChannelPool` type), so a
 *    second conversation for the same agent reuses the channel and the socket.
 *    See {@link EngineChannelPool.getChannel} for why the first binding is the
 *    one the channel is built for.
 * 3. **`getChannel` is synchronous.** It registers intent; it never awaits a
 *    network. A caller on a render path cannot await, and a channel that is not
 *    connected yet answers `NOT_CONNECTED` instead of blocking. The pool itself
 *    5.1). The pool itself has no promise in it at all.
 * 4. **Local failure does not spread.** One agent's close, one agent's failed
 *    agent's failed creation and one agent's throwing `close()` touch that agent
 *    else. This is the whole value of one connection per agent: no shared
 *    no shared failure.
 * 5. **`closeAll` is not a terminal dispose.** It closes what exists now and
 *    drops the entries; a later `getChannel` builds a fresh channel. It is the
 *    "close the window" action, not "shut the pool down for good", and it says
 *    so here so nobody adds a `disposed` flag that would turn a user closing a
 *    window into a permanently dead client.
 */

import { createChannel } from "./channel";
import type { ChannelClock, ChannelReadiness, ChannelWriter } from "./channel";
import type { Channel, ChannelPool, Endpoint } from "./types";

/* ------------------------------------------------------------------------- */
/* Injected ports                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Everything a factory needs to open one agent's connection.
 *
 * `endpoint` is `null` when the engine has no usable endpoint yet - it is not
 * ready, or the caller's resolver had nothing to give. Passing `null` rather
 * than throwing is what lets a factory decide for itself whether it can build a
 * channel now (for example one whose readiness flips when the engine comes up)
 * or must give up; it can also simply throw, and the pool degrades that one
 * agent to a not-connected channel (see {@link EngineChannelPool.getChannel}).
 *
 * `clock` is `undefined` when the caller did not inject one; a factory that
 * needs deterministic timers must pass it on to the channel rather than
 * defaulting to the system clock behind the caller's back.
 */
export interface ChannelOpenContext {
  /** The agent this channel will belong to. */
  readonly agentId: string;
  /**
   * The conversation the channel is being opened for, when the caller named
   * one. It is a *default request scope*, never a second connection: the frozen
   * `ChannelPool` doc comment states that two conversation ids for one agent
   * share the same socket.
   */
  readonly conversationId: string | undefined;
  /** Where to connect, or `null` when there is nothing to connect to yet. */
  readonly endpoint: Endpoint | null;
  /** The injected time source, or `undefined` for the channel's own default. */
  readonly clock: ChannelClock | undefined;
}

/**
 * Builds one agent's channel: transport, wiring and all.
 *
 * This is the pool's only construction seam, and it is a *function* rather than
 * a set of ports on purpose. A transport has to be given the channel it feeds
 * (`ingest`), and the channel has to be given the transport it writes through;
 * that cycle has to be closed by whoever builds both. The factory is that
 * whoever, so the pool does not need a post-construction hook and does not need
 * to know what a transport is.
 */
export type ChannelFactory = (context: ChannelOpenContext) => Channel;

/** What the pool needs from its caller, all of it injected. */
export interface PoolOptions {
  /**
   * Builds one agent's channel (see {@link ChannelFactory}). Required: the pool
   * has no default that could connect, and a silently defaulted factory would
   * fail at the first send instead of at construction.
   */
  readonly createChannel: ChannelFactory;
  /**
   * Resolves the endpoint to connect to, per agent.
   *
   * Typed per agent even though this build has one engine process, so the seam
   * matches the shape the pool will need when it is not one: the wiring passes
   * `() => engine.endpoint` and ignores the argument.
   * `null` means "not available yet" and is normal, not an error - the engine's
   * endpoint is `null` until its state is ready. A throw is treated the same
   * way (that agent degrades), because a render-path caller must not have to
   * catch to obtain a channel.
   */
  readonly endpointOf: (agentId: string) => Endpoint | null | undefined;
  /**
   * The time source handed to every channel. Optional; when omitted the channel
   * falls back to its own system clock. Tests inject a fake so a timeout costs
   * no wall-clock time.
   */
  readonly clock?: ChannelClock;
}

/* ------------------------------------------------------------------------- */
/* Errors                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Raised when a factory calls back into `getChannel` for the agent it is
 * currently building.
 *
 * The pool could return a half-built channel here, but there is no honest one
 * to return: the entry does not exist yet, and inventing a placeholder would
 * mean one `getChannel` handing out two different instances for one agent. It
 * is a programming error in the factory, so it is loud, and it is *the pool's
 * own* error - `getChannel` re-raises it instead of degrading the agent the way
 * it degrades a runtime failure (see {@link EngineChannelPool.getChannel}).
 */
export class ChannelPoolReentryError extends Error {
  /** The agent whose creation re-entered the pool. */
  readonly agentId: string;

  /**
   * @param agentId the agent being built when the re-entry happened
   */
  constructor(agentId: string) {
    super(
      `ChannelPool.getChannel re-entered for agent "${agentId}" while that agent's ` +
        "channel was still being built. A channel factory must not call back into the " +
        "pool for the same agent; build the channel and return it.",
    );
    this.name = "ChannelPoolReentryError";
    this.agentId = agentId;
  }
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * A channel that may report its own closure.
 *
 * `Channel` is frozen and has no `isClosed`; `EngineChannel` has it, and its own
 * doc comment says the pool is one of the two readers that need it. Duck typing
 * rather than a concrete import keeps the pool usable with any `Channel`
 * implementation (including the one in `alternate-channel.ts`): a channel
 * that does not report closure is simply never dropped externally, and the pool
 * behaves as if it were open.
 */
type ClosableChannel = Channel & { readonly isClosed?: () => boolean };

/**
 * Whether a channel has closed itself, without the pool's help.
 *
 * A consumer holds a `Channel` and may call `close()` on it directly; the frozen
 * contract says that is idempotent and affects nothing else. If the pool kept
 * handing that instance out, every later send would fail `NOT_CONNECTED`
 * forever - a zombie entry. Reporting closure here is what lets `channels()`
 * omit it and `getChannel` rebuild it.
 *
 * @param channel the channel to inspect
 * @returns `true` only when the channel both has the accessor and reports closed
 */
function isClosedNow(channel: Channel): boolean {
  const probe = (channel as ClosableChannel).isClosed;
  if (typeof probe !== "function") {
    return false;
  }
  return probe.call(channel) === true;
}

/**
 * Closes one channel, absorbing a throwing `close()`.
 *
 * Closing is best effort by design: the entry is already gone from the map when
 * this runs, so the channel is unreachable from the pool either way. Letting the
 * throw escape would mean one broken channel can stop `closeAll` from closing
 * the rest - a shared failure over a per-agent fault, which is exactly the class
 * of bug one-connection-per-agent removes for the user. The channel's own defect still surfaces
 * where it belongs: in that channel's diagnostics, or in the test that owns it.
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
 * Rejects an agent id the pool cannot key on.
 *
 * `getChannel` is the one synchronous entry a render path calls, and it is
 * documented not to throw except for invalid input - the same carve-out
 * `Channel.send` states ("never throws, except for invalid arguments"). An empty
 * or non-string id would otherwise create a channel nobody can address again,
 * which is worse than a loud argument error at the call site.
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
 * An *absent* conversation id is legitimate - plenty of channels are opened
 * before the UI knows which conversation it will show - so only a provided but
 * empty or non-string value is refused. It would be stored as the channel's
 * creation scope and never match a real conversation.
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

/**
 * The readiness port of a channel that has no connection at all.
 *
 * `everReady: false` is the load-bearing half: it makes `NOT_CONNECTED` say
 * "engine has not become ready" rather than "was ready and dropped", which is
 * the distinction a reconnect policy needs in order to tell a startup problem
 * tell a startup problem from a dropped connection.
 *
 * @returns never ready, and never was
 */
const NEVER_READY: () => ChannelReadiness = () => ({ ready: false, everReady: false });

/**
 * The writer of a channel that has no connection: unreachable by construction.
 *
 * A degraded channel reports not-ready, and `send` checks readiness *before* it
 * writes (`channel.ts`), so this is never called. It throws rather than
 * returning quietly so that a future change which starts writing anyway fails
 * loudly in a test instead of dropping a command on the floor - a silent drop is
 * is the one failure mode that must never happen.
 */
const UNREACHABLE_WRITE: ChannelWriter = () => {
  throw new Error(
    "a channel with no endpoint wrote a command: readiness must refuse before the write",
  );
};

/* ------------------------------------------------------------------------- */
/* The pool                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The production `ChannelPool`: one channel per agent, built on demand.
 *
 * Not to be constructed directly in most code - {@link createChannelPool} is
 * the convenience form - but it is safe to do so; the constructor takes the
 * whole option object and keeps no global state.
 */
export class EngineChannelPool implements ChannelPool {
  private readonly factory: ChannelFactory;
  private readonly endpointOf: (agentId: string) => Endpoint | null | undefined;
  private readonly clock: ChannelClock | undefined;

  /** The live map. Insertion order is creation order, which `channels()` keeps. */
  private readonly entries = new Map<string, Channel>();

  /**
   * Agents whose factory is running right now.
   *
   * Only re-entrancy uses it: a factory that asks the pool for the agent it is
   * building would otherwise recurse until the stack ends. Cross-agent calls
   * from inside a factory are fine and are not blocked.
   */
  private readonly opening = new Set<string>();

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
   * Returns the agent's channel, building it on first use.
   *
   * **Synchronous, by contract.** It registers intent and returns; the factory
   * may still be connecting (or may connect in the background), and a command
   * sent before the channel is ready answers `NOT_CONNECTED` rather than
   * waiting. An `async` signature here would force `await` into every render
   * path.
   *
   * Three decisions this method makes, none of them obvious:
   *
   * - **A conversation id does not open a second channel.** The frozen
   *   `ChannelPool` contract says two conversation ids for one agent share the
   *   same socket, so a second id returns the existing channel. The *first*
   *   conversation the channel was built for stays its creation scope: the
   *   channel was opened (subscribed, handed to the factory) for that scope, and
   *   re-scoping an established connection behind the caller's back would
   *   redirect commands another caller already issued - the exact cross-talk
   *   one-connection-per-agent removes. A caller that needs a different scope states it per
   *   request (`CommandRequest.runtime`); if a *second connection* per
   *   conversation is ever wanted, that is a different pool, not a flag here
   *   (see the work report for the blast radius).
   * - **A wrapper that closed itself is replaced, not returned.** A consumer may
   *   call `close()` on the `Channel` it holds. Returning that instance would
   *   make every later send fail forever, so the dead entry is dropped and a
   *   fresh channel built. The caller holding the old one must re-fetch.
   * - **Failure degrades one agent, and only that agent.** If the endpoint
   *   resolver throws, or the factory throws, this agent gets a channel that
   *   reports not-connected (`NOT_CONNECTED`, "engine has not become ready")
   *   instead of an exception escaping into a render path. Other agents are
   *   untouched.
   * - **A stand-in is not cached, because "no endpoint yet" is temporary.** The
   *   one thing this method must not do is promote a *moment* into a *verdict*:
   *   the endpoint is non-null only while the engine is ready, and the engine is
   *   engine is handshaking at startup, so "null endpoint" describes the normal
   *   first few hundred milliseconds - during which a window may well ask for a
   *   channel to restore a conversation. Caching the stand-in would make that
   *   agent unreachable for the whole process, with no retry and no signal the
   *   caller could act on. So the stand-in is returned *and not stored*: every
   *   later call re-resolves the endpoint, and the first call after readiness
   *   builds the real channel.
   *
   *   The cost is one throwaway channel per `getChannel` while the engine is not
   *   ready - bounded by render passes during startup, and cheap (no socket, no
   *   timer, no log subscription beyond the kernel's own). The alternative -
   *   caching a stand-in and later swapping it - buys that back by keeping a
   *   second state bit whose "is this a real entry or a placeholder?" question
   *   collides with the self-closed check below, to save an allocation that
   *   already happens on every frame.
   *
   *   This is what makes a failed connection retryable at all: re-fetching is the
   *   retry, so the pool needs no reconnect policy of its own.
   *
   * The one error that *does* escape is the pool's own re-entrancy error, which
   * is a factory bug rather than a runtime condition (see
   * {@link ChannelPoolReentryError}).
   *
   * @param agentId the agent to address; must be a non-empty string
   * @param conversationId the conversation this channel is being opened for
   * @returns the agent's channel, the same instance on every subsequent call
   * @throws TypeError when the agent id (or a provided conversation id) is unusable
   * @throws ChannelPoolReentryError when a factory re-enters for the same agent
   */
  getChannel(agentId: string, conversationId?: string): Channel {
    assertAgentId(agentId);
    if (conversationId !== undefined) {
      assertConversationId(conversationId);
    }

    const existing = this.entries.get(agentId);
    if (existing !== undefined) {
      if (!isClosedNow(existing)) {
        return existing;
      }
      // Closed from outside: the entry is a zombie, so drop it and rebuild. The
      // delete happens before the build so a failed rebuild cannot resurrect it.
      this.entries.delete(agentId);
    }

    if (this.opening.has(agentId)) {
      throw new ChannelPoolReentryError(agentId);
    }

    this.opening.add(agentId);
    try {
      const channel = this.open(agentId, conversationId);
      // Only a channel that could be built becomes an entry. A stand-in is
      // returned to this caller but never stored: storing it would answer
      // "unreachable" for the rest of the process on the strength of a state that
      // lasts a few hundred milliseconds at startup (see the doc comment above).
      if (channel !== undefined) {
        this.entries.set(agentId, channel);
        return channel;
      }
      return this.unconnected(agentId);
    } finally {
      this.opening.delete(agentId);
    }
  }

  /* --------------------------------------------------------------------- */
  /* Read                                                                  */
  /* --------------------------------------------------------------------- */

  /**
   * The channels that are open right now, in creation order.
   *
   * A fresh array on every call: holding it does not keep a closed channel
   * reachable, and iterating it while another part of the process closes a
   * channel is safe (the frozen contract says exactly that). Channels that
   * closed themselves are omitted, so the array answers "what is connected",
   * not "what did we ever build". Reading does not mutate the map; a stale entry
   * for a self-closed channel is dropped on the next `getChannel` instead.
   *
   * @returns a snapshot of the live channels
   */
  channels(): readonly Channel[] {
    const live: Channel[] = [];
    for (const channel of this.entries.values()) {
      if (!isClosedNow(channel)) {
        live.push(channel);
      }
    }
    return live;
  }

  /* --------------------------------------------------------------------- */
  /* Close                                                                 */
  /* --------------------------------------------------------------------- */

  /**
   * Closes one agent's channel and drops its entry.
   *
   * This is the operation one connection per agent exists for: it closes
   * channel. Other channels keep their entries, their subscribers, their
   * in-flight requests and their timers, so an agent that is mid-answer keeps
   * mid-answer keeps answering after a neighbour is closed.
   * Nothing here touches the map entry of another agent, and there is no
   * pool-level resource to dispose - the whole point of one channel per agent.
   *
   * Idempotent, and lenient about unknown agents: closing something that is not
   * there is a no-op, not an error, because the caller (a window closing, a
   * sidebar action) cannot be expected to know the pool's current contents.
   *
   * The entry is removed *before* the channel is closed, so a `close()` that
   * somehow calls back into the pool cannot observe a half-closed entry.
   *
   * @param agentId the agent whose channel to close
   */
  closeChannel(agentId: string): void {
    const channel = this.entries.get(agentId);
    if (channel === undefined) {
      return;
    }
    this.entries.delete(agentId);
    closeQuietly(channel);
  }

  /**
   * Closes every channel and empties the pool.
   *
   * **Not a terminal dispose.** It closes the channels that exist now; a later
   * `getChannel` builds a fresh one. That follows from what this operation means
   * to a user: a window closing is not a decision to have no client for the rest
   * of the session, and a pool that latched a `disposed` flag here would turn
   * closing one window into a permanently dead client. (`Engine.stop` is where
   * "this engine is over" belongs; the pool has no opinion about it.)
   *
   * The map is cleared before any channel closes, so a `close()` that re-enters
   * the pool sees an empty pool rather than a half-closed one, and every
   * channel's `close()` is isolated: one throwing cannot leave the rest open.
   *
   * Idempotent: on an empty pool it does nothing.
   */
  closeAll(): void {
    const closing = [...this.entries.values()];
    this.entries.clear();
    for (const channel of closing) {
      closeQuietly(channel);
    }
  }

  /* --------------------------------------------------------------------- */
  /* Construction                                                          */
  /* --------------------------------------------------------------------- */

  /**
   * Builds one channel, degrading to a not-connected one on a runtime failure.
   *
   * The catch is deliberately narrow in what it swallows: anything that is not
   * the pool's own re-entrancy error is treated as "this agent's connection
   * could not be opened" - the endpoint was not available, the transport refused
   * or the factory threw - and becomes a channel that answers `NOT_CONNECTED`.
   * That is  section 3.6.3's promise that the endpoint seam changes
   * nothing here: whatever the resolver returns, the pool still hands the caller
   * a `Channel`.
   *
   * Returns `undefined` when no channel could be built, so the caller can hand out
   * a stand-in without storing it. Keeping "build a channel" and "decide whether
   * it is worth remembering" separate is what lets `getChannel` treat a transient
   * condition as transient.
   *
   * @param agentId the agent to build for
   * @param conversationId the creation scope, when the caller named one
   * @returns the built channel, or `undefined` when there is nothing to build yet
   */
  private open(agentId: string, conversationId: string | undefined): Channel | undefined {
    try {
      const endpoint = this.resolveEndpoint(agentId);
      if (endpoint === null) {
        return undefined;
      }
      return this.factory({ agentId, conversationId, endpoint, clock: this.clock });
    } catch (error) {
      if (error instanceof ChannelPoolReentryError) {
        throw error;
      }
      return undefined;
    }
  }

  /**
   * Reads the endpoint, treating every unavailable form as "nothing yet".
   *
   * Three cases collapse to `null` on purpose: an absent endpoint (the engine is
   * not ready), an endpoint that is not the shape the contract promises (a
   * wiring bug), and a resolver that throws (a runtime condition). Only the
   * middle one is a defect, and it is still not worth costing the user a
   * channel: the failure is visible as `NOT_CONNECTED` and as the diagnostics
   * the transport never produced. The returned object is passed straight to the
   * factory and never retained.
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
   * Built through the kernel's own factory (the pool's only construction entry)
   * rather than hand-rolled, so a degraded channel behaves like every other one:
   * `send` resolves `NOT_CONNECTED` instead of throwing, subscriptions are
   * accepted and never called, and `capabilities()` answers `unknown`. That is
   * what lets an upper layer treat "no endpoint yet" and "connected" with the
   * same code path.
   *
   * Deliberately **not** inserted into `entries`: it is a reply, not a
   * connection. `channels()` therefore keeps reporting only real connections, and
   * `closeChannel` has nothing to close for an agent that never got one.
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
 * Builds the pool with the caller's ports filled in.
 *
 * @param options the injected factory, endpoint resolver and clock
 * @returns a pool ready to hand out channels
 */
export function createChannelPool(options: PoolOptions): EngineChannelPool {
  return new EngineChannelPool(options);
}
