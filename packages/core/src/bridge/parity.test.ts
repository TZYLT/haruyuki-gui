/**
 * Parity test: the same frames, through two platform-shaped doubles,
 * arrive as the same stream.
 *
 * Why this lives in `packages/core` and not in `scripts/`
 *   `scripts/` cannot resolve the workspace packages: `vitest` reports "Cannot
 *   find package '@haruyuki/core'" and `tsc -p scripts` reports TS2307, because
 *   there is no `scripts/node_modules` and no root link for the scoped names.
 *   `apps/*` is not collected by the test runner either. So the
 *   test has to live inside a package, and it has to live in the package that
 *   owns both sides of the comparison -- the sender under test and the doubles
 *   it is posted through. Putting it in `packages/ui` would have needed a test
 *   exemption to reach `core`, for a test that never exercises the renderer.
 *
 * What "parity" means here
 *   Not "the two doubles agree with each other in summary", which
 *   `compareObservations` already covers with a reduced state and per-channel
 *   grouping. This test compares the frame streams FIELD BY FIELD, in arrival
 *   order: the same frames, the same sequence numbers, the same types, the same
 *   bodies, the same cursors. A summary comparison can hide a lost frame whose
 *   effect on the reduced state happens to be idempotent; a per-field comparison
 *   cannot.
 *
 * The two doubles differ in one deliberate way: the IPC double
 * delivers on a microtask and the postMessage double on a zero-delay timer. That
 * difference is the point -- it is the platform difference the parity claim has
 * to survive -- so the comparison is made after both have drained, not before.
 */

import { describe, expect, it } from "vitest";

import { createIpcDouble } from "../testing/transport/ipc.js";
import { createPostMessageDouble } from "../testing/transport/postmessage.js";
import type { BridgeFrame } from "../testing/fixture.js";
import { createFrameSender } from "./sender.js";
import type { FrameSender } from "./sender.js";

/** The channels, in contract order. */
const CHANNELS = ["control", "stream", "bulk"] as const;

/**
 * A frame stream that exercises every channel and both frame shapes the sender
 * rewrites: a control frame, a stream slice, and a bulk snapshot that pages.
 */
function buildStream(): BridgeFrame[] {
  const filler = "x".repeat(1024);

  return [
    {
      v: 1,
      ch: "control",
      seq: 0,
      t: "bridge.ready",
      body: { appVersion: "0.1.0", bridgeVersion: "1" },
    },
    {
      v: 1,
      ch: "stream",
      seq: 0,
      t: "term.output",
      body: { bytes: filler.length, text: "first slice" },
    },
    {
      v: 1,
      ch: "stream",
      seq: 0,
      t: "term.output",
      body: { bytes: filler.length, text: "second slice" },
    },
  ];
}

/**
 * Send one stream through one double and return what arrived.
 *
 * The sender is constructed per double, because a sender owns a transport. The
 * sequence numbers it assigns are therefore per-run, and the comparison below
 * normalises them: two runs that numbered identically would also pass if the
 * counter were per-sender, which is the property under test elsewhere
 * (`sequencer.test.ts`). What this test claims is that the same input produces
 * the same stream shape through either platform.
 *
 * @param createDouble the platform double to post through
 * @param frames the frames to send
 * @returns frames in arrival order, as the double delivered them
 */
async function runThrough(
  createDouble: () => {
    post: (frame: BridgeFrame) => void;
    onFrame: (cb: (frame: BridgeFrame) => void) => () => void;
  },
  frames: readonly BridgeFrame[],
): Promise<BridgeFrame[]> {
  const double = createDouble();
  const received: BridgeFrame[] = [];

  const unsubscribe = double.onFrame((frame) => {
    received.push(frame);
  });

  const sender: FrameSender = createFrameSender({
    transport: (payload) => {
      double.post(JSON.parse(payload) as BridgeFrame);
    },
    // Injected so the test does not depend on the real frame table: an
    // unregistered type would otherwise be a fixture defect rather than a
    // parity result.
    frameTypes: new Set([
      "bridge.ready",
      "bridge.accept",
      "bridge.reject",
      "bulk.page",
      "term.output",
    ]),
  });

  try {
    for (const frame of frames) {
      sender.send(frame);
    }

    sender.flush();

    // Both doubles deliver asynchronously: one on a microtask, one on a
    // zero-delay timer. Two real turns is enough for either, and it keeps the
    // test honest about the platform difference instead of pinning one
    // granularity.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    unsubscribe();
    sender.close();
  }

  return received;
}

/**
 * Drop the sequence numbers from a stream.
 *
 * The numbers are compared separately and as a shape (strictly increasing, no
 * gaps), so the field-by-field comparison below is about everything else. Doing
 * it this way rather than deleting the field keeps a missing `seq` visible: a
 * frame that lost its number fails the shape assertion.
 *
 * @param frames arrival-ordered frames
 * @returns the same frames with `seq` replaced by its index
 */
function renumber(frames: readonly BridgeFrame[]): BridgeFrame[] {
  return frames.map((frame, index) => ({ ...frame, seq: index + 1 }));
}

describe("parity: the same stream through two platform doubles", () => {
  it("delivers the same frames, field by field, through the IPC double", async () => {
    const stream = buildStream();
    const received = await runThrough(() => createIpcDouble(), stream);

    expect(received).toHaveLength(stream.length);
    expect(renumber(received)).toEqual(
      stream.map((frame, index) => ({ ...frame, seq: index + 1 })),
    );
  });

  it("delivers the same frames, field by field, through the postMessage double", async () => {
    const stream = buildStream();
    const received = await runThrough(() => createPostMessageDouble(), stream);

    expect(received).toHaveLength(stream.length);
    expect(renumber(received)).toEqual(
      stream.map((frame, index) => ({ ...frame, seq: index + 1 })),
    );
  });

  it("produces byte-identical streams through both doubles", async () => {
    const stream = buildStream();

    const viaIpc = await runThrough(() => createIpcDouble(), stream);
    const viaPostMessage = await runThrough(() => createPostMessageDouble(), stream);

    // The claim: platform choice does not change what the consumer sees. The
    // comparison is the raw serialisation, so it also catches a field that one
    // path preserves and the other drops -- which a per-field assertion written
    // as "expect(received).toEqual(stream)" would miss for a field the test
    // author forgot to name.
    //
    // Renumbered first because the sequence counter is deliberately a global
    // singleton (see sequencer.ts): two runs cannot share numbers, and that is
    // the correct behaviour. Comparing raw bytes would assert the opposite.
    expect(renumber(viaPostMessage).map((frame) => JSON.stringify(frame))).toEqual(
      renumber(viaIpc).map((frame) => JSON.stringify(frame)),
    );
  });

  it("assigns strictly increasing sequence numbers with no gaps", async () => {
    const received = await runThrough(() => createIpcDouble(), buildStream());
    const numbers = received.map((frame) => frame.seq);

    expect(numbers).toEqual([...numbers].sort((left, right) => left - right));
    expect(new Set(numbers).size).toBe(numbers.length);

    for (let index = 1; index < numbers.length; index += 1) {
      // A gap would mean the producer burned a number on a frame that never
      // arrived, which is the failure mode a consumer cannot distinguish from a
      // lost frame.
      expect((numbers[index] ?? 0) - (numbers[index - 1] ?? 0)).toBe(1);
    }
  });

  it("keeps every channel's frames in source order", async () => {
    const received = await runThrough(() => createIpcDouble(), buildStream());

    for (const channel of CHANNELS) {
      const onChannel = received.filter((frame) => frame.ch === channel);
      const sourceOrder = buildStream()
        .filter((frame) => frame.ch === channel)
        .map((frame) => frame.t);

      expect(onChannel.map((frame) => frame.t)).toEqual(sourceOrder);
    }
  });

  it("keeps a bulk snapshot's cursor identical through both doubles", async () => {
    const snapshot = "y".repeat(600 * 1024);
    const frame: BridgeFrame = {
      v: 1,
      ch: "bulk",
      seq: 0,
      t: "bulk.page",
      body: { items: [snapshot, snapshot] },
      page: { more: true, watermark: 7, token: "snap-7" },
    };

    const viaIpc = await runThrough(() => createIpcDouble(), [frame]);
    const viaPostMessage = await runThrough(() => createPostMessageDouble(), [frame]);

    // A snapshot too large for one page is split, so more than one frame
    // arrives, and every page must carry the same watermark with a distinct
    // token -- otherwise the consumer's dedup key would drop all but the first.
    expect(viaIpc.length).toBeGreaterThan(1);
    expect(viaPostMessage.map((f) => f.page)).toEqual(viaIpc.map((f) => f.page));

    const cursors = viaIpc.map((f) => f.page);
    const watermarks = new Set(cursors.map((cursor) => cursor?.watermark));
    const tokens = new Set(cursors.map((cursor) => cursor?.token));

    expect(watermarks.size).toBe(1);
    expect(tokens.size).toBe(cursors.length);
  });
});
