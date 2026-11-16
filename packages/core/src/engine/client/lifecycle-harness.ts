/**
 * The lifecycle rig (`lifecycle.test.ts`): one channel per
 * agent, each carrying its **own** handshake / ready / dropped state, all behind
 * the real pool.
 *
 * ## What this rig is for, and what it deliberately is not
 *
 * `multichannel-harness.ts` asks a **horizontal** question: "if C is
 * closed, does A keep receiving?" Its rig therefore has to reach one layer
 * further down - a socket and a real `EngineTransport` per agent - because
 * crossing frames are a statement about *connections*.
 *
 * This rig asks the **vertical** question: "does one channel's own state machine
 * behave like a state machine?" - handshaking refuses, ready writes, a drop
 * changes the wording, a rebuild starts over. That is a statement about the
 * kernel's readiness seam, so there is no socket
 * here at all: the readiness port *is* the transport's report, and the writer
 * double *is* the wire. Adding a transport would not make any assertion in this
 * suite stronger; it would only make the rig a second copy of the horizontal rig.
 *
 * Consequence worth stating, because it is where this suite's coverage stops:
 * the **wiring** that closes the kernel when a socket dies (`transport.onClose`
 * -> `channel.close()`) is the obligation, and this rig *assumes* it exists.
 * A suite that wants to see the socket's own close event must use the horizontal rig fleet;
 * a suite that wants to see what the kernel does once it has been closed is
 * this one.
 *
 * ```
 *   pool.getChannel(agentId)
 *        |
 *        v
 *   EngineChannel (kernel)  ---- write ----> RecordingWriter (the wire)
 *        ^
 *        +-- readiness() ---> that channel's ReadinessCell (handshaking/ready/dropped)
 * ```
 *
 * ## The one thing that makes the suite honest: every channel starts handshaking
 *
 * A channel built ready would let a case assert "ready writes" without ever
 * having produced the state - and a mutant that hard-codes readiness would pass
 * half the suite. So {@link makeLifecycle} builds every channel **not ready and
 * never was** (`{ready: false, everReady: false}`), and a case moves it on with
 * {@link LifecycleHarness.setReady}. Three states then fall out of one port,
 * exactly as `channel.ts`'s readiness port describes them:
 *
 * | state | cell | `send` answers | what it means |
 * |---|---|---|---|
 * | handshaking | `{false, false}` | `NOT_CONNECTED`, "engine has not become ready" | startup problem |
 * | ready | `{true, true}` | writes the frame | usable |
 * | dropped | `{false, true}` | `NOT_CONNECTED`, "channel was ready and dropped" | reconnect problem |
 *
 * The `everReady` half **latches**: once a channel has been usable it keeps the
 * second wording for the rest of its life, which is the fact B3 reads to decide
 * reads when it decides whether a replay is worth attempting - the two English
 * sentences are an interface there, not prose).
 *
 * ## The cell is per channel, and that is the whole point
 *
 * Each factory invocation mints a **fresh** `ReadinessCell` and closes it over
 * that one kernel's readiness port. Two channels therefore cannot share a state
 * even by accident, and a **rebuild** starts from a fresh cell - so a channel
 * that comes back after a drop is truthfully "never ready" rather than
 * inheriting the dead connection's latch. A single module-level cell is the
 * defect `I-1` names, and it is the first mutant this suite is built to kill.
 *
 * ## Discipline this file keeps
 *
 * - **No wire ids.** The one command the cases
 *   send is `channel-test-support`'s `TRACKED` (`conversation.sync`, a dotted
 *   capability name), and the frames the cases inject are that file's
 *   marker-based builders.
 * - **No second copy of a type.** Readiness is `channel.ts`'s own
 *   `ChannelReadiness`; the writer, clock, reader and probe doubles are
 *   `channel-test-support.ts`'s; the pool is the real one.
 * - **No real time.** Every channel is built on one tracked fake clock, so a
 *   request that is never answered costs no wall-clock time and
 *   {@link teardownLifecycles} can demand the clock is silent.
 * - **No hanging promise escapes.** `teardownLifecycles` closes every pool
 *   *before* it inspects the clocks, so the leak detector is not made vacuous by
 *   the teardown itself (a leaked timer shows up as an
 *   unrelated suite timing out 30 s later).
 */

import {
  assertNoLeakedTimers,
  expectSettles,
  makeClock,
  makeProbe,
  makeReader,
  makeWriter,
  trackChannel,
  trackClock,
  TRACKED,
} from "./channel-test-support";
import type { FakeClock, RecordingWriter } from "./channel-test-support";
import { createChannel } from "./channel";
import type { ChannelReadiness, EngineChannel } from "./channel";
import type { EngineClientError } from "./errors";
import { createChannelPool } from "./pool";
import type { ChannelFactory, ChannelOpenContext, EngineChannelPool } from "./pool";
import type { Channel, CommandResult, DiagnosticRecord, Endpoint } from "./types";

/* ------------------------------------------------------------------------- */
/* The state this rig models                                                 */
/* ------------------------------------------------------------------------- */

/**
 * One channel's readiness, in the mutable form the factory needs.
 *
 * `ChannelReadiness` (the injected port's return type) is `readonly`, and it
 * should be: a consumer of the port must not be able to move a channel's state
 * by writing to the value it was handed. The factory, however, *is* the owner -
 * it is the stand-in for the transport that observes the state change - so it
 * keeps the mutable cell privately and hands out read-only snapshots.
 */
type ReadinessCell = { ready: boolean; everReady: boolean };

/**
 * The event type this rig tells its channels they model.
 *
 * The kernel reports an `unknown-event` diagnostic only when it has a type table
 * to compare against; without one it cannot tell an unmodelled type from an
 * unknown one, so it reports neither (see `ChannelOptions.knownEventTypes`).
 * The diagnostic half of the failed-connection case needs a channel that
 * *records* something of its own, so the table is injected.
 */
export const MODELLED_TYPES: ReadonlySet<string> = new Set(["lifecycle.ping"]);

/**
 * A type no build models, owned by agent A in the failed-connection case.
 *
 * Made up rather than drawn from the contract on purpose: this is a forward
 * compatibility marker (a newer engine behind an older host), and a real engine
 * type's spelling would put a wire id under `client/`).
 */
export const UNMODELLED_A = "lifecycle.unmodelled.alpha";

/** The same, owned by agent B, so the two rings are distinguishable. */
export const UNMODELLED_B = "lifecycle.unmodelled.beta";

/* ------------------------------------------------------------------------- */
/* Views                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * One agent's side of the rig: everything a case may observe about it.
 *
 * The reads are live rather than snapshots: "A's wording did not change when C
 * dropped" is a comparison of two *later* readings, and a struct captured at
 * construction could not express it.
 */
export interface LifecycleAgent {
  /** The agent this view belongs to. */
  readonly agentId: string;
  /** The handle the pool returns - what a consumer holds. */
  readonly channel: Channel;
  /** The same object as `channel`; named for the read-only accessors. */
  readonly engine: EngineChannel;
  /** The writer standing in for this agent's wire. */
  readonly writer: RecordingWriter;
  /** This agent's readiness right now, as a copy. */
  readiness(): ChannelReadiness;
  /** This agent's diagnostic ring, oldest first. */
  records(): readonly DiagnosticRecord[];
}

/** What a case can do to the rig, and read back from it. */
export interface LifecycleHarness {
  /** The pool under test: the only thing that decides who has a channel. */
  readonly pool: EngineChannelPool;
  /** The one fake clock every channel in the rig runs on. */
  readonly clock: FakeClock;
  /** The agents that currently have a channel, in creation order. */
  readonly agents: readonly LifecycleAgent[];
  /** One agent's view; throws when that agent has no channel. */
  agent(agentId: string): LifecycleAgent;
  /** One agent's view, or `undefined` - for the case that a build failed. */
  maybe(agentId: string): LifecycleAgent | undefined;
  /** `pool.getChannel`, named after the operation under test. */
  getChannel(agentId: string, conversationId?: string): Channel;
  /**
   * Move **one** channel's readiness, latching `everReady`.
   *
   * This is the transport's report, standing where the socket layer will stand
   * in production: `true` is "the handshake finished, commands may go out",
   * `false` is "it was ready and it dropped". A channel that was never ready
   * stays `{ready: false, everReady: false}`, which is the startup wording.
   *
   * @param agentId the agent whose state moves; must already have a channel
   * @param ready the new `ready` value
   */
  setReady(agentId: string, ready: boolean): void;
  /** This agent's readiness right now (the same read as `agent().readiness()`). */
  readinessOf(agentId: string): ChannelReadiness;
  /** How many times the factory ran, ever - a rebuild is visible as a rise. */
  factoryCalls(): number;
  /** Every factory invocation's context, in creation order. */
  contexts(): readonly ChannelOpenContext[];
  /** The invocations for one agent, in order; two means it was rebuilt. */
  contextsFor(agentId: string): readonly ChannelOpenContext[];
  /** The agents the pool reports as connected, in creation order. */
  channelIds(): readonly string[];
  /** The frames this agent wrote, in write order. */
  writesOf(agentId: string): RecordingWriter["calls"];
  /** This agent's diagnostic ring, oldest first. */
  recordsOf(agentId: string): readonly DiagnosticRecord[];
  /** Feed one raw frame to one agent's kernel, as its transport would. */
  emit(agentId: string, raw: string): void;
}

/* ------------------------------------------------------------------------- */
/* Small readers and helpers                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The endpoint a channel is "built against".
 *
 * No socket is ever opened - the pool only requires a resolver to answer
 * something usable - but it is per agent so a pool that resolved one endpoint
 * and reused it for everyone would still be visible in `contexts()`. The token
 * is per agent and never asserted on: it is a plaintext leak surface, and
 * the token stays out of diagnostics and out of the pool.
 *
 * @param agentId the agent the endpoint belongs to
 * @returns a per-agent endpoint
 */
function endpointFor(agentId: string): Endpoint {
  return { url: `ws://127.0.0.1:1/${agentId}`, token: `token-for-${agentId}` };
}

/** The error text for a read of an agent this rig never built. */
function missing(agentId: string): Error {
  return new Error(
    `the lifecycle rig has no channel for agent "${agentId}"; a failed build leaves no view, ` +
      "so a read must be loud rather than answer for a channel that does not exist",
  );
}

/**
 * A channel's diagnostic ring, for a channel the rig did not build.
 *
 * The pool's degraded stand-in is a real kernel, but the caller only holds the
 * frozen `Channel` surface and `diagnostics()` is not on it (it is the
 * read-the-backlog accessor `EngineChannel` adds for tests and support
 * bundles). Duck-typing keeps this usable with any `Channel`, and answers "no
 * records" for one that cannot be read rather than asserting on a private field.
 *
 * @param channel the channel to read
 * @returns its ring contents, oldest first
 */
export function ringOf(channel: Channel): readonly DiagnosticRecord[] {
  const probe = (channel as { diagnostics?: () => readonly DiagnosticRecord[] }).diagnostics;
  return typeof probe === "function" ? probe.call(channel) : [];
}

/* ------------------------------------------------------------------------- */
/* The rig                                                                   */
/* ------------------------------------------------------------------------- */

/** Pools built by the current test, so teardown can close them. */
const livePools: EngineChannelPool[] = [];

/**
 * Build the rig: one kernel per agent, each with its own readiness cell.
 *
 * Nothing is connected and nothing is ready: see the module header for why every
 * channel starts in handshaking.
 *
 * @param options `failing` names agents whose connection cannot be built at all
 * @returns the rig, registered for teardown
 */
export function makeLifecycle(
  options: { readonly failing?: readonly string[] } = {},
): LifecycleHarness {
  const failing = new Set(options.failing ?? []);
  const clock = trackClock(makeClock());
  const contexts: ChannelOpenContext[] = [];
  const cells = new Map<string, ReadinessCell>();
  const views = new Map<string, LifecycleAgent>();
  let factoryCalls = 0;

  const factory: ChannelFactory = (context) => {
    factoryCalls += 1;
    contexts.push(context);

    const agentId = context.agentId;
    if (failing.has(agentId)) {
      // The whole point of the failed-connection case: this agent's transport
      // refuses, and the pool must turn that into one degraded channel rather
      // than an exception on a render path or a fault on a neighbour.
      throw new Error(`the transport for agent "${agentId}" refused to open a connection`);
    }

    // A fresh cell per build. A rebuild therefore starts at "never ready", which
    // is the truthful state of a new connection and the fact §5.2.2 turns into
    // the startup wording.
    const cell: ReadinessCell = { ready: false, everReady: false };
    cells.set(agentId, cell);

    const writer = makeWriter();
    const engine = createChannel({
      agentId,
      write: writer.write,
      reader: makeReader(),
      probe: makeProbe(),
      knownEventTypes: MODELLED_TYPES,
      readiness: () => ({ ready: cell.ready, everReady: cell.everReady }),
      ...(context.clock === undefined ? {} : { clock: context.clock }),
    });
    trackChannel(engine);

    const view: LifecycleAgent = {
      agentId,
      // The kernel *is* the handle here: with no transport behind it there is
      // nothing else for `close()` to release, and returning it directly keeps
      // `close()` meaning exactly "the wiring closed the kernel" - which is the
      // event the rebuild cases model.
      channel: engine,
      engine,
      writer,
      readiness: () => ({ ready: cell.ready, everReady: cell.everReady }),
      records: () => engine.diagnostics(),
    };
    views.set(agentId, view);
    return engine;
  };

  const pool = createChannelPool({
    createChannel: factory,
    endpointOf: endpointFor,
    clock: clock.clock,
  });
  livePools.push(pool);

  const agent = (agentId: string): LifecycleAgent => {
    const view = views.get(agentId);
    if (view === undefined) {
      throw missing(agentId);
    }
    return view;
  };

  return {
    pool,
    clock,
    get agents() {
      return [...views.values()];
    },
    agent,
    maybe: (agentId) => views.get(agentId),
    getChannel: (agentId, conversationId) =>
      conversationId === undefined
        ? pool.getChannel(agentId)
        : pool.getChannel(agentId, conversationId),
    setReady: (agentId, ready) => {
      const cell = cells.get(agentId);
      if (cell === undefined) {
        throw missing(agentId);
      }
      cell.ready = ready;
      if (ready) {
        cell.everReady = true;
      }
    },
    readinessOf: (agentId) => agent(agentId).readiness(),
    factoryCalls: () => factoryCalls,
    contexts: () => contexts,
    contextsFor: (agentId) => contexts.filter((context) => context.agentId === agentId),
    channelIds: () => pool.channels().map((channel) => channel.agentId),
    writesOf: (agentId) => agent(agentId).writer.calls,
    recordsOf: (agentId) => agent(agentId).records(),
    emit: (agentId, raw) => {
      agent(agentId).engine.ingest(raw);
    },
  };
}

/**
 * Send one tracked command on one agent's channel.
 *
 * The capability is `channel-test-support`'s `TRACKED` (`conversation.sync`), the
 * one dotted name that is both a capability and a request that waits - the
 * property the "ready writes and then settles" assertions need. It is imported
 * rather than written down so this file stays free of engine spellings.
 *
 * @param agent the agent whose channel sends
 * @param requestId the caller-supplied correlation, when a case needs to name it
 * @returns the promise the caller is waiting on
 */
export function sendTracked(agent: LifecycleAgent, requestId?: string): Promise<CommandResult> {
  return agent.channel.send({
    capability: TRACKED,
    body: {},
    runtime: { agent_id: agent.agentId, conversation_id: `conversation-${agent.agentId}` },
    ...(requestId === undefined ? {} : { requestId }),
  });
}

/**
 * The same send, on a channel the rig has no view for.
 *
 * The pool's degraded stand-in is a real kernel but it is **not** a botched
 * build: nothing was constructed for that agent, so the rig has no
 * {@link LifecycleAgent} and {@link sendTracked} cannot be used. Taking the
 * frozen `Channel` directly is what lets the failed-connection case compare C's
 * refusal with A's success on identical terms.
 *
 * @param channel the channel to send on
 * @param requestId the caller-supplied correlation, when a case needs to name it
 * @returns the promise the caller is waiting on
 */
export function sendTrackedOn(channel: Channel, requestId?: string): Promise<CommandResult> {
  return channel.send({
    capability: TRACKED,
    body: {},
    runtime: { agent_id: channel.agentId, conversation_id: `conversation-${channel.agentId}` },
    ...(requestId === undefined ? {} : { requestId }),
  });
}

/**
 * Await a send that must be **refused**, and return the classified failure.
 *
 * Written as a helper for the same reason `expectSettles` exists: a bare `await`
 * on a send that wrongly entered the in-flight table does not fail, it *hangs*
 * until vitest's 30 s timeout and then names neither the regression nor the
 * assertion. `expectSettles` turns that into an immediate, self-describing
 * failure; this layer adds "and it must not have succeeded", so a mutant that
 * drops the readiness check reads as "C's command succeeded while handshaking"
 * instead of as a confusing mismatch on `error.code`.
 *
 * @param pending the send under test
 * @param what a short description for the failure message
 * @returns the `ok: false` arm's error
 * @throws when the send succeeded, or did not settle within one macrotask
 */
export async function refusalOf(
  pending: Promise<CommandResult>,
  what: string,
): Promise<EngineClientError> {
  const result = await expectSettles(pending);
  if (result.ok) {
    throw new Error(`${what} succeeded, but it should have been refused before the wire`);
  }
  return result.error;
}

/**
 * Close every pool the test built, then demand the clocks are silent.
 *
 * `closeAll` runs first on purpose: the invariant is "closing releases
 * everything", and a guard that did the closing itself before inspecting would
 * be vacuous. What must never survive is a timer - one that outlives `close()`
 * holds a promise that can never settle, and in a full run the *next* test pays
 * for it by timing out with no indication of where it came from.
 *
 * @throws when a channel left a timer scheduled
 */
export function teardownLifecycles(): void {
  // Drained in one step rather than popped in a loop: `pop()` is
  // `T | undefined` under `noUncheckedIndexedAccess` even inside a
  // `length > 0` guard, and the resulting defensive branch is code no test can
  // reach - which makes it a line a reader has to skip and a coverage report has
  // to excuse.
  for (const pool of livePools.splice(0, livePools.length)) {
    try {
      pool.closeAll();
    } catch {
      // Teardown must not fail the case it is cleaning up after.
    }
  }
  assertNoLeakedTimers();
}
