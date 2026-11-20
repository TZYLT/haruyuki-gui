/**
 * A four-agent fleet for the isolation suite (`multichannel.test.ts`).
 *
 * Split out of the suite for the repository's file-size limit, and because
 * nothing here belongs to a `describe` block: it is the rig the cases run on.
 * It does not end in `.test.ts` on purpose - vitest collects by that suffix, so
 * a helper that stops being used cannot silently pass as an empty suite.
 *
 * ## What this rig is, and why it is not `pool-test-support.makePool`
 *
 * `channel-test-support.ts` builds a channel over *symbolic* ports (`makeReader`,
 * `makeWriter`): it can say "the channel wrote this request", but not "the
 * bytes went out of this socket and no other". Isolation is a statement about
 * **connections**, so the rig has to reach one layer further
 * down: each agent gets its own fake socket, its own real `EngineTransport`, its
 * own real kernel and the real send path (`buildFrame`), all placed behind the
 * real pool.
 *
 * That difference is what makes the red-ability honest. A mutant that shares
 * the frame listeners (transport layer), the subscriber set (channel layer) or
 * the map (pool layer) crosses at a *different* seam, and each of those seams
 * exists in this rig.
 *
 * ```
 *   pool.getChannel(agentId)
 *        |
 *        v
 *   handle (Channel)  ----- close() ----> kernel.close() + transport.close()
 *        |                                    ^
 *        |                                    |
 *        v                                    |
 *   EngineChannel (kernel)  <--ingest--  EngineTransport  <-- message -- socket
 *        |                                    ^
 *        +-- write -> buildFrame -> transport.send ----------+
 * ```
 *
 * ## The one thing the rig adds, and why it belongs to the factory
 *
 * The frozen `Channel` surface has **no close event** and no reference to a
 * transport: `close()` ends the kernel, and the socket behind it is not the
 * kernel's to close. In production that half has to be owned by whoever built
 * both - the wiring - and it is the only arrangement in which
 * `closeChannel(agentId)` also releases that agent's connection (a channel that
 * closes and leaves its socket open is a leak).
 *
 * So the factory here returns a handle that delegates to the kernel and, on
 * `close()`, closes the kernel and then that agent's transport. The handle also
 * re-exports `isClosed`, which `pool.ts` duck-types (`ClosableChannel`) to keep
 * `channels()` truthful and to replace a self-closed entry - a wrapper that
 * dropped it would make the pool hand out zombies. Both facts are stated here as
 * contract observations rather than silently absorbed.
 *
 * Two consequences the cases rely on, both stated so they cannot be mistaken
 * for test convenience:
 *
 * - **Pool-initiated close is silent on the wiring's `onClose`.** The transport's
 *   own `close()` flips `isOpen` *before* asking the socket to shut, so the
 *   socket's close event is ignored and `onClose` does not fire. A pool-driven
 *   close is therefore observed as `transport.isOpen === false`, a frozen event
 *   stream, `NOT_CONNECTED` on the next send and a shorter `channels()` - never
 *   as a callback.
 * - **Peer-initiated close does fire it.** A socket that dies underneath the
 *   transport is the other close path, and that one *does* run
 *   the wiring this rig installs, which is why {@link FleetAgent.closes} exists.
 *
 * ## Discipline this file keeps
 *
 * - **No wire ids** (this directory is scanned for them). Frames are built by
 *   `channel-test-support`'s marker-based helpers, and the one command the cases
 *   send is the dotted capability name `conversation.sync` from that same file.
 *   `buildFrame` turns it into bytes without this file ever spelling one.
 * - **No real time.** Every kernel is built on one tracked fake clock, so a
 *   request that never answers costs no wall-clock time and the leak detector
 *   can count timers; {@link assertFleetClean} closes the fleet before it
 *   inspects them.
 * - **No duplicated doubles.** The socket stub is `scripted-harness.ts`'s
 *   exported `makeSocketDouble` (a stub is not a second *type*, which is the
 *   thing the no-second-copy rule forbids), and the reader, probe, clock and
 *   frame builders are `channel-test-support.ts`'s.
 */

import { createChannel } from "./channel";
import type { EngineChannel } from "./channel";
import {
  assertNoLeakedTimers,
  eventFrame,
  makeClock,
  makeProbe,
  makeReader,
  trackChannel,
  trackClock,
  TRACKED,
} from "./channel-test-support";
import type { FakeClock } from "./channel-test-support";
import type { ChannelFactory, ChannelOpenContext, EngineChannelPool } from "./pool";
import { createChannelPool } from "./pool";
import { buildFrame } from "./send";
import { makeSocketDouble } from "./scripted-harness";
import type { SocketDouble } from "./scripted-harness";
import { createTransport } from "./transport";
import type { EngineTransport } from "./transport";
import type {
  Channel,
  CommandRequest,
  CommandResult,
  DiagnosticRecord,
  Endpoint,
  EngineEventFrame,
} from "./types";

/* ------------------------------------------------------------------------- */
/* Defaults                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The four agents the suite runs: A, B, C and D.
 *
 * Four rather than two on purpose: "A and B are fine" can be produced by an
 * implementation that happens to have two independent halves (a pair of maps, a
 * pair of sockets), while a third and a fourth agent expose a table that is
 * keyed on something coarser than the agent id. `C` is the victim the close
 * cases evict, and `D` is the neighbour that proves a surviving agent is not
 * merely "the one that was not named".
 */
export const FLEET_AGENT_IDS: readonly string[] = ["a", "b", "c", "d"];

/**
 * The endpoint each agent is given.
 *
 * Distinct per agent so a pool that resolved **one** endpoint and reused it for
 * every channel is caught: the URL carries the agent id, and the cases assert
 * the factory saw each agent's own. The port is fixed and never dialled - no
 * socket is opened against it, because {@link makeFleet} builds the transport
 * over an in-memory stub instead of a real connection.
 *
 * @param agentId the agent the endpoint belongs to
 * @returns a per-agent endpoint
 */
export function endpointFor(agentId: string): Endpoint {
  return {
    url: `ws://127.0.0.1:7022/${agentId}`,
    token: `token-for-${agentId}`,
  };
}

/**
 * The event types this fleet's channels are told they model.
 *
 * The fleet's frames are `channel-test-support`'s `test.ping` / `test.status`
 * markers, so the modelled set is exactly those. Injecting it is what makes an
 * unmodelled frame *reportable*: without a type table the kernel cannot tell an
 * unmodelled type from an unknown one and reports neither (see
 * `ChannelOptions.knownEventTypes`), so a case that wants to count unknown
 * events has to say which types the build knows.
 */
export const MODELLED_TYPES: ReadonlySet<string> = new Set(["test.ping", "test.status"]);

/**
 * A type no build models, used by the per-channel aggregation case.
 *
 * Made up rather than drawn from the contract on purpose: it is a *forward
 * compatibility* case (a newer engine behind an older host), so it must not be a
 * real engine type, whose spelling would be a wire id under `client/`.
 */
export const UNMODELLED_TYPE = "future.engine.never.sent";

/* ------------------------------------------------------------------------- */
/* The views                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * One agent's side of the fleet: everything a case may observe about it.
 *
 * The reader functions are live reads rather than snapshots on purpose. A case
 * that asserted on `Array` fields captured at construction would be asserting
 * on the harness rather than on the channel, and "A kept receiving after C
 * closed" is exactly a comparison of *later* reads.
 */
export interface FleetAgent {
  /** The agent this view belongs to. */
  readonly agentId: string;
  /** The handle the **pool** handed out - what a UI consumer holds. */
  readonly channel: Channel;
  /** The real kernel behind that handle, for the read-only accessors. */
  readonly engine: EngineChannel;
  /** This agent's own transport. Two agents must never share one. */
  readonly transport: EngineTransport;
  /** Event frames this agent's subscriber received, in arrival order. */
  events(): readonly EngineEventFrame[];
  /** Diagnostic records this agent's subscriber received, in arrival order. */
  records(): readonly DiagnosticRecord[];
  /**
   * Close reasons a **peer** reported to this agent's wiring, in order.
   *
   * Empty for a pool-initiated close by construction (see the module header);
   * populated when the socket itself dies, which is the path that runs
   * `transport.onClose` -> `channel.close()`.
   */
  closes(): readonly string[];
  /** Raw frames this agent wrote, in write order. */
  sent(): readonly string[];
  /** The same frames, parsed, for field-level assertions. */
  sentFrames(): readonly Record<string, unknown>[];
  /** The `marker` each delivered frame carried, in delivery order. */
  markers(): readonly unknown[];
  /** The `type` of each delivered frame, in delivery order. */
  types(): readonly string[];
  /** Whether this agent's connection is still open. */
  isOpen(): boolean;
  /**
   * Move **this agent's** readiness, latching `everReady`.
   *
   * Per agent rather than per fleet, which is the whole point: readiness is the
   * third per-channel store (`NOT_CONNECTED` has to say whether the engine ever
   * came up), and a shared one would make one agent's
   * startup state decide another's sends. Latching mirrors the production port:
   * a channel that was once usable keeps the "was ready and dropped" wording
   * forever, which is what tells B3 whether a replay is worth attempting.
   */
  setReady(ready: boolean): void;
}

/** The fleet plus the operations a case performs on it. */
export interface FleetHarness {
  /** The pool under test: the only thing that decides who has a channel. */
  readonly pool: EngineChannelPool;
  /** The one fake clock every channel in the fleet runs on. */
  readonly clock: FakeClock;
  /** The agents, in creation order. */
  readonly agents: readonly FleetAgent[];
  /** One agent's view; throws when that agent was never opened. */
  agent(agentId: string): FleetAgent;
  /** The endpoint resolver this fleet was built with, for the assertions. */
  endpointOf(agentId: string): Endpoint;
  /** Every factory invocation's context, in creation order. */
  contexts(): readonly ChannelOpenContext[];
  /** How many sockets have been built, ever. */
  socketsOpened(): number;
  /** Deliver one raw frame on one agent's socket, as the engine would. */
  emit(agentId: string, raw: string): void;
  /** Kill one agent's socket underneath its transport (the peer-close path). */
  killSocket(agentId: string): void;
  /** `pool.closeChannel`, named after the operation under test. */
  closeChannel(agentId: string): void;
  /** The agents whose connection is still open, in creation order. */
  openAgents(): readonly string[];
}

/* ------------------------------------------------------------------------- */
/* The fleet                                                                 */
/* ------------------------------------------------------------------------- */

/** Fleets built by the current test, so teardown can close them. */
const liveFleets: FleetHarness[] = [];

/**
 * Build a fleet: one socket, one transport, one kernel and one channel per agent.
 *
 * Nothing connects anywhere. The "connection" is `makeSocketDouble`, so frames
 * the cases deliver are the same call path a live socket drives
 * (`socket` -> `transport.onFrame` -> `channel.ingest`) and frames a channel
 * writes are the same bytes `buildFrame` would put on a wire.
 *
 * @param options the agent ids to open, and which of them start out not-yet-ready
 * @returns the fleet, registered for teardown
 */
export function makeFleet(
  options: {
    readonly agentIds?: readonly string[];
    /**
     * Agents whose connection has not become usable yet.
     *
     * This is the startup window: the engine is `idle`,
     * `spawning` or `handshaking`, so a send is refused with "the engine has not
     * become ready". It is an *option* rather than the default because almost
     * every case is about a running fleet, and the one case that needs the
     * startup wording has to be able to ask for a fleet that is still coming up.
     */
    readonly unready?: readonly string[];
  } = {},
): FleetHarness {
  const agentIds = options.agentIds ?? FLEET_AGENT_IDS;
  const unready = new Set(options.unready ?? []);
  const clock = trackClock(makeClock());
  const contexts: ChannelOpenContext[] = [];
  const views = new Map<string, FleetAgent>();
  const order: FleetAgent[] = [];
  const sockets = new Map<string, SocketDouble>();
  const transports: EngineTransport[] = [];
  /**
   * Sockets built, ever.
   *
   * Counted separately from {@link sockets} because that map is keyed on the
   * agent (a rebuilt channel replaces its entry), while "how many connections
   * did the pool open" is a running total: a close-then-reopen must read as two.
   */
  let socketsBuilt = 0;

  const resolve = (agentId: string): Endpoint => endpointFor(agentId);

  const factory: ChannelFactory = (context) => {
    contexts.push(context);

    const socket = makeSocketDouble();
    sockets.set(context.agentId, socket);
    socketsBuilt += 1;

    // The transport is built on the fake socket and the **injected** clock, so
    // "which time source does this channel use" is observable: a factory that
    // forgot to forward the clock would leave the kernel on system timers, which
    // no fake-clock assertion (and no leak detector) can see.
    const transport = createTransport(socket.socket, {
      now: () => clock.clock.now(),
    });
    transports.push(transport);

    const events: EngineEventFrame[] = [];
    const records: DiagnosticRecord[] = [];
    const closes: string[] = [];

    // This agent's readiness, owned here rather than derived from a shared flag.
    // A closed transport is *also* not ready, so the two facts compose: a case can
    // make an agent "never came up" without closing it (the startup state), and a
    // close makes it not-ready on its own.
    const startingUnready = unready.has(context.agentId);
    const readiness = { ready: !startingUnready, everReady: !startingUnready };

    const engine = createChannel({
      agentId: context.agentId,
      write: (request, requestId) => {
        const frame = buildFrame(request, {}, requestId);
        const outcome = transport.send(frame.raw);
        if (!outcome.ok) {
          // The kernel turns a throwing writer into SEND_FAILED, which is the
          // classified answer for "there was a transport and the write still
          // failed". Throwing here rather than dropping the frame
          // is what keeps a lost write from looking like a slow answer.
          throw new Error(outcome.detail);
        }
      },
      reader: makeReader(),
      probe: makeProbe(),
      knownEventTypes: MODELLED_TYPES,
      readiness: () => ({
        ready: readiness.ready && transport.isOpen,
        everReady: readiness.everReady,
      }),
      ...(context.clock === undefined ? {} : { clock: context.clock }),
    });
    trackChannel(engine);

    // The two subscriptions the wiring owns. The close half is
    // what makes a dropped connection visible at all: it settles in-flight
    // requests and refuses later sends.
    transport.onFrame((frame) => {
      engine.ingest(frame.raw);
    });
    transport.onClose((reason) => {
      closes.push(reason);
      engine.close();
    });

    // The handle the pool stores: the frozen surface verbatim, plus the two
    // things the pool and the transport need from whoever built both.
    const handle: Channel & { isClosed: () => boolean } = {
      agentId: context.agentId,
      send: (request: CommandRequest) => engine.send(request),
      onEvent: (subscriber) => engine.onEvent(subscriber),
      onDiagnostic: (subscriber) => engine.onDiagnostic(subscriber),
      capabilities: () => engine.capabilities(),
      close: () => {
        engine.close();
        transport.close();
      },
      isClosed: () => engine.isClosed(),
    };

    // Subscribed through the **handle**, not the kernel: the cases are about what
    // a consumer holding a pool-issued channel sees. A pool that handed out the
    // wrong agent's instance would therefore show up as crossed frames rather
    // than as a harness-internal surprise.
    handle.onEvent((frame) => {
      events.push(frame);
    });
    handle.onDiagnostic((record) => {
      records.push(record);
    });

    const view: FleetAgent = {
      agentId: context.agentId,
      channel: handle,
      engine,
      transport,
      events: () => events,
      records: () => records,
      closes: () => closes,
      sent: () => socket.sent,
      sentFrames: () => socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>),
      markers: () => events.map((frame) => (frame.raw as { marker?: unknown }).marker),
      types: () => events.map((frame) => frame.type),
      isOpen: () => transport.isOpen,
      setReady: (ready) => {
        readiness.ready = ready;
        if (ready) {
          readiness.everReady = true;
        }
      },
    };

    views.set(context.agentId, view);
    order.push(view);
    return handle;
  };

  const pool = createChannelPool({
    createChannel: factory,
    endpointOf: resolve,
    clock: clock.clock,
  });

  const agent = (agentId: string): FleetAgent => {
    const view = views.get(agentId);
    if (view === undefined) {
      throw new Error(`the fleet has no agent "${agentId}"`);
    }
    return view;
  };

  const fleet: FleetHarness = {
    pool,
    clock,
    get agents() {
      return order;
    },
    agent,
    endpointOf: resolve,
    contexts: () => contexts,
    socketsOpened: () => socketsBuilt,
    emit: (agentId, raw) => {
      const socket = sockets.get(agentId);
      if (socket === undefined) {
        throw new Error(`the fleet has no socket for agent "${agentId}"`);
      }
      socket.emitMessage(raw);
    },
    killSocket: (agentId) => {
      const socket = sockets.get(agentId);
      if (socket === undefined) {
        throw new Error(`the fleet has no socket for agent "${agentId}"`);
      }
      socket.emitClose("the peer went away");
    },
    closeChannel: (agentId) => {
      pool.closeChannel(agentId);
    },
    openAgents: () => order.filter((view) => view.transport.isOpen).map((view) => view.agentId),
  };

  liveFleets.push(fleet);
  return fleet;
}

/* ------------------------------------------------------------------------- */
/* Sending                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Send one tracked command on one agent's channel.
 *
 * The request names a **conversation, not a connection**: `runtime` carries the
 * agent and a per-agent conversation id, which is what the send path requires
 * for a conversation-scoped capability and what makes a frame's origin readable
 * from its own bytes. Passing it here rather than in the cases keeps every case
 * from re-deriving the same scope.
 *
 * The capability is `channel-test-support`'s `TRACKED` (`conversation.sync`),
 * the one dotted name that is both a capability and a request that waits - the
 * property the in-flight cases need. It is imported rather than written down so
 * the file stays free of engine spellings.
 *
 * @param agent the agent whose channel sends
 * @param requestId the caller-supplied correlation, when a case needs to name it
 * @returns the promise the caller is waiting on
 */
export function sendOn(agent: FleetAgent, requestId?: string): Promise<CommandResult> {
  return agent.channel.send({
    capability: TRACKED,
    body: {},
    runtime: { agent_id: agent.agentId, conversation_id: `conversation-${agent.agentId}` },
    ...(requestId === undefined ? {} : { requestId }),
  });
}

/**
 * Open all four agents and hand back the fleet.
 *
 * The pool is asked for each agent in creation order, which is also the order
 * `channels()` reports, so a case that asserts on that order is asserting the
 * pool's documented behaviour rather than an accident of the harness. Each agent
 * is opened for its own conversation id, which is the shape we want: one
 * connection per agent, a conversation as its request scope.
 *
 * Lives here for the same reason {@link emitRun} does - it is how a fleet is set
 * up, not what a case asserts - and because the four-agent setup is repeated by
 * nearly every case in the suite.
 *
 * @param options `unready` agents start in the "engine is coming up" window
 * @returns the fleet with A, B, C and D open
 */
export function openFleetOfFour(
  options: { readonly unready?: readonly string[] } = {},
): FleetHarness {
  const fleet = makeFleet(options);
  for (const agentId of FLEET_AGENT_IDS) {
    fleet.pool.getChannel(agentId, `conversation-${agentId}`);
  }
  return fleet;
}

/* ------------------------------------------------------------------------- */
/* Driving one agent's stream                                                */
/* ------------------------------------------------------------------------- */

/**
 * Deliver `count` frames on one agent's socket, each marked `<agent>-<n>`.
 *
 * The marker is test-owned (never engine vocabulary), so a case can name whose
 * frame it is without asserting on wire ids - the whole directory is scanned,
 * this file included. Emitting through the agent's own socket is the point: the
 * frame then travels the production path (`socket` -> `transport.onFrame` ->
 * `channel.ingest`), so an isolation defect anywhere on it is reachable.
 *
 * Lives here rather than in the suite because it is a *fleet operation*, not an
 * assertion: every case that needs "A sent three frames" would otherwise carry
 * its own copy of the loop, and the copies could drift on the marker format that
 * the assertions read back.
 *
 * @param fleet the fleet to drive
 * @param agentId the agent whose connection carries the frames
 * @param count how many frames
 * @param from the first sequence number, so a case can resume a stream
 */
export function emitRun(fleet: FleetHarness, agentId: string, count: number, from = 1): void {
  for (let index = from; index < from + count; index += 1) {
    fleet.emit(agentId, eventFrame("test.ping", { marker: `${agentId}-${String(index)}` }));
  }
}

/* ------------------------------------------------------------------------- */
/* Teardown                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Close every fleet the test built, then demand the clocks are silent.
 *
 * `closeAll` runs first on purpose, for the same reason `pool-test-support`'s
 * teardown does: the invariant is "closing releases everything", and a guard
 * that closed things itself would be vacuous. What must not survive is a timer,
 * because a timer that outlives `close()` holds a promise that can never settle
 * and the *next* test pays for it as an unexplained timeout - a failure mode
 * that once burnt 93 seconds.
 *
 * Transports are closed after the pool, and without error, so a fleet whose
 * `closeAll` was the very thing under test still leaves no socket behind.
 *
 * @throws when a channel left a timer scheduled, or a socket open
 */
export function assertFleetClean(): void {
  while (liveFleets.length > 0) {
    const fleet = liveFleets.pop();
    if (fleet === undefined) {
      continue;
    }
    try {
      fleet.pool.closeAll();
    } catch {
      // Teardown must not fail the case it is cleaning up after; the leftover
      // socket check below still reports anything that stayed open.
    }
    for (const agent of fleet.agents) {
      try {
        agent.transport.close();
      } catch {
        // Same reasoning.
      }
    }
  }

  assertNoLeakedTimers();
}

/**
 * The agents whose connection is still open, as a sorted list.
 *
 * Sorted because every case that reads it is asking "which set", never "in what
 * order"; sort also keeps a failure message stable across creation orders.
 *
 * @param fleet the fleet to read
 * @returns the still-open agent ids, sorted
 */
export function openAgentIds(fleet: FleetHarness): readonly string[] {
  return [...fleet.openAgents()].sort();
}

/**
 * Fail the case when any socket stayed open after a close it should not have
 * survived.
 *
 * Written as an assertion helper rather than left to teardown so a case can
 * prove the *specific* set: "A, B and D are still connected and C is not" is the
 * claim, and a bare "nothing leaked" at teardown cannot say it.
 *
 * @param fleet the fleet to read
 * @param expected the agent ids that must still be open
 * @throws when the open set differs from the expected one
 */
export function expectOpenAgents(fleet: FleetHarness, expected: readonly string[]): void {
  const actual = openAgentIds(fleet);
  const sortedExpected = [...expected].sort();
  if (actual.join(",") !== sortedExpected.join(",")) {
    throw new Error(
      `open agents were [${actual.join(", ")}], expected [${sortedExpected.join(", ")}]; ` +
        "a close that crosses agents is the defect this suite exists for",
    );
  }
}
