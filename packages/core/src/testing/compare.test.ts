/**
 * Tests for the observation and comparison layer.
 *
 * The claim: the same bridge frames through both transport doubles must produce
 * the same observation, and a structural rejection must be visible in it.
 *
 * Two transports observing one fixture compare equal; a deliberately swapped
 * same-channel pair does not; a different cross-channel interleaving is not a
 * difference, because the bridge never promises one. Rejection cases prove a
 * refused frame is visible in the observation and never silently dropped.
 */

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BridgeFrame, Clock, FrameChannel } from "./fixture";
import { loadFramesFixture } from "./fixture";
import { createComparisonHarness, compareObservations } from "./compare";
import { createObservedDouble, observeThrough } from "./observation";
import { createIpcDouble } from "./transport/ipc";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const CHANNELS: readonly FrameChannel[] = ["control", "stream", "bulk"];

/** A virtual clock that never waits. */
const CLOCK: Clock = {
  now: () => 0,
  sleep: async () => {},
};

/** Absolute path of one bridge corpus member. */
function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/bridge/${name}`, import.meta.url));
}

/** One frame; `t` is only ever a label here. */
function frame(
  channel: FrameChannel,
  seq: number,
  t: string,
  body: Record<string, unknown> = {},
): BridgeFrame {
  return { v: 1, ch: channel, seq, t, body };
}

/** Observe a frame list through a fresh double of the given shape. */
async function observe(name: "ipc" | "postmessage", frames: readonly BridgeFrame[]) {
  const double = createObservedDouble(name);

  try {
    return await observeThrough(double, frames, CLOCK);
  } finally {
    double.close();
  }
}

/** Swap two entries of a frame list, refusing an out-of-range index. */
function withSwapped(frames: readonly BridgeFrame[], left: number, right: number): BridgeFrame[] {
  const copy = [...frames];
  const first = copy[left];
  const second = copy[right];

  if (first === undefined || second === undefined) {
    throw new Error(`cannot swap frame indexes ${left} and ${right} of ${frames.length}`);
  }

  copy[left] = second;
  copy[right] = first;

  return copy;
}

/* ------------------------------------------------------------------ */
/* two transports, one observation                                     */
/* ------------------------------------------------------------------ */

describe("compareObservations", () => {
  it("compares equal for the same fixture through both doubles", async () => {
    const fixture = await loadFramesFixture(fixturePath("three-channels.jsonl"));
    const ipc = await observe("ipc", fixture.frames);
    const postmessage = await observe("postmessage", fixture.frames);
    const report = compareObservations(ipc, postmessage);

    expect(ipc.rejected).toEqual([]);
    expect(ipc.transportRejections).toBeUndefined();
    expect(report).toEqual({ equal: true, diffs: [] });
    expect(report.equal).toBe(report.diffs.length === 0);

    // Same-channel order and content, channel by channel.
    for (const channel of CHANNELS) {
      expect(ipc.byChannel[channel]).toEqual(postmessage.byChannel[channel]);
    }

    expect(ipc.state).toEqual(postmessage.state);
    expect(ipc.state).toEqual({
      control: fixture.frames.filter((entry) => entry.ch === "control"),
      stream: fixture.frames.filter((entry) => entry.ch === "stream" && entry.t !== "state.queue"),
      bulk: fixture.frames.filter((entry) => entry.ch === "bulk"),
      state: { queue: { pending: 1 } },
    });
  });

  it("does not compare equal when an adjacent same-channel pair is swapped", async () => {
    const frames = [
      frame("control", 1, "bridge.ready"),
      frame("stream", 1, "delta.message", { text: "a" }),
      frame("stream", 2, "delta.message", { text: "b" }),
      frame("bulk", 1, "bulk.page", { page: 1 }),
    ];
    const baseline = await observe("ipc", frames);
    const altered = await observe("ipc", withSwapped(frames, 1, 2));
    const report = compareObservations(baseline, altered);

    expect(report.equal).toBe(false);
    expect(report.diffs.length).toBeGreaterThan(0);
    expect(report.diffs).toEqual([...new Set(report.diffs)].sort());
    expect(report.diffs.some((diff) => diff.startsWith("byChannel.stream[0]"))).toBe(true);
    expect(report.diffs.some((diff) => diff.startsWith("stream[0]"))).toBe(true);
  });

  it("ignores cross-channel interleaving but keeps same-channel order", async () => {
    const control = [frame("control", 1, "bridge.ready"), frame("control", 2, "ping")];
    const stream = [
      frame("stream", 1, "delta.message", { text: "a" }),
      frame("stream", 2, "delta.message", { text: "b" }),
    ];
    const bulk = [frame("bulk", 1, "bulk.page", { page: 1 })];
    const firstOrder = [control[0], stream[0], stream[1], bulk[0], control[1]] as BridgeFrame[];
    const secondOrder = [bulk[0], control[0], stream[0], stream[1], control[1]] as BridgeFrame[];

    const first = await observe("ipc", firstOrder);
    const second = await observe("ipc", secondOrder);

    // The arrival lists really do interleave differently ...
    expect(first.frames.map((entry) => entry.ch)).not.toEqual(
      second.frames.map((entry) => entry.ch),
    );
    // ... and that difference is not a comparison failure.
    expect(compareObservations(first, second)).toEqual({ equal: true, diffs: [] });
    for (const channel of CHANNELS) {
      expect(first.byChannel[channel]).toEqual(second.byChannel[channel]);
    }
  });

  it("reports a folded-state difference as a path through the state map", async () => {
    const before = await observe("ipc", [frame("stream", 1, "state.queue", { pending: 0 })]);
    const after = await observe("ipc", [frame("stream", 1, "state.queue", { pending: 1 })]);
    const report = compareObservations(before, after);

    expect(report.equal).toBe(false);
    expect(report.diffs).toContain("state.queue.pending: 0 !== 1");
    expect(report.diffs).toContain("byChannel.stream[0].body.pending: 0 !== 1");
  });
});

/* ------------------------------------------------------------------ */
/* rejected frames are visible                                         */
/* ------------------------------------------------------------------ */

describe("observeThrough", () => {
  it("keeps a structural rejection out of rejected and reports it as a transport rejection", async () => {
    const malformed = {
      v: 2,
      ch: "stream",
      seq: 1,
      t: "delta.message",
      body: {},
    } as unknown as BridgeFrame;
    const double = createObservedDouble("ipc");

    try {
      const observation = await observeThrough(double, [malformed], CLOCK);

      expect(observation.frames).toEqual([]);
      expect(observation.rejected).toEqual([]);
      expect(observation.transportRejections).toHaveLength(1);
      expect(observation.transportRejections?.[0]?.reason).toContain("malformed frame");
    } finally {
      double.close();
    }
  });

  it("records a non-JSON frame in both rejection lists", async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    const good = frame("stream", 1, "delta.message", { text: "a" });
    const bad = {
      v: 1,
      ch: "stream",
      seq: 2,
      t: "delta.message",
      body: cycle,
    } as unknown as BridgeFrame;
    const double = createObservedDouble("ipc");

    try {
      const observation = await observeThrough(double, [good, bad], CLOCK);

      expect(observation.frames).toEqual([good]);
      // A structural rejection has no text, so `rejected` stays empty: the
      // invented `"[object Object]"` used to make two different frames look the
      // same, and it made the result depend on whether a sink was attached.
      expect(observation.rejected).toEqual([]);
      expect(observation.transportRejections).toHaveLength(1);
      expect(observation.transportRejections?.[0]?.reason).toContain("not JSON-serialisable");

      const clean = await observe("ipc", [good]);
      const report = compareObservations(clean, observation);

      expect(report.equal).toBe(false);
      expect(report.diffs.some((diff) => diff.startsWith("transportRejections[0]"))).toBe(true);
    } finally {
      double.close();
    }
  });

  it("records a missing frame from a double without a rejection sink", async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    const good = frame("stream", 1, "delta.message", { text: "a" });
    const bad = {
      v: 1,
      ch: "stream",
      seq: 2,
      t: "delta.message",
      body: cycle,
    } as unknown as BridgeFrame;
    const double = createIpcDouble();

    try {
      const observation = await observeThrough(double, [good, bad], CLOCK);

      expect(observation.frames).toEqual([good]);
      expect(observation.rejected).toEqual([]);
      expect(observation.transportRejections).toHaveLength(1);
      expect(observation.transportRejections?.[0]?.reason).toContain("no rejection sink");
    } finally {
      double.close();
    }
  });

  it("carries the additive scenario option without breaking the frozen call", async () => {
    const double = createObservedDouble("ipc");

    try {
      const unlabelled = await observeThrough(double, [], CLOCK);
      const labelled = await observeThrough(double, [], CLOCK, { scenario: "three-channels" });

      expect(unlabelled.scenario).toBe("");
      expect(labelled.scenario).toBe("three-channels");
    } finally {
      double.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* the harness                                                         */
/* ------------------------------------------------------------------ */

describe("createComparisonHarness", () => {
  it("uses the same observe and compare entry points", async () => {
    const fixture = await loadFramesFixture(fixturePath("three-channels.jsonl"));
    const harness = createComparisonHarness();
    const ipcDouble = createObservedDouble("ipc");
    const postMessageDouble = createObservedDouble("postmessage");

    try {
      const ipc = await harness.observe(ipcDouble, fixture.frames, CLOCK);
      const postmessage = await harness.observe(postMessageDouble, fixture.frames, CLOCK);

      expect(harness.compare(ipc, postmessage)).toEqual({ equal: true, diffs: [] });
    } finally {
      ipcDouble.close();
      postMessageDouble.close();
    }
  });
});
