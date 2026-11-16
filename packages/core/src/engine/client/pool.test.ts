/**
 * Tests for `ChannelPool`       .
 *
 * Contract: the frozen `ChannelPool` signature and the pool/channel split.
 * pool/channel split), §6.2 (`the bridge`: build, close, local failure) and §3.6.3
 * (the endpoint seam). User-facing behaviour: docs/26 §4.7 and the ``
 * ruling - one connection per agent - plus the measured fact this file protects
 *  §2.3 fact 14): with C's connection closed mid-stream, A still
 * received all 10 of its 10 frames.
 *
 * Every test names the one deliberate change that turns it red. The channel's
 * own in-flight table, fan-out and diagnostic ring have their own suites;
 * this file tests the pool's decisions - which instance an agent gets, what a
 * close touches, and what a caller sees when a connection cannot be built - and
 * reads the channel's observable surface only to prove that closing one agent
 * did not disturb another.
 *
 * Time is never real: every channel is built on `makeClock`. `afterEach` closes
 * every pool and then asserts the fake clocks are silent; the invariant there is
 * "closing releases everything", not "no test leaves a request in flight" - the
 * V-15b group leaves one waiting on purpose, which is legitimate because closing
 * settles it (see `assertNoLeakedTimers`).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  assertNoLeakedTimers,
  eventFrame,
  expectSettles,
  makeClock,
  makeProbe,
  makeReader,
  makeWriter,
  responseFrame,
  trackChannel,
  trackClock,
} from "./channel-test-support";
import type { FakeClock, RecordingWriter } from "./channel-test-support";
import { EngineChannel, createChannel } from "./channel";
import type { ChannelFactory, ChannelOpenContext, EngineChannelPool } from "./pool";
import { ChannelPoolReentryError, createChannelPool } from "./pool";
import type { Channel, ChannelPool, CommandResult, DiagnosticRecord, Endpoint } from "./types";
import type { EngineEventFrame } from "./types";

/* Compile-time checks */

/** `true` only when the two types are identical. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails the build unless its argument is `true`. */
type Expect<T extends true> = T;

/**
 * `getChannel` is synchronous. An `async` method cannot satisfy `Equal`, so
 * changing the signature is a compile error here.
 */
type GetChannelReturnsChannel = Expect<Equal<ReturnType<ChannelPool["getChannel"]>, Channel>>;

/** The class must satisfy the frozen interface, not merely resemble it. */
type PoolIsAChannelPool = Expect<Equal<EngineChannelPool extends ChannelPool ? true : false, true>>;

/** Keeps the compile-time assertions above from being reported as unused. */
const COMPILE_TIME_CHECKS: [GetChannelReturnsChannel, PoolIsAChannelPool] = [true, true];

/* Harness */

/** What one built channel's test side can see. */
interface AgentView {
  readonly channel: Channel;
  readonly writer: RecordingWriter;
  readonly events: EngineEventFrame[];
  readonly records: DiagnosticRecord[];
}

/** The structured form of a pool under test. */
interface PoolHarness {
  readonly pool: EngineChannelPool;
  readonly clock: FakeClock;
  /** Every factory invocation's context, in creation order. */
  readonly contexts: ChannelOpenContext[];
  factoryCalls(): number;
  viewOf(agentId: string): AgentView | undefined;
  /** Feed one raw frame to one agent's channel. */
  ingest(agentId: string, raw: string): void;
}

/** The pools this file built, so teardown can close them. */
const livePools: EngineChannelPool[] = [];

/**
 * Build a pool whose channels are real kernels with the doubles wired.
 *
 * The default factory stands where the transport will: handed no endpoint it
 * throws, so the pool degrades that agent. `ingest` reaches the kernel's own
 * entry point, so a test asserts on what a consumer would see.
 *
 * @param overrides test-specific factory or endpoint resolver
 * @returns the pool plus the observable side effects
 */
function makePool(
  overrides: {
    readonly createChannel?: ChannelFactory;
    readonly endpointOf?: (agentId: string) => Endpoint | null;
  } = {},
): PoolHarness {
  const clock = trackClock(makeClock());
  const contexts: ChannelOpenContext[] = [];
  const views = new Map<string, AgentView>();
  let factoryCalls = 0;

  const defaultFactory: ChannelFactory = (context) => {
    factoryCalls += 1;
    contexts.push(context);
    if (context.endpoint === null) {
      throw new Error("the transport cannot open a connection with no endpoint");
    }
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

  const pool = createChannelPool({
    createChannel: overrides.createChannel ?? defaultFactory,
    endpointOf:
      overrides.endpointOf ??
      ((agentId) => ({ url: `ws://127.0.0.1:1/${agentId}`, token: `token-for-${agentId}` })),
    clock: clock.clock,
  });
  livePools.push(pool);

  return {
    pool,
    clock,
    contexts,
    factoryCalls: () => factoryCalls,
    viewOf: (agentId) => views.get(agentId),
    ingest: (agentId, raw) => {
      const view = views.get(agentId);
      if (view === undefined) throw new Error(`no channel built for ${agentId}`);
      (view.channel as EngineChannel).ingest(raw);
    },
  };
}

/**
 * A `Channel` double whose `close()` a test controls, for the cases where only
 * the pool's bookkeeping is under test: counting closes, and proving a throwing
 * `close()` cannot strand a neighbour.
 *
 * @param agentId the agent this double reports
 * @param onClose what `close()` should do
 * @returns a `Channel`-shaped object
 */
function stubChannel(agentId: string, onClose: () => void): Channel {
  return {
    agentId,
    send: () => Promise.resolve<CommandResult>({ ok: true, data: undefined, raw: undefined }),
    onEvent: () => () => undefined,
    onDiagnostic: () => () => undefined,
    capabilities: () => ({ state: "unknown" }),
    close: onClose,
  };
}

/**
 * A pool over stub channels, for tests that only count closes.
 *
 * @param onClose receives each agent id whose channel was closed
 * @param clock the fake clock to pass through
 * @returns the pool, registered for teardown
 */
function stubPool(onClose: (agentId: string) => void, clock: FakeClock): EngineChannelPool {
  const pool = createChannelPool({
    createChannel: (context) => stubChannel(context.agentId, () => onClose(context.agentId)),
    endpointOf: () => null,
    clock: clock.clock,
  });
  livePools.push(pool);
  return pool;
}

/**
 * Await a promise that must *not* settle yet - the mirror of `expectSettles`.
 * Asserting "still waiting" with a bare `await` is impossible and proving it by
 * not awaiting proves nothing; one macrotask lets every microtask run, so a
 * promise still pending after it is genuinely awaiting an answer.
 *
 * @param promise the promise under test
 * @param what a short description for the failure message
 * @throws when the promise settled
 */
async function expectPending(promise: Promise<CommandResult>, what: string): Promise<void> {
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
    throw new Error(`${what} settled, but it should still be waiting for its answer`);
  }
}

/**
 * Close every pool this file built, then demand the clocks are silent.
 *
 * `closeAll` runs first on purpose: the invariant is "closing releases
 * everything", and `assertNoLeakedTimers` would make the check vacuous if it
 * did the closing itself before inspecting the clocks.
 */
afterEach(() => {
  while (livePools.length > 0) {
    livePools.pop()?.closeAll();
  }
  assertNoLeakedTimers();
});

/* One channel per agent */

describe("one channel per agent", () => {
  it("returns the same instance for repeated calls for one agent", () => {
    // Red when: getChannel builds unconditionally.
    const h = makePool();
    const first = h.pool.getChannel("a");

    expect(h.pool.getChannel("a")).toBe(first);
    expect(h.factoryCalls()).toBe(1);
  });

  it("returns different instances for different agents", () => {
    // Red when: the pool keys on a constant, or shares one channel.
    const h = makePool();
    const a = h.pool.getChannel("a");
    const b = h.pool.getChannel("b");

    expect(a).not.toBe(b);
    expect(a.agentId).toBe("a");
    expect(b.agentId).toBe("b");
    expect(h.factoryCalls()).toBe(2);
  });

  it("reuses the channel when only the conversation id changes", () => {
    // The conversation is a request scope, not a connection key (frozen `ChannelPool`
    // doc comment). Red when: the pool keys on both ids.
    const h = makePool();
    const first = h.pool.getChannel("a", "conv-1");

    expect(h.pool.getChannel("a", "conv-2")).toBe(first);
    expect(h.factoryCalls()).toBe(1);
    expect(h.pool.channels()).toHaveLength(1);
  });

  it("hands the factory the agent and the creation scope, and nothing invented", () => {
    // Red when: the context drops either field, invents a scope where the caller gave none, or
    // builds the channel under an id other than the map key.
    const h = makePool();
    h.pool.getChannel("agent-x", "conv-1");
    h.pool.getChannel("b");

    expect(h.contexts[0]?.agentId).toBe("agent-x");
    expect(h.contexts[0]?.conversationId).toBe("conv-1");
    expect(h.contexts[1]?.conversationId).toBeUndefined();
    expect(h.pool.getChannel("agent-x").agentId).toBe("agent-x");
  });

  it("keeps exactly one entry per agent in channels()", () => {
    // The shape: one agent, one channel, no matter how often asked.
    const h = makePool();
    for (let i = 0; i < 5; i += 1) {
      h.pool.getChannel("a");
      h.pool.getChannel("b", `conv-${String(i)}`);
    }

    const agents = h.pool.channels().map((channel) => channel.agentId);
    expect(agents).toEqual(["a", "b"]);
    expect(new Set(agents).size).toBe(agents.length);
  });
});

/* Synchronous return */

describe("synchronous return", () => {
  it("returns a channel synchronously, before the connection is ready", () => {
    // The pool registers intent and never waits for a socket. Red when: the method becomes async
    // (also a compile error, above), or it awaits readiness.
    const h = makePool({
      createChannel: (context) => {
        const channel = createChannel({
          agentId: context.agentId,
          write: () => undefined,
          readiness: () => ({ ready: false, everReady: false }),
          ...(context.clock === undefined ? {} : { clock: context.clock }),
        });
        trackChannel(channel);
        return channel;
      },
    });

    const channel = h.pool.getChannel("a");

    expect(channel).toBeDefined();
    expect(typeof (channel as unknown as { then?: unknown }).then).toBe("undefined");
  });

  it("answers NOT_CONNECTED while not ready, without throwing", () => {
    // Not-ready is a value, not an exception and not a drop.
    const h = makePool({
      createChannel: (context) => {
        const channel = createChannel({
          agentId: context.agentId,
          write: () => {
            throw new Error("must not write before ready");
          },
          readiness: () => ({ ready: false, everReady: false }),
          ...(context.clock === undefined ? {} : { clock: context.clock }),
        });
        trackChannel(channel);
        return channel;
      },
    });

    return expectSettles(
      h.pool.getChannel("a").send({ capability: "conversation.sync", body: {} }),
    ).then((result) => {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_CONNECTED");
        expect(result.error.detail).toContain("engine has not become ready");
      }
    });
  });
});

/* Local failure does not spread */

describe("local failure does not spread", () => {
  it("closes only the named channel", () => {
    // Red when: closeChannel closes the whole pool.
    const h = makePool();
    const a = h.pool.getChannel("a");
    const b = h.pool.getChannel("b");
    h.pool.getChannel("c");

    h.pool.closeChannel("c");

    expect(h.pool.getChannel("a")).toBe(a);
    expect(h.pool.getChannel("b")).toBe(b);
    expect(h.pool.channels().map((channel) => channel.agentId)).toEqual(["a", "b"]);
  });

  it("keeps A's and B's subscribers receiving after C is closed (probe-10 shape)", () => {
    // The measured behaviour: A is at 3/10 when C's connection
    // closes and still receives 10/10. Red when: closing one agent touches a shared subscriber set
    // or a shared socket.
    const h = makePool();
    h.pool.getChannel("a");
    h.pool.getChannel("b");
    h.pool.getChannel("c");

    for (let i = 1; i <= 3; i += 1) {
      h.ingest("a", eventFrame("known.event", { seq: i }));
      h.ingest("b", eventFrame("known.event", { seq: i }));
    }
    h.pool.closeChannel("c");
    for (let i = 4; i <= 10; i += 1) {
      h.ingest("a", eventFrame("known.event", { seq: i }));
      h.ingest("b", eventFrame("known.event", { seq: i }));
    }

    const seqs = (agent: string): unknown[] =>
      (h.viewOf(agent)?.events ?? []).map((frame) => (frame.raw as { seq: number }).seq);
    expect(seqs("a")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(seqs("b")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("does not cancel A's in-flight request when C is closed", () => {
    // The user-visible core: A's turn keeps running. Red when: closing one channel settles
    // or clears another channel's table.
    const h = makePool();
    const a = h.pool.getChannel("a");
    h.pool.getChannel("c");

    const pending = a.send({ capability: "conversation.sync", body: {}, requestId: "req-a" });
    h.pool.closeChannel("c");

    expect(h.viewOf("a")?.writer.calls.at(-1)?.requestId).toBe("req-a");
    h.ingest("a", responseFrame("req-a", { data: { answer: 42 } }));

    return pending.then((result) => {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({ answer: 42 });
      }
    });
  });

  it("settles C's in-flight request and leaves A's waiting", () => {
    // Both halves at once. Red when: the close misses its own channel, or spills.
    const h = makePool();
    const a = h.pool.getChannel("a");
    const c = h.pool.getChannel("c");

    const aPending = a.send({ capability: "conversation.sync", body: {}, requestId: "req-a" });
    const cPending = c.send({ capability: "conversation.sync", body: {}, requestId: "req-c" });
    h.pool.closeChannel("c");

    return expectSettles(cPending).then(async (settled) => {
      expect(settled.ok).toBe(false);
      if (!settled.ok) {
        expect(settled.error.code).toBe("NOT_CONNECTED");
      }
      await expectPending(aPending, "A's request after C was closed");
      h.ingest("a", responseFrame("req-a"));
      await expectSettles(aPending);
    });
  });

  it("degrades one agent without touching the others when its factory throws", () => {
    // Red when: a factory failure escapes getChannel (the render path throws) or leaks into the
    // neighbouring entry.
    const h = makePool({
      createChannel: (context) => {
        if (context.agentId === "broken") {
          throw new Error("transport refused");
        }
        const channel = createChannel({
          agentId: context.agentId,
          write: () => undefined,
          ...(context.clock === undefined ? {} : { clock: context.clock }),
        });
        trackChannel(channel);
        return channel;
      },
    });

    const healthy = h.pool.getChannel("healthy");
    const degraded = h.pool.getChannel("broken");

    expect(degraded).not.toBe(healthy);
    expect(h.pool.channels()).toHaveLength(2);
    expect(h.pool.getChannel("healthy")).toBe(healthy);
  });
});

/* closeAll */

describe("closeAll", () => {
  it("closes every channel", () => {
    // Red when: it closes only the first entry (a `break` instead of a loop).
    const h = makePool();
    const closed: string[] = [];
    const pool = stubPool((agentId) => closed.push(agentId), h.clock);
    pool.getChannel("a");
    pool.getChannel("b");
    pool.getChannel("c");

    pool.closeAll();

    expect(closed.sort()).toEqual(["a", "b", "c"]);
    expect(pool.channels()).toEqual([]);
  });

  it("empties channels() and leaves the channels closed", () => {
    // Red when: entries survive the close (a stale snapshot), or the entries are
    // dropped without closing the channels they point at.
    const h = makePool();
    const a = h.pool.getChannel("a");
    h.pool.getChannel("b");
    const pending = a.send({ capability: "conversation.sync", body: {}, requestId: "req-timer" });
    expect(h.clock.pending()).toBe(1);

    h.pool.closeAll();

    expect(h.pool.channels()).toHaveLength(0);
    expect((a as EngineChannel).isClosed()).toBe(true);
    // `closeAll` drops the entries *and* closes them, so an in-flight timer cannot
    // survive it. (afterEach also catches this; asserting here names the cause.)
    expect(h.clock.pending()).toBe(0);
    return expectSettles(pending).then((result) => {
      expect(result.ok).toBe(false);
    });
  });

  it("is idempotent", () => {
    // Red when: a second call throws, or re-closes what is already closed.
    const h = makePool();
    let closes = 0;
    const pool = stubPool(() => {
      closes += 1;
    }, h.clock);
    pool.getChannel("a");

    pool.closeAll();
    pool.closeAll();

    expect(closes).toBe(1);
    expect(pool.channels()).toEqual([]);
  });

  it("has already emptied the map when a channel's close() runs", () => {
    // Red when: the close happens before the delete, so a close() that calls back
    // into the pool observes the entry it is in the middle of destroying.
    const h = makePool();
    const seen: number[] = [];
    const pool = createChannelPool({
      createChannel: (context) =>
        stubChannel(context.agentId, () => {
          seen.push(pool.channels().length);
        }),
      endpointOf: () => null,
      clock: h.clock.clock,
    });
    livePools.push(pool);
    pool.getChannel("a");
    pool.getChannel("b");

    pool.closeChannel("a");
    expect(seen).toEqual([1]);

    pool.closeAll();
    // The last entry was gone before its own close ran, not after.
    expect(seen).toEqual([1, 0]);
  });

  it("closes the rest when one channel's close throws", () => {
    // Red when: the first throw escapes and strands its neighbours.
    const h = makePool();
    const closed: string[] = [];
    const pool = createChannelPool({
      createChannel: (context) =>
        stubChannel(context.agentId, () => {
          if (context.agentId === "b") {
            throw new Error("close exploded");
          }
          closed.push(context.agentId);
        }),
      endpointOf: () => null,
      clock: h.clock.clock,
    });
    livePools.push(pool);
    pool.getChannel("a");
    pool.getChannel("b");
    pool.getChannel("c");

    expect(() => {
      pool.closeAll();
    }).not.toThrow();
    expect(closed.sort()).toEqual(["a", "c"]);
    expect(pool.channels()).toEqual([]);
  });

  it("allows a new channel afterwards: it is not a terminal dispose", () => {
    // The decision documented in pool.ts. Red when: a `disposed` flag latches.
    const h = makePool();
    const before = h.pool.getChannel("a");
    h.pool.closeAll();

    const after = h.pool.getChannel("a");

    expect(after).not.toBe(before);
    expect(h.factoryCalls()).toBe(2);
    expect(h.pool.channels()).toHaveLength(1);
  });
});

/* channels() is a truthful snapshot */

describe("channels()", () => {
  it("reflects a close instead of returning a stale array", () => {
    // Red when: the array is cached, or closeChannel forgets to delete.
    const h = makePool();
    h.pool.getChannel("a");
    h.pool.getChannel("b");
    expect(h.pool.channels()).toHaveLength(2);

    h.pool.closeChannel("a");

    expect(h.pool.channels().map((channel) => channel.agentId)).toEqual(["b"]);

    // A consumer may also close the handle it holds. Red when: a dead channel is
    // reported live, which hides the zombie until every send fails.
    h.pool.getChannel("a").close();
    expect(h.pool.channels().map((channel) => channel.agentId)).toEqual(["b"]);
  });

  it("returns a fresh array in creation order that cannot mutate the pool", () => {
    // Red when: the internal array is handed out by reference, or the map is
    // rebuilt in a way that loses insertion order.
    const h = makePool();
    h.pool.getChannel("c");
    h.pool.getChannel("a");
    const snapshot = h.pool.channels() as Channel[];
    expect(snapshot.map((channel) => channel.agentId)).toEqual(["c", "a"]);

    snapshot.push(stubChannel("intruder", () => undefined));
    snapshot.length = 0;

    expect(h.pool.channels().map((channel) => channel.agentId)).toEqual(["c", "a"]);
  });
});

/* Rebuild after close */

describe("rebuild after close", () => {
  it("builds a fresh channel after closeChannel", () => {
    // Red when: the pool keeps handing out the closed instance.
    const h = makePool();
    const first = h.pool.getChannel("a");
    h.pool.closeChannel("a");

    const second = h.pool.getChannel("a");

    expect(second).not.toBe(first);
    expect(h.factoryCalls()).toBe(2);
  });

  it("replaces a channel that closed itself, instead of returning the zombie", () => {
    // Red when: a self-closed entry is returned forever, so every later send fails
    // with no way for the caller to notice - the defect the frozen `Channel`
    // contract's "close() is idempotent" wording is easy to misread into.
    const h = makePool();
    const first = h.pool.getChannel("a");
    first.close();

    const second = h.pool.getChannel("a");

    expect(second).not.toBe(first);
    expect((second as EngineChannel).isClosed()).toBe(false);
    expect(h.pool.getChannel("a")).toBe(second);
    expect(h.factoryCalls()).toBe(2);
  });
});

/* Subscriber isolation */

describe("subscriber isolation", () => {
  it("delivers one agent's event only to that agent's subscriber", () => {
    // Red when: the pool introduces a shared subscriber set or a shared channel.
    const h = makePool();
    h.pool.getChannel("a");
    h.pool.getChannel("b");

    h.ingest("a", eventFrame("known.event", { who: "a" }));
    h.ingest("b", eventFrame("known.event", { who: "b" }));
    h.ingest("b", eventFrame("known.event", { who: "b2" }));

    const who = (agent: string): unknown[] =>
      (h.viewOf(agent)?.events ?? []).map((frame) => (frame.raw as { who: string }).who);
    expect(who("a")).toEqual(["a"]);
    expect(who("b")).toEqual(["b", "b2"]);
  });

  it("keeps diagnostic histories per channel", () => {
    // Red when: one shared diagnostic log is wired into every channel.
    const h = makePool();
    h.pool.getChannel("a");
    h.pool.getChannel("b");

    h.ingest("a", "{ not json");
    h.ingest("b", "{ also not json");
    h.ingest("b", "{ still not json");

    expect(h.viewOf("a")?.records).toHaveLength(1);
    expect(h.viewOf("b")?.records).toHaveLength(2);
    expect(h.viewOf("a")?.records[0]?.kind).toBe("malformed");
  });

  it("keeps each channel's writer calls separate", () => {
    // Red when: the pool builds channels around one shared writer.
    const h = makePool();
    const a = h.pool.getChannel("a");
    h.pool.getChannel("b");

    void a.send({ capability: "conversation.sync", body: {}, requestId: "req-a" });
    void a.send({ capability: "conversation.sync", body: {}, requestId: "req-a-2" });

    expect(h.viewOf("a")?.writer.calls.map((call) => call.requestId)).toEqual(["req-a", "req-a-2"]);
    expect(h.viewOf("b")?.writer.calls).toHaveLength(0);
  });
});

/* Endpoint seam */

describe("endpoint seam", () => {
  it("asks the resolver per agent and hands that agent's endpoint to the factory", () => {
    // Red when: the resolver is called once and its answer reused for everyone, or
    // the endpoint is resolved but never handed over (no channel could connect).
    const asked: string[] = [];
    const h = makePool({
      endpointOf: (agentId) => {
        asked.push(agentId);
        return { url: `ws://127.0.0.1:9999/${agentId}`, token: `token-${agentId}` };
      },
    });

    h.pool.getChannel("a");
    h.pool.getChannel("b");
    h.pool.getChannel("a");

    expect(asked).toEqual(["a", "b"]);
    expect(h.contexts.map((context) => context.endpoint)).toEqual([
      { url: "ws://127.0.0.1:9999/a", token: "token-a" },
      { url: "ws://127.0.0.1:9999/b", token: "token-b" },
    ]);
  });

  it("does not retain the endpoint on the pool", () => {
    // The token is a plaintext leak surface. Red when: a field caches
    // it.
    const h = makePool({
      endpointOf: () => ({ url: "ws://127.0.0.1:9999/ws", token: "token-do-not-keep" }),
    });
    h.pool.getChannel("a");

    expect(JSON.stringify(h.pool)).not.toContain("token-do-not-keep");
    expect(JSON.stringify(h.pool)).not.toContain("ws://127.0.0.1:9999");
    expect(Object.keys(h.pool)).not.toContain("endpoint");
    expect(Object.keys(h.pool)).not.toContain("token");
  });

  it("degrades to a not-connected channel when there is no endpoint yet", () => {
    // The engine's endpoint is null until it is ready, and a render path must still
    // get a channel. Red when: getChannel throws or returns nothing.
    const h = makePool({ endpointOf: () => null });

    const channel = h.pool.getChannel("a");
    expect(channel.agentId).toBe("a");
    expect(channel.capabilities()).toEqual({ state: "unknown" });

    // It still takes the pool's clock: a degraded channel stamps events too, and a
    // frame's `at` must not silently come from the system clock.
    const at: number[] = [];
    channel.onEvent((frame) => at.push(frame.at));
    (channel as EngineChannel).ingest(eventFrame("known.event"));
    expect(at).toEqual([h.clock.clock.now()]);

    return expectSettles(channel.send({ capability: "conversation.sync", body: {} })).then(
      (result) => {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_CONNECTED");
          // §5.2.2: "never came up" must be distinguishable from "dropped".
          expect(result.error.detail).toContain("engine has not become ready");
        }
      },
    );
  });

  it("degrades instead of throwing when the resolver throws or returns junk", () => {
    // A resolver that throws is a runtime condition; one that returns a wrong shape
    // is a wiring bug. Neither may cost the user a channel, and neither may escape
    // into a render path. Red when: either failure propagates out of `getChannel`, or
    // the pool trusts the shape and the factory explodes on `url`.
    const throwing = makePool({
      endpointOf: () => {
        throw new Error("engine is not ready");
      },
    });
    expect(() => throwing.pool.getChannel("a")).not.toThrow();
    expect(throwing.pool.channels()).toHaveLength(1);

    const malformed = makePool({
      endpointOf: () => ({ url: "ws://127.0.0.1:1/a" }) as unknown as Endpoint,
    });
    const channel = malformed.pool.getChannel("a");

    // The defective shape was rejected before the factory saw it: the factory is
    // handed `null` and decides it cannot connect, which is the pool degrading.
    expect(malformed.contexts[0]?.endpoint).toBeNull();
    return expectSettles(channel.send({ capability: "conversation.sync", body: {} })).then(
      (result) => {
        expect(result.ok).toBe(false);
      },
    );
  });

  it("caches the degraded channel instead of retrying on every call", () => {
    // Red when: a null endpoint rebuilds per call (a new channel every frame, and one leaked
    // not-connected channel per conversation switch). The conversation rule must hold on the
    // degraded path too.
    const h = makePool({ endpointOf: () => null });

    const first = h.pool.getChannel("a", "conv-1");

    expect(h.pool.getChannel("a")).toBe(first);
    expect(h.pool.getChannel("a", "conv-2")).toBe(first);
    expect(h.pool.channels()).toHaveLength(1);
  });
});

/* Arguments */

describe("arguments", () => {
  it("rejects an empty agent id, and an empty conversation id when given", () => {
    // Red when: a channel is created that nobody can address again, or an empty
    // scope is stored as the creation scope.
    const h = makePool();
    expect(() => h.pool.getChannel("")).toThrow(TypeError);
    expect(() => h.pool.getChannel("a", "")).toThrow(TypeError);
    expect(h.factoryCalls()).toBe(0);
    expect(h.pool.channels()).toHaveLength(0);
  });

  it("rejects a non-string agent id", () => {
    // Red when: a number or object silently becomes a map key.
    const h = makePool();
    expect(() => h.pool.getChannel(42 as unknown as string)).toThrow(TypeError);
    expect(() => h.pool.getChannel(undefined as unknown as string)).toThrow(TypeError);
    expect(h.factoryCalls()).toBe(0);
  });
});

/* Re-entrancy */

describe("re-entrancy", () => {
  it("refuses a factory that asks for the agent it is building, and names it", () => {
    // Red when: the pool recurses until the stack ends, invents a placeholder and
    // so hands out two instances for one agent, or reports an error nobody can act
    // on.
    let pool: EngineChannelPool | undefined;
    pool = createChannelPool({
      createChannel: (context) => {
        pool?.getChannel(context.agentId);
        return stubChannel(context.agentId, () => undefined);
      },
      endpointOf: () => null,
    });
    livePools.push(pool);

    try {
      pool.getChannel("agent-z");
      throw new Error("expected a re-entrancy error");
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelPoolReentryError);
      expect((error as ChannelPoolReentryError).agentId).toBe("agent-z");
      expect((error as ChannelPoolReentryError).message).toContain("agent-z");
    }
    expect(pool.channels()).toHaveLength(0);
  });

  it("releases the per-agent guard after a re-entrancy error", () => {
    // Red when: the guard is left set, so every later getChannel for that agent
    // throws for a factory that is no longer running.
    let attempts = 0;
    let pool: EngineChannelPool | undefined;
    pool = createChannelPool({
      createChannel: (context) => {
        attempts += 1;
        if (attempts === 1) {
          pool?.getChannel(context.agentId);
        }
        return stubChannel(context.agentId, () => undefined);
      },
      endpointOf: () => null,
    });
    livePools.push(pool);

    expect(() => pool?.getChannel("a")).toThrow(ChannelPoolReentryError);

    const ok = pool.getChannel("a");
    expect(ok.agentId).toBe("a");
    expect(pool.channels()).toHaveLength(1);
  });

  it("allows a factory to open a different agent", () => {
    // Red when: the guard is a global lock rather than a per-agent one.
    let pool: EngineChannelPool | undefined;
    const inner: Channel[] = [];
    pool = createChannelPool({
      createChannel: (context) => {
        if (context.agentId === "a") {
          const other = pool?.getChannel("b");
          if (other !== undefined) {
            inner.push(other);
          }
        }
        return stubChannel(context.agentId, () => undefined);
      },
      endpointOf: () => null,
    });
    livePools.push(pool);

    const a = pool.getChannel("a");
    const b = pool.getChannel("b");

    expect(inner).toHaveLength(1);
    expect(inner[0]).toBe(b);
    expect(a).not.toBe(b);
  });
});

/* closeChannel edges */

describe("closeChannel edges", () => {
  it("ignores an agent it never opened", () => {
    // Red when: closing an unknown agent throws, so a window closing action can fail for a race the
    // caller cannot see.
    const h = makePool();
    const a = h.pool.getChannel("a");

    expect(() => h.pool.closeChannel("never-opened")).not.toThrow();
    expect(h.pool.getChannel("a")).toBe(a);
  });

  it("is idempotent", () => {
    // Red when: a second close throws, or re-closes the same channel.
    const h = makePool();
    let closes = 0;
    const pool = stubPool(() => {
      closes += 1;
    }, h.clock);
    pool.getChannel("a");

    pool.closeChannel("a");
    pool.closeChannel("a");

    expect(closes).toBe(1);
    expect(pool.channels()).toHaveLength(0);
    // An empty pool is not a special case: a window closing action must never
    // throw for a race the caller cannot see.
    expect(() => pool.closeAll()).not.toThrow();
    expect(() => pool.closeChannel("never-opened")).not.toThrow();
  });
});

/* Clock injection */

describe("clock injection", () => {
  it("routes every channel's timers through the injected clock", () => {
    // Red when: the pool lets a channel default to the system clock - then this file's timeout
    // would cost the `normal` ceiling (30 s) and the fake clock would see no timer at
    // all.
    const h = makePool();
    const a = h.pool.getChannel("a");
    h.pool.getChannel("b");

    expect(h.contexts.map((context) => context.clock)).toEqual([h.clock.clock, h.clock.clock]);

    const pending = a.send({
      capability: "conversation.sync",
      body: {},
      requestId: "req-clock",
    });
    expect(h.clock.delays).toHaveLength(1);
    expect(h.clock.pending()).toBe(1);

    h.clock.advance(30_000);

    return expectSettles(pending).then((result) => {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("TIMEOUT");
      }
      expect(h.clock.pending()).toBe(0);
    });
  });
});

/* Guard rails on this file + the frozen surface */

describe("frozen surface", () => {
  it("returns the frozen Channel type, not a pool-specific one", () => {
    // Red when: the return type drifts to `EngineChannel`, which would make comparing
    // implementation impossible.
    const h = makePool();
    const channel: Channel = h.pool.getChannel("a");

    expect(channel.agentId).toBe("a");
    expect(typeof channel.send).toBe("function");
    expect(typeof channel.onEvent).toBe("function");
    expect(typeof channel.onDiagnostic).toBe("function");
    expect(typeof channel.capabilities).toBe("function");
    expect(typeof channel.close).toBe("function");
    // The compile-time signature checks above are asserted here so deleting them (they look unused)
    // is also a runtime red, not a silent loss of coverage.
    expect(COMPILE_TIME_CHECKS).toEqual([true, true]);
  });
});
