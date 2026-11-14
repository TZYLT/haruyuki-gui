/**
 * Tests for the reference frame reducer (contract, self-proof for `A3-Q02`).
 *
 * Requirement source: docs/17-A3 sections 4.3 and 6.5; contract source:
 * docs/18-A3 section 3.4.4 and section 7 `A3-Q02`; frame and channel rules:
 * docs/01-3 sections 3.1-3.3.
 *
 * The reducer is a comparison aid, so the cases pin exactly the three
 * statements the bridge makes: same-channel order, overwrite-style `state.*`,
 * and bulk pages appended in arrival order. The last case proves the fold does
 * not depend on cross-channel interleaving, which `INV-A3-8` says the bridge
 * does not guarantee.
 */

import { describe, expect, it } from "vitest";

import type { BridgeFrame, FrameChannel } from "./fixture";
import { reduce } from "./reducer";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** One frame; `t` is only ever a label here. */
function frame(
  channel: FrameChannel,
  seq: number,
  t: string,
  body: Record<string, unknown> = {},
): BridgeFrame {
  return { v: 1, ch: channel, seq, t, body };
}

/** `channel#seq` labels of one frame list. */
function labels(frames: readonly BridgeFrame[]): string[] {
  return frames.map((entry) => `${entry.ch}#${entry.seq}`);
}

/** Deep-freeze a frame list so an accidental mutation throws in strict mode. */
function frozen(frames: BridgeFrame[]): readonly BridgeFrame[] {
  for (const entry of frames) {
    Object.freeze(entry.body);
    Object.freeze(entry);
  }

  return Object.freeze(frames);
}

/* ------------------------------------------------------------------ */
/* channel semantics                                                   */
/* ------------------------------------------------------------------ */

describe("reduce", () => {
  it("keeps control as a log and bulk pages in arrival order", () => {
    const state = reduce([
      frame("control", 1, "bridge.ready", { appVersion: "0.1.0" }),
      frame("bulk", 1, "bulk.page", { page: 1 }),
      frame("control", 2, "approval.request", { id: "a-1" }),
      frame("bulk", 2, "bulk.page", { page: 2 }),
      frame("control", 3, "approval.response", { id: "a-1" }),
    ]);

    expect(labels(state.control)).toEqual(["control#1", "control#2", "control#3"]);
    expect(labels(state.bulk)).toEqual(["bulk#1", "bulk#2"]);
    expect(state.stream).toEqual([]);
    expect(state.state).toEqual({});
  });

  it("folds state.* by overwrite and drops the intermediate body", () => {
    const state = reduce([
      frame("stream", 1, "state.queue", { pending: 0 }),
      frame("stream", 2, "state.queue", { pending: 1 }),
      frame("stream", 3, "state.queue", { pending: 2 }),
    ]);

    expect(state.state).toEqual({ queue: { pending: 2 } });
    // Folded state frames are not also kept as stream log entries.
    expect(state.stream).toEqual([]);
  });

  it("replaces the whole body instead of deep-merging it", () => {
    const state = reduce([
      frame("stream", 1, "state.queue", { pending: 1, items: ["a"] }),
      frame("stream", 2, "state.queue", { pending: 2 }),
    ]);

    expect(state.state).toEqual({ queue: { pending: 2 } });
  });

  it("keeps separate state keys and strips only the frozen prefix", () => {
    const state = reduce([
      frame("stream", 1, "state.queue", { pending: 0 }),
      frame("stream", 2, "state.approval", { pending: "a-1" }),
      // "statement" starts with "state" but not with "state."; it stays a log.
      frame("stream", 3, "statement.ready", { text: "x" }),
    ]);

    expect(state.state).toEqual({
      queue: { pending: 0 },
      approval: { pending: "a-1" },
    });
    expect(labels(state.stream)).toEqual(["stream#3"]);
  });

  it("keeps non-state stream frames in arrival order", () => {
    const state = reduce([
      frame("stream", 1, "delta.message", { index: 1 }),
      frame("stream", 2, "tool.state", { running: true }),
      frame("stream", 3, "delta.message", { index: 2 }),
    ]);

    expect(labels(state.stream)).toEqual(["stream#1", "stream#2", "stream#3"]);
    expect(state.stream.map((entry) => entry.t)).toEqual([
      "delta.message",
      "tool.state",
      "delta.message",
    ]);
  });

  it("does not depend on cross-channel interleaving (INV-A3-8)", () => {
    const control = [frame("control", 1, "bridge.ready"), frame("control", 2, "ping")];
    const stream = [
      frame("stream", 1, "delta.message", { text: "a" }),
      frame("stream", 2, "state.queue", { pending: 0 }),
      frame("stream", 3, "delta.message", { text: "b" }),
    ];
    const bulk = [
      frame("bulk", 1, "bulk.page", { page: 1 }),
      frame("bulk", 2, "bulk.page", { page: 2 }),
    ];

    const interleavingOne = [
      control[0],
      stream[0],
      bulk[0],
      control[1],
      stream[1],
      stream[2],
      bulk[1],
    ];
    const interleavingTwo = [
      stream[0],
      bulk[0],
      control[0],
      bulk[1],
      stream[1],
      control[1],
      stream[2],
    ];
    const first = reduce(interleavingOne as BridgeFrame[]);
    const second = reduce(interleavingTwo as BridgeFrame[]);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(labels(first.stream)).toEqual(["stream#1", "stream#3"]);
    expect(first.state).toEqual({ queue: { pending: 0 } });
  });

  it("keeps state.__proto__ as data instead of writing the prototype", () => {
    // `folded["__proto__"] = body` would set the prototype: the frame then has no
    // own key, disappears from Object.keys and from the JSON view, and the body
    // lands on the prototype chain of the reducer's own output.
    const folded = reduce([frame("stream", 1, "state.__proto__", { pending: 1 })] as BridgeFrame[]);

    // An object literal `{ __proto__: ... }` would set a prototype too, so the
    // assertions are about the keys and the prototype, not about a literal.
    expect(Object.keys(folded.state)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(folded.state)).toBe(Object.prototype);
    expect(folded.state["__proto__"]).toEqual({ pending: 1 });
  });

  it("is pure: frozen input is accepted and the same input folds identically", () => {
    const frames = frozen([
      frame("control", 1, "bridge.ready"),
      frame("stream", 1, "state.queue", { pending: 0 }),
      frame("bulk", 1, "bulk.page", { page: 1 }),
    ]);

    const first = reduce(frames);
    const second = reduce(frames);

    expect(second).toEqual(first);
    // The fold shares frame references, but it never writes through them.
    expect(first.control[0]).toBe(frames[0]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
