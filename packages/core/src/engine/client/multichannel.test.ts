/**
 * Four agents, four connections: events do not cross between agents, and closing
 * one channel does not spread.
 *
 * ## Why this suite is the load-bearing one
 *
 * The user overruled the first design (**one connection carrying two
 * subscriptions**) specifically because it could not express "evict C": with a
 * single socket, the only way to drop one conversation's subscription is to
 * close the socket everyone shares, and the measured consequence is that A's
 * turn is cancelled too. Isolation says that cannot happen, and the probe behind
 * it is a measurement, not a design claim: **C's connection was closed while A
 * was at 3 of 10 frames, and A received 10 of 10**.
 *
 * Before the pool existed, the isolation claim had nowhere to live: a shared
 * module-level subscriber set, a shared socket, a shared in-flight table and a
 * shared diagnostic ring all fail the same way and all look correct in a
 * single-agent test. So the four groups below attack the four places isolation
 * is *stored*, one per group, and each group would still be green if only the
 * other three were intact:
 *
 * | group | the storage under attack | one shared copy would look like |
 * |---|---|---|
 * | 1 | the frame listener / subscriber set | B receiving A's frames |
 * | 2 | the pool map and the socket | A stopping when C closes |
 * | 3 | the in-flight table and its timers | A's request settling on C's close |
 * | 4 | the diagnostic ring and correlation | C's three records appearing in A |
 *
 * ## The two claims this suite does *not* make, and why not
 *
 * - **"C's subscriber is called when C closes."** The frozen `Channel` surface
 *   has no close event: `close()` is idempotent and says nothing
 *   back. So closure is asserted through the three things a consumer can
 *   actually observe - a refused send, a shorter `channels()`, a closed
 *   transport - rather than through a callback the type does not have. That is
 *   a contract observation, stated here rather than papered over.
 * - **"The outbound dedupe table does not cross."** `dedupe.ts` constructs
 *   nothing inside the client stack today: it is a standalone class with its own
 *   suite, and no channel or send path holds an
 *   instance. There is therefore no per-channel dedupe instance to isolate, and
 *   a case that built two `OutboundDedupe`s to prove they are independent would
 *   be testing `dedupe.ts`, not the pool. What *is* per channel and *is*
 *   asserted here is the correlation table that the duplicate rule runs on: the
 *   same caller-supplied id is accepted by two different agents and settles
 *   independently (group 4). The missing wiring is a known gap.
 *
 * ## Anti-leak discipline
 *
 * Everything runs on the fleet's one fake clock, so a request that never answers
 * costs no wall-clock time; every case's `afterEach` runs `assertFleetClean`,
 * which closes the fleet *before* demanding the clocks are silent (a guard that
 * closed things itself would be vacuous). A "must settle immediately" assertion
 * races one macrotask and throws a self-describing error rather than hanging
 * until vitest's timeout - a failure mode that once cost 93 seconds of wall
 * clock.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eventFrame, expectSettles, responseFrame } from "./channel-test-support";
import type { EngineEventFrame } from "./types";
import {
  assertFleetClean,
  emitRun,
  endpointFor,
  openFleetOfFour,
  expectOpenAgents,
  FLEET_AGENT_IDS,
  makeFleet,
  openAgentIds,
  sendOn,
  UNMODELLED_TYPE,
} from "./multichannel-harness";
import type { FleetHarness } from "./multichannel-harness";
import { expectPending } from "./pool-test-support";

afterEach(assertFleetClean);

/**
 * The markers one agent's subscriber actually saw.
 *
 * @param fleet the fleet to read
 * @param agentId the agent whose stream to read
 * @returns the `marker` field of each delivered frame, in delivery order
 */
function markersOf(fleet: FleetHarness, agentId: string): readonly unknown[] {
  return fleet.agent(agentId).markers();
}

/* ------------------------------------------------------------------------- */
/* One connection per agent                                                  */
/* ------------------------------------------------------------------------- */

describe("one connection per agent", () => {
  it("builds one channel, one kernel and one socket per agent", () => {
    // Red when: the factory is called once and its channel shared, the pool keys
    // on a constant, or the harness hands two agents the same socket.
    const fleet = openFleetOfFour();

    expect(fleet.contexts()).toHaveLength(4);
    expect(fleet.socketsOpened()).toBe(4);

    const channels = fleet.agents.map((agent) => agent.channel);
    expect(new Set(channels).size).toBe(4);
    const kernels = fleet.agents.map((agent) => agent.engine);
    expect(new Set(kernels).size).toBe(4);
    const transports = fleet.agents.map((agent) => agent.transport);
    expect(new Set(transports).size).toBe(4);
  });

  it("reuses one agent's connection however often it is asked for", () => {
    // The same agent asked twice - and asked for a second conversation - is still
    // one connection (a conversation id is a request scope, not a key).
    // Red when: getChannel builds unconditionally, or keys on the conversation.
    const fleet = openFleetOfFour();
    const first = fleet.pool.getChannel("a");

    expect(fleet.pool.getChannel("a")).toBe(first);
    expect(fleet.pool.getChannel("a", "another-conversation")).toBe(first);
    expect(fleet.contexts()).toHaveLength(4);
    expect(fleet.socketsOpened()).toBe(4);
  });

  it("lists each agent exactly once in channels()", () => {
    // The shape: four agents, four entries, no duplicates. Red when: the pool
    // stores per conversation, or appends on every lookup.
    const fleet = openFleetOfFour();

    const ids = fleet.pool.channels().map((channel) => channel.agentId);
    expect([...ids].sort()).toEqual(["a", "b", "c", "d"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves a distinct endpoint for every agent and hands each its own", () => {
    // The endpoint seam is per agent even though this build has one
    // engine process. Red when: the resolver is called once and reused, or the
    // factory drops the endpoint it was handed.
    const fleet = openFleetOfFour();

    const urls = fleet.contexts().map((context) => context.endpoint?.url);
    const tokens = fleet.contexts().map((context) => context.endpoint?.token);
    expect(new Set(urls).size).toBe(4);
    expect(new Set(tokens).size).toBe(4);

    for (const agent of fleet.agents) {
      expect(agent.agentId).toBeDefined();
      const expected = endpointFor(agent.agentId);
      expect(urls).toContain(expected.url);
      expect(tokens).toContain(expected.token);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Group 1: events do not cross                                              */
/* ------------------------------------------------------------------------- */

describe("events do not cross between agents", () => {
  it("delivers each frame only to the subscriber of the connection it arrived on", () => {
    // The measured shape: A sees only A's frames.
    // Red when: the two channels' subscribers share one set, or delivery is a
    // broadcast.
    const fleet = openFleetOfFour();

    for (const agentId of ["a", "b", "c", "d"]) {
      emitRun(fleet, agentId, 3);
    }

    expect(markersOf(fleet, "a")).toEqual(["a-1", "a-2", "a-3"]);
    expect(markersOf(fleet, "b")).toEqual(["b-1", "b-2", "b-3"]);
    expect(markersOf(fleet, "c")).toEqual(["c-1", "c-2", "c-3"]);
    expect(markersOf(fleet, "d")).toEqual(["d-1", "d-2", "d-3"]);

    // Every frame landed exactly once, somewhere: twelve in, twelve delivered.
    const total = fleet.agents.reduce((sum, agent) => sum + agent.events().length, 0);
    expect(total).toBe(12);
  });

  it("keeps each agent's stream in its own arrival order under round-robin delivery", () => {
    // Interleaving is what a table keyed on "the last frame" fails: the order of
    // one agent's stream must survive three other agents writing between its
    // frames. Red when: a shared buffer is drained by whoever asks first.
    const fleet = openFleetOfFour();

    for (let round = 1; round <= 10; round += 1) {
      for (const agentId of ["a", "b", "c", "d"]) {
        fleet.emit(agentId, eventFrame("test.ping", { marker: `${agentId}-${String(round)}` }));
      }
    }

    for (const agentId of ["a", "b", "c", "d"]) {
      expect(markersOf(fleet, agentId)).toEqual(
        Array.from({ length: 10 }, (_, index) => `${agentId}-${String(index + 1)}`),
      );
    }
  });

  it("leaves the other three agents silent when only one connection speaks", () => {
    // The complement of the case above, and the one a broadcast defect survives:
    // "each got three of its own" can still be true if everyone also got
    // everyone else's and the assertions read a filtered view. Here nothing is
    // filtered: the other three subscribers must have seen zero frames.
    // Red when: delivery fans out to every channel, or one channel's ingest is
    // wired to another channel's subscriber set.
    const fleet = openFleetOfFour();

    emitRun(fleet, "b", 4);

    expect(markersOf(fleet, "b")).toHaveLength(4);
    expect(fleet.agent("a").events()).toEqual([]);
    expect(fleet.agent("c").events()).toEqual([]);
    expect(fleet.agent("d").events()).toEqual([]);
  });

  it("counts frames per agent, so no agent's totals include a neighbour's", () => {
    // Counts, because a mixed-up channel can still deliver the right *number* to
    // one agent while attributing another's frames to it. Red when: any counter
    // lives at module scope.
    const fleet = openFleetOfFour();

    emitRun(fleet, "a", 2);
    emitRun(fleet, "c", 5);

    expect(fleet.agent("a").events()).toHaveLength(2);
    expect(fleet.agent("b").events()).toHaveLength(0);
    expect(fleet.agent("c").events()).toHaveLength(5);
    expect(fleet.agent("d").events()).toHaveLength(0);
    expect(fleet.agent("a").types()).toEqual(["test.ping", "test.ping"]);
  });

  it("keeps subscriber sets per channel, so one throwing consumer costs only itself", () => {
    // Delivery isolation at the subscriber level, across agents: A's consumer
    // throws, and B must still receive its own frame *and* A's remaining
    // subscriber must still be called. Red when: the subscriber set is shared, or
    // one throwing consumer stops a channel's loop for everyone.
    const fleet = openFleetOfFour();
    const after: string[] = [];

    fleet.agent("a").channel.onEvent(() => {
      throw new Error("a consumer that throws");
    });
    fleet.agent("a").channel.onEvent(() => {
      after.push("a");
    });
    fleet.agent("b").channel.onEvent(() => {
      after.push("b");
    });

    emitRun(fleet, "a", 1);
    emitRun(fleet, "b", 1);

    expect(after).toEqual(["a", "b"]);
    expect(markersOf(fleet, "b")).toEqual(["b-1"]);
  });
});

/* ------------------------------------------------------------------------- */
/* Group 2: closing one channel does not spread                              */
/* ------------------------------------------------------------------------- */

describe("closing one channel does not spread", () => {
  it("lets A, B and D finish while C is closed at 3 of 10 frames", () => {
    // The measured fact this whole design rests on: A is
    // at 3/10 when C's connection closes and still receives 10/10. D is here so
    // the assertion cannot be satisfied by "the two agents that were not named".
    // Red when: closeChannel closes the whole pool, or a close triggers a
    // global cleanup that clears other subscriber sets.
    const fleet = openFleetOfFour();

    for (let index = 1; index <= 3; index += 1) {
      for (const agentId of ["a", "b", "c", "d"]) {
        fleet.emit(agentId, eventFrame("test.ping", { marker: `${agentId}-${String(index)}` }));
      }
    }

    fleet.closeChannel("c");

    for (let index = 4; index <= 10; index += 1) {
      for (const agentId of ["a", "b", "c", "d"]) {
        fleet.emit(agentId, eventFrame("test.ping", { marker: `${agentId}-${String(index)}` }));
      }
    }

    const full = Array.from({ length: 10 }, (_, index) => String(index + 1));
    expect(markersOf(fleet, "a")).toEqual(full.map((n) => `a-${n}`));
    expect(markersOf(fleet, "b")).toEqual(full.map((n) => `b-${n}`));
    expect(markersOf(fleet, "d")).toEqual(full.map((n) => `d-${n}`));

    // C kept what it had already received and gained nothing: its connection is
    // gone, so the frames emitted afterwards never reached it.
    expect(markersOf(fleet, "c")).toEqual(["c-1", "c-2", "c-3"]);
  });

  it("closes exactly one connection and leaves the other three open", () => {
    // The connection-level half, which a subscriber-set-only assertion cannot
    // see: a channel that stops delivering but leaves its socket open is a leak,
    // and one that closes a shared socket is the defect this suite exists for.
    // Red when: close reaches a neighbour's transport, or does not reach its own.
    const fleet = openFleetOfFour();
    expect(openAgentIds(fleet)).toEqual(["a", "b", "c", "d"]);

    fleet.closeChannel("c");

    expectOpenAgents(fleet, ["a", "b", "d"]);
    expect(fleet.agent("c").transport.isOpen).toBe(false);
    expect(fleet.agent("a").transport.isOpen).toBe(true);
    expect(fleet.agent("d").transport.isOpen).toBe(true);
  });

  it("keeps the surviving entries in channels(), and reopens C as a new connection", () => {
    // Two pool-level consequences that share one cause. Red when: closeAll is
    // used for a single close (survivors vanish), or the closed entry stays, so
    // getChannel hands back a dead channel.
    const fleet = openFleetOfFour();
    const aBefore = fleet.pool.getChannel("a");
    const cBefore = fleet.agent("c").channel;

    fleet.closeChannel("c");

    expect(fleet.pool.channels().map((channel) => channel.agentId)).toEqual(["a", "b", "d"]);
    expect(fleet.pool.getChannel("a")).toBe(aBefore);

    const reopened = fleet.pool.getChannel("c");
    expect(reopened).not.toBe(cBefore);
    expect(fleet.socketsOpened()).toBe(5);
  });

  it("reports C's closure through the frozen surface rather than through a callback", () => {
    // The frozen `Channel` has no close event (see the file header), so closure is
    // observable three ways and the case pins all three: a refused send, a shorter
    // channels(), a closed transport. Red when: a closed channel still accepts
    // sends, or getChannel/channels keep advertising it.
    const fleet = openFleetOfFour();
    fleet.closeChannel("c");
    const closed = fleet.agent("c");

    const refused = closed.channel.send({
      capability: "conversation.sync",
      body: {},
      runtime: { agent_id: "c", conversation_id: "conversation-c" },
    });
    expect(closed.channel.agentId).toBe("c");
    expect(closed.isOpen()).toBe(false);
    expect(fleet.pool.channels().some((channel) => channel.agentId === "c")).toBe(false);

    // The pool's close does not come back as a *peer* close: the transport flips
    // its own `isOpen` before asking the socket to shut, so the socket's close
    // event is ignored and no wiring callback runs. That matters here because a
    // close path that reported itself would make "we closed C" and "C dropped"
    // indistinguishable to anything listening (the reconnect decision). Red when:
    // `transport.close()` drops its early `open = false`.
    expect(closed.closes()).toEqual([]);

    return expectSettles(refused).then((result) => {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_CONNECTED");
        expect(result.error.detail).toContain("closed");
      }
    });
  });

  it("keeps A's subscriber attached across C's close", () => {
    // The other half of "the survivor stays live": A's own subscription must not
    // be a casualty of C's teardown. Red when: close clears a shared set, or the
    // pool's close path calls closeAll.
    const fleet = openFleetOfFour();
    emitRun(fleet, "a", 2);

    fleet.closeChannel("c");
    emitRun(fleet, "a", 2, 3);

    expect(markersOf(fleet, "a")).toEqual(["a-1", "a-2", "a-3", "a-4"]);
    expect(fleet.agent("a").closes()).toEqual([]);
  });

  it("treats a close for an agent that was never opened as a no-op, not a sweep", () => {
    // The pool is lenient about unknown agents because a caller (a window
    // closing, a sidebar action) cannot know the map's contents. The defect this
    // pins is the cheapest way to "handle" the miss: fall back to closing
    // everything. Red when: the undefined branch calls closeAll, or an unknown id
    // is treated as a wildcard.
    const fleet = openFleetOfFour();
    emitRun(fleet, "a", 1);

    fleet.closeChannel("never-opened");

    expectOpenAgents(fleet, ["a", "b", "c", "d"]);
    expect(fleet.pool.channels()).toHaveLength(4);
    expect(markersOf(fleet, "a")).toEqual(["a-1"]);
  });

  it("stays local when the same agent is closed twice", () => {
    // Idempotence is stated on the frozen surface, and the second close is where
    // a "delete then sweep" implementation fires its sweep. Red when: the second
    // close re-enters a global cleanup.
    const fleet = openFleetOfFour();

    fleet.closeChannel("c");
    fleet.closeChannel("c");

    expectOpenAgents(fleet, ["a", "b", "d"]);
    emitRun(fleet, "b", 1);
    expect(markersOf(fleet, "b")).toEqual(["b-1"]);
  });

  it("survives a neighbour whose socket dies underneath it", () => {
    // The peer-close path, which does run the wiring's
    // `onClose -> channel.close()`. A failure that reaches the pool through that
    // path must still be C's alone. Red when: the close handler reaches a shared
    // subject, or the pool reacts to any close with a sweep.
    const fleet = openFleetOfFour();

    fleet.killSocket("c");

    expect(fleet.agent("c").closes()).toEqual(["the peer went away"]);
    expect(fleet.agent("a").closes()).toEqual([]);
    expectOpenAgents(fleet, ["a", "b", "d"]);

    emitRun(fleet, "a", 1);
    expect(markersOf(fleet, "a")).toEqual(["a-1"]);
  });

  it("drops a peer-closed agent from channels() and rebuilds it on demand", () => {
    // A channel that closed **itself** - the socket died, or a consumer called
    // `close()` directly - leaves a zombie behind in any pool that only cleans up
    // on its own close path. The frozen contract says a consumer may call
    // `close()`, so the pool must notice without being told. Red when: `channels()`
    // lists closed entries, or `getChannel` hands the dead instance back (every
    // later send would then fail forever).
    const fleet = openFleetOfFour();
    const cBefore = fleet.agent("c").channel;

    fleet.killSocket("c");

    expect(fleet.pool.channels().map((channel) => channel.agentId)).toEqual(["a", "b", "d"]);

    const rebuilt = fleet.pool.getChannel("c");
    expect(rebuilt).not.toBe(cBefore);
    expect(fleet.socketsOpened()).toBe(5);
    expect(fleet.pool.channels()).toHaveLength(4);
  });

  it("rebuilds only the agent a consumer closed directly", () => {
    // The same zombie rule through the other door: the consumer holds the handle
    // and closes it without going through the pool. Red when: the pool cannot
    // tell a closed handle from an open one, or it rebuilds more than the one.
    const fleet = openFleetOfFour();
    const cBefore = fleet.agent("c").channel;
    const aBefore = fleet.agent("a").channel;

    cBefore.close();

    expect(fleet.pool.getChannel("c")).not.toBe(cBefore);
    expect(fleet.pool.getChannel("a")).toBe(aBefore);
    expect(fleet.socketsOpened()).toBe(5);
  });

  it("rebuilds the whole fleet after closeAll, so closing a window is not a dispose", () => {
    // `closeAll` is "the window closed", not "this client is over".
    // A pool that latched a disposed flag here would turn a user closing a window
    // into a permanently dead client. Red when: closeAll sets a terminal flag, or
    // getChannel refuses after it.
    const fleet = openFleetOfFour();

    fleet.pool.closeAll();
    expect(fleet.pool.channels()).toEqual([]);
    expect(fleet.pool.getChannel("a").agentId).toBe("a");
    expect(fleet.pool.channels()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Group 3: in-flight requests are isolated                                  */
/* ------------------------------------------------------------------------- */

describe("in-flight requests are isolated", () => {
  it("settles C's request on close and leaves A's still waiting", () => {
    // Both halves at once, and the one a "clear the table" defect cannot fake: C
    // must be told (its answer can never come) while A must be untouched - not
    // settled early, not dropped. Red when: close empties a shared table, or
    // settles every promise it can reach.
    const fleet = openFleetOfFour();

    const aPending = sendOn(fleet.agent("a"), "req-a");
    const cPending = sendOn(fleet.agent("c"), "req-c");

    expect(fleet.agent("a").sent()).toHaveLength(1);
    expect(fleet.agent("c").sent()).toHaveLength(1);
    expect(fleet.agent("b").sent()).toHaveLength(0);

    fleet.closeChannel("c");

    return expectSettles(cPending).then(async (settled) => {
      expect(settled.ok).toBe(false);
      if (!settled.ok) {
        expect(settled.error.code).toBe("NOT_CONNECTED");
      }

      await expectPending(aPending, "A's request after C was closed");
      expect(fleet.agent("a").engine.inFlightCount()).toBe(1);

      // And A can still be answered normally afterwards.
      fleet.emit("a", responseFrame("req-a", { data: { answer: 42 } }));
      const answered = await expectSettles(aPending);
      expect(answered.ok).toBe(true);
      if (answered.ok) {
        expect(answered.data).toEqual({ answer: 42 });
      }
    });
  });

  it("cancels only C's timer, never a neighbour's", () => {
    // The clock is the second witness of "whose table was touched": a close that
    // stopped a sibling's timer would leave a promise that can never settle. Red
    // when: close iterates every channel's entries, or a shared clock handle is
    // cleared.
    const fleet = openFleetOfFour();

    const aPending = sendOn(fleet.agent("a"), "req-a");
    const cPending = sendOn(fleet.agent("c"), "req-c");
    expect(fleet.clock.pending()).toBe(2);

    fleet.closeChannel("c");
    // C's entry is gone and its timer cancelled; A's timer is still armed.
    expect(fleet.clock.pending()).toBe(1);

    fleet.emit("a", responseFrame("req-a"));
    expect(fleet.clock.pending()).toBe(0);

    return Promise.all([expectSettles(aPending), expectSettles(cPending)]).then(
      ([answered, refused]) => {
        expect(answered.ok).toBe(true);
        expect(refused.ok).toBe(false);
      },
    );
  });

  it("does not settle A when C's socket dies underneath it", () => {
    // The peer-close variant: the wiring closes C's channel, and A's request must
    // still be waiting. Red when: the close handler settles a shared table or
    // invokes a pool-wide cleanup.
    const fleet = openFleetOfFour();

    const aPending = sendOn(fleet.agent("a"), "req-a");
    const cPending = sendOn(fleet.agent("c"), "req-c");

    fleet.killSocket("c");

    return expectSettles(cPending).then(async (refused) => {
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe("NOT_CONNECTED");
      }
      await expectPending(aPending, "A's request after C's socket died");
      fleet.emit("a", responseFrame("req-a"));
      const answered = await expectSettles(aPending);
      expect(answered.ok).toBe(true);
    });
  });

  it("counts in-flight entries per channel, including for the same caller id", () => {
    // Two channels, one caller-supplied id, two independent entries: the
    // correlation table is per channel, so the duplicate-id refusal that protects
    // one agent's table must not fire because a *different* agent used the name.
    // Red when: the in-flight table is a module-level singleton.
    const fleet = openFleetOfFour();

    const aPending = sendOn(fleet.agent("a"), "shared-id");
    const cPending = sendOn(fleet.agent("c"), "shared-id");

    expect(fleet.agent("a").engine.inFlightCount()).toBe(1);
    expect(fleet.agent("c").engine.inFlightCount()).toBe(1);
    expect(fleet.agent("b").engine.inFlightCount()).toBe(0);

    // Answering C's copy settles C only; A's copy is still waiting for its own.
    fleet.emit("c", responseFrame("shared-id", { data: { from: "c" } }));

    return expectSettles(cPending).then(async (answered) => {
      expect(answered.ok).toBe(true);
      if (answered.ok) {
        expect(answered.data).toEqual({ from: "c" });
      }
      expect(fleet.agent("c").engine.inFlightCount()).toBe(0);
      await expectPending(aPending, "A's copy of the shared id");
      expect(fleet.agent("a").engine.inFlightCount()).toBe(1);

      fleet.emit("a", responseFrame("shared-id", { data: { from: "a" } }));
      const aAnswered = await expectSettles(aPending);
      expect(aAnswered.ok).toBe(true);
      if (aAnswered.ok) {
        expect(aAnswered.data).toEqual({ from: "a" });
      }
    });
  });
});

/* ------------------------------------------------------------------------- */
/* Group 4: diagnostics and correlation storage are per channel              */
/* ------------------------------------------------------------------------- */

describe("diagnostics and correlation storage are per channel", () => {
  it("records C's three diagnostics in C's ring and none in A's", () => {
    // The exact assertion isolation needs. Red when: the ring is a
    // module-level singleton, or the channel reports every record it sees to a
    // shared subscriber list.
    const fleet = openFleetOfFour();

    for (let index = 0; index < 3; index += 1) {
      fleet.emit("c", "{ this is not json");
    }

    expect(fleet.agent("c").records()).toHaveLength(3);
    expect(
      fleet
        .agent("c")
        .records()
        .map((record) => record.kind),
    ).toEqual(["malformed", "malformed", "malformed"]);
    expect(fleet.agent("a").records()).toEqual([]);
    expect(fleet.agent("b").records()).toEqual([]);
    expect(fleet.agent("d").records()).toEqual([]);
    expect(fleet.agent("a").engine.diagnostics()).toEqual([]);
    expect(fleet.agent("c").engine.diagnostics()).toHaveLength(3);
  });

  it("keeps A's later diagnostics out of C's ring", () => {
    // The other direction, so the ring cannot be "the first channel that happened
    // to be built". Red when: the diagnostic log is created once per module.
    const fleet = openFleetOfFour();

    fleet.emit("c", "not json");
    fleet.emit("a", "also not json");
    fleet.emit("a", "still not json");

    expect(fleet.agent("a").engine.diagnostics()).toHaveLength(2);
    expect(fleet.agent("c").engine.diagnostics()).toHaveLength(1);
  });

  it("gives a rebuilt channel an empty ring rather than C's history", () => {
    // Reopening an agent must not inherit the closed instance's records: that is
    // how a singleton ring leaks across a whole session. Red when: the ring is
    // keyed on the agent id by a shared registry, or created outside the factory.
    const fleet = openFleetOfFour();
    fleet.emit("c", "not json");

    fleet.closeChannel("c");
    const reopened = fleet.pool.getChannel("c");
    const reopenedView = fleet.agent("c");

    expect(reopened).not.toBe(null);
    expect(reopenedView.engine.diagnostics()).toEqual([]);
    expect(reopenedView.records()).toEqual([]);
  });

  it("counts unknown event types per channel, not in one shared tally", () => {
    // The fourth per-channel store: unknown types are counted per type rather
    // than stored per frame. A shared tally would
    // make "which agent is receiving something this build cannot render" single
    // answerable only for the whole process. Red when: the counts (or the
    // first-arrival diagnostic that summarises them) live at module scope.
    const fleet = openFleetOfFour();

    fleet.emit("c", eventFrame(UNMODELLED_TYPE, { marker: "c-1" }));
    fleet.emit("c", eventFrame(UNMODELLED_TYPE, { marker: "c-2" }));
    fleet.emit("a", eventFrame(UNMODELLED_TYPE, { marker: "a-1" }));

    expect(fleet.agent("c").engine.unknownEventCounts().get(UNMODELLED_TYPE)).toBe(2);
    expect(fleet.agent("a").engine.unknownEventCounts().get(UNMODELLED_TYPE)).toBe(1);
    expect(fleet.agent("b").engine.unknownEventCounts().size).toBe(0);
    expect(fleet.agent("d").engine.unknownEventCounts().size).toBe(0);

    // The summary record is emitted once per type *per channel*, so C's three
    // records are C's: two malformed-free unknown frames plus its own first-arrival
    // notice, and nothing in B.
    expect(
      fleet
        .agent("c")
        .records()
        .map((record) => record.kind),
    ).toEqual(["unknown-event"]);
    expect(
      fleet
        .agent("a")
        .records()
        .map((record) => record.kind),
    ).toEqual(["unknown-event"]);
    expect(fleet.agent("b").records()).toEqual([]);
  });

  it("does not report a modelled type as unknown on any channel", () => {
    // The complement that keeps the case above from being satisfied by "report
    // everything": a frame of a type the build models must never produce an
    // unknown-event record, and the modelled set is per fleet, not per channel
    // accident. Red when: the type table is ignored, or it is shared in a way
    // that makes one channel's table decide another's.
    const fleet = openFleetOfFour();

    emitRun(fleet, "a", 2);
    emitRun(fleet, "d", 2);

    for (const agentId of ["a", "b", "c", "d"]) {
      expect(fleet.agent(agentId).engine.unknownEventCounts().size).toBe(0);
      expect(
        fleet
          .agent(agentId)
          .records()
          .some((record) => record.kind === "unknown-event"),
      ).toBe(false);
    }
  });

  it("hands each channel a fresh, independent capability snapshot", () => {
    // The third per-agent store, and the one a shared kernel would collapse
    // silently: every channel starts `unknown` and stays there independently.
    // Red when: the snapshot is held at module scope.
    const fleet = openFleetOfFour();

    for (const agent of fleet.agents) {
      expect(agent.channel.capabilities()).toEqual({ state: "unknown" });
    }
  });

  it("probes one channel's capabilities without moving a neighbour's snapshot", () => {
    // The assertion above is only half the claim: "everyone is unknown" is also
    // true of a *shared* snapshot nobody has written yet - the vacuity trap this
    // suite's own self-check warns about. So one agent's connection is fed a
    // capability reading and the others must stay `unknown`, which a module-level
    // snapshot cannot do. Red when: the probed state is stored at module scope,
    // or one channel's probe is applied to its neighbours.
    const fleet = openFleetOfFour();

    fleet.emit(
      "c",
      eventFrame("test.status", {
        capabilityProbe: { booleans: { canFork: true }, slashCommands: ["sample.command"] },
      }),
    );

    expect(fleet.agent("c").engine.capabilities()).toEqual({
      state: "probed",
      booleans: { canFork: true },
      slashCommands: ["sample.command"],
      probedAt: fleet.clock.clock.now(),
    });

    for (const agentId of ["a", "b", "d"]) {
      expect(fleet.agent(agentId).engine.capabilities()).toEqual({ state: "unknown" });
    }
  });

  it("keeps a neighbour's later probe out of a channel that never probed", () => {
    // The other direction, so the snapshot cannot be "whichever channel probed
    // first". Red when: the probed state is a single shared cell.
    const fleet = openFleetOfFour();

    fleet.emit(
      "a",
      eventFrame("test.status", { capabilityProbe: { slashCommands: ["sample.command"] } }),
    );
    fleet.emit("d", eventFrame("test.status", { capabilityProbe: { slashCommands: [] } }));

    expect(fleet.agent("a").engine.capabilities().state).toBe("probed");
    // D probed and found nothing: the documented third state, not `unknown`.
    expect(fleet.agent("d").engine.capabilities().state).toBe("confirmed-empty");
    expect(fleet.agent("b").engine.capabilities().state).toBe("unknown");
    expect(fleet.agent("c").engine.capabilities().state).toBe("unknown");
  });

  it("keeps each channel's readiness separate, so one agent's startup does not gate another", () => {
    // Readiness is per channel, and the wording it picks is what the reconnect
    // layer reads to decide whether a replay is worth attempting. Two agents in
    // different startup states must answer differently, and dropping A must not
    // make D look dropped. Red when: readiness is a shared flag, or one channel's
    // close moves a neighbour's.
    const fleet = openFleetOfFour({ unready: ["a"] });

    const aRefused = sendOn(fleet.agent("a"), "req-a");

    return expectSettles(aRefused).then(async (refused) => {
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        // A was never ready: the startup wording, not the dropped one.
        expect(refused.error.code).toBe("NOT_CONNECTED");
        expect(refused.error.detail).toContain("has not become ready");
      }
      // Nothing was written: a channel that is not ready refuses before the wire.
      expect(fleet.agent("a").sent()).toHaveLength(0);

      // D was never touched and is still usable.
      const dPending = sendOn(fleet.agent("d"), "req-d");
      expect(fleet.agent("d").sent()).toHaveLength(1);
      fleet.emit("d", responseFrame("req-d"));
      expect((await expectSettles(dPending)).ok).toBe(true);

      // A, once ready, no longer refuses on readiness grounds.
      fleet.agent("a").setReady(true);
      const aPending = sendOn(fleet.agent("a"), "req-a-2");
      expect(fleet.agent("a").sent()).toHaveLength(1);
      fleet.emit("a", responseFrame("req-a-2"));
      expect((await expectSettles(aPending)).ok).toBe(true);

      // And a *dropped* channel says dropped, which is the other wording.
      fleet.killSocket("a");
      const dropped = sendOn(fleet.agent("a"), "req-a-3");
      const droppedResult = await expectSettles(dropped);
      expect(droppedResult.ok).toBe(false);
      if (!droppedResult.ok) {
        expect(droppedResult.error.detail).toContain("ready and dropped");
      }
      // D still says the same thing it said before: nothing moved.
      expect(fleet.agent("d").isOpen()).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------------- */
/* Writes stay on their own agent's connection                               */
/* ------------------------------------------------------------------------- */

describe("writes stay on their own agent's connection", () => {
  it("keeps the frozen agentId truthful on every channel, not just on one", () => {
    // `agentId` is a frozen member of `Channel`, and it is the only thing a
    // consumer uses to attribute a stream it is holding. A fleet where every
    // kernel reports the same id cannot be told apart after the fact - the
    // consumer's own label and the channel's would disagree, and nothing else in
    // this suite would notice, because every other assertion reaches the channel
    // through the pool's map rather than through the id it reports.
    // Red when: the factory constructs every kernel under one id, or the handle
    // substitutes one.
    const fleet = openFleetOfFour();

    for (const agentId of ["a", "b", "c", "d"]) {
      const view = fleet.agent(agentId);
      expect(view.channel.agentId).toBe(agentId);
      expect(view.engine.agentId).toBe(agentId);
    }
  });

  it("stamps the sending agent's own scope into the frame it writes", () => {
    // The outbound mirror of the case above: the id the channel reports must be
    // the id that reaches the wire, or a command sent from B's channel could be
    // executed against A's runtime. Red when: the runtime scope is taken from a
    // shared source, or the kernel reports an id it did not build the frame with.
    const fleet = openFleetOfFour();

    for (const agentId of ["a", "b", "c", "d"]) {
      sendOn(fleet.agent(agentId), `req-${agentId}`);
      const frames = fleet.agent(agentId).sentFrames();
      expect(frames).toHaveLength(1);
      expect(frames[0]?.["runtime"]).toEqual({
        agent_id: agentId,
        conversation_id: `conversation-${agentId}`,
      });
      expect(frames[0]?.["request_id"]).toBe(`req-${agentId}`);
    }
  });

  it("puts one agent's command bytes on that agent's socket only", () => {
    // The outbound half of isolation, which the inbound assertions cannot see: a
    // command written through a shared writer reaches the wrong engine. Red when:
    // the transport is resolved globally instead of per channel.
    const fleet = openFleetOfFour();

    sendOn(fleet.agent("a"), "req-a");

    expect(fleet.agent("a").sent()).toHaveLength(1);
    for (const agentId of ["b", "c", "d"]) {
      expect(fleet.agent(agentId).sent()).toHaveLength(0);
    }

    const [frame] = fleet.agent("a").sentFrames();
    expect(frame).toBeDefined();
    expect(frame?.["request_id"]).toBe("req-a");
    expect(frame?.["runtime"]).toEqual({
      agent_id: "a",
      conversation_id: "conversation-a",
    });
  });

  it("keeps each agent's request ids in its own table when they collide", () => {
    // Same caller id on two agents - accepted twice, settled separately. Red
    // when: the dedupe/duplicate rule is evaluated against a shared table, so
    // agent B's legitimate send is refused as a duplicate of agent A's.
    const fleet = openFleetOfFour();

    const aPending = sendOn(fleet.agent("a"), "req-same");
    const dPending = sendOn(fleet.agent("d"), "req-same");

    expect(fleet.agent("a").sent()).toHaveLength(1);
    expect(fleet.agent("d").sent()).toHaveLength(1);
    expect(fleet.agent("a").engine.inFlightCount()).toBe(1);
    expect(fleet.agent("d").engine.inFlightCount()).toBe(1);

    fleet.emit("d", responseFrame("req-same", { data: { from: "d" } }));

    return expectSettles(dPending).then(async (answered) => {
      expect(answered.ok).toBe(true);
      await expectPending(aPending, "A's request under the same id");
      expect(fleet.agent("a").engine.inFlightCount()).toBe(1);
      fleet.emit("a", responseFrame("req-same"));
      await expectSettles(aPending);
    });
  });

  it("refuses a duplicate id inside one agent without touching another's table", () => {
    // The complement: the duplicate rule *does* fire within one channel. Red when
    // the rule is removed (the second send is wrongly accepted) or globalised (A's
    // refusal empties C's table).
    const fleet = openFleetOfFour();

    const aFirst = sendOn(fleet.agent("a"), "req-dup");
    const aSecond = sendOn(fleet.agent("a"), "req-dup");
    const cPending = sendOn(fleet.agent("c"), "req-c");

    return expectSettles(aSecond).then(async (refused) => {
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.code).toBe("REJECTED");
      }
      expect(fleet.agent("a").engine.inFlightCount()).toBe(1);
      expect(fleet.agent("c").engine.inFlightCount()).toBe(1);

      fleet.emit("a", responseFrame("req-dup"));
      fleet.emit("c", responseFrame("req-c"));
      await Promise.all([expectSettles(aFirst), expectSettles(cPending)]);
    });
  });
});

/* ------------------------------------------------------------------------- */
/* Guards on the harness itself                                             */
/* ------------------------------------------------------------------------- */

describe("the harness can tell the four agents apart", () => {
  let fleet: FleetHarness;

  beforeEach(() => {
    fleet = openFleetOfFour();
  });

  it("reports an unknown agent loudly instead of returning an empty view", () => {
    // A harness that silently answered `undefined` for a typo would make every
    // isolation case above pass while checking nothing. Red when: agent() returns
    // a stand-in.
    expect(() => fleet.agent("no-such-agent")).toThrow(/no agent/);
  });

  it("keeps its own event list per view, not one shared array", () => {
    // The scaffolding's own anti-vacuity check for group 1: if every view read the
    // same array, "A saw only A" and "A saw everything" would be the same
    // observation. Red when: the harness builds one list for the fleet.
    emitRun(fleet, "a", 1);
    const aEvents: readonly EngineEventFrame[] = fleet.agent("a").events();

    expect(aEvents).toHaveLength(1);
    expect(fleet.agent("b").events()).not.toBe(aEvents);
    expect(fleet.agent("b").events()).toHaveLength(0);
  });

  it("names the open set, so expectOpenAgents is not a tautology", () => {
    // The helper group 2 leans on must be able to disagree with itself. Red when:
    // openAgents() reports every agent the pool ever built instead of open ones.
    expect(openAgentIds(fleet)).toEqual(["a", "b", "c", "d"]);
    expect(() => expectOpenAgents(fleet, ["a", "b"])).toThrow(/open agents were/);
    fleet.closeChannel("d");
    expect(openAgentIds(fleet)).toEqual(["a", "b", "c"]);
  });
});
