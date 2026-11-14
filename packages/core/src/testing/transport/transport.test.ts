/**
 * Tests for the two transport doubles (`send.ts`, acceptance pick-path).
 *
 * Requirement source: docs/17-A3 sections 4.3 and 5.1 pick-path; contract source:
 * docs/18-A3 sections 1.2 `R-06`, 3.4.4 (the frozen `TransportDouble`) and 8
 * (`INV-A3-4`, `INV-A3-8`); frame envelope: docs/01-3 sections 3.1 and 3.3.
 *
 * The claim under test is deliberately narrow. The doubles must move the same
 * frame stream through two platform shapes and hand both an equal JSON copy;
 * they must preserve post order within one double; they must NOT be asserted to
 * agree on a global arrival order, because `R-06` makes their async granularity
 * intentionally different (microtask vs macrotask). The granularity test proves
 * that difference is real rather than a comment.
 *
 * No wall-clock waiting beyond one macrotask turn: `nextTurn` is a zero-delay
 * timer, which is also what the `postmessage` double itself uses.
 */

import { describe, expect, it } from "vitest";

import type { BridgeFrame, FrameChannel } from "../fixture";

import type { TransportDouble, TransportDoubleOptions, TransportRejection } from "./delivery";
import { createIpcDouble } from "./ipc";
import { createPostMessageDouble } from "./postmessage";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** One frame; `t` is a label only, because a double must not interpret it. */
function frame(
  channel: FrameChannel,
  seq: number,
  body: Record<string, unknown> = {},
): BridgeFrame {
  return { v: 1, ch: channel, seq, t: `test.${channel}`, body };
}

/** Wait one macrotask turn: enough for either double to drain. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Read one item, failing loudly instead of asserting against `undefined`. */
function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`expected an item at index ${index}, received ${items.length}`);
  }

  return item;
}

/** Short `channel#seq` labels, in arrival order. */
function labels(frames: readonly BridgeFrame[]): string[] {
  return frames.map((entry) => `${entry.ch}#${entry.seq}`);
}

type DoubleFactory = (options?: TransportDoubleOptions) => TransportDouble;

const DOUBLES: Array<{ name: TransportDouble["name"]; create: DoubleFactory }> = [
  { name: "ipc", create: createIpcDouble },
  { name: "postmessage", create: createPostMessageDouble },
];

/** A double plus the two things a test can observe without a mock framework. */
type Recording = {
  double: TransportDouble;
  frames: BridgeFrame[];
  rejected: TransportRejection[];
};

/** Build one recording double. */
function record(create: DoubleFactory): Recording {
  const frames: BridgeFrame[] = [];
  const rejected: TransportRejection[] = [];
  const double = create({ onReject: (rejection) => rejected.push(rejection) });

  double.onFrame((received) => frames.push(received));

  return { double, frames, rejected };
}

/* ------------------------------------------------------------------ */
/* the rules both doubles share                                        */
/* ------------------------------------------------------------------ */

describe.each(DOUBLES)("$name double", ({ create }) => {
  it("delivers every frame after a JSON round trip, with no shared references", async () => {
    const source = [
      frame("control", 1, { hello: "world" }),
      frame("stream", 2, { delta: "a" }),
      frame("bulk", 1, { pages: [1, 2] }),
    ];
    const { double, frames, rejected } = record(create);

    source.forEach((entry) => double.post(entry));
    await nextTurn();

    expect(rejected).toEqual([]);
    expect(frames).toEqual(source);

    for (const [index, delivered] of frames.entries()) {
      const original = itemAt(source, index);

      expect(delivered).not.toBe(original);
      expect(delivered.body).not.toBe(original.body);
    }
  });

  it("copies at post time, so a caller mutation cannot reach the consumer", async () => {
    const source = frame("stream", 1, { text: "original" });
    const { double, frames } = record(create);

    double.post(source);
    source.body.text = "mutated";
    source.seq = 99;
    await nextTurn();

    expect(labels(frames)).toEqual(["stream#1"]);
    expect(itemAt(frames, 0).body).toEqual({ text: "original" });
  });

  it("keeps post order across channels and never sorts by seq", async () => {
    const posted = [
      frame("control", 3),
      frame("stream", 1),
      frame("control", 1),
      frame("stream", 2),
      frame("bulk", 1),
    ];
    const { double, frames } = record(create);

    posted.forEach((entry) => double.post(entry));
    await nextTurn();

    expect(labels(frames)).toEqual(["control#3", "stream#1", "control#1", "stream#2", "bulk#1"]);
    // The control subsequence descends in seq on purpose: a double that sorted
    // by seq would turn [3, 1] into [1, 3].
    expect(frames.filter((entry) => entry.ch === "control").map((entry) => entry.seq)).toEqual([
      3, 1,
    ]);
  });

  it("rejects malformed frames at post time with a reason and never delivers them", async () => {
    const malformed: Array<{ label: string; field: string; value: unknown }> = [
      { label: "missing v", field: '"v"', value: { ch: "control", seq: 1, t: "x", body: {} } },
      {
        label: "wrong v",
        field: '"v"',
        value: { v: 2, ch: "control", seq: 1, t: "x", body: {} },
      },
      { label: "missing ch", field: '"ch"', value: { v: 1, seq: 1, t: "x", body: {} } },
      {
        label: "unknown ch",
        field: '"ch"',
        value: { v: 1, ch: "diagnostics", seq: 1, t: "x", body: {} },
      },
      { label: "missing seq", field: '"seq"', value: { v: 1, ch: "control", t: "x", body: {} } },
      {
        label: "fractional seq",
        field: '"seq"',
        value: { v: 1, ch: "control", seq: 1.5, t: "x", body: {} },
      },
      { label: "missing t", field: '"t"', value: { v: 1, ch: "control", seq: 1, body: {} } },
      {
        label: "empty t",
        field: '"t"',
        value: { v: 1, ch: "control", seq: 1, t: "", body: {} },
      },
      { label: "missing body", field: '"body"', value: { v: 1, ch: "control", seq: 1, t: "x" } },
      {
        label: "non-object body",
        field: '"body"',
        value: { v: 1, ch: "control", seq: 1, t: "x", body: "text" },
      },
    ];
    const { double, frames, rejected } = record(create);

    for (const entry of malformed) {
      double.post(entry.value as BridgeFrame);
    }

    expect(rejected).toHaveLength(malformed.length);

    malformed.forEach((entry, index) => {
      const reason = itemAt(rejected, index).reason;

      expect(reason, entry.label).toContain("malformed frame");
      expect(reason, entry.label).toContain(entry.field);
    });

    // A rejection happens at post time and never schedules a delivery.
    await nextTurn();
    expect(frames).toEqual([]);
  });

  it("rejects a lossy JSON round trip instead of silently dropping a field", async () => {
    const lossy: Array<{ label: string; value: BridgeFrame }> = [
      { label: "undefined property", value: frame("stream", 1, { note: undefined }) },
      { label: "NaN", value: frame("stream", 1, { value: Number.NaN }) },
      { label: "Infinity", value: frame("stream", 1, { value: Number.POSITIVE_INFINITY }) },
      { label: "Date", value: frame("stream", 1, { when: new Date("2024-01-01T00:00:00.000Z") }) },
      { label: "Map", value: frame("stream", 1, { labels: new Map([["a", 1]]) }) },
      // `-0 === 0` and `every` skips holes, so both of these used to pass the
      // round-trip check and reach the double as a modified frame.
      { label: "negative zero", value: frame("stream", 1, { n: -0 }) },
      { label: "sparse array", value: frame("stream", 1, { list: [, "a"] as unknown[] }) },
    ];
    const { double, frames, rejected } = record(create);

    for (const entry of lossy) {
      double.post(entry.value);
    }

    expect(rejected).toHaveLength(lossy.length);

    lossy.forEach((entry, index) => {
      const reason = itemAt(rejected, index).reason;

      expect(reason, entry.label).toContain("not JSON-serialisable");
      expect(reason, entry.label).toContain("round trip");
    });

    // A cycle cannot even reach the round-trip comparison: stringify throws.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    double.post(frame("stream", 1, cyclic));

    expect(rejected).toHaveLength(lossy.length + 1);
    expect(itemAt(rejected, lossy.length).reason).toContain("not JSON-serialisable");

    await nextTurn();
    expect(frames).toEqual([]);
  });

  it("stops delivery at close and rejects every later post", async () => {
    const { double, frames, rejected } = record(create);

    double.post(frame("control", 1));
    double.close();
    await nextTurn();

    expect(frames).toEqual([]);

    double.post(frame("control", 2));

    expect(rejected).toHaveLength(1);
    expect(itemAt(rejected, 0).reason).toContain("closed");

    await nextTurn();
    expect(frames).toEqual([]);

    // Closing twice is harmless.
    double.close();
  });

  it("stops delivery for one unsubscribed listener without closing", async () => {
    const { double, frames } = record(create);
    const unseen: BridgeFrame[] = [];
    const unsubscribe = double.onFrame((received) => unseen.push(received));

    unsubscribe();
    double.post(frame("control", 1));
    await nextTurn();

    expect(labels(frames)).toEqual(["control#1"]);
    expect(unseen).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* the difference the two granularities make                           */
/* ------------------------------------------------------------------ */

describe("async granularity", () => {
  it("delivers one back-to-back pair a microtask on ipc and a macrotask on postmessage", async () => {
    const ipc = record(createIpcDouble);
    const postmessage = record(createPostMessageDouble);
    const pair = [frame("control", 1), frame("stream", 1)];

    for (const entry of pair) {
      ipc.double.post(entry);
      postmessage.double.post(entry);
    }

    // One microtask turn is enough for `queueMicrotask`, not for `setTimeout`.
    await Promise.resolve();

    expect(labels(ipc.frames)).toEqual(["control#1", "stream#1"]);
    expect(postmessage.frames).toEqual([]);

    await nextTurn();

    expect(labels(postmessage.frames)).toEqual(["control#1", "stream#1"]);
    expect(postmessage.frames).toEqual(ipc.frames);
    expect(itemAt(postmessage.frames, 0)).not.toBe(itemAt(ipc.frames, 0));
  });

  it("lets cross-double arrival order differ from the order the frames were posted", async () => {
    const arrival: string[] = [];
    const ipc = createIpcDouble();
    const postmessage = createPostMessageDouble();

    ipc.onFrame((received) => arrival.push(`ipc:${received.ch}`));
    postmessage.onFrame((received) => arrival.push(`postmessage:${received.ch}`));

    // Post-message is posted first, yet its timer runs after the IPC microtask.
    postmessage.post(frame("bulk", 1));
    ipc.post(frame("control", 1));

    await Promise.resolve();
    expect(arrival).toEqual(["ipc:control"]);

    await nextTurn();
    expect(arrival).toEqual(["ipc:control", "postmessage:bulk"]);

    // Only per-double order is guaranteed; the interleaving above must not be
    // read as a global ordering rule.
    expect(arrival).not.toEqual(["postmessage:bulk", "ipc:control"]);
  });
});

/* ------------------------------------------------------------------ */
/* platform shapes                                                     */
/* ------------------------------------------------------------------ */

describe("platform shapes", () => {
  it("exposes the frozen names", () => {
    expect(createIpcDouble().name).toBe("ipc");
    expect(createPostMessageDouble().name).toBe("postmessage");
  });

  it("delivers through ipc send(channel, payload) like ipcRenderer.send", async () => {
    const frames: BridgeFrame[] = [];
    const rejected: TransportRejection[] = [];
    const double = createIpcDouble({ onReject: (rejection) => rejected.push(rejection) });

    double.onFrame((received) => frames.push(received));
    double.send("bridge", frame("control", 1));
    await nextTurn();

    expect(rejected).toEqual([]);
    expect(labels(frames)).toEqual(["control#1"]);
  });

  it("rejects an empty ipc channel without delivering the payload", async () => {
    const frames: BridgeFrame[] = [];
    const rejected: TransportRejection[] = [];
    const double = createIpcDouble({ onReject: (rejection) => rejected.push(rejection) });

    double.onFrame((received) => frames.push(received));
    double.send("", frame("control", 1));

    expect(rejected).toHaveLength(1);
    expect(itemAt(rejected, 0).reason).toContain("channel");

    await nextTurn();
    expect(frames).toEqual([]);
  });

  it("delivers through postMessage(frame) like a webview message post", async () => {
    const frames: BridgeFrame[] = [];
    const double = createPostMessageDouble();

    double.onFrame((received) => frames.push(received));
    double.postMessage(frame("bulk", 1));
    await nextTurn();

    expect(labels(frames)).toEqual(["bulk#1"]);
  });
});
