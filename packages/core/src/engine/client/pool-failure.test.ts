/**
 * `ChannelPool` local failure does not spread.
 *
 * This is the file to read if you are looking for the evidence behind the
 * one-connection-per-agent ruling. It exists separately because it is the reason
 * the ruling was made, not a detail of it.
 *
 * The measured fact it protects: with agent C's connection closed at 3 of A's
 * closed at 3 of A's 10 frames, **A still received 10 of 10**. Under one shared
 * connection that is impossible - closing it would have taken everyone's frames,
 * and there is no unsubscribe command in the engine (124 client-to-server commands,
 * none of them `unsub*`), so evicting one agent is only possible if each agent owns
 * a connection to close.
 *
 * Two halves, and both must go red independently:
 *
 * 1. **Damage is local.** Closing C leaves A's and B's subscribers receiving, and
 *    leaves A's in-flight request waiting for its own answer rather than settling it
 *    early or clearing its table. A factory that throws for one agent degrades that
 *    agent alone.
 * 2. **A channel always exists.** The engine's endpoint is `null` until it is ready
 *    ready, and a resolver may throw or return junk. None of those may reach a
 *    those may reach a render path as an exception: the caller gets a channel that
 *    answers `NOT_CONNECTED` with the §5.2.2 "never came up" wording, so `B3` can
 *    tell that apart from "dropped" when it decides where to reconnect from.
 *
 * The harness is `pool-test-support.ts`; identity and lifetime are `pool.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { eventFrame, expectSettles, responseFrame, trackChannel } from "./channel-test-support";
import { EngineChannel, createChannel } from "./channel";
import type { Endpoint } from "./types";
import { expectPending, makePool, teardownPools } from "./pool-test-support";

afterEach(teardownPools);

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
