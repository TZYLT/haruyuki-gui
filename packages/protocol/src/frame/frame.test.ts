/**
 * Contract tests for the frame layer.
 *
 * This is the cheap tripwire for the wire envelope: a later item that widens a
 * channel union, drops a `FRAME_TYPES` column or writes a non-English summary
 * fails here, before a renderer or the core ever meets the frame on a socket.
 * Three kinds of check are mixed on purpose:
 *
 * - compile-time, via `satisfies` and exhaustive `Record` tables, so a missing
 *   or extra member is a type error at the exact line that drifted;
 * - runtime, over `Object.entries`, so the values are verified too, not only
 *   their declared types;
 * - construction, so the discriminated union is proven usable from both sides
 *   and a consumer can assign either channel to the plain `Frame`.
 *
 * The frame type literals below are all rows of `FRAME_TYPES` on purpose. The
 * gate does NOT require it: `scripts/check-frame.mjs` skips `*.test.ts(x)`,
 * because a test legitimately writes literals nobody should register. Using real
 * rows here keeps the example frames honest, and it is a convention this file
 * keeps for its own readers rather than a rule the gate enforces.
 */

import { describe, expect, it } from "vitest";

import { FRAME_PROTOCOL_VERSION } from "./frame.js";
import { FRAME_TYPES } from "./frame-types.js";
import type { BulkFrame, ControlFrame, Frame, FrameChannel } from "./frame.js";
import type { FrameCoalescing, FrameTypeSpec, KnownFrameType } from "./frame-types.js";

/** The three legal channels, in contract order. */
const CHANNELS = ["control", "stream", "bulk"] as const;

/** The legal coalescing policies, in contract order. */
const COALESCING = ["never", "by-channel"] as const;

describe("FRAME_TYPES", () => {
  it("has at least one row, so the loops below inspect something", () => {
    expect(Object.keys(FRAME_TYPES).length).toBeGreaterThan(0);
  });

  it("covers every KnownFrameType exactly once", () => {
    // Compile-time: a row added without being listed here, or a listed key that
    // no longer exists, is a type error on this line.
    const covered: Record<KnownFrameType, true> = {
      "bridge.ready": true,
      "bridge.accept": true,
      "bridge.reject": true,
      "bulk.page": true,
      "term.output": true,
      "layout.snapshot": true,
    };

    // Runtime: the two sets must agree, which catches a table edited through a
    // spread or a computed key that the literal type above could not follow.
    expect(Object.keys(FRAME_TYPES).sort()).toEqual(Object.keys(covered).sort());
  });

  it("registers a channel that is one of the three legal channels", () => {
    for (const [type, spec] of Object.entries(FRAME_TYPES)) {
      expect(CHANNELS, `frame type ${type}`).toContain(spec.ch);
    }
  });

  it("declares a coalescing policy that is one of the two legal policies", () => {
    for (const [type, spec] of Object.entries(FRAME_TYPES)) {
      expect(COALESCING, `frame type ${type}`).toContain(spec.coalescible);
    }
  });

  it("carries all four columns on every row", () => {
    // The columns are required by `satisfies Record<string, FrameTypeSpec>`, so
    // this is a runtime second opinion: it also proves no row was written with
    // an undefined or inherited value.
    const columns = ["ch", "coalescible", "since", "summary"] as const;

    for (const [type, spec] of Object.entries(FRAME_TYPES)) {
      const row: FrameTypeSpec = spec;

      expect(Object.keys(row).sort(), `frame type ${type}`).toEqual([...columns].sort());

      for (const column of columns) {
        expect(row[column], `frame type ${type} column ${column}`).toBeTruthy();
      }
    }
  });

  it("names the work package that introduced every row", () => {
    for (const [type, spec] of Object.entries(FRAME_TYPES)) {
      expect(spec.since, `frame type ${type}`).toMatch(/^[A-Z]\d+$/);
    }
  });

  it("gives every row a non-empty English summary", () => {
    // The summary is printed in diagnostics and in the unknown-frame fallback,
    // so a blank or non-English one is a real defect rather than a nit.
    for (const [type, spec] of Object.entries(FRAME_TYPES)) {
      const summary = spec.summary.trim();

      expect(summary.length, `frame type ${type}`).toBeGreaterThan(0);
      expect(summary, `frame type ${type}`).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("keeps the summaries distinct, so diagnostics stay unambiguous", () => {
    const summaries = Object.values(FRAME_TYPES).map((spec) => spec.summary);

    expect(new Set(summaries).size).toBe(summaries.length);
  });

  it("pins the choices the frozen table makes", () => {
    // Deliberate: these are wire-visible decisions, so changing one is a
    // contract change and must fail here rather than silently ship.
    expect(FRAME_TYPES["bridge.ready"].ch).toBe("control");
    expect(FRAME_TYPES["bridge.accept"].ch).toBe("control");
    expect(FRAME_TYPES["bridge.reject"].ch).toBe("control");
    expect(FRAME_TYPES["bulk.page"].ch).toBe("bulk");
    expect(FRAME_TYPES["term.output"].ch).toBe("stream");

    for (const spec of Object.values(FRAME_TYPES)) {
      expect(spec.coalescible).toBe("never");
    }
  });
});

describe("FRAME_PROTOCOL_VERSION", () => {
  it("is 1", () => {
    expect(FRAME_PROTOCOL_VERSION).toBe(1);

    // Compile-time: the literal type, not only the runtime value.
    const version: 1 = FRAME_PROTOCOL_VERSION;

    expect(version).toBe(1);
  });
});

describe("Frame envelope", () => {
  it("constructs a control frame assignable to the plain envelope", () => {
    const control: ControlFrame<"bridge.ready", { bridge: string }> = {
      v: FRAME_PROTOCOL_VERSION,
      ch: "control",
      seq: 1,
      t: "bridge.ready",
      reqId: "req-1",
      body: { bridge: "1.0" },
    };

    const frame: Frame<"bridge.ready", { bridge: string }> = control;

    expect(frame.v).toBe(1);
    expect(frame.ch).toBe("control");
    expect(frame.seq).toBe(1);
    expect(control.reqId).toBe("req-1");
    expect(frame.body.bridge).toBe("1.0");
  });

  it("constructs a bulk frame assignable to the plain envelope", () => {
    const bulk: BulkFrame<"bulk.page", { rows: readonly string[] }> = {
      v: FRAME_PROTOCOL_VERSION,
      ch: "bulk",
      seq: 2,
      t: "bulk.page",
      page: { watermark: 0, token: "tok-1", more: true },
      body: { rows: ["a", "b"] },
    };

    const frame: Frame<"bulk.page", { rows: readonly string[] }> = bulk;

    expect(frame.ch).toBe("bulk");
    expect(bulk.page.watermark).toBe(0);
    expect(bulk.page.token).toBe("tok-1");
    expect(bulk.page.more).toBe(true);
    expect(frame.body.rows).toEqual(["a", "b"]);
  });

  it("narrows a discriminated union on the channel field", () => {
    // A host-injected type, built from a widened value on purpose: `Frame["t"]`
    // must accept a type this package does not know (C5-Q24), and the gate must
    // not see an unregistered literal in this file.
    const injectedType: string = "host.private";

    const injected: Frame = {
      v: FRAME_PROTOCOL_VERSION,
      ch: "stream",
      seq: 3,
      t: injectedType,
      body: { chunk: "x" },
    };

    const control: ControlFrame = {
      v: FRAME_PROTOCOL_VERSION,
      ch: "control",
      seq: 4,
      t: "bridge.accept",
      reqId: "req-2",
      body: { version: 1 },
    };

    const bulk: BulkFrame = {
      v: FRAME_PROTOCOL_VERSION,
      ch: "bulk",
      seq: 5,
      t: "bulk.page",
      page: { watermark: 10, token: "tok-2", more: false },
      body: null,
    };

    /** @param frame either concrete channel */
    function cursorOf(frame: ControlFrame | BulkFrame): string {
      if (frame.ch === "bulk") {
        return `${String(frame.page.watermark)}:${frame.page.token}`;
      }

      return frame.reqId;
    }

    expect(cursorOf(control)).toBe("req-2");
    expect(cursorOf(bulk)).toBe("10:tok-2");

    expect(injected.t).toBe("host.private");
    expect(injected.ch).toBe("stream");
    expect(CHANNELS).toContain(injected.ch);
  });

  it("keeps the frame type literal open to host-injected tables", () => {
    // Compile-time: `KnownFrameType` is narrower than what `Frame["t"]` accepts.
    const known: KnownFrameType = "term.output";
    const open: Frame["t"] = known;

    expect(open).toBe("term.output");
    expect(COALESCING).toContain(FRAME_TYPES[known].coalescible);
  });

  it("types a channel as the union of its three members", () => {
    // Compile-time: an exhaustive table over FrameChannel, so adding a channel
    // to the union without handling it here is a type error.
    const represented: Record<FrameChannel, true> = {
      control: true,
      stream: true,
      bulk: true,
    };

    expect(Object.keys(represented).sort()).toEqual([...CHANNELS].sort());
  });

  it("types coalescing as the union of its two members", () => {
    const represented: Record<FrameCoalescing, true> = {
      never: true,
      "by-channel": true,
    };

    expect(Object.keys(represented).sort()).toEqual([...COALESCING].sort());
  });
});
