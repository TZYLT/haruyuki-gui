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
    expect(degraded.agentId).toBe("broken");
    // The healthy neighbour is a real entry and stays one, the broken agent is a
    // reply rather than a cached verdict, and one failure did not cost the other.
    expect(h.pool.getChannel("healthy")).toBe(healthy);
    expect(h.pool.channels().map((channel) => channel.agentId)).toEqual(["healthy"]);
    return expectSettles(degraded.send({ capability: "conversation.sync", body: {} })).then(
      (result) => {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.detail).toContain("engine has not become ready");
        }
      },
    );
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
    // A resolver that always throws never yields a connection, so nothing is
    // reported as one - but the caller still got a channel to branch on.
    expect(throwing.pool.channels()).toHaveLength(0);

    const malformed = makePool({
      endpointOf: () => ({ url: "ws://127.0.0.1:1/a" }) as unknown as Endpoint,
    });
    const channel = malformed.pool.getChannel("a");

    // The defective shape is rejected before the factory is ever called: the pool
    // never builds, and the caller gets a stand-in.
    expect(malformed.contexts).toHaveLength(0);
    return expectSettles(channel.send({ capability: "conversation.sync", body: {} })).then(
      (result) => {
        expect(result.ok).toBe(false);
      },
    );
  });

  it("connects an agent that was asked for before the endpoint existed", () => {
    // The defect this group exists for, and the most likely one in production.
    // `endpoint` is non-null only while the engine is ready, and the
    // engine goes handshaking -> openSocket -> requestAppServerInfo -> ready. So
    // "no endpoint yet" is the *normal* state during startup, not an exception -
    // and a render path may well ask for a channel while it holds (a window
    // restoring a conversation is exactly that).
    //
    // Red when: the not-connected stand-in is cached like a real entry. Then this
    // agent is unreachable for the rest of the process: every later `send` answers
    // NOT_CONNECTED and nothing ever retries, because the caller has no way to know
    // it must close and re-fetch.
    let ready = false;
    const h = makePool({
      endpointOf: (agentId) =>
        ready ? { url: `ws://127.0.0.1:1/${agentId}`, token: `token-${agentId}` } : null,
    });

    const early = h.pool.getChannel("a");
    // It must still be a channel, not an exception and not undefined: the caller
    // cannot be expected to handle a third outcome.
    expect(early.agentId).toBe("a");

    ready = true;
    const later = h.pool.getChannel("a");

    expect(later).not.toBe(early);
    expect(later).toBe(h.pool.getChannel("a"));
    // And it is genuinely connected: the command reached a transport.
    const pending = later.send({
      capability: "conversation.sync",
      body: {},
      requestId: "req-late",
    });
    expect(h.viewOf("a")?.writer.calls.at(-1)?.requestId).toBe("req-late");
    h.ingest("a", responseFrame("req-late", { data: { ok: true } }));
    return expectSettles(pending).then((result) => {
      expect(result.ok).toBe(true);
    });
  });

  it("connects after any number of pre-ready fetches", () => {
    // The same defect after repeated early calls - a window that renders a few
    // times before the engine is ready must not be worse off than one that
    // rendered once. Red when: only the first early fetch is special-cased.
    let ready = false;
    const h = makePool({
      endpointOf: (agentId) =>
        ready ? { url: `ws://127.0.0.1:1/${agentId}`, token: `token-${agentId}` } : null,
    });

    const first = h.pool.getChannel("a");
    const second = h.pool.getChannel("a");
    const third = h.pool.getChannel("a", "conv-1");
    for (const channel of [first, second, third]) {
      expect(channel.agentId).toBe("a");
    }

    ready = true;
    const live = h.pool.getChannel("a");

    expect(live).toBe(h.pool.getChannel("a"));
    const pending = live.send({ capability: "conversation.sync", body: {}, requestId: "req-many" });
    expect(h.viewOf("a")?.writer.calls.at(-1)?.requestId).toBe("req-many");
    h.ingest("a", responseFrame("req-many", { data: {} }));
    return expectSettles(pending).then((result) => {
      expect(result.ok).toBe(true);
    });
  });

  it("hands out a fresh stand-in per fetch, and never enrols one", () => {
    // The mechanism behind the fix, asserted on the frozen surface only. While the
    // endpoint is unavailable the pool returns a stand-in, and a stand-in is a
    // *reply*, not a connection, so it is not stored: every fetch is a new object
    // and `channels()` - which reports real connections - stays empty.
    //
    // Red when: the stand-in is cached. Then the second fetch returns the first
    // object (so this agent is stuck on it), and `channels()` starts advertising
    // a connection that does not exist. Both halves matter: an implementation
    // could keep returning fresh objects while also enrolling them, or cache one
    // object without reporting it.
    const h = makePool({ endpointOf: () => null });

    const first = h.pool.getChannel("a");
    const second = h.pool.getChannel("a");
    const third = h.pool.getChannel("a", "conv-1");

    // Fresh each time: nothing was remembered to hand back.
    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
    // And none of them is a connection, so none is reported as one.
    expect(h.pool.channels()).toHaveLength(0);
    // Fetching again still does not start caching: the rule is about the endpoint,
    // not about how many times the caller asked.
    expect(h.pool.getChannel("a")).not.toBe(first);
    expect(h.pool.channels()).toHaveLength(0);
    // A stand-in still carries its agent, so a caller can log or route on it.
    expect(first.agentId).toBe("a");
    expect(third.agentId).toBe("a");
  });

  it("keeps answering NOT_CONNECTED, without throwing, while there is no endpoint", () => {
    // Not caching the stand-in must not become "throw" or "return nothing": the
    // engine may never become ready (no credentials, a failed handshake), and a
    // render path still runs. Red when: the pool refuses to hand out a channel, or
    // the stand-in rejects instead of resolving, or it stops reporting not-ready.
    const h = makePool({ endpointOf: () => null });

    const sends = [1, 2, 3].map((i) => {
      const channel = h.pool.getChannel("a", i === 3 ? "conv-1" : undefined);
      expect(channel.agentId).toBe("a");
      expect(channel.capabilities()).toEqual({ state: "unknown" });
      return channel.send({ capability: "conversation.sync", body: {}, requestId: `req-${i}` });
    });

    return Promise.all(sends.map((pending) => expectSettles(pending))).then((results) => {
      for (const result of results) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("NOT_CONNECTED");
          // §5.2.2: "never came up" must stay distinguishable from "dropped".
          expect(result.error.detail).toContain("engine has not become ready");
        }
      }
      // A stand-in is not a connection, so it must not be reported as one.
      expect(h.pool.channels()).toHaveLength(0);
    });
  });

  it("does not leak a closed stand-in into channels()", () => {
    // Whatever a stand-in is, closing it must remain safe and idempotent, and it
    // must never be counted as a live connection. Red when: stand-ins are tracked
    // as entries and `closeChannel` cannot find them, or `channels()` reports one.
    const h = makePool({ endpointOf: () => null });

    const stand = h.pool.getChannel("a");
    expect(h.pool.channels()).toHaveLength(0);

    stand.close();
    expect(() => h.pool.closeChannel("a")).not.toThrow();
    expect(h.pool.channels()).toHaveLength(0);
    // The next fetch is a fresh attempt, not a dead instance.
    expect(h.pool.getChannel("a")).not.toBe(stand);
  });
});
