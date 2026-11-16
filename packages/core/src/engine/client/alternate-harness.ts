/**
 * Differential harness for the interface-equivalence comparison.
 *
 * One claim about the `ChannelPool` seam: **swapping
 * the implementation changes one layer and nothing above it**. A claim like that
 * is only worth the test that can falsify it, and the only test that can is one
 * that runs *one* caller script against *two* implementations and compares what
 * the caller saw. This file is that rig, and `alternate-channel.test.ts` is the
 * evidence.
 *
 * Four design decisions, because each of them is what makes a green run mean
 * something:
 *
 * 1. **The rig never sees either implementation class.** {@link World.pool} is
 *    typed `ChannelPool`, the frozen interface. If the
 *    two implementations could be driven through their own members, the
 *    comparison would be about those members instead of about the contract, and
 *    a caller holding only the interface would have no such members to call.
 *
 * 2. **A script is data, not code.** A step is a plain object and
 *    {@link runScript} is the only thing that interprets it, so the *same* script
 *    object runs against both worlds. A caller written twice - once per pool -
 *    would drift, and the drift would silently narrow the comparison instead of
 *    failing it.
 *
 * 3. **A handle is a value the script can keep.** `send` delivers on the handle a
 *    previous `get` returned, not on a fresh lookup, because the interesting
 *    question is about a handle a caller is *still holding*
 *    after a close. Re-looking the channel up would quietly test the rebuild
 *    path instead.
 *
 * 4. **Observations are normalised dirt.** A log entry holds only values a caller
 *    can obtain through the frozen interface: command results, events,
 *    diagnostics, capability snapshots, `channels()` order and per-world channel
 *    tokens. It deliberately does **not** hold transport-side facts the pool
 *    owns - factory call counts, writer call lists, close counts, or a minted
 *    request id (whose random suffix differs per process) - because those are
 *    internal policy, not contract. Comparing them would either produce false
 *    failures for a legitimate implementation or force every future
 *    implementation to copy the production pool's construction order. Where one
 *    of those internals leaks into a caller-visible value,
 *    `alternate-channel.test.ts` measures the leak on its own and calls it a
 *    finding rather than papering over it.
 *
 * Time is fake in both worlds, from the same `makeClock` fake the channel suites
 * use, and every clock and channel is registered with the shared leak detector.
 * A scenario that leaves a timer behind therefore fails in `afterEach` with a
 * self-describing message instead of turning into an unrelated thirty-second
 * timeout - the failure mode `snapshot assembly` paid ninety-three seconds of gate budget to
 * learn.
 */

import { expect } from "vitest";

import {
  assertNoLeakedTimers,
  eventFrame,
  makeClock,
  makeProbe,
  makeReader,
  makeWriter,
  responseFrame,
  trackChannel,
  trackClock,
} from "./channel-test-support";
import type { FakeClock, RecordingWriter } from "./channel-test-support";
import { AlternateChannelPool } from "./alternate-channel";
import { EngineChannel, createChannel } from "./channel";
import type { ChannelClock } from "./channel";
import type { ChannelFactory } from "./pool";
import { createChannelPool } from "./pool";
import type {
  CapabilitySnapshot,
  Channel,
  ChannelPool,
  CommandResult,
  DiagnosticRecord,
  Endpoint,
  EngineEventFrame,
} from "./types";
import type { CapabilityName } from "@haruyuki/protocol";

/* ------------------------------------------------------------------------- */
/* Observations                                                              */
/* ------------------------------------------------------------------------- */

/**
 * One thing the caller saw, normalised for comparison.
 *
 * The union is closed and JSON-shaped on purpose: {@link runDual} compares two
 * logs with `toEqual`, so anything that cannot be compared structurally (a
 * `Map`, an object identity, a promise) would make the comparison either always
 * pass or always fail. Channel identity is therefore carried as a per-world
 * token rather than as the object.
 */
export type Observation =
  | {
      readonly op: "get";
      readonly handle: string;
      readonly agent: string;
      readonly instance: string;
    }
  | { readonly op: "channels"; readonly live: readonly { agent: string; instance: string }[] }
  | { readonly op: "send"; readonly label: string; readonly handle: string }
  | { readonly op: "settle"; readonly label: string; readonly result: ResultView }
  | { readonly op: "capabilities"; readonly agent: string; readonly snapshot: CapabilitySnapshot }
  | { readonly op: "advance"; readonly ms: number; readonly pending: number }
  | { readonly op: "drain"; readonly label: string; readonly result: ResultView }
  | { readonly op: "sees"; readonly label: string; readonly seen: readonly unknown[] };

/** A `CommandResult` as a caller can compare it. */
export type ResultView = {
  readonly ok: boolean;
  /** Absent on success, so two successes cannot differ on a failure field. */
  readonly code?: string;
  /** Absent on success. Prose, for humans. */
  readonly detail?: string;
  /** Present on success: the answer itself, so two different answers cannot compare equal. */
  readonly data?: unknown;
};

/**
 * Reduce a `CommandResult` to the fields a caller can observe.
 *
 * `data` is carried on success: it is the answer, and two pools that answered
 * differently are not equivalent. `detail` is carried on failure because the
 * *wording* is contract at one point - there are two `NOT_CONNECTED` states -
 * `NOT_CONNECTED` states - and a comparison that dropped it could not tell
 * "never came up" from "was ready and dropped". `raw` is not carried: it is the
 * untouched frame, identical for both by construction.
 *
 * @param result the result a caller received
 * @returns the comparable view
 */
export function viewOfResult(result: CommandResult): ResultView {
  if (result.ok) {
    return { ok: true, data: result.data };
  }
  return { ok: false, code: result.error.code, detail: result.error.detail };
}

/**
 * One diagnostic record as a caller can compare it.
 *
 * `at` is included: both worlds run one fake clock started at the same epoch and
 * advanced by the same script, so two records produced by the same cause carry
 * the same timestamp. Dropping it would let a redesign that stamped records from
 * a different source pass the comparison.
 *
 * @param record the record a subscriber received
 * @returns the comparable view
 */
export function viewOfRecord(record: DiagnosticRecord): {
  readonly kind: string;
  readonly subject: string;
  readonly engineText?: string;
  readonly at: number;
} {
  return record.engineText === undefined
    ? { kind: record.kind, subject: record.subject, at: record.at }
    : { kind: record.kind, subject: record.subject, engineText: record.engineText, at: record.at };
}

/**
 * One event frame as a caller can compare it.
 *
 * @param frame the frame a subscriber received
 * @returns the comparable view
 */
export function viewOfFrame(frame: EngineEventFrame): {
  readonly type: string;
  readonly raw: unknown;
  readonly at: number;
  readonly envelope: unknown;
} {
  return { type: frame.type, raw: frame.raw, at: frame.at, envelope: frame.envelope };
}

/* ------------------------------------------------------------------------- */
/* A world: one pool plus everything a test can see of it                    */
/* ------------------------------------------------------------------------- */

/** What one agent's built channel exposes to the test side. */
export interface AgentView {
  readonly channel: Channel;
  readonly writer: RecordingWriter;
  readonly events: EngineEventFrame[];
  readonly records: DiagnosticRecord[];
}

/**
 * One pool and the observables around it.
 *
 * `pool` is the frozen interface and nothing else, which is the constraint the
 * whole comparison rests on. The rest is test plumbing: the fake clock, the
 * factory-call counter (reported, never compared), the per-agent
 * writer/subscriber recorders, an endpoint switch, and the token table that
 * turns object identity into comparable data.
 */
export interface World {
  readonly kind: "production" | "alternate";
  readonly pool: ChannelPool;
  readonly clock: FakeClock;
  /** Replace what the endpoint resolver answers from now on; `null` restores the default. */
  setEndpoint(next: ((agentId: string) => Endpoint | null | undefined) | null): void;
  /** Factory invocations so far. Internal policy; never part of a comparison log. */
  factoryCalls(): number;
  /** The views of every channel the factory built, keyed by agent. */
  viewOf(agentId: string): AgentView | undefined;
  /** Feed one raw frame to one agent's channel, as a transport would. */
  ingest(agentId: string, raw: string): void;
  /** The stable comparison token for a channel object. */
  tokenOf(channel: Channel): string;
  /** Every event frame any subscriber would have seen, per agent, for a test to diff. */
  eventsOf(agentId: string): readonly unknown[];
  /** Every diagnostic record the channel stored, per agent, for a test to diff. */
  recordsOf(agentId: string): readonly unknown[];
  /** The writer calls for one agent, for the cases where reaching the transport *is* the assertion. */
  writesOf(agentId: string): readonly string[];
  /** The context each factory invocation received, in creation order. */
  contexts(): readonly { agentId: string; conversationId: string | undefined }[];
  /** Close the built channel behind the pool's back, as a transport may. */
  closeInnerOf(agentId: string): void;
}

/** A well-formed endpoint, built per agent so a mix-up is visible. */
export function endpointFor(agentId: string): Endpoint {
  return { url: `ws://127.0.0.1:1/${agentId}`, token: `token-for-${agentId}` };
}

/**
 * Build one world around the caller's pool constructor.
 *
 * The factory mirrors `pool-test-support.ts`: with no endpoint it throws, so the
 * pool has to degrade the agent, and with one it builds a real kernel on the
 * fake clock with the recorder ports wired. Everything it builds is registered
 * with the leak detector.
 *
 * @param kind which implementation this world drives
 * @param build the constructor under test
 * @returns the world
 */
function makeWorld(
  kind: "production" | "alternate",
  build: (
    factory: ChannelFactory,
    resolve: (agentId: string) => Endpoint | null | undefined,
    clock: ChannelClock,
  ) => ChannelPool,
): World {
  const clock = trackClock(makeClock());
  const contexts: { agentId: string; conversationId: string | undefined }[] = [];
  const views = new Map<string, AgentView>();
  const tokens = new Map<Channel, string>();
  let factoryCalls = 0;
  let resolveEndpoint: (agentId: string) => Endpoint | null | undefined = endpointFor;

  const factory: ChannelFactory = (context) => {
    factoryCalls += 1;
    if (context.endpoint === null) {
      throw new Error("the transport cannot open a connection with no endpoint");
    }
    contexts.push({ agentId: context.agentId, conversationId: context.conversationId });
    const writer = makeWriter();
    const events: EngineEventFrame[] = [];
    const records: DiagnosticRecord[] = [];
    const channel = createChannel({
      agentId: context.agentId,
      write: writer.write,
      reader: makeReader(),
      probe: makeProbe(),
      ...(context.clock === undefined ? {} : { clock: context.clock }),
    });
    channel.onEvent((frame) => {
      events.push(frame);
    });
    channel.onDiagnostic((record) => {
      records.push(record);
    });
    views.set(context.agentId, { channel, writer, events, records });
    trackChannel(channel);
    return channel;
  };

  const pool = build(factory, (agentId) => resolveEndpoint(agentId), clock.clock);

  const viewOrThrow = (agentId: string): AgentView => {
    const view = views.get(agentId);
    if (view === undefined) {
      throw new Error(
        `no channel was built for ${agentId}. Either the test delivered a frame to an agent whose ` +
          "channel does not exist yet, or the two pools differ on when they construct one - the " +
          "latter is a measured divergence, and a test that means to compare delivery has to " +
          "materialize both worlds first.",
      );
    }
    return view;
  };

  return {
    kind,
    pool,
    clock,
    factoryCalls: () => factoryCalls,
    setEndpoint: (next) => {
      // A resolver that throws, or answers junk, is a real condition; `null` here
      // means "give me the default well-formed resolver back".
      resolveEndpoint = next ?? endpointFor;
    },
    viewOf: (agentId) => views.get(agentId),
    ingest: (agentId, raw) => {
      (viewOrThrow(agentId).channel as EngineChannel).ingest(raw);
    },
    tokenOf: (channel) => {
      const existing = tokens.get(channel);
      if (existing !== undefined) {
        return existing;
      }
      const token = `ch-${String(tokens.size + 1)}`;
      tokens.set(channel, token);
      return token;
    },
    eventsOf: (agentId) => viewOrThrow(agentId).events.map(viewOfFrame),
    recordsOf: (agentId) => viewOrThrow(agentId).records.map(viewOfRecord),
    writesOf: (agentId) =>
      viewOrThrow(agentId).writer.calls.map((call) => call.requestId ?? "none"),
    contexts: () => contexts,
    closeInnerOf: (agentId) => {
      // The pool is not told: this is the transport giving up on its own, which is
      // the zombie case `pool.ts` also replaces rather than hands out.
      viewOrThrow(agentId).channel.close();
    },
  };
}

/** Both worlds of one scenario, built the same way. */
export interface Dual {
  readonly production: World;
  readonly alternate: World;
}

/**
 * Build the two worlds a scenario runs against.
 *
 * Each world gets its own clock, its own recorder views and its own pool,
 * because two pools sharing a clock would make one implementation's timers
 * observable in the other - and the comparison would then depend on run order.
 *
 * @returns both worlds, unstarted
 */
export function makeDual(): Dual {
  return {
    production: makeWorld("production", (factory, resolve, clock) =>
      createChannelPool({ createChannel: factory, endpointOf: resolve, clock }),
    ),
    alternate: makeWorld(
      "alternate",
      (factory, resolve, clock) =>
        new AlternateChannelPool({ createChannel: factory, endpointOf: resolve, clock }),
    ),
  };
}

/* ------------------------------------------------------------------------- */
/* Scripts                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * One caller action.
 *
 * Steps are deliberately coarse: each one is something a UI layer could do, not
 * something an implementation offers. `get`/`sendOn`/`channels`/`close`/
 * `closeAll`/`capabilities` cover the pool surface; `reply`/`refuse`/`push`/
 * `malformed`/`advance` are the transport events a scenario delivers; `await`
 * is how a caller observes a promise it is holding.
 *
 * `get` names its handle so a later `sendOn` can use *that* object. This is what
 * makes "a stale handle after a close" expressible, which is the third assertion
 * assertion.
 */
export type Step =
  | {
      readonly op: "get";
      readonly handle: string;
      readonly agent: string;
      readonly conversation?: string;
    }
  | { readonly op: "channels" }
  | {
      readonly op: "sendOn";
      readonly label: string;
      readonly handle: string;
      readonly requestId: string;
      readonly capability?: CapabilityName;
      readonly timeoutMs?: number;
    }
  | {
      readonly op: "reply";
      readonly agent: string;
      readonly requestId: string;
      readonly data?: unknown;
    }
  | { readonly op: "refuse"; readonly agent: string; readonly requestId: string }
  | {
      readonly op: "push";
      readonly agent: string;
      readonly type: string;
      readonly extra?: Record<string, unknown>;
    }
  | { readonly op: "malformed"; readonly agent: string }
  | { readonly op: "close"; readonly agent: string }
  | { readonly op: "closeHandle"; readonly handle: string }
  | { readonly op: "closeInner"; readonly agent: string }
  | { readonly op: "closeAll" }
  | { readonly op: "await"; readonly label: string }
  | { readonly op: "capabilities"; readonly handle: string }
  | { readonly op: "subscribe"; readonly handle: string }
  | { readonly op: "sees"; readonly label: string; readonly handle: string }
  | { readonly op: "advance"; readonly ms: number };

/** The phrase the kernel uses for a command refused because the channel is closed. */
export const CLOSED_PHRASE = "the channel is closed";

/** The capability a scenario sends unless it names another: one of the 60 with an answer. */
export const TRACKED: CapabilityName = "conversation.sync";

/**
 * Run one scripted caller session against one world, then shut that world down.
 *
 * The shutdown is part of the session rather than the caller's job: every
 * scenario ends with `closeAll` and a drain of whatever is still in flight. That
 * is what keeps a mid-request scenario from leaking a promise into another test,
 * and because it is identical in both worlds it is also part of what is being
 * compared.
 *
 * @param script the steps, in order
 * @param world the world to drive
 * @returns the observations, ending with the drains
 */
export async function runScript(script: readonly Step[], world: World): Promise<Observation[]> {
  const log: Observation[] = [];
  const handles = new Map<string, Channel>();
  const subscriptions = new Map<string, unknown[]>();
  const outstanding = new Map<string, Promise<CommandResult>>();

  for (const step of script) {
    switch (step.op) {
      case "get": {
        const channel =
          step.conversation === undefined
            ? world.pool.getChannel(step.agent)
            : world.pool.getChannel(step.agent, step.conversation);
        handles.set(step.handle, channel);
        log.push({
          op: "get",
          handle: step.handle,
          agent: channel.agentId,
          instance: world.tokenOf(channel),
        });
        break;
      }
      case "channels": {
        log.push({
          op: "channels",
          live: world.pool.channels().map((channel) => ({
            agent: channel.agentId,
            instance: world.tokenOf(channel),
          })),
        });
        break;
      }
      case "sendOn": {
        const handle = handles.get(step.handle);
        if (handle === undefined) {
          throw new Error(`the script sends on handle "${step.handle}", which was never obtained`);
        }
        const promise = handle.send({
          capability: step.capability ?? TRACKED,
          body: { at: step.label },
          requestId: step.requestId,
          ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
        });
        outstanding.set(step.label, promise);
        log.push({ op: "send", label: step.label, handle: step.handle });
        break;
      }
      case "reply": {
        world.ingest(step.agent, responseFrame(step.requestId, { data: step.data ?? {} }));
        break;
      }
      case "refuse": {
        world.ingest(step.agent, responseFrame(step.requestId, { ok: false }));
        break;
      }
      case "push": {
        world.ingest(step.agent, eventFrame(step.type, step.extra ?? {}));
        break;
      }
      case "malformed": {
        world.ingest(step.agent, "{ not json");
        break;
      }
      case "close": {
        world.pool.closeChannel(step.agent);
        break;
      }
      case "closeHandle": {
        const handle = handles.get(step.handle);
        if (handle === undefined) {
          throw new Error(`the script closes handle "${step.handle}", which was never obtained`);
        }
        handle.close();
        break;
      }
      case "closeInner": {
        world.closeInnerOf(step.agent);
        break;
      }
      case "closeAll": {
        world.pool.closeAll();
        break;
      }
      case "await": {
        const promise = outstanding.get(step.label);
        if (promise === undefined) {
          throw new Error(`the script awaits "${step.label}", which was never sent`);
        }
        outstanding.delete(step.label);
        log.push({
          op: "settle",
          label: step.label,
          result: viewOfResult(await expectSettlesNow(promise, `the send "${step.label}"`)),
        });
        break;
      }
      case "capabilities": {
        const handle = handles.get(step.handle);
        if (handle === undefined) {
          throw new Error(`the script reads capabilities of "${step.handle}", never obtained`);
        }
        log.push({ op: "capabilities", agent: handle.agentId, snapshot: handle.capabilities() });
        break;
      }
      case "subscribe": {
        const handle = handles.get(step.handle);
        if (handle === undefined) {
          throw new Error(`the script subscribes on "${step.handle}", which was never obtained`);
        }
        // Recorded so a scenario can compare *what a facade subscriber saw*, not
        // merely that subscribing did not throw: an implementation that drops the
        // delivery would otherwise look identical.
        const seen: unknown[] = [];
        handle.onEvent((frame) => {
          seen.push(viewOfFrame(frame));
        });
        handle.onDiagnostic((record) => {
          seen.push(viewOfRecord(record));
        });
        subscriptions.set(step.handle, seen);
        break;
      }
      case "sees": {
        log.push({ op: "sees", label: step.label, seen: subscriptions.get(step.handle) ?? [] });
        break;
      }
      case "advance": {
        world.clock.advance(step.ms);
        log.push({ op: "advance", ms: step.ms, pending: world.clock.pending() });
        break;
      }
      default: {
        // An unhandled step would silently shrink the comparison, so it is a
        // failure rather than a skip.
        throw new Error(`unhandled script step: ${JSON.stringify(step)}`);
      }
    }
  }

  // Shutdown. `closeAll` settles every in-flight request with the kernel's own
  // NOT_CONNECTED, which is what makes the drain below finite.
  world.pool.closeAll();
  for (const [label, promise] of outstanding) {
    log.push({
      op: "drain",
      label,
      result: viewOfResult(await expectSettlesNow(promise, `the drain of "${label}"`)),
    });
  }
  return log;
}

/**
 * The four template assertions, run against one pool.
 *
 * Deliberately written with the frozen `Channel` surface only: no `isClosed()`,
 * no writer, no factory counter. `isClosed()` is not a frozen member, so a
 * comparison based on it would not reach the claim.
 *
 * @param pool the pool under test
 * @returns the observations the caller made, for the test to assert on
 */
export async function v16Template(pool: ChannelPool): Promise<{
  readonly stale: CommandResult;
  readonly fresh: CommandResult;
  readonly staleDetail: string;
  readonly freshDetail: string;
}> {
  // 1. Take `ch`, close it, take `next`: a closed handle is never handed out again.
  const ch = pool.getChannel("tpl-agent");
  ch.close();
  const next = pool.getChannel("tpl-agent");
  expect(next).not.toBe(ch);

  // 2. A second look-up is stable: still `next`, not a third instance.
  expect(pool.getChannel("tpl-agent")).toBe(next);

  // 3. The stale handle refuses, with the closed wording. This is the positive
  //    control: without it, assertion 4's "does not contain" proves nothing.
  const stale = await expectSettlesNow(
    ch.send({ capability: TRACKED, body: {}, requestId: "req-stale" }),
    "a send on the closed handle",
  );
  expect(stale.ok).toBe(false);
  const staleDetail = stale.ok ? "" : stale.error.detail;
  expect(staleDetail).toContain(CLOSED_PHRASE);

  // 4. The fresh handle is alive, so any refusal it returns must not be the
  //    closed wording. The send is left pending on purpose (a live tracked send
  //    waits for an answer), which is itself proof it was not refused.
  const freshPromise = next.send({ capability: TRACKED, body: {}, requestId: "req-fresh" });
  await expectStillWaiting(freshPromise, "a send on the rebuilt handle");
  pool.closeAll();
  const fresh = await expectSettlesNow(freshPromise, "the rebuilt handle's send after closeAll");
  expect(fresh.ok).toBe(false);
  const freshDetail = fresh.ok ? "" : fresh.error.detail;
  expect(freshDetail).not.toContain(CLOSED_PHRASE);
  // The refusal that *did* arrive must be the close-path one, so the negative
  // assertion above is not vacuously true because nothing was returned at all.
  expect(freshDetail).toContain("closed while the request was in flight");

  return { stale, fresh, staleDetail, freshDetail };
}

/**
 * Await a promise that must settle now, failing loudly when it does not.
 *
 * A bare `await` on a promise nothing will settle does not fail - it waits for
 * vitest's `testTimeout` and reports a timeout naming neither the promise nor the
 * cause (The same 93-second lesson). Racing one macrotask converts that into an
 * immediate failure that says which promise stalled. Every step before an
 * `await` step has already delivered the answer, closed the channel or fired the
 * timer, so a promise still pending here is a real defect.
 *
 * @param promise the send under test
 * @param what a short description for the failure message
 * @returns the settled result
 * @throws when the promise is still pending after one macrotask
 */
export async function expectSettlesNow(
  promise: Promise<CommandResult>,
  what: string,
): Promise<CommandResult> {
  const unsettled = Symbol("unsettled");
  const raced = await Promise.race([
    promise,
    new Promise<typeof unsettled>((resolve) => {
      setTimeout(() => {
        resolve(unsettled);
      }, 0);
    }),
  ]);
  if (raced === unsettled) {
    throw new Error(
      `${what} did not settle after one macrotask, so the caller would hang. A refusal, a ` +
        "not-connected channel or a closed channel must resolve immediately.",
    );
  }
  return raced;
}

/**
 * Await a promise that must *not* settle yet.
 *
 * The mirror of {@link expectSettlesNow}: one macrotask is enough for every
 * microtask in the kernel, so a promise still pending after it is genuinely
 * waiting for an answer - which is what proves a tracked send is not being
 * wrongly refused.
 *
 * @param promise the send under test
 * @param what a short description for the failure message
 * @throws when the promise settled
 */
export async function expectStillWaiting(
  promise: Promise<CommandResult>,
  what: string,
): Promise<void> {
  const stillPending = Symbol("still-pending");
  const raced = await Promise.race([
    promise,
    new Promise<typeof stillPending>((resolve) => {
      setTimeout(() => {
        resolve(stillPending);
      }, 0);
    }),
  ]);
  if (raced !== stillPending) {
    throw new Error(`${what} settled, but it should still be waiting for an answer`);
  }
}

/**
 * Run one script against both worlds and return both logs plus the worlds.
 *
 * The rig deliberately does not assert: a test that wants to *measure* a
 * divergence rather than forbid it has to be able to see both logs. The
 * comparison itself belongs to the test, which can then name the step that
 * differs instead of dumping two arrays.
 *
 * @param script the steps to run against each world
 * @param dual the two worlds, defaulting to a fresh pair
 * @returns one log per world, plus the worlds for further assertions
 */
export async function runDual(
  script: readonly Step[],
  dual: Dual = makeDual(),
): Promise<{ production: Observation[]; alternate: Observation[]; dual: Dual }> {
  const production = await runScript(script, dual.production);
  const alternate = await runScript(script, dual.alternate);
  return { production, alternate, dual };
}

/**
 * Demand that both implementations left no timer scheduled.
 *
 * This is the leak detector for the *pool* layer: a pool that closes a channel
 * without letting the kernel settle its in-flight entries leaves a timer behind,
 * and the next scenario pays for it. Called explicitly as well as from
 * `afterEach` so a failing scenario names both counts instead of only the total.
 *
 * @param dual both worlds
 * @throws when either clock still has a scheduled timer
 */
export function expectNoTimers(dual: Dual): void {
  const production = dual.production.clock.pending();
  const alternate = dual.alternate.clock.pending();
  if (production !== 0 || alternate !== 0) {
    throw new Error(
      `a pool left timers scheduled (production ${String(production)}, alternate ` +
        `${String(alternate)}). Both implementations close every channel through the kernel, so ` +
        "every in-flight entry - and its timer - must be gone after closeAll.",
    );
  }
}

/**
 * The shared `afterEach` body: close the harness channels and demand silence.
 *
 * `assertNoLeakedTimers` closes anything a test built without a pool and then
 * throws if any tracked clock still has a timer, which is the check that keeps a
 * regression in one scenario from surfacing as an unrelated timeout in another.
 */
export function teardownDifferential(): void {
  assertNoLeakedTimers();
}
