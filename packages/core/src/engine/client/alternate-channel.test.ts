/**
 * Differential suite: the second `ChannelPool` implementation against the
 * production one.
 *
 * Claim under test: **swapping the pool implementation
 * changes one layer and nothing above it.** The alternate implementation is
 * a comparison artifact only: `alternate-channel.ts` lives next to this file,
 * is exported from no barrel, and is not used in production. Its job is to be a
 * *different* implementation of the same frozen interface so that "the caller
 * cannot tell" is a measurement rather than an assurance.
 *
 * Four kinds of test: the four-assertion template (assertion 3 is the
 * positive control for assertion 4), the differential battery (one script object,
 * two worlds, one comparison - the caller written once so both pools see the
 * identical sequence), the mutation-driven corner cases, and the measured
 * divergences, which are reported rather than smoothed over.
 *
 * **What a differential suite cannot do.** Agreement is not correctness: two
 * implementations can agree on being wrong, and then every comparison here is
 * green and worthless. It happened - this file spent hours in exactly that state,
 * while `materialize()` and `pool.ts` both cached the degraded channel, so a
 * `getChannel` that ran before the engine was ready pinned that agent to a dead
 * channel for the session and the whole battery still passed. What found it was
 * *one of the two implementations being fixed*, not the comparison; the
 * comparison only reports "these disagree", never "this is right". A green run
 * here therefore licenses "swapping the pool changes nothing above it" and
 * nothing more - never "the pool is correct".
 *
 * Time is fake throughout and every world is torn down in `afterEach`; see
 * `alternate-harness.ts`. The file is bounded by scenario count, not by any wait.
 */

import { afterEach, describe, expect, it } from "vitest";

import { AlternateChannelPool } from "./alternate-channel";
import type { Observation, Step } from "./alternate-harness";
import {
  CLOSED_PHRASE,
  expectSettlesNow,
  expectStillWaiting,
  makeDual,
  runDual,
  teardownDifferential,
  TRACKED,
  templateAssertions,
} from "./alternate-harness";
import type { Dual } from "./alternate-harness";
import {
  makeClock,
  makeReader,
  makeWriter,
  trackChannel,
  trackClock,
} from "./channel-test-support";
import { EngineChannel, createChannel } from "./channel";
import { ChannelPoolReentryError, createChannelPool } from "./pool";
import type { Channel, ChannelPool, CommandResult } from "./types";

afterEach(teardownDifferential);

/* Compile-time checks */

/** `true` only when the two types are identical. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails the build unless its argument is `true`. */
type Expect<T extends true> = T;

/** `getChannel` must stay synchronous on both: an `async` method cannot satisfy `Equal`. */
type BothGetChannelSynchronous = Expect<
  Equal<ReturnType<AlternateChannelPool["getChannel"]>, Channel> &
    Equal<ReturnType<ChannelPool["getChannel"]>, Channel>
>;

/** The comparison pool must satisfy the frozen interface, not merely resemble it. */
type AlternateIsAChannelPool = Expect<
  Equal<AlternateChannelPool extends ChannelPool ? true : false, true>
>;

/** Keeps the assertions above from being optimised away as unused. */
const COMPILE_TIME_CHECKS: [BothGetChannelSynchronous, AlternateIsAChannelPool] = [true, true];

/* Helpers */

/**
 * Compare two logs and demand they are the same session.
 *
 * The length check runs first because `toEqual` on arrays of different lengths
 * prints both in full, burying the entry that differs. Then every `sendOn` label
 * must appear as a `settle` or a `drain`, so a scenario whose steps were silently
 * skipped cannot pass by comparing two equally short logs.
 *
 * @param script the script both worlds ran
 * @param result the two logs plus the worlds
 */
function expectEquivalent(
  script: readonly Step[],
  result: Awaited<ReturnType<typeof runDual>>,
): void {
  const { production, alternate } = result;
  expect(alternate.length).toBe(production.length);

  const sent = script.filter((step) => step.op === "sendOn").map((step) => step.label);
  const resolved = new Set(
    alternate
      .filter((entry) => entry.op === "settle" || entry.op === "drain")
      .map((entry) => entry.label),
  );
  for (const label of sent) {
    expect(resolved.has(label)).toBe(true);
  }

  expect(alternate).toEqual(production);
  expect(alternate.length).toBeGreaterThan(0);
}

/**
 * Run one script against both pools, demand equivalence, and return the result.
 *
 * @param script the steps
 * @param extra an optional assertion that runs with both worlds in hand
 * @returns both logs and both worlds, for a caller that needs them
 */
async function scenario(
  script: readonly Step[],
  extra?: (result: Awaited<ReturnType<typeof runDual>>) => void,
): Promise<Awaited<ReturnType<typeof runDual>>> {
  const result = await runDual(script);
  try {
    expectEquivalent(script, result);
    extra?.(result);
    return result;
  } finally {
    // Both worlds close on their own inside `runScript`; this only names the
    // leak when one implementation failed to release a timer.
    expect(result.dual.production.clock.pending()).toBe(0);
    expect(result.dual.alternate.clock.pending()).toBe(0);
  }
}

/* 1. The four-assertion template */

describe("the four assertions, on each implementation", () => {
  it("holds for the production pool", async () => {
    await templateAssertions(makeDual().production.pool);
  });

  it("holds for the alternate pool", async () => {
    await templateAssertions(makeDual().alternate.pool);
  });

  it("reaches the same verdicts on both, step for step", async () => {
    // Verdicts, not prose: assertions 3 and 4 are the phrase's presence and its
    // absence. Now that divergence 1 is fixed the whole result agrees, but the
    // template only ever required these two verdicts.
    const dual = makeDual();
    const production = await templateAssertions(dual.production.pool);
    const alternate = await templateAssertions(dual.alternate.pool);

    expect(alternate).toEqual(production);
    expect(alternate.staleDetail).toContain(CLOSED_PHRASE);
    expect(alternate.freshDetail).not.toContain(CLOSED_PHRASE);
  });
});

/* 2. Instance identity */

describe("instance identity is the same on both", () => {
  it("reuses the instance for repeated getChannel, and never across agents", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "get", handle: "h2", agent: "a" },
      { op: "get", handle: "h3", agent: "b" },
      { op: "channels" },
    ]);
  });

  it("treats a second conversation id as a scope, not a second connection", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a", conversation: "conv-1" },
      { op: "get", handle: "h2", agent: "a", conversation: "conv-2" },
      { op: "channels" },
      { op: "sendOn", label: "second-scope", handle: "h2", requestId: "req-scope" },
      { op: "reply", agent: "a", requestId: "req-scope", data: { ok: 1 } },
      { op: "await", label: "second-scope" },
      // The transport saw one connection for the agent, under the *first*
      // conversation: the second id is a request scope, not a second channel.
      { op: "channels" },
    ]);
  });

  it("hands back a distinct instance after a close, and keeps it stable", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "close", agent: "a" },
      { op: "get", handle: "h2", agent: "a" },
      { op: "get", handle: "h3", agent: "a" },
      { op: "channels" },
    ]);
  });

  it("replaces a channel the consumer closed, rather than returning the zombie", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "closeHandle", handle: "h1" },
      { op: "channels" },
      { op: "get", handle: "h2", agent: "a" },
      { op: "sendOn", label: "after-rebuild", handle: "h2", requestId: "req-rebuilt" },
      { op: "reply", agent: "a", requestId: "req-rebuilt", data: {} },
      { op: "await", label: "after-rebuild" },
    ]);
  });
});

/* 3. Command result sequences */

describe("command results are the same on both", () => {
  it("delivers a correlated answer to the caller", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "sendOn", label: "ask", handle: "h1", requestId: "req-1" },
      { op: "reply", agent: "a", requestId: "req-1", data: { answer: 42 } },
      { op: "await", label: "ask" },
    ]);
  });

  it("reports the engine's refusal as a value, not a throw", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "sendOn", label: "refused", handle: "h1", requestId: "req-r" },
      { op: "refuse", agent: "a", requestId: "req-r" },
      { op: "await", label: "refused" },
    ]);
  });

  it("times out on the injected clock, without spending wall-clock time", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "sendOn", label: "slow", handle: "h1", requestId: "req-t" },
      { op: "advance", ms: 30_000 },
      { op: "await", label: "slow" },
    ]);
  });

  it("refuses the in-flight request when its own channel is closed", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "sendOn", label: "pending", handle: "h1", requestId: "req-c" },
      { op: "close", agent: "a" },
      { op: "await", label: "pending" },
    ]);
  });

  it("refuses the in-flight request when the whole pool closes", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "get", handle: "h2", agent: "b" },
      { op: "sendOn", label: "pa", handle: "h1", requestId: "req-pa" },
      { op: "sendOn", label: "pb", handle: "h2", requestId: "req-pb" },
      { op: "closeAll" },
      { op: "await", label: "pa" },
      { op: "await", label: "pb" },
      { op: "channels" },
    ]);
  });

  it("refuses work on a handle the pool has already replaced", async () => {
    // The third assertion through the scripted path. The handle is *used*
    // before the close, so both pools built a channel behind it: a never-used
    // handle is measured divergence 1, and mixing the two would hide which one a
    // failure came from.
    await scenario([
      { op: "get", handle: "old", agent: "a" },
      { op: "capabilities", handle: "old" },
      { op: "close", agent: "a" },
      { op: "get", handle: "new", agent: "a" },
      { op: "sendOn", label: "on-old", handle: "old", requestId: "req-old" },
      { op: "await", label: "on-old" },
    ]);
  });

  it("answers NOT_CONNECTED the same way when no endpoint exists yet", async () => {
    // The degraded path end to end: with no endpoint the pool still hands out a
    // channel, and a command on it is a value with the wording both agree on.
    const dual = makeDual();
    dual.production.setEndpoint(() => null);
    dual.alternate.setEndpoint(() => null);
    const script: readonly Step[] = [
      { op: "get", handle: "h1", agent: "a" },
      { op: "sendOn", label: "no-endpoint", handle: "h1", requestId: "req-n" },
      { op: "await", label: "no-endpoint" },
      { op: "capabilities", handle: "h1" },
      { op: "get", handle: "h2", agent: "a", conversation: "conv-2" },
      { op: "channels" },
    ];
    const both = await runDual(script, dual);
    expectEquivalent(script, both);

    // The result is asserted by value, so "both refused" cannot hide "both said
    // something else".
    const settle = both.production.find((entry) => entry.op === "settle");
    expect(settle).toBeDefined();
    expect(settle?.result.code).toBe("NOT_CONNECTED");
    expect(settle?.result.detail).toContain("engine has not become ready");
  });

  it("degrades instead of throwing when the resolver fails or answers junk", async () => {
    const dual = makeDual();
    dual.production.setEndpoint(() => {
      throw new Error("engine is not ready");
    });
    dual.alternate.setEndpoint(() => {
      throw new Error("engine is not ready");
    });
    const throwing: readonly Step[] = [
      { op: "get", handle: "h1", agent: "a" },
      { op: "sendOn", label: "throwing", handle: "h1", requestId: "req-x" },
      { op: "await", label: "throwing" },
    ];
    expectEquivalent(throwing, await runDual(throwing, dual));

    const malformed = makeDual();
    // A resolver that answers a shape the contract does not promise: a wiring
    // bug the pool is required to absorb rather than propagate.
    const junk = () =>
      ({ url: "ws://127.0.0.1:1/a" }) as unknown as { url: string; token: string } | null;
    malformed.production.setEndpoint(junk);
    malformed.alternate.setEndpoint(junk);
    const junkScript: readonly Step[] = [
      { op: "get", handle: "h1", agent: "a" },
      { op: "sendOn", label: "junk", handle: "h1", requestId: "req-j" },
      { op: "await", label: "junk" },
    ];
    expectEquivalent(junkScript, await runDual(junkScript, malformed));
  });

  it("resolves the write-and-forget capabilities on both, with no answer to wait for", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      // `device.setState` is untracked (no request id on the wire).
      {
        op: "sendOn",
        label: "untracked",
        handle: "h1",
        requestId: "req-u",
        capability: "device.setState",
      },
      { op: "await", label: "untracked" },
      // `file.watch` is silent: it carries an id and the engine never answers it.
      { op: "sendOn", label: "silent", handle: "h1", requestId: "req-w", capability: "file.watch" },
      { op: "await", label: "silent" },
    ]);
  });
});

describe("identity and lifetime corners the mutation pass singled out", () => {
  it("replaces a channel the transport closed behind the pool's back", async () => {
    // Red when: a self-closed entry is handed out again, or the replacement is
    // not stable afterwards.
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "capabilities", handle: "h1" },
      { op: "closeInner", agent: "a" },
      { op: "channels" },
      { op: "get", handle: "h2", agent: "a" },
      { op: "get", handle: "h3", agent: "a" },
      { op: "channels" },
    ]);
  });

  it("passes the first conversation id to the factory, and only once", async () => {
    // Red when: the creation scope is dropped, invented, or re-supplied by a
    // later getChannel (the conversation is a request scope, not a connection).
    const result = await scenario([
      { op: "get", handle: "h1", agent: "a", conversation: "conv-1" },
      { op: "get", handle: "h2", agent: "a", conversation: "conv-2" },
      { op: "capabilities", handle: "h2" },
    ]);
    // The context both pools hand the factory: agent, and the first scope.
    const contexts = result.dual.production.contexts();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.agentId).toBe("a");
    expect(contexts[0]?.conversationId).toBe("conv-1");
    expect(result.dual.alternate.contexts()).toEqual(contexts);
  });

  it("closes the named agent only, keeping the neighbour's channel and order", async () => {
    // Red when: closeChannel closes the newest entry regardless of its agent.
    const result = await scenario([
      { op: "get", handle: "ha", agent: "a" },
      { op: "get", handle: "hb", agent: "b" },
      { op: "get", handle: "hc", agent: "c" },
      { op: "close", agent: "a" },
      { op: "channels" },
      { op: "sendOn", label: "b-alive", handle: "hb", requestId: "req-b" },
      { op: "reply", agent: "b", requestId: "req-b", data: { b: true } },
      { op: "await", label: "b-alive" },
    ]);
    const live = result.alternate.find((entry) => entry.op === "channels");
    expect(live?.live.map((entry) => entry.agent)).toEqual(["b", "c"]);
  });

  it("keeps closeChannel and closeAll idempotent under repetition", async () => {
    // Red when: retire/release are not idempotent, so the second close frees a
    // lease that is already gone (which would close a rebuilt channel).
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "close", agent: "a" },
      { op: "close", agent: "a" },
      { op: "get", handle: "h2", agent: "a" },
      { op: "closeAll" },
      { op: "closeAll" },
      { op: "get", handle: "h3", agent: "a" },
      { op: "sendOn", label: "rebuilt", handle: "h3", requestId: "req-r" },
      { op: "reply", agent: "a", requestId: "req-r", data: {} },
      { op: "await", label: "rebuilt" },
    ]);
  });

  it("delivers diagnostics to a facade subscriber, not only events", async () => {
    // Red when: onDiagnostic is wired to nothing, so a diagnostics panel stays
    // empty while the channel records failures.
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "subscribe", handle: "h1" },
      { op: "sendOn", label: "refused", handle: "h1", requestId: "req-d" },
      { op: "refuse", agent: "a", requestId: "req-d" },
      { op: "await", label: "refused" },
      { op: "malformed", agent: "a" },
      { op: "sees", label: "records", handle: "h1" },
    ]);
  });

  it("keeps delivering after one subscriber throws", async () => {
    // Red when: a throwing consumer takes the next subscriber's frame with it.
    const dual = makeDual();
    const seen: Record<string, unknown[]> = {};
    for (const world of [dual.production, dual.alternate]) {
      const frames: unknown[] = [];
      seen[world.kind] = frames;
      const channel = world.pool.getChannel("a");
      channel.onEvent(() => {
        throw new Error("the panel crashed");
      });
      channel.onEvent((frame) => {
        frames.push((frame.raw as { who: string }).who);
      });
      world.ingest("a", JSON.stringify({ type: "known.event", who: "survivor" }));
      world.pool.closeAll();
    }
    expect(seen["alternate"]).toEqual(["survivor"]);
    expect(seen["production"]).toEqual(["survivor"]);
  });
});

/* 4. Event and diagnostic sequences */

describe("event and diagnostic sequences are the same on both", () => {
  it("keeps each agent's events to itself and in arrival order", async () => {
    const result = await runDual([
      { op: "get", handle: "ha", agent: "a" },
      { op: "get", handle: "hb", agent: "b" },
      // Touch both handles so the alternate pool has materialized its channels
      // before a frame is delivered. The construction *timing* is a measured
      // divergence (below); what is compared here is delivery.
      { op: "capabilities", handle: "ha" },
      { op: "capabilities", handle: "hb" },
      { op: "push", agent: "a", type: "known.event", extra: { who: "a1" } },
      { op: "push", agent: "b", type: "known.event", extra: { who: "b1" } },
      { op: "push", agent: "b", type: "known.event", extra: { who: "b2" } },
      { op: "malformed", agent: "a" },
      { op: "close", agent: "b" },
      { op: "push", agent: "a", type: "known.event", extra: { who: "a2" } },
    ]);

    expect(result.alternate).toEqual(result.production);
    expect(result.dual.alternate.eventsOf("a")).toEqual(result.dual.production.eventsOf("a"));
    expect(result.dual.alternate.eventsOf("b")).toEqual(result.dual.production.eventsOf("b"));
    expect(result.dual.alternate.recordsOf("a")).toEqual(result.dual.production.recordsOf("a"));
    // The counts are asserted as well, so "both empty" cannot pass silently.
    expect(result.dual.alternate.eventsOf("a")).toHaveLength(2);
    expect(result.dual.alternate.recordsOf("a")).toHaveLength(1);
  });

  it("delivers a late answer as an event, not as an error", async () => {
    const result = await runDual([
      { op: "get", handle: "h1", agent: "a" },
      { op: "sendOn", label: "late", handle: "h1", requestId: "req-late" },
      { op: "advance", ms: 30_000 },
      { op: "await", label: "late" },
      { op: "reply", agent: "a", requestId: "req-late", data: { stale: true } },
    ]);

    expect(result.alternate).toEqual(result.production);
    expect(result.dual.alternate.eventsOf("a")).toHaveLength(1);
    expect(result.dual.alternate.eventsOf("a")).toEqual(result.dual.production.eventsOf("a"));
  });

  it("reports the same diagnostics for the same failures", async () => {
    const result = await runDual([
      { op: "get", handle: "h1", agent: "a" },
      { op: "sendOn", label: "refused", handle: "h1", requestId: "req-d1" },
      { op: "refuse", agent: "a", requestId: "req-d1" },
      { op: "await", label: "refused" },
      { op: "sendOn", label: "timed-out", handle: "h1", requestId: "req-d2" },
      { op: "advance", ms: 30_000 },
      { op: "await", label: "timed-out" },
      { op: "malformed", agent: "a" },
    ]);

    expect(result.alternate).toEqual(result.production);
    const records = result.dual.alternate.recordsOf("a") as readonly { kind: string }[];
    expect(records.map((record) => record.kind)).toEqual(["rejected", "timeout", "malformed"]);
    expect(records).toEqual(result.dual.production.recordsOf("a"));
  });

  it("keeps the capability snapshot in all three states", async () => {
    const script: readonly Step[] = [
      { op: "get", handle: "h1", agent: "a" },
      { op: "capabilities", handle: "h1" },
      // Flags only: the state has to stay `unknown`.
      {
        op: "push",
        agent: "a",
        type: "known.event",
        extra: { capabilityProbe: { booleans: { a: true } } },
      },
      { op: "capabilities", handle: "h1" },
      // An explicit empty list is `confirmed-empty`, not `probed`.
      {
        op: "push",
        agent: "a",
        type: "known.event",
        extra: { capabilityProbe: { slashCommands: [] } },
      },
      { op: "capabilities", handle: "h1" },
      // A non-empty list is `probed`.
      {
        op: "push",
        agent: "a",
        type: "known.event",
        extra: { capabilityProbe: { slashCommands: ["go"], booleans: { a: true } } },
      },
      { op: "capabilities", handle: "h1" },
    ];
    const result = await runDual(script);
    expectEquivalent(script, result);

    const states = result.alternate
      .filter(
        (entry): entry is Extract<Observation, { op: "capabilities" }> =>
          entry.op === "capabilities",
      )
      .map((entry) => entry.snapshot.state);
    expect(states).toEqual(["unknown", "unknown", "confirmed-empty", "probed"]);
  });
});

/* 5. Lifetime: close, closeAll, arguments */

describe("lifetime semantics are the same on both", () => {
  it("ignores a close for an agent it never opened, and stays idempotent", async () => {
    await scenario([
      { op: "close", agent: "never-opened" },
      { op: "get", handle: "h1", agent: "a" },
      { op: "close", agent: "a" },
      { op: "close", agent: "a" },
      { op: "closeAll" },
      { op: "closeAll" },
      { op: "channels" },
    ]);
  });

  it("treats closeAll as a close, not as a terminal dispose", async () => {
    await scenario([
      { op: "get", handle: "h1", agent: "a" },
      { op: "closeAll" },
      { op: "channels" },
      { op: "get", handle: "h2", agent: "a" },
      { op: "sendOn", label: "after-closeAll", handle: "h2", requestId: "req-ac" },
      { op: "reply", agent: "a", requestId: "req-ac", data: {} },
      { op: "await", label: "after-closeAll" },
    ]);
  });

  it("leaves the neighbour's handle and subscribers alone when one agent closes", async () => {
    await scenario([
      { op: "get", handle: "ha", agent: "a" },
      { op: "get", handle: "hb", agent: "b" },
      { op: "sendOn", label: "a-in-flight", handle: "ha", requestId: "req-a" },
      { op: "close", agent: "b" },
      { op: "reply", agent: "a", requestId: "req-a", data: { alive: true } },
      { op: "await", label: "a-in-flight" },
      { op: "channels" },
    ]);
  });

  it("rejects the same two bad arguments with the same error class", () => {
    const dual = makeDual();
    for (const pool of [dual.production.pool, dual.alternate.pool]) {
      expect(() => pool.getChannel("")).toThrow(TypeError);
      expect(() => pool.getChannel("a", "")).toThrow(TypeError);
      expect(() => pool.getChannel(42 as unknown as string)).toThrow(TypeError);
      // The rejections left nothing behind on either.
      expect(pool.channels()).toEqual([]);
    }
  });

  it("does not rebuild a channel for a subscriber attached after the close", async () => {
    // Red when: subscribing on a retired facade attaches a pump, building a fresh
    // connection only to have nothing to deliver on it.
    const dual = makeDual();
    const stale = dual.alternate.pool.getChannel("a");
    dual.alternate.pool.closeChannel("a");
    const before = dual.alternate.factoryCalls();
    stale.onEvent(() => undefined)();
    expect(dual.alternate.factoryCalls()).toBe(before);
    dual.production.pool.closeAll();
    dual.alternate.pool.closeAll();
  });

  it("keeps live handles across enough closes to compact its registry", async () => {
    // Red when: the sweep that removes tombstones also drops live entries, so a
    // handle handed out earlier stops being the handle the pool returns. The
    // alternate pool compacts only after COMPACT_AT tombstones, so this needs
    // more closes than any other scenario - which is why the first mutation pass
    // could not see it.
    const dual = makeDual();
    // One long-lived agent stays open across every close below.
    const productions: Channel[] = [dual.production.pool.getChannel("keeper")];
    const alternates: Channel[] = [dual.alternate.pool.getChannel("keeper")];
    for (let index = 0; index < 20; index += 1) {
      const agent = `churn-${String(index)}`;
      dual.production.pool.getChannel(agent).close();
      dual.alternate.pool.getChannel(agent).close();
    }
    // The registry was compacted, and the keeper survived it on both.
    expect(dual.production.pool.getChannel("keeper")).toBe(productions[0]);
    expect(dual.alternate.pool.getChannel("keeper")).toBe(alternates[0]);
    expect(dual.production.pool.channels().map((channel) => channel.agentId)).toEqual(["keeper"]);
    expect(dual.alternate.pool.channels().map((channel) => channel.agentId)).toEqual(["keeper"]);

    dual.production.pool.closeAll();
    dual.alternate.pool.closeAll();
  });

  it("returns a fresh array from channels() that cannot mutate the pool", async () => {
    await scenario([
      { op: "get", handle: "hc", agent: "c" },
      { op: "get", handle: "ha", agent: "a" },
      { op: "channels" },
    ]);
  });
});

/* 6. Subscriber fan-out */

describe("subscriber fan-out is the same on both", () => {
  it("fans one frame out to every subscriber and honours unsubscribe", async () => {
    const dual = makeDual();
    const observed = new Map<string, number[]>();

    for (const world of [dual.production, dual.alternate]) {
      const channel = world.pool.getChannel("a");
      const first: number[] = [];
      const second: number[] = [];
      observed.set(`${world.kind}:first`, first);
      observed.set(`${world.kind}:second`, second);
      const stopFirst = channel.onEvent((frame) => {
        first.push((frame.raw as { seq: number }).seq);
      });
      channel.onEvent((frame) => {
        second.push((frame.raw as { seq: number }).seq);
      });

      // The first frame also proves a subscription attached before any use is
      // honoured: the alternate pool attaches its inner pump lazily.
      world.ingest("a", JSON.stringify({ type: "known.event", seq: 1 }));
      stopFirst();
      stopFirst(); // idempotent
      world.ingest("a", JSON.stringify({ type: "known.event", seq: 2 }));
      world.pool.closeAll();
    }

    // Both implementations deliver the same sequence to the same subscriber set.
    expect(observed.get("alternate:first")).toEqual(observed.get("production:first"));
    expect(observed.get("alternate:second")).toEqual(observed.get("production:second"));
    // And the counts are real, so "both empty" cannot pass.
    expect(observed.get("alternate:first")).toEqual([1]);
    expect(observed.get("alternate:second")).toEqual([1, 2]);
  });
});

/* 7. Convergence and the one remaining divergence */
