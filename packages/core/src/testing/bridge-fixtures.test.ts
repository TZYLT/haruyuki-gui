/**
 * The hand-authored bridge-frame corpus and the replay-injection proof.
 *
 * Corpus: `fixtures/bridge/*.jsonl`, one `frames` header line plus one Frame
 * envelope per line, the format `loadFramesFixture` enforces. The recorder never
 * produces these, so each file is small and says in its `note` what it
 * demonstrates. The injected sequence lives in the companion `.plan.json` next
 * to the fixture, in the `ReplayPlan` shape.
 *
 * Proof: load each fixture with `loadFramesFixture`, replay it through the
 * replay double (`replayThrough` in `./replay-client`) with the matching plan,
 * and assert that the injection is visible in what the client received:
 *
 *   reorder            the adjacent stream pair arrives swapped;
 *   duplicate          the same seq arrives twice, never renumbered;
 *   coalesce           the adjacent state frames are emitted with no wait;
 *   disconnect resume  the tail arrives on a second socket;
 *   disconnect stop    the replay truncates at the break.
 *
 * The replay client speaks the wire fixture shape, so `asWireFixture` wraps a
 * frame stream as one `s2c` line per frame. `at` is the frame index, which keeps
 * the plan's 1-based line numbers equal to the fixture's frame lines and lets
 * `speed` turn frame spacing into observable waits.
 *
 * Same-channel order is promised and cross-channel order is not, so the corpus
 * assertions compare per-channel projections, never the raw cross-channel
 * arrival list.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BridgeFrame, Clock, FramesFixture, ReplayPlan, WireFixture } from "./fixture";
import { loadFramesFixture } from "./fixture";
import type { ReplayThroughResult } from "./replay-client";
import { replayThrough } from "./replay-client";

/** `packages/core/src/testing` -> repo root -> the bridge corpus. */
const CORPUS_URL = new URL("../../../../fixtures/bridge/", import.meta.url);

/** Every file in the corpus, one per channel sample or injection. */
const CORPUS_FILES = [
  "three-channels.jsonl",
  "reorder.jsonl",
  "duplicate.jsonl",
  "coalesce.jsonl",
  "disconnect.jsonl",
  "disconnect-truncate.jsonl",
] as const;

/** The three frozen channels. */
const CHANNELS = ["control", "stream", "bulk"] as const;

type Channel = (typeof CHANNELS)[number];

/** Absolute path of one corpus member (fixture or its companion plan). */
function corpusPath(name: string): string {
  return fileURLToPath(new URL(name, CORPUS_URL));
}

/** Load one `.jsonl` fixture through the frozen frames loader. */
async function loadBridgeFixture(name: string): Promise<FramesFixture> {
  return loadFramesFixture(corpusPath(name));
}

/** Load the companion `.plan.json` next to a fixture, as the frozen plan shape. */
async function loadPlan(name: string): Promise<ReplayPlan> {
  return JSON.parse(await readFile(corpusPath(name), "utf8")) as ReplayPlan;
}

/**
 * Wrap a frame stream as a wire fixture for the replay double.
 *
 * One `s2c` line per frame, in fixture order: the header line is not a plan
 * line, so frame line N is wire line N and a plan can name it directly.
 */
function asWireFixture(fixture: FramesFixture): WireFixture {
  return {
    header: {
      kind: "wire",
      schemaVersion: 1,
      scenario: "bridge-fixtures",
      clock: "virtual",
    },
    lines: fixture.frames.map((frame, index) => ({ dir: "s2c", at: index, msg: frame })),
  };
}

/** Every received frame, parsed; the replay double must not alter the envelope. */
function framesOf(result: ReplayThroughResult): BridgeFrame[] {
  return result.frames.map((frame) => frame.json as BridgeFrame);
}

/** One source frame by its 1-based fixture line, failing loudly on a bad plan. */
function frameAt(fixture: FramesFixture, line: number): BridgeFrame {
  const frame = fixture.frames[line - 1];

  if (frame === undefined) {
    throw new Error(`bridge fixture has no frame line ${line}`);
  }

  return frame;
}

/** The frames of one channel, in arrival order. */
function channelFrames(frames: readonly BridgeFrame[], channel: Channel): BridgeFrame[] {
  return frames.filter((frame) => frame.ch === channel);
}

/** A per-channel projection; the only order the bridge promises. */
function perChannel(frames: readonly BridgeFrame[]): Record<Channel, BridgeFrame[]> {
  return {
    control: channelFrames(frames, "control"),
    stream: channelFrames(frames, "stream"),
    bulk: channelFrames(frames, "bulk"),
  };
}

/** A clock that records every wait the replay plans, for the coalesce gap. */
function createWaitClock(): { clock: Clock; waits: number[] } {
  const waits: number[] = [];
  let now = 0;

  return {
    clock: {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    },
    waits,
  };
}

describe("bridge frame corpus", () => {
  it("keeps every file a frozen frames file with per-channel increasing seq", async () => {
    for (const name of CORPUS_FILES) {
      const fixture = await loadBridgeFixture(name);

      expect(fixture.header.kind, name).toBe("frames");
      expect(fixture.header.schemaVersion, name).toBe(1);
      expect(fixture.header.bridgeVersion, name).toBe(1);
      expect(fixture.frames.length, name).toBeGreaterThan(0);
      expect(fixture.frames.length, name).toBeLessThanOrEqual(20);

      for (const channel of CHANNELS) {
        const seqs = channelFrames(fixture.frames, channel).map((frame) => frame.seq);

        expect(new Set(seqs).size, `${name} ${channel} seq unique`).toBe(seqs.length);
        expect(seqs, `${name} ${channel} seq increasing`).toEqual(
          [...seqs].sort((left, right) => left - right),
        );
      }
    }
  });

  it("replays the three channels with per-channel order and source seq", async () => {
    const fixture = await loadBridgeFixture("three-channels.jsonl");
    const result = await replayThrough({ fixture: asWireFixture(fixture) });
    const received = framesOf(result);

    expect(received).toHaveLength(fixture.frames.length);
    // Same-channel order and content are promised; cross-channel order is not,
    // so only the per-channel projection is compared.
    expect(perChannel(received)).toEqual(perChannel(fixture.frames));
    // The double carries seq, it never renumbers it.
    for (const channel of CHANNELS) {
      expect(channelFrames(received, channel).map((frame) => frame.seq)).toEqual(
        channelFrames(fixture.frames, channel).map((frame) => frame.seq),
      );
    }
    // The corpus really exercises all three channels.
    expect(new Set(received.map((frame) => frame.ch))).toEqual(new Set(CHANNELS));
    // What arrived is byte for byte what the replay emitted.
    expect(result.received).toEqual(result.server.emitted);
  });
});

describe("replay injections", () => {
  it("reorder: the adjacent pair arrives swapped, with seq untouched", async () => {
    const fixture = await loadBridgeFixture("reorder.jsonl");
    const plan = await loadPlan("reorder.plan.json");
    const plain = framesOf(await replayThrough({ fixture: asWireFixture(fixture) }));
    const reordered = framesOf(await replayThrough({ fixture: asWireFixture(fixture), plan }));

    // Baseline: the stream channel is seq 1, 2, 3.
    expect(channelFrames(plain, "stream").map((frame) => frame.seq)).toEqual([1, 2, 3]);
    // Lines 3 and 4 are seq 2 and seq 3; the plan swaps them.
    expect(channelFrames(reordered, "stream").map((frame) => frame.seq)).toEqual([1, 3, 2]);
    expect(channelFrames(reordered, "stream")).toEqual([
      frameAt(fixture, 2),
      frameAt(fixture, 4),
      frameAt(fixture, 3),
    ]);
    // The swap moved frames; it did not rewrite them.
    expect(
      channelFrames(reordered, "stream")
        .map((frame) => frame.seq)
        .sort((left, right) => left - right),
    ).toEqual([1, 2, 3]);
    expect(reordered).toHaveLength(plain.length);
    expect(perChannel(reordered).control).toEqual(perChannel(fixture.frames).control);
    expect(perChannel(reordered).bulk).toEqual(perChannel(fixture.frames).bulk);
  });

  it("duplicate: the same frame arrives twice, still with its original seq", async () => {
    const fixture = await loadBridgeFixture("duplicate.jsonl");
    const plan = await loadPlan("duplicate.plan.json");
    const received = framesOf(await replayThrough({ fixture: asWireFixture(fixture), plan }));
    const stream = channelFrames(received, "stream");

    // Line 3 is stream seq 2; one repeat makes the stream [1, 2, 2, 3].
    expect(received).toHaveLength(fixture.frames.length + 1);
    expect(stream.map((frame) => frame.seq)).toEqual([1, 2, 2, 3]);
    expect(stream[1]).toEqual(stream[2]);
    expect(stream[1]?.seq).toBe(2);
    expect(stream[1]?.body).toEqual(frameAt(fixture, 3).body);
    // The frame after the pair keeps its own seq (no renumbering).
    expect(stream[3]).toEqual(frameAt(fixture, 5));
  });

  it("coalesce: the adjacent state frames are emitted back to back", async () => {
    const fixture = await loadBridgeFixture("coalesce.jsonl");
    const plan = await loadPlan("coalesce.plan.json");
    const wire = asWireFixture(fixture);
    const spaced = createWaitClock();
    const coalesced = createWaitClock();

    const spacedResult = await replayThrough({
      fixture: wire,
      plan: { speed: 100 },
      clock: spaced.clock,
    });
    const coalescedResult = await replayThrough({ fixture: wire, plan, clock: coalesced.clock });
    const spacedFrames = framesOf(spacedResult);
    const coalescedFrames = framesOf(coalescedResult);

    // Baseline: one 100 ms wait before each of the four later frames.
    expect(spaced.waits).toEqual([100, 100, 100, 100]);
    // Coalesce drops exactly the wait before line 4: the two state.queue frames
    // on lines 3 and 4 leave the double with no gap between them.
    expect(coalesced.waits).toEqual([100, 100, 100]);
    // Dropping the wait neither reorders nor rewrites the frames. The comparison
    // is per channel: cross-channel order is not promised.
    expect(coalescedFrames).toHaveLength(spacedFrames.length);
    expect(perChannel(coalescedFrames)).toEqual(perChannel(spacedFrames));
    expect(perChannel(coalescedFrames)).toEqual(perChannel(fixture.frames));
    const stream = channelFrames(coalescedFrames, "stream");
    expect(stream.map((frame) => frame.t)).toEqual(["delta.message", "state.queue", "state.queue"]);
    expect([stream[1], stream[2]]).toEqual([frameAt(fixture, 3), frameAt(fixture, 4)]);
  });

  it("disconnect with resume: the tail arrives on a second socket", async () => {
    const fixture = await loadBridgeFixture("disconnect.jsonl");
    const plan = await loadPlan("disconnect.plan.json");
    const arrivals: Array<{ frame: BridgeFrame; socket: unknown }> = [];

    await replayThrough({
      fixture: asWireFixture(fixture),
      plan,
      onFrame: (frame, socket) => {
        arrivals.push({ frame: frame.json as BridgeFrame, socket });
      },
    });

    const bySocket = new Map<unknown, BridgeFrame[]>();

    for (const arrival of arrivals) {
      const group = bySocket.get(arrival.socket) ?? [];

      group.push(arrival.frame);
      bySocket.set(arrival.socket, group);
    }

    const groups = [...bySocket.values()];
    const before = groups[0] ?? [];
    const after = groups[1] ?? [];

    // The break is after line 3: three frames, a new socket, then the tail.
    expect(bySocket.size).toBe(2);
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(3);
    expect(perChannel(before)).toEqual(perChannel(fixture.frames.slice(0, 3)));
    expect(perChannel(after)).toEqual(perChannel(fixture.frames.slice(3)));
    // Reconnecting does not renumber seq, and the resumed tail keeps its
    // same-channel order (cross-channel order is still not promised).
    expect(channelFrames(after, "stream").map((frame) => frame.seq)).toEqual([3, 4]);
    expect(channelFrames(after, "bulk").map((frame) => frame.seq)).toEqual([1]);
    expect(channelFrames(after, "control")).toEqual([]);
  });

  it("disconnect without resume: the replay truncates at the break", async () => {
    const fixture = await loadBridgeFixture("disconnect-truncate.jsonl");
    const plan = await loadPlan("disconnect-truncate.plan.json");
    const sockets = new Set<unknown>();

    const result = await replayThrough({
      fixture: asWireFixture(fixture),
      plan,
      onFrame: (_frame, socket) => {
        sockets.add(socket);
      },
    });
    const received = framesOf(result);

    // Only the prefix before the break arrives; the last two frames never do.
    expect(received).toHaveLength(3);
    expect(received).toHaveLength(fixture.frames.length - 2);
    expect(perChannel(received)).toEqual(perChannel(fixture.frames.slice(0, 3)));
    expect(result.received).toEqual(result.server.emitted);
    expect(sockets.size).toBe(1);
  });
});
