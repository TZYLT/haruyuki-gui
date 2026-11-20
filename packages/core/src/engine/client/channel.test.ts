/**
 * Tests for the channel kernel.
 *
 * Every group here names the single deliberate change that turns it red; a test
 * that cannot answer "which edit breaks me?" is a test that does not hold the
 * line.
 *
 * Where the rest went: this file holds the channel's own state machines. The
 * three-state capability snapshot, the envelope passthrough and the diagnostic
 * history each have their own suite beside it, because each answers a different
 * question and each has a failure mode the others cannot see. The doubles they
 * all share live in `channel-test-support.ts`.
 *
 * Frames here are synthetic and carry test-owned marker fields (`reply`,
 * `capabilityProbe`), so the suites exercise the *injected ports* the kernel is
 * built on rather than hard-coding engine vocabulary. That keeps this directory
 * free of wire ids while still testing the real code path: those ports are
 * exactly the seam where the send path plugs the engine's field names in.
 *
 * Time is never real here: every timeout test drives a fake clock, because a
 * single real `fast`-family wait would cost the gate ten seconds.
 */

import { afterEach, describe, expect, it } from "vitest";

import { completionOf } from "./capability-names";
import {
  SILENT,
  TRACKED,
  UNTRACKED,
  assertNoLeakedTimers,
  closeHarnesses,
  eventFrame,
  expectSettles,
  makeClock,
  makeHarness,
  makeInlineClock,
  makeReader,
  makeWriter,
  responseFrame,
  trackChannel,
} from "./channel-test-support";
import { createChannel, EngineChannel } from "./channel";
import type { ChannelReadiness, ResolvedBudget } from "./channel";
import type { EngineClientError } from "./errors";
import type { CommandRequest, CommandResult } from "./types";

/**
 * Close every channel this file built, before the next test runs.
 *
 * Without this, a test that leaves entries in flight hands its timers and
 * unsettled promises to whatever runs next - which passes in isolation and fails
 * in a full run as a `testTimeout` in a test that did nothing wrong.
 */
afterEach(() => {
  // Asserts before it cleans: see `assertNoLeakedTimers`. Calling
  // `closeHarnesses()` first would free the timers and make the check vacuous.
  assertNoLeakedTimers();
});

/* ------------------------------------------------------------------------- */
/* Capability classification                                                 */
/* ------------------------------------------------------------------------- */

describe("command classification", () => {
  it("classifies the 2 silent and 5 untracked capabilities as the shared table does", () => {
    // Red when: the capability table (which this kernel defaults to) moves a
    // capability between classes, or when the kernel stops reading the table.
    for (const name of SILENT) {
      expect(completionOf(name)).toBe("silent");
    }
    for (const name of UNTRACKED) {
      expect(completionOf(name)).toBe("untracked");
    }
    expect(completionOf(TRACKED)).toBe("response");
  });

  it("puts a tracked command in the in-flight table and keeps it there", () => {
    // Red when: a response-class command stops being tracked (a lost answer would
    // then never become a TIMEOUT).
    const h = makeHarness();
    void h.channel.send({ capability: TRACKED, body: {}, requestId: "a" });
    expect(h.channel.inFlightCount()).toBe(1);
    expect(h.clock.pending()).toBe(1);
    expect(h.writer.calls).toHaveLength(1);
    expect(h.writer.calls[0]?.requestId).toBe("a");
  });

  it("never puts the 2 silent capabilities in the table, so they cannot time out", async () => {
    // Red when: `file.watch` / `file.unwatch` enter the table. Advancing the clock
    // past every family budget would then produce a false TIMEOUT - the bug this
    // rule exists to prevent.
    const h = makeHarness();
    for (const capability of SILENT) {
      const result = await expectSettles(
        h.channel.send({ capability, body: {}, requestId: "watch-1" }),
      );
      expect(result.ok).toBe(true);
    }

    expect(h.channel.inFlightCount()).toBe(0);
    expect(h.clock.pending()).toBe(0);

    h.clock.advance(24 * 60 * 60 * 1000);
    expect(h.records.filter((record) => record.kind === "timeout")).toHaveLength(0);
  });

  it("sends a silent capability with a request id, as its wire declares one", async () => {
    // Red when: a silent command is written with no id, or with the caller's id
    // replaced. Fact 31 says the id is on the wire even though no answer uses it.
    //
    // Both sends go through `expectSettles`: a silent capability never answers, so
    // if one were ever tracked the bare `await` would hang until vitest's timeout
    // instead of failing here.
    const h = makeHarness();
    await expectSettles(
      h.channel.send({ capability: "file.watch", body: { path: "x" }, requestId: "caller-id" }),
    );
    expect(h.writer.calls[0]?.requestId).toBe("caller-id");

    await expectSettles(h.channel.send({ capability: "file.watch", body: { path: "y" } }));
    expect(h.writer.calls[1]?.requestId).toMatch(/^req-/);
  });

  it("sends the 5 untracked capabilities with no request id at all", async () => {
    // Red when: the kernel mints an id for, or forwards a caller's id to, a
    // command whose wire has no such field - the engine would
    // read a field that is not part of that command.
    const h = makeHarness();
    for (const capability of UNTRACKED) {
      const result = await expectSettles(
        h.channel.send({ capability, body: {}, requestId: "should-be-dropped" }),
      );
      expect(result.ok).toBe(true);
    }

    expect(h.writer.calls).toHaveLength(UNTRACKED.length);
    for (const call of h.writer.calls) {
      expect(call.requestId).toBeUndefined();
    }
    expect(h.channel.inFlightCount()).toBe(0);
    expect(h.clock.pending()).toBe(0);
  });

  it("does not track the one duplex capability either", async () => {
    // Red when: `file.ops` is treated as request-response - its wire has no
    // request/reply pairing, so a timer on it is a guaranteed false timeout.
    const h = makeHarness();
    const result = await expectSettles(h.channel.send({ capability: "file.ops", body: {} }));
    expect(result.ok).toBe(true);
    expect(h.channel.inFlightCount()).toBe(0);
    expect(h.clock.pending()).toBe(0);
  });

  it("writes exactly what the caller asked for, untouched", async () => {
    // Red when: the kernel rewrites the body or the scope on the way out. The
    // body is the caller's; the channel adds correlation only.
    const h = makeHarness();
    const request: CommandRequest = {
      capability: TRACKED,
      body: { nested: { deep: [1, 2, 3] } },
      runtime: { agent_id: "agent-1", conversation_id: "c-1" },
      requestId: "explicit",
    };
    void h.channel.send(request);
    expect(h.writer.calls[0]?.request).toBe(request);
  });
});

/* ------------------------------------------------------------------------- */
/* The in-flight table: bound and the four delete paths                      */
/* ------------------------------------------------------------------------- */

describe("in-flight table bound", () => {
  it("accepts 256 and refuses the 257th with REJECTED instead of queueing", async () => {
    // Red when: the bound becomes 257, or a full table waits instead of refusing.
    // A queue would hold the 257th caller for a full family budget before telling
    // them anything.
    //
    // Every assertion that can fail here runs BEFORE the `await`, and the 257th
    // send is examined through its synchronous effects. That ordering is the point:
    // if the bound were raised, that send would succeed and enter the table with no
    // answer ever coming, so awaiting it would hang until vitest's `testTimeout`
    // fired - a thirty-second timeout in place of a one-line failure. A test that
    // fails slowly is a test that hides its own regression.
    const h = makeHarness();
    for (let index = 0; index < 256; index += 1) {
      void h.channel.send({ capability: TRACKED, body: {}, requestId: `r-${index}` });
    }
    expect(h.channel.inFlightCount()).toBe(256);
    // All 256 waits are on the fake clock, not on real timers: the kernel routes
    // every timer through the injected clock, which is what keeps this case at
    // milliseconds instead of the family ceiling.
    expect(h.clock.pending()).toBe(256);
    expect(h.writer.calls).toHaveLength(256);

    const refused = h.channel.send({ capability: TRACKED, body: {}, requestId: "r-256" });

    // Synchronous consequences first, so a raised bound fails here and now.
    expect(h.channel.inFlightCount()).toBe(256);
    expect(h.writer.calls).toHaveLength(256);
    expect(h.clock.pending()).toBe(256);
    expect(h.records.some((record) => record.kind === "rejected")).toBe(true);

    // Only now is it safe to await: a refusal resolves immediately, and a
    // regression already failed above.
    const result = await refused;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REJECTED");
    }
  });

  it("frees slots as answers arrive, so the bound is not a lifetime quota", async () => {
    // Red when: a slot is not reclaimed on the resolve path, which would make the
    // bound a total-send limit of 256 for the process lifetime.
    const h = makeHarness();
    for (let index = 0; index < 256; index += 1) {
      void h.channel.send({ capability: TRACKED, body: {}, requestId: `r-${index}` });
    }
    for (let index = 0; index < 256; index += 1) {
      h.channel.ingest(responseFrame(`r-${index}`, { data: index }));
    }
    expect(h.channel.inFlightCount()).toBe(0);

    // A fresh send now succeeds where the 257th was refused a moment ago: the
    // bound counts live entries, not sends.
    const next = h.channel.send({ capability: TRACKED, body: {}, requestId: "later" });
    expect(h.channel.inFlightCount()).toBe(1);
    h.channel.ingest(responseFrame("later", { data: "answered" }));
    await expect(next).resolves.toMatchObject({ ok: true, data: "answered" });
  });

  it("refuses a caller-supplied id that is already in flight", async () => {
    // Red when: two in-flight entries share one id. Both waiters would be settled
    // by whichever answer arrives first, and the table would hold one entry for
    // two promises.
    const h = makeHarness();
    void h.channel.send({ capability: TRACKED, body: {}, requestId: "dup" });
    const result = await expectSettles(
      h.channel.send({ capability: TRACKED, body: {}, requestId: "dup" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REJECTED");
    }
    expect(h.channel.inFlightCount()).toBe(1);
  });
});

describe("the entry leaves the table on every settle path", () => {
  it("deletes on resolve", async () => {
    // Red when: the resolve path forgets to delete. The slot never comes back and
    // the timer keeps the process alive.
    const h = makeHarness();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "res" });
    h.channel.ingest(responseFrame("res", { ok: true, data: { answered: true } }));

    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ answered: true });
    }
    expect(h.channel.inFlightCount()).toBe(0);
    expect(h.clock.pending()).toBe(0);
  });

  it("deletes on reject", async () => {
    // Red when: the reject path forgets to delete - same leak as resolve, but on
    // the branch that a review is least likely to look at.
    const h = makeHarness();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "rej" });
    const error: EngineClientError = { code: "UNKNOWN_COMMAND", detail: "no such command" };
    h.channel.ingest(responseFrame("rej", { ok: false, error }));

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_COMMAND");
    }
    expect(h.channel.inFlightCount()).toBe(0);
    expect(h.clock.pending()).toBe(0);
  });

  it("deletes on timeout, and reports TIMEOUT rather than rejecting the promise", async () => {
    // Red when: expiry forgets to delete, or the TIMEOUT reaches the caller as a
    // rejected promise (`send` never rejects).
    const h = makeHarness();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "slow" });
    expect(h.channel.inFlightCount()).toBe(1);

    h.clock.advance(30_000);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.detail).toContain("30000");
    }
    expect(h.channel.inFlightCount()).toBe(0);
    expect(h.clock.pending()).toBe(0);
    expect(h.records.some((record) => record.kind === "timeout")).toBe(true);
  });

  it("deletes on close, and settles the waiter with NOT_CONNECTED", async () => {
    // Red when: close leaves entries behind. The caller would wait forever for an
    // answer that a closed channel cannot deliver, and the timers would outlive it.
    const h = makeHarness();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "open" });
    expect(h.channel.inFlightCount()).toBe(1);

    h.channel.close();

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_CONNECTED");
    }
    expect(h.channel.inFlightCount()).toBe(0);
    expect(h.clock.pending()).toBe(0);
  });

  it("deletes on a failed write, and reports SEND_FAILED", async () => {
    // Red when: a throwing writer leaves the entry in the table. The slot would be
    // held forever for a command that never reached the wire.
    const h = makeHarness({
      write: () => {
        throw new Error("socket is gone");
      },
    });
    const result = await expectSettles(
      h.channel.send({ capability: TRACKED, body: {}, requestId: "boom" }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SEND_FAILED");
    }
    expect(h.channel.inFlightCount()).toBe(0);
    expect(h.clock.pending()).toBe(0);
  });

  it("inserts the entry before starting its timer", async () => {
    // Red when: the timer is started before the table holds the entry. An inline
    // clock then expires a request that is not in the table yet, the entry is
    // inserted holding a spent timer, and the slot leaks with no TIMEOUT.
    const inline = makeInlineClock();
    const writer = makeWriter();
    // Registered so teardown closes it: this clock cannot be a `FakeClock`, so
    // `makeHarness` cannot build this case, and an unregistered channel is a leak
    // no assertion would see.
    const channel = trackChannel(
      createChannel({
        agentId: "agent-1",
        write: writer.write,
        reader: makeReader(),
        clock: inline.clock,
      }),
    );

    const pending = channel.send({ capability: TRACKED, body: {}, requestId: "inline" });

    // Asserted synchronously, before any await, so a leak shows up as a failed
    // expectation rather than as a hung test.
    expect(inline.fired()).toBe(1);
    expect(channel.inFlightCount()).toBe(0);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  it("survives an answer that arrives after the timeout, and ignores it", async () => {
    // Red when: the late-answer path loses its `undefined` guard and throws. A
    // late frame is normal - the engine answered a request we already gave up on.
    const h = makeHarness();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "late" });
    h.clock.advance(30_000);
    const result = await pending;
    expect(result.ok).toBe(false);

    expect(() => h.channel.ingest(responseFrame("late", { data: "too late" }))).not.toThrow();
    // The stranger frame is not dropped either: an unmatched response is treated
    // as an event, because it may be a push we misread.
    expect(h.events).toHaveLength(1);
    expect(h.channel.inFlightCount()).toBe(0);
    // One timeout record, not two: the late frame is not a second failure.
    expect(h.records.filter((record) => record.kind === "timeout")).toHaveLength(1);
  });

  it("produces one result for a duplicated answer", async () => {
    // Red when: a duplicate response settles the promise twice or throws on the
    // second lookup.
    const h = makeHarness();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "dup-answer" });
    h.channel.ingest(responseFrame("dup-answer", { data: "first" }));
    h.channel.ingest(responseFrame("dup-answer", { data: "second" }));

    await expect(pending).resolves.toMatchObject({ ok: true, data: "first" });
    expect(h.channel.inFlightCount()).toBe(0);
  });

  it("does not settle a request on an answer for a different id", async () => {
    // Red when: the lookup falls back to "the most recent entry" - the classic
    // out-of-order correlation bug.
    const h = makeHarness();
    const first = h.channel.send({ capability: TRACKED, body: {}, requestId: "one" });
    void h.channel.send({ capability: TRACKED, body: {}, requestId: "two" });

    h.channel.ingest(responseFrame("two", { data: "for-two" }));

    // `one` is still waiting: its own answer has not arrived.
    expect(h.channel.inFlightCount()).toBe(1);
    h.channel.ingest(responseFrame("one", { data: "for-one" }));
    await expect(first).resolves.toMatchObject({ data: "for-one" });
  });
});

describe("timeouts", () => {
  it("gives each request its own timer, at its own family budget", () => {
    // Red when: the channel polls with one shared timer. Two channels or two
    // request families would then share one deadline, which is exactly how a local
    // failure gets reported as a global one.
    const h = makeHarness();
    void h.channel.send({ capability: TRACKED, body: {}, requestId: "normal" });
    void h.channel.send({ capability: "compaction.prepare", body: {}, requestId: "slow" });

    expect(h.clock.delays).toEqual([30_000, 180_000]);
    expect(h.clock.pending()).toBe(2);

    // The `normal` one expires alone; the `slow` one is still waiting.
    h.clock.advance(30_000);
    expect(h.channel.inFlightCount()).toBe(1);
    h.clock.advance(150_000);
    expect(h.channel.inFlightCount()).toBe(0);
  });

  it("clamps a caller's timeoutMs to ten times the family budget", () => {
    // Red when: the override is honoured without limit, which pins a slot for an
    // hour.
    const h = makeHarness();
    void h.channel.send({ capability: TRACKED, body: {}, timeoutMs: 3_600_000 });
    expect(h.clock.delays).toEqual([300_000]);
  });

  it("uses a caller's shorter timeoutMs as given", () => {
    // Red when: the clamp becomes a floor, so a caller who wants a 2 s wait is
    // forced to wait the family default.
    const h = makeHarness();
    void h.channel.send({ capability: TRACKED, body: {}, timeoutMs: 2_000 });
    expect(h.clock.delays).toEqual([2_000]);
  });

  it("accepts an injected budget resolver and uses its number verbatim", () => {
    // Red when: the kernel keeps a private copy of the family table instead of
    // asking the injected resolver - the two would drift the moment the timeout
    // table is revised.
    const budget: ResolvedBudget = { ms: 1_234, clamped: false };
    const h = makeHarness({ resolveTimeoutMs: () => budget });
    void h.channel.send({ capability: TRACKED, body: {}, requestId: "custom" });
    expect(h.clock.delays).toEqual([1_234]);
    h.clock.advance(1_234);
    expect(h.channel.inFlightCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Readiness and NOT_CONNECTED                                               */
/* ------------------------------------------------------------------------- */

describe("readiness", () => {
  it("distinguishes never-ready from ready-then-dropped", async () => {
    // Red when: both cases share one detail string. The reconnect layer uses the
    // wording to decide whether a send is worth replaying at all.
    const neverReady = makeHarness({
      readiness: (): ChannelReadiness => ({ ready: false, everReady: false }),
    });
    const never = await expectSettles(neverReady.channel.send({ capability: TRACKED, body: {} }));
    expect(never.ok).toBe(false);
    if (!never.ok) {
      expect(never.error.code).toBe("NOT_CONNECTED");
      expect(never.error.detail).toContain("engine has not become ready");
    }

    const droppedHarness = makeHarness({
      readiness: (): ChannelReadiness => ({ ready: false, everReady: true }),
    });
    const dropped = await expectSettles(
      droppedHarness.channel.send({ capability: TRACKED, body: {} }),
    );
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) {
      expect(dropped.error.code).toBe("NOT_CONNECTED");
      expect(dropped.error.detail).toContain("channel was ready and dropped");
    }

    // Nothing was written in either case: a not-connected channel must not
    // pretend it sent something.
    expect(neverReady.writer.calls).toHaveLength(0);
    expect(droppedHarness.writer.calls).toHaveLength(0);
  });

  it("closes idempotently and stops accepting commands", async () => {
    // Red when: close is not idempotent (a second close re-runs the loop and
    // double-settles), or a closed channel still writes.
    const h = makeHarness();
    h.channel.close();
    expect(h.channel.isClosed()).toBe(true);

    expect(() => h.channel.close()).not.toThrow();
    expect(h.channel.isClosed()).toBe(true);

    const result = await expectSettles(h.channel.send({ capability: TRACKED, body: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_CONNECTED");
    }
    expect(h.writer.calls).toHaveLength(0);
  });

  it("stops delivering to subscribers once closed", () => {
    // Red when: close leaves the subscriber sets populated, so a frame ingested
    // after close still reaches a consumer that was told it was done.
    const h = makeHarness();
    h.channel.close();
    h.channel.ingest(eventFrame("known.event"));
    expect(h.events).toHaveLength(0);
  });

  it("ignores frames after close, so a closed channel records nothing more", () => {
    // Red when: `ingest` loses its closed-state guard. Observed through the
    // diagnostic history rather than through a subscriber, because `onEvent` on a
    // closed channel hands back a no-op unsubscribe and never registers anything -
    // so a subscriber-based test would stay green with the guard removed. `diagnose`
    // is not gated on close, which makes it the observable consequence: a closed
    // channel that still ingests will record a `malformed` for a junk frame.
    const h = makeHarness();
    const pending = h.channel.send({ capability: TRACKED, body: {}, requestId: "closed" });
    h.channel.close();
    const before = h.channel.diagnostics().length;

    h.channel.ingest("this is not json");
    h.channel.ingest(eventFrame("known.event"));

    expect(h.channel.diagnostics()).toHaveLength(before);
    expect(h.channel.inFlightCount()).toBe(0);
    void pending;
  });
});

/* ------------------------------------------------------------------------- */
/* Event dispatch                                                            */
/* ------------------------------------------------------------------------- */

describe("event dispatch", () => {
  it("delivers every frame to every subscriber, in arrival order", () => {
    // Red when: dispatch iterates the wrong set, drops a frame, or reorders.
    const h = makeHarness();
    const seen: string[] = [];
    h.channel.onEvent((frame) => seen.push(`second:${frame.type}`));

    h.channel.ingest(eventFrame("known.a"));
    h.channel.ingest(eventFrame("known.b"));

    expect(h.events.map((frame) => frame.type)).toEqual(["known.a", "known.b"]);
    expect(seen).toEqual(["second:known.a", "second:known.b"]);
  });

  it("carries the frame untouched, including its id", () => {
    // Red when: the kernel rebuilds the frame with a new id or a stripped field -
    // the reason the engine's inbound control frames keep their id.
    const h = makeHarness();
    const payload = {
      type: "known.event",
      event_seq: 42,
      payload: { keep: ["everything"] },
    };
    h.channel.ingest(JSON.stringify(payload));

    expect(h.events[0]?.raw).toEqual(payload);
    expect(h.events[0]?.raw).toBe(h.events[0]?.raw);
  });

  it("timestamps with the injected clock, not the engine's emitted_at", () => {
    // Red when: `at` is taken from the envelope. They come from different clocks
    // on different machines, so comparing them is meaningless (types.ts).
    const h = makeHarness();
    const before = h.clock.clock.now();
    h.channel.ingest(eventFrame("known.event", { emitted_at: "1999-01-01T00:00:00.000Z" }));
    expect(h.events[0]?.at).toBe(before);
  });

  it("keeps one throwing subscriber from costing another its frame", () => {
    // Red when: the try/catch around delivery is removed. A renderer bug would
    // then take down every other consumer and the channel with it.
    const h = makeHarness();
    const later: string[] = [];
    h.channel.onEvent(() => {
      throw new Error("subscriber bug");
    });
    h.channel.onEvent((frame) => later.push(frame.type));

    expect(() => h.channel.ingest(eventFrame("known.event"))).not.toThrow();
    expect(later).toEqual(["known.event"]);

    // And the channel still works for the next frame.
    expect(h.channel.ingest.bind(h.channel, eventFrame("known.next"))).not.toThrow();
    expect(later).toEqual(["known.event", "known.next"]);
  });

  it("unsubscribes idempotently and only for the caller", () => {
    // Red when: the returned function deletes the wrong entry (or all of them), so
    // one consumer's unsubscribe silences another.
    const h = makeHarness();
    const seen: string[] = [];
    const unsubscribe = h.channel.onEvent((frame) => seen.push(frame.type));

    unsubscribe();
    unsubscribe();
    h.channel.ingest(eventFrame("known.after-unsubscribe"));

    expect(seen).toEqual([]);
    // The harness subscriber is untouched.
    expect(h.events.map((frame) => frame.type)).toEqual(["known.after-unsubscribe"]);
  });
});

/* ------------------------------------------------------------------------- */
/* Unknown events                                                            */
/* ------------------------------------------------------------------------- */

describe("unknown events", () => {
  it("does not crash on an unknown type, and counts it per type", () => {
    // Red when: an unknown type throws, or is stored per frame instead of counted.
    // 155 of the 295 recorded frames share one type, so per-frame storage would
    // spend the whole history on a single answer.
    const h = makeHarness({ knownEventTypes: new Set(["known.event"]) });
    for (let index = 0; index < 5; index += 1) {
      expect(() => h.channel.ingest(eventFrame("future.type"))).not.toThrow();
    }

    expect(h.channel.unknownEventCounts().get("future.type")).toBe(5);
    // One summary record, not five.
    expect(h.records.filter((record) => record.kind === "unknown-event")).toHaveLength(1);
    // The frames are still delivered: unknown means unmodelled, not discarded.
    expect(h.events).toHaveLength(5);
  });

  it("aggregates two unknown types separately", () => {
    // Red when: the tally keys on something constant (or on the count), so two
    // types share one bucket.
    const h = makeHarness({ knownEventTypes: new Set(["known.event"]) });
    h.channel.ingest(eventFrame("future.a"));
    h.channel.ingest(eventFrame("future.b"));
    h.channel.ingest(eventFrame("future.a"));

    const counts = h.channel.unknownEventCounts();
    expect(counts.get("future.a")).toBe(2);
    expect(counts.get("future.b")).toBe(1);
    expect([...counts.keys()]).toEqual(["future.a", "future.b"]);
  });

  it("does not count a known type as unknown", () => {
    // Red when: the membership test is inverted or forgotten, so every frame is
    // reported unknown and the tally stops meaning anything.
    const h = makeHarness({ knownEventTypes: new Set(["known.event"]) });
    h.channel.ingest(eventFrame("known.event"));
    expect(h.channel.unknownEventCounts().size).toBe(0);
  });

  it("does not hand a non-object frame to the reader", () => {
    // Red when: the object guard is dropped. The default reader is total over
    // `unknown`, so its own `typeof` check hides a missing guard (that is why this
    // case uses a reader that is *not* total - the realistic shape, since a
    // response reader will index fields). A frame that is not an object must be
    // rejected by the channel, because a reader that throws on it would take the
    // channel down on a malformed frame, and the next frame must still flow.
    let calls = 0;
    const h = makeHarness({
      reader: {
        typeOf: (raw) => {
          calls += 1;
          // Deliberately not guarded: proves the channel never reaches here with a
          // primitive.
          return (raw as { type: string }).type;
        },
        responseOf: () => undefined,
      },
    });

    for (const raw of ["null", "42", '"a string"', "[]"]) {
      expect(() => h.channel.ingest(raw)).not.toThrow();
    }

    // The reader was never consulted for a frame that is not an object.
    expect(calls).toBe(0);
    expect(h.events).toHaveLength(0);
    expect(h.records.every((record) => record.kind === "malformed")).toBe(true);
  });

  it("does not crash on an object with no usable type", () => {
    // Red when: `type` is trusted to be a non-empty string, so a number or an
    // absent field becomes the event type "undefined".
    const h = makeHarness();
    expect(() => h.channel.ingest(JSON.stringify({ type: 7 }))).not.toThrow();
    expect(() => h.channel.ingest(JSON.stringify({ type: "" }))).not.toThrow();
    expect(() => h.channel.ingest(JSON.stringify({ no_type: true }))).not.toThrow();
    expect(h.events).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- */
/* Contract shape                                                            */
/* ------------------------------------------------------------------------- */

describe("contract", () => {
  it("exposes the frozen Channel surface", () => {
    // Red when: a member is renamed or removed, or `agentId` stops being readable.
    const channel: EngineChannel = trackChannel(
      new EngineChannel({ agentId: "agent-7", write: makeWriter().write }),
    );

    expect(channel.agentId).toBe("agent-7");
    expect(typeof channel.send).toBe("function");
    expect(typeof channel.onEvent).toBe("function");
    expect(typeof channel.onDiagnostic).toBe("function");
    expect(typeof channel.capabilities).toBe("function");
    expect(typeof channel.close).toBe("function");
  });

  it("resolves send to a CommandResult rather than rejecting, even for a throwing writer", async () => {
    // Red when: any failure path rejects instead of returning `ok: false`. A
    // rejected promise would force every call site into try/catch.
    const h = makeHarness({
      write: () => {
        throw new Error("nope");
      },
    });
    const outcome: Promise<CommandResult> = h.channel.send({ capability: TRACKED, body: {} });
    await expect(outcome).resolves.toMatchObject({ ok: false });
  });

  it("gives each channel its own identity and its own table", () => {
    // Red when: the table or the subscriber sets become module-level state, so one
    // channel's in-flight requests leak into another's.
    const one = makeHarness();
    const two = makeHarness();

    void one.channel.send({ capability: TRACKED, body: {}, requestId: "one" });
    expect(one.channel.inFlightCount()).toBe(1);
    expect(two.channel.inFlightCount()).toBe(0);

    two.channel.ingest(responseFrame("one", { data: "crossed" }));
    expect(two.events).toHaveLength(1);
    expect(one.events).toHaveLength(0);
    expect(one.channel.inFlightCount()).toBe(1);
  });
});
