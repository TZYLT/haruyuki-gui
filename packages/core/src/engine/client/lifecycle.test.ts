/**
 * One channel's own lifecycle, and why its failure stays its own.
 *
 * `I-1` is not "agents cannot see each other" -  covers that, and
 * `multichannel.test.ts`  is its evidence. `I-1` is the **vertical** claim,
 * one channel deep:
 *
 * > C's own state goes handshaking -> ready -> dropped, and each of those states
 * > changes what **C** answers and nothing else.
 *
 * The horizontal question ("does closing C disturb A?") is deliberately *not*
 * asked here - not even once, even where it would be convenient. The two are
 * different defects: a pool-level sweep breaks the horizontal one, while a
 * shared readiness flag breaks the vertical one and leaves every horizontal
 * assertion green (A and C would both think they are ready, which looks like
 * agreement, not like a fault). Re-asking the horizontal question here would
 * produce a second copy of `multichannel.test.ts` and still not see that.
 *
 * The five groups, and the user-visible sentence each one protects:
 *
 * 1. **Each channel owns its readiness.** A is ready, C is still handshaking:
 *    A's command goes out, C's does not, and C says *why*, in the two wordings
 *    §5.2.2 makes an interface. Red when readiness is one shared cell.
 * 2. **A drop is a fact about one channel.** C was ready and dropped: C's answer
 *    changes from "written" to "was ready and dropped", and A's answer, A's
 *    readiness reading and A's diagnostic ring are byte-identical to before.
 *    Red when the drop path resets a global flag - the defect `I-1` is named for.
 * 3. **A rebuilt channel starts over.** Re-fetching after a drop must not hand
 *    back the corpse (every later send would fail forever) and must not inherit
 *    the corpse's latch, because a new connection has, truthfully, never been
 *    ready. Red when the rebuild reuses the dead channel or its state.
 * 4. **A connection that cannot be built degrades one agent.** The factory
 *    throws for C: C gets a stand-in that answers the startup wording, and A's
 *    and B's rings hold exactly the records *their own* frames produced. Red
 *    when the exception escapes, or lands in a ring a neighbour reads.
 * 5. **A slow channel does not make a fast one wait.** C never finishes its
 *    handshake; A's write still happens synchronously, in the same tick, and
 *    A's round trip completes while C is *still* handshaking. Red when the
 *    handshake is serialised, or one "currently handshaking" flag gates writes.
 *
 * Time is fake everywhere: a request that is never answered costs
 * no wall-clock time, and `teardownLifecycles` closes every pool before it
 * demands the clock is silent - a leaked timer here would surface as an
 * unrelated suite timing out 30 s later.
 *
 * The rig is `lifecycle-harness.ts`; it is socket-free on purpose and says so in
 * its header, so the boundary with the transport-level fleet is written down.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  eventFrame,
  expectSettles,
  responseFrame,
  TRACKED,
  UNTRACKED,
} from "./channel-test-support";
import type { Channel } from "./types";
import {
  makeLifecycle,
  MODELLED_TYPES,
  refusalOf,
  ringOf,
  sendTracked,
  sendTrackedOn,
  teardownLifecycles,
  UNMODELLED_A,
  UNMODELLED_B,
} from "./lifecycle-harness";

afterEach(teardownLifecycles);

/* ------------------------------------------------------------------------- */
/* 1. Each channel owns its readiness                                        */
/* ------------------------------------------------------------------------- */

describe("each channel owns its readiness", () => {
  it("lets the ready channel write while its neighbour is still handshaking", () => {
    // The startup window: one agent is up and
    // another is still coming up, which is the *normal* state for the first few
    // hundred milliseconds of a session. Red when: readiness is one cell for the
    // whole process - A coming up would then make C look ready too, and C's
    // command would reach a connection that does not exist.
    const h = makeLifecycle();
    const aChannel = h.getChannel("a");
    const cChannel = h.getChannel("c");
    h.setReady("a", true);

    // The two readings are separate facts, not one flag read twice.
    expect(h.readinessOf("a")).toEqual({ ready: true, everReady: true });
    expect(h.readinessOf("c")).toEqual({ ready: false, everReady: false });
    // They are also two kernels, so "different readiness" below cannot be an
    // artefact of one object answering for both.
    expect(aChannel).not.toBe(cChannel);
    expect(aChannel.agentId).toBe("a");
    expect(cChannel.agentId).toBe("c");

    return (async () => {
      const pending = sendTracked(h.agent("a"), "req-a");
      // A wrote, synchronously: the readiness port said yes and nothing gated it.
      expect(h.writesOf("a")).toHaveLength(1);

      const cError = await refusalOf(
        sendTracked(h.agent("c"), "req-c"),
        "C's send while handshaking",
      );
      expect(cError.code).toBe("NOT_CONNECTED");
      // §5.2.2, first sentence: a startup problem, not a dropped connection.
      expect(cError.detail).toContain("engine has not become ready");
      expect(cError.detail).not.toContain("ready and dropped");
      // And nothing was written on C's behalf: "not ready" refuses *before* the
      // wire, so a peer that is down never sees a command it cannot answer.
      expect(h.writesOf("c")).toHaveLength(0);

      // A's request still finishes with its own answer, so the refusal above
      // cost A nothing.
      h.emit("a", responseFrame("req-a", { data: { answer: 1 } }));
      const answered = await expectSettles(pending);
      expect(answered.ok).toBe(true);
      if (answered.ok) {
        expect(answered.data).toEqual({ answer: 1 });
      }
    })();
  });

  it("answers each channel on its own terms in the reverse pairing", () => {
    // The same claim with the roles swapped, so a "whichever channel was asked
    // for first owns the flag" implementation cannot pass group 1 by luck. C is
    // built *first* here and is ready; A is built second and is not.
    // Red when: readiness is keyed on creation order, or on the first channel.
    const h = makeLifecycle();
    h.getChannel("c");
    h.getChannel("a");
    h.setReady("c", true);

    return (async () => {
      const pending = sendTracked(h.agent("c"), "req-c");
      expect(h.writesOf("c")).toHaveLength(1);

      const aError = await refusalOf(
        sendTracked(h.agent("a"), "req-a"),
        "A's send while handshaking",
      );
      expect(aError.code).toBe("NOT_CONNECTED");
      expect(aError.detail).toContain("engine has not become ready");
      expect(h.writesOf("a")).toHaveLength(0);

      h.emit("c", responseFrame("req-c"));
      expect((await expectSettles(pending)).ok).toBe(true);
    })();
  });
});

/* ------------------------------------------------------------------------- */
/* 2. A drop changes one channel's answer, and only that answer              */
/* ------------------------------------------------------------------------- */

describe("a drop changes one channel's answer and nothing else", () => {
  it("moves C from 'written' to 'was ready and dropped' while A keeps writing", () => {
    // This is `I-1`'s core sentence: **C's disconnection is not reported as a
    // global failure.** Both channels were ready; C's connection then went away.
    // Red when: the drop path resets a readiness flag that is not C's - then A's
    // second send would be refused too, and the user would lose a working agent
    // because a different one dropped.
    const h = makeLifecycle();
    h.getChannel("a");
    h.getChannel("c");
    h.setReady("a", true);
    h.setReady("c", true);

    return (async () => {
      // Both usable to start with, so "C can send" is an observed fact and not an
      // assumption this case silently relies on.
      const firstC = sendTracked(h.agent("c"), "req-c-1");
      expect(h.writesOf("c")).toHaveLength(1);
      h.emit("c", responseFrame("req-c-1"));
      expect((await expectSettles(firstC)).ok).toBe(true);

      // A's state before the drop, kept as a value so the comparison after it is
      // on the reading and not on the shape of the test.
      const aReadinessBefore = h.readinessOf("a");
      const aWritesBefore = h.writesOf("a").length;
      // A also has one record of its own before the drop. A shared ring, or a
      // "the fleet dropped" record written on the way past, would change this
      // number; a per-channel ring cannot.
      h.emit("a", eventFrame(UNMODELLED_A));
      expect(h.recordsOf("a").map((record) => record.subject)).toEqual([UNMODELLED_A]);

      // The drop. `false` is "it was ready and it went away"; `everReady` latches.
      h.setReady("c", false);
      expect(h.readinessOf("c")).toEqual({ ready: false, everReady: true });

      // C's own answer changes, and it changes to the *second* sentence.
      const cError = await refusalOf(
        sendTracked(h.agent("c"), "req-c-2"),
        "C's send after the drop",
      );
      expect(cError.code).toBe("NOT_CONNECTED");
      expect(cError.detail).toContain("channel was ready and dropped");
      expect(cError.detail).not.toContain("engine has not become ready");
      // The dropped channel wrote nothing more: it is not "probably still fine".
      expect(h.writesOf("c")).toHaveLength(1);

      // A is exactly as it was: same readiness reading, same record, and its next
      // command still reaches its own wire.
      expect(h.readinessOf("a")).toEqual(aReadinessBefore);
      expect(h.readinessOf("a")).toEqual({ ready: true, everReady: true });
      expect(h.recordsOf("a").map((record) => record.subject)).toEqual([UNMODELLED_A]);

      const aPending = sendTracked(h.agent("a"), "req-a");
      expect(h.writesOf("a")).toHaveLength(aWritesBefore + 1);
      h.emit("a", responseFrame("req-a", { data: { answer: 2 } }));
      const aResult = await expectSettles(aPending);
      expect(aResult.ok).toBe(true);
      if (aResult.ok) {
        expect(aResult.data).toEqual({ answer: 2 });
      }
    })();
  });

  it("latches everReady on the channel that dropped and leaves it off the one that never came up", () => {
    // The two sentences are not decoration: §5.2.2 makes them the only signal a
    // reconnect policy (B3) has to decide whether a replay is worth attempting.
    // Two channels, two different truthful answers, live at the same moment.
    // Red when: `everReady` is stored per process (everyone says "dropped" once
    // anyone has been up), or never latched (the dropped channel claims startup).
    const h = makeLifecycle();
    h.getChannel("up");
    h.getChannel("never");
    h.setReady("up", true);
    h.setReady("up", false);

    return (async () => {
      const upError = await refusalOf(
        sendTracked(h.agent("up"), "req-up"),
        "the channel that dropped",
      );
      const neverError = await refusalOf(
        sendTracked(h.agent("never"), "req-never"),
        "the channel that never came up",
      );

      expect(upError.code).toBe("NOT_CONNECTED");
      expect(neverError.code).toBe("NOT_CONNECTED");
      // Same code, different sentence - which is exactly the contract.
      expect(upError.detail).toContain("channel was ready and dropped");
      expect(neverError.detail).toContain("engine has not become ready");
      expect(upError.detail).not.toBe(neverError.detail);
      // Neither of them wrote: the wording is a report, not a retry.
      expect(h.writesOf("up")).toHaveLength(0);
      expect(h.writesOf("never")).toHaveLength(0);
    })();
  });
});

/* ------------------------------------------------------------------------- */
/* 3. Re-fetching after a drop builds a channel that has never been ready    */
/* ------------------------------------------------------------------------- */

describe("re-fetching after a drop starts from a channel that never came up", () => {
  it("replaces a closed channel with a new object that answers the startup wording", () => {
    // Reading `pool.ts` first, as the work package requires: `closeChannel` drops
    // the entry and closes the kernel, so the next `getChannel` must build a new
    // one. The sharp half is the *wording*. The dead object keeps its `everReady`
    // latch and says "was ready and dropped"; the replacement has never spoken to
    // an engine and must say "has not become ready". A pool that handed the dead
    // object back, or a rebuild that copied the latch forward, collapses the two
    // and leaves B3 unable to tell a retry from a lost connection.
    // Red when: the closed entry is returned (zombie), or the rebuilt channel
    // inherits the old readiness.
    const h = makeLifecycle();
    const c = h.getChannel("c");
    h.setReady("c", true);

    expect(h.getChannel("c")).toBe(c);
    expect(h.contextsFor("c")).toHaveLength(1);

    h.pool.closeChannel("c");

    return (async () => {
      // The object the consumer is still holding: closed, and truthfully dropped.
      const deadError = await refusalOf(
        c.send({ capability: TRACKED, body: {}, requestId: "req-dead" }),
        "the closed channel",
      );
      expect(deadError.code).toBe("NOT_CONNECTED");
      expect(deadError.detail).toContain("channel was ready and dropped");
      expect(deadError.detail).toContain("the channel is closed");

      const rebuilt = h.getChannel("c");
      expect(rebuilt).not.toBe(c);
      expect(rebuilt.agentId).toBe("c");
      // A second build for C: the factory ran again, for the same agent.
      expect(h.contextsFor("c")).toHaveLength(2);
      expect(h.contextsFor("c")[1]?.agentId).toBe("c");
      // The new connection has, truthfully, never been ready - so the *first*
      // sentence, not the corpse's latch.
      expect(h.readinessOf("c")).toEqual({ ready: false, everReady: false });

      const freshError = await refusalOf(
        rebuilt.send({ capability: TRACKED, body: {}, requestId: "req-fresh" }),
        "the rebuilt channel",
      );
      expect(freshError.code).toBe("NOT_CONNECTED");
      expect(freshError.detail).toContain("engine has not become ready");
      expect(freshError.detail).not.toContain("ready and dropped");
      // Nothing was written for either request, so the rebuild did not resurrect
      // the old writer.
      expect(h.writesOf("c")).toHaveLength(0);
    })();
  });

  it("rebuilds a channel the wiring closed, instead of returning the zombie", () => {
    // The other door, and the one the task asked to be settled from the code
    // rather than assumed: when the *transport* dies, the wiring calls
    // `channel.close()` and the pool is never told. `pool.ts` keeps no close
    // notification, so the entry **does** linger in the map - but `channels()`
    // filters it and `getChannel` drops it before building, which is why the
    // observable behaviour matches `closeChannel`'s.
    //
    // Red when: the pool cannot tell a self-closed entry from an open one. Then
    // `getChannel` returns a closed channel, every later send answers
    // NOT_CONNECTED forever, and nothing ever retries.
    const h = makeLifecycle();
    const a = h.getChannel("a");
    const c = h.getChannel("c");
    h.setReady("c", true);

    // What the wiring does on `transport.onClose`. No pool call.
    c.close();

    return (async () => {
      // The entry lingers, but it is not reported as a connection...
      expect(h.channelIds()).toEqual(["a"]);
      // ...and no rebuild happens just because the pool was read.
      expect(h.contextsFor("c")).toHaveLength(1);

      const rebuilt = h.getChannel("c");
      expect(rebuilt).not.toBe(c);
      expect(h.contextsFor("c")).toHaveLength(2);
      expect(h.channelIds()).toEqual(["a", "c"]);

      // Fresh state again: the drop was the old connection's fact.
      expect(h.readinessOf("c")).toEqual({ ready: false, everReady: false });
      const error = await refusalOf(sendTracked(h.agent("c")), "the rebuilt channel");
      expect(error.code).toBe("NOT_CONNECTED");
      expect(error.detail).toContain("engine has not become ready");

      // A is the same object throughout: a rebuild for C is not a sweep.
      expect(h.getChannel("a")).toBe(a);
    })();
  });
});

/* ------------------------------------------------------------------------- */
/* 4. A connection that cannot be built degrades one agent                  */
/* ------------------------------------------------------------------------- */

describe("a failed connection degrades one agent and does not escalate", () => {
  it("gives C a stand-in, keeps A and B working, and keeps their rings their own", () => {
    // `I-1`'s body. "这个 agent 连接建不起来" is a runtime condition - a refused
    // condition - a refused socket, a poison endpoint - and the caller still gets
    // a channel. The half that makes this case different from the pool's factory-throw
    // case is the *diagnostics*: a failure that lands in a shared ring is a
    // failure A's bug report now carries, and the support bundle would name an
    // agent the user was not talking about.
    //
    // Red when: the throw escapes `getChannel` (the render path explodes), or it
    // is recorded somewhere a neighbour reads.
    const h = makeLifecycle({ failing: ["c"] });

    const a = h.getChannel("a");
    const b = h.getChannel("b");
    const c = h.getChannel("c");
    h.setReady("a", true);
    h.setReady("b", true);

    // C is a channel, not an exception and not `undefined` - the caller cannot
    // be expected to handle a third outcome.
    expect(c.agentId).toBe("c");
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);
    // It is the pool's own stand-in, never a connection: not in the map...
    expect(h.channelIds()).toEqual(["a", "b"]);
    // ...and no kernel was built for C at all, which is why the rig has no view.
    expect(h.maybe("c")).toBeUndefined();
    // The failure is C's alone: both neighbours are still real entries.
    expect(h.getChannel("a")).toBe(a);
    expect(h.getChannel("b")).toBe(b);

    return (async () => {
      const cError = await refusalOf(sendTrackedOn(c), "C's send on the degraded channel");
      expect(cError.code).toBe("NOT_CONNECTED");
      // First sentence: this agent's engine never became ready for us.
      expect(cError.detail).toContain("engine has not become ready");
      // The stand-in has no connection, so it reported nothing: there is no
      // channel behind it to have seen a failure.
      expect(ringOf(c)).toEqual([]);

      // A and B are fully usable, each with its own ring.
      h.emit("a", eventFrame(UNMODELLED_A));
      h.emit("b", eventFrame(UNMODELLED_B));
      // A modelled type is not a diagnostic: this pins that the two rings below
      // are "what each channel saw", not "everything the rig saw".
      h.emit("a", eventFrame("lifecycle.ping"));

      const aPending = sendTracked(h.agent("a"), "req-a");
      const bPending = sendTracked(h.agent("b"), "req-b");
      h.emit("a", responseFrame("req-a"));
      h.emit("b", responseFrame("req-b"));
      expect((await expectSettles(aPending)).ok).toBe(true);
      expect((await expectSettles(bPending)).ok).toBe(true);

      // **The assertion this case exists for**: not one record in A's or B's ring
      // came from C's failure. Exact arrays, so a leaked record of any kind -
      // including a "pool failure" summary - fails rather than being tolerated.
      expect(h.recordsOf("a").map((record) => record.subject)).toEqual([UNMODELLED_A]);
      expect(h.recordsOf("b").map((record) => record.subject)).toEqual([UNMODELLED_B]);
      for (const record of [...h.recordsOf("a"), ...h.recordsOf("b")]) {
        expect(record.engineText ?? "").not.toContain("refused to open");
      }

      // A second attempt for C is a second failure, and still C's: the factory is
      // asked again (a failed build is a moment, not a cached verdict) and the
      // neighbours neither rebuild nor gain a record.
      const secondC = h.getChannel("c");
      expect(secondC).not.toBe(c);
      expect(h.contextsFor("c")).toHaveLength(2);
      // Two builds for C and one each for the neighbours: the failure was retried
      // for C alone and nobody else was rebuilt to find that out.
      expect(h.factoryCalls()).toBe(4);
      expect(h.getChannel("a")).toBe(a);
      expect(h.getChannel("b")).toBe(b);
      expect(h.recordsOf("a").map((record) => record.subject)).toEqual([UNMODELLED_A]);
      expect(h.recordsOf("b").map((record) => record.subject)).toEqual([UNMODELLED_B]);
    })();
  });

  it("keeps the neighbours' answers unchanged when a third agent's build fails", () => {
    // The same failure with the neighbours' *answers* as the evidence, so a
    // "degrade" that quietly turned every channel not-ready would be caught even
    // if the rings happened to stay clean. Red when: the catch degrades the pool
    // instead of the agent.
    const h = makeLifecycle({ failing: ["dead"] });
    h.getChannel("a");
    h.getChannel("b");
    h.setReady("a", true);
    h.setReady("b", true);

    // Ask for the broken agent twice, in between valid sends on both neighbours.
    h.getChannel("dead");
    h.getChannel("dead");

    return (async () => {
      for (const agentId of ["a", "b"]) {
        const requestId = `req-${agentId}`;
        const pending = sendTracked(h.agent(agentId), requestId);
        expect(h.writesOf(agentId)).toHaveLength(1);
        h.emit(agentId, responseFrame(requestId));
        expect((await expectSettles(pending)).ok).toBe(true);
      }
      expect(h.readinessOf("a")).toEqual({ ready: true, everReady: true });
      expect(h.readinessOf("b")).toEqual({ ready: true, everReady: true });
      // And the degraded agent never appears as a connection anywhere.
      expect(h.channelIds()).toEqual(["a", "b"]);
    })();
  });

  it("gives each unconnectable agent its own stand-in, not one shared fallback", () => {
    // Two agents whose connections cannot be built are two *different* agents, and
    // the handle a caller holds is labelled with the agent it belongs to
    // (`Channel.agentId` is frozen, and it is how a consumer attributes the stream
    // it is holding). One stand-in reused for both would make the second caller's
    // channel claim the first caller's id - a cross-talk defect that is invisible
    // in a single-broken-agent test, because there is nothing to confuse it with.
    //
    // This is `I-1` at its narrowest: a *local* failure stays local, including in
    // the object handed out for it. Red when: `unconnected()` memoises its result,
    // or builds the kernel under a constant id.
    const h = makeLifecycle({ failing: ["c", "d"] });

    const c = h.getChannel("c");
    const d = h.getChannel("d");

    expect(c).not.toBe(d);
    expect(c.agentId).toBe("c");
    expect(d.agentId).toBe("d");
    // The same agent asked twice is a *reply*, not a connection: no entry, so each
    // call is free to build its own stand-in (they need not be identical, and
    // pinning that would freeze an implementation detail). What must not happen is
    // one agent's stand-in being answered to another agent.
    expect(h.getChannel("c").agentId).toBe("c");
    expect(h.getChannel("d").agentId).toBe("d");
    expect(h.channelIds()).toEqual([]);

    return (async () => {
      const cError = await refusalOf(sendTrackedOn(c), "C's degraded channel");
      const dError = await refusalOf(sendTrackedOn(d), "D's degraded channel");
      for (const error of [cError, dError]) {
        expect(error.code).toBe("NOT_CONNECTED");
        expect(error.detail).toContain("engine has not become ready");
      }
    })();
  });
});

/* ------------------------------------------------------------------------- */
/* 5. A slow channel does not make a fast one wait                           */
/* ------------------------------------------------------------------------- */

describe("a handshaking channel does not gate its neighbours", () => {
  it("writes A's frame in the same tick, with C still handshaking", () => {
    // The blocking defect: one "the fleet is handshaking" flag in front of the
    // write path, or a build queue that serialises connections. Either one makes
    // a user's able agent pay for an agent that is still starting.
    //
    // No real waiting is used to prove "immediately": the proof is the *absence*
    // of any tick between `send` returning and the frame being on A's wire, which
    // is asserted before the first `await`.
    // Red when: the write is gated on anything but this channel's own readiness.
    const h = makeLifecycle();
    // C is asked for first on purpose: a pool whose builds are serialised behind
    // the first handshake would never reach A here.
    h.getChannel("c");
    h.getChannel("a");
    h.setReady("a", true);
    expect(h.contexts().map((context) => context.agentId)).toEqual(["c", "a"]);

    const pending = sendTracked(h.agent("a"), "req-a");
    // Synchronous, before any await: the frame is on A's wire while C has not
    // finished its handshake.
    expect(h.writesOf("a")).toHaveLength(1);
    expect(h.readinessOf("c")).toEqual({ ready: false, everReady: false });
    // Exactly one timer exists - A's own request budget. C's handshake cost A no
    // timer, which is what "does not wait" means on a fake clock.
    expect(h.clock.pending()).toBe(1);

    return (async () => {
      h.emit("a", responseFrame("req-a", { data: { answer: 5 } }));
      const result = await expectSettles(pending);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({ answer: 5 });
      }
      // A's round trip is over and released its timer; C is *still* handshaking,
      // so A demonstrably never waited for it.
      expect(h.clock.pending()).toBe(0);
      expect(h.readinessOf("c")).toEqual({ ready: false, everReady: false });
      // C consumed no tick either: it refused without arming a timer.
      const cError = await refusalOf(sendTracked(h.agent("c")), "C's send while handshaking");
      expect(cError.detail).toContain("engine has not become ready");
      expect(h.clock.pending()).toBe(0);
    })();
  });

  it("does not reorder or duplicate A's writes when C finally becomes ready", () => {
    // The slow channel catching up is a change *on C*. A mutant that gates the
    // write path on "is any neighbour still handshaking" flips state when C
    // finishes and would replay or drop the frames A already sent.
    // Red when: the write path reacts to a neighbour's readiness transition.
    const h = makeLifecycle();
    h.getChannel("a");
    h.getChannel("c");
    h.setReady("a", true);

    return (async () => {
      const first = sendTracked(h.agent("a"), "req-a-1");
      expect(h.writesOf("a").map((call) => call.requestId)).toEqual(["req-a-1"]);
      h.emit("a", responseFrame("req-a-1"));
      expect((await expectSettles(first)).ok).toBe(true);

      // C's handshake completes. Nothing about A may move.
      h.setReady("c", true);

      const second = sendTracked(h.agent("a"), "req-a-2");
      expect(h.writesOf("a").map((call) => call.requestId)).toEqual(["req-a-1", "req-a-2"]);
      h.emit("a", responseFrame("req-a-2"));
      expect((await expectSettles(second)).ok).toBe(true);

      // C is usable now, on its own evidence.
      const cPending = sendTracked(h.agent("c"), "req-c");
      expect(h.writesOf("c").map((call) => call.requestId)).toEqual(["req-c"]);
      h.emit("c", responseFrame("req-c"));
      expect((await expectSettles(cPending)).ok).toBe(true);
    })();
  });
});

/* ------------------------------------------------------------------------- */
/* Guards: the rig can tell the three states apart                           */
/* ------------------------------------------------------------------------- */

describe("the rig makes the three states distinguishable", () => {
  it("starts every channel in handshaking, so a ready assertion cannot pass for free", () => {
    // Without this, "A is ready so A writes" would pass on a rig whose channels
    // are ready from birth, and group 1 would prove nothing. Red when: the
    // factory hands out an already-ready channel.
    const h = makeLifecycle();
    h.getChannel("a");
    h.getChannel("c");

    expect(h.readinessOf("a")).toEqual({ ready: false, everReady: false });
    expect(h.readinessOf("c")).toEqual({ ready: false, everReady: false });
    return (async () => {
      for (const agentId of ["a", "c"]) {
        const error = await refusalOf(sendTracked(h.agent(agentId)), `${agentId}'s first send`);
        expect(error.detail).toContain("engine has not become ready");
      }
      expect(h.writesOf("a")).toHaveLength(0);
      expect(h.writesOf("c")).toHaveLength(0);
    })();
  });

  it("mints one readiness cell per channel, so moving one cannot move another", () => {
    // The rig-level half of group 1: if the two cells were one, every observable
    // assertion above would become a statement about a single flag and the suite
    // would be structurally unable to see the defect it is named for.
    // Red when: the factory closes over one shared cell.
    const h = makeLifecycle();
    h.getChannel("a");
    h.getChannel("c");

    h.setReady("a", true);
    expect(h.readinessOf("a")).toEqual({ ready: true, everReady: true });
    expect(h.readinessOf("c")).toEqual({ ready: false, everReady: false });

    h.setReady("a", false);
    expect(h.readinessOf("a")).toEqual({ ready: false, everReady: true });
    expect(h.readinessOf("c")).toEqual({ ready: false, everReady: false });
  });

  it("reports a modelled type as no diagnostic and an unmodelled one as a record", () => {
    // Group 4 asserts exact ring contents, which only means "came from C's
    // failure" if the rig's own frames produce a predictable number of records.
    // Red when: the type table is dropped (nothing is reported at all, so a
    // neighbour could look clean without being per-channel).
    const h = makeLifecycle();
    h.getChannel("a");

    h.emit("a", eventFrame("lifecycle.ping"));
    expect(MODELLED_TYPES.has("lifecycle.ping")).toBe(true);
    expect(h.recordsOf("a")).toEqual([]);

    h.emit("a", eventFrame(UNMODELLED_A));
    expect(h.recordsOf("a").map((record) => record.kind)).toEqual(["unknown-event"]);
    expect(h.recordsOf("a").map((record) => record.subject)).toEqual([UNMODELLED_A]);
  });

  it("fails loudly when a refusal helper meets a send that succeeded", () => {
    // `refusalOf` is what makes groups 1, 2, 3 and 5 readable ("refused, because")
    // rather than a bare await. If it silently accepted a success, a mutant that
    // dropped the readiness check would look like a passing case.
    const h = makeLifecycle();
    h.getChannel("a");
    h.setReady("a", true);

    return (async () => {
      // An untracked capability resolves as soon as it is written, which is the
      // shortest "this send succeeded" the rig can produce.
      const succeeded = h.agent("a").channel.send({
        capability: UNTRACKED[0],
        body: {},
        runtime: { agent_id: "a", conversation_id: "conversation-a" },
      });
      await expect(refusalOf(succeeded, "a sent frame")).rejects.toThrow(
        /should have been refused/,
      );
      expect(h.writesOf("a")).toHaveLength(1);
      // The refusing path is the other half of the helper, so it is not vacuous:
      // a channel that is still handshaking must be reported as refused, not as a
      // success and not as a hang.
      h.getChannel("quiet");
      const refused = await refusalOf(
        sendTrackedOn(h.getChannel("quiet")),
        "a handshaking channel",
      );
      expect(refused.code).toBe("NOT_CONNECTED");
      expect(refused.detail).toContain("engine has not become ready");
    })();
  });

  it("names the agent instead of answering for one it never built", () => {
    // A rig that answered a read for an unbuilt agent would let the failed-build
    // case pass while reading a phantom: `maybe` must be the only quiet door, and
    // the loud ones must say which agent is missing. Red when: a view lookup
    // returns an empty object, or the rig's reads silently share one view.
    const h = makeLifecycle({ failing: ["dead"] });
    h.getChannel("a");
    h.getChannel("dead");

    expect(h.maybe("dead")).toBeUndefined();
    expect(h.maybe("a")?.agentId).toBe("a");
    expect(h.maybe("never-asked")).toBeUndefined();

    // Every loud read names the missing agent.
    expect(() => h.agent("dead")).toThrow(/has no channel for agent "dead"/);
    expect(() => h.readinessOf("dead")).toThrow(/"dead"/);
    expect(() => h.writesOf("dead")).toThrow(/"dead"/);
    expect(() => h.recordsOf("dead")).toThrow(/"dead"/);
    expect(() => h.emit("dead", eventFrame(UNMODELLED_A))).toThrow(/"dead"/);
    // Moving a state that does not exist is the same kind of mistake.
    expect(() => h.setReady("dead", true)).toThrow(/"dead"/);

    // The view list is a snapshot: mutating it cannot reach back into the rig.
    const agents = h.agents;
    expect(agents.map((view) => view.agentId)).toEqual(["a"]);
    (agents as unknown as { pop: () => void }).pop();
    expect(h.agents.map((view) => view.agentId)).toEqual(["a"]);

    // The rig can address a channel by conversation id as well as by agent, so a
    // case is never forced to reach around it into the pool. Asserted on the
    // creation context, because "the same instance came back" is true whether or
    // not the id was forwarded - only the factory sees the scope.
    h.getChannel("scoped", "conversation-scoped");
    expect(h.contextsFor("scoped")[0]?.conversationId).toBe("conversation-scoped");
    // A second id for the same agent reuses the channel rather than rebuilding it,
    // which is the frozen `ChannelPool` rule about conversations being scopes.
    expect(h.getChannel("scoped", "conversation-other")).toBe(h.getChannel("scoped"));
    expect(h.contextsFor("scoped")).toHaveLength(1);
  });

  it("reads a ring through the frozen surface, and answers empty when it cannot", () => {
    // `ringOf` is the only way group 4 can read the pool's degraded stand-in's
    // history: `diagnostics()` is not on the frozen `Channel`, it is the
    // read-the-backlog accessor the kernel adds. A version that asserted on a
    // private field instead would break on any other `Channel` implementation -
    // including `alternate-channel.ts`'s, which is exactly what the interface comparison consumes.
    // Red when: the reader casts without checking, or invents records for a
    // channel that has none.
    const h = makeLifecycle({ failing: ["c"] });
    h.getChannel("a");
    const degraded = h.getChannel("c");

    // A kernel: its own real ring.
    expect(ringOf(h.getChannel("a"))).toEqual([]);
    // The stand-in: a real kernel too, so it also answers.
    expect(ringOf(degraded)).toEqual([]);
    // A `Channel` that does not expose the accessor answers "no records" rather
    // than throwing - a support bundle must not fail on one such channel.
    const bare: Channel = {
      agentId: "bare",
      send: () => Promise.resolve({ ok: true, data: undefined, raw: undefined }),
      onEvent: () => () => undefined,
      onDiagnostic: () => () => undefined,
      capabilities: () => ({ state: "unknown" }),
      close: () => undefined,
    };
    expect(ringOf(bare)).toEqual([]);

    // `sendTrackedOn` forwards a caller-supplied id when one is given, so a case
    // can name the correlation it is about to assert on.
    return refusalOf(sendTrackedOn(degraded, "req-named"), "a named send").then((error) => {
      expect(error.code).toBe("NOT_CONNECTED");
    });
  });
});
