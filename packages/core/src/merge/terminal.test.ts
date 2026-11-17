/**
 * Tests for the terminal output mapper.
 *
 * The interesting failures are not "the text is dropped" but "the text is
 * damaged": a slice cut inside a three-byte character or a four-byte emoji
 * decodes to U+FFFD, and the stream then looks complete while a character has
 * silently become something else. So the assertions are: every slice is at
 * most the wire limit, the pieces concatenate back to the input verbatim,
 * re-decoding each piece is lossless, and exactly one piece is `final`.
 *
 * The 1 MB case is the size the shell actually forwards; the multi-byte cases
 * exist because a byte counter that is not code-point aware passes the ASCII
 * case and fails these.
 */

import { describe, expect, it } from "vitest";

import type { Frame } from "@haruyuki/protocol";

import type { EnvelopeFacts } from "./envelope.js";
import { terminalFramesOf } from "./terminal.js";
import type { TerminalSliceBody } from "./terminal.js";
import { TERM_SLICE_BYTES } from "./types.js";

/** Envelope facts; the mapper is expected to ignore them. */
function facts(): EnvelopeFacts {
  return {
    seq: 7,
    idempotencyKey: null,
    runtimeAgentId: "runtime-main",
    conversationId: "conversation-1",
    authorAgentId: "author-1",
    subagentId: null,
    at: 42,
  };
}

/**
 * Read a slice body.
 *
 * The protocol's `Frame` leaves `body` as `unknown` on purpose, so a consumer
 * has to narrow before reading. These tests narrow to the shape the mapper
 * promises; asserting on the real frames is the point, so no second declaration
 * of the frame exists here.
 */
function bodyOf(frame: Frame<"term.output">): TerminalSliceBody {
  return frame.body as TerminalSliceBody;
}

/** The frames for one `terminal_output` payload. */
function framesFor(data: string): readonly Frame<"term.output">[] {
  return terminalFramesOf(
    "terminal_output",
    { type: "terminal_output", terminal_id: "terminal-1", data },
    facts(),
  );
}

describe("terminalFramesOf slicing", () => {
  it("slices 1 MB of ASCII into full slices whose text joins back to the input", () => {
    const text = "a".repeat(1024 * 1024);
    const frames = framesFor(text);
    const bodies = frames.map(bodyOf);

    expect(frames).toHaveLength((1024 * 1024) / TERM_SLICE_BYTES);

    for (const body of bodies) {
      expect(body.terminal_id).toBe("terminal-1");
      expect(body.bytes).toBeLessThanOrEqual(TERM_SLICE_BYTES);
      expect(body.bytes).toBe(body.text.length);
      expect(body.slices).toBe(frames.length);
    }

    expect(bodies.map((body) => body.text).join("")).toBe(text);
    expect(bodies.map((body) => body.offset)).toEqual(
      bodies.map((_, index) => index * TERM_SLICE_BYTES),
    );
    expect(bodies.filter((body) => body.final)).toHaveLength(1);
    expect(bodies.at(0)?.final).toBe(false);
    expect(bodies.at(-1)?.final).toBe(true);
  });

  it("leaves the sequence to the sender and numbers the slices from zero", () => {
    const frames = framesFor("abc");

    expect(frames).toHaveLength(1);
    expect(frames.at(0)).toMatchObject({ v: 1, ch: "stream", seq: 0, t: "term.output" });
    expect(frames.map(bodyOf).at(0)).toMatchObject({
      slice: 0,
      slices: 1,
      offset: 0,
      bytes: 3,
      final: true,
      text: "abc",
    });
  });

  it("repeats the terminal id and the total on every slice", () => {
    const bodies = framesFor("x".repeat(TERM_SLICE_BYTES * 2 + 1)).map(bodyOf);

    expect(bodies).toHaveLength(3);
    expect(bodies.map((body) => body.terminal_id)).toEqual([
      "terminal-1",
      "terminal-1",
      "terminal-1",
    ]);
    expect(bodies.map((body) => body.slices)).toEqual([3, 3, 3]);
    expect(bodies.map((body) => body.slice)).toEqual([0, 1, 2]);
    expect(bodies.map((body) => body.bytes)).toEqual([TERM_SLICE_BYTES, TERM_SLICE_BYTES, 1]);
  });

  it("moves a character to the next slice rather than splitting it", () => {
    const head = "a".repeat(TERM_SLICE_BYTES - 1);
    const text = `${head}中b`;
    const bodies = framesFor(text).map(bodyOf);

    expect(bodies).toHaveLength(2);
    expect(bodies.at(0)?.bytes).toBe(TERM_SLICE_BYTES - 1);
    expect(bodies.at(0)?.text).toBe(head);
    expect(bodies.at(0)?.final).toBe(false);
    expect(bodies.at(1)?.text).toBe("中b");
    expect(bodies.at(1)?.bytes).toBe(4);
    expect(bodies.at(1)?.offset).toBe(TERM_SLICE_BYTES - 1);
    expect(bodies.at(1)?.final).toBe(true);
    expect(bodies.map((body) => body.text).join("")).toBe(text);
  });

  it("keeps three-byte characters whole and losslessly decodable", () => {
    const text = "中文终端".repeat(3000);
    const bodies = framesFor(text).map(bodyOf);

    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.map((body) => body.text).join("")).toBe(text);
    expect(text).not.toContain("\uFFFD");

    for (const body of bodies) {
      expect(body.bytes).toBeLessThanOrEqual(TERM_SLICE_BYTES);
      expect(body.bytes).toBe(Buffer.byteLength(body.text, "utf8"));
      expect(body.bytes % 3).toBe(0);
      expect(Buffer.from(body.text, "utf8").toString("utf8")).toBe(body.text);
    }
  });

  it("keeps four-byte emoji whole and losslessly decodable", () => {
    const text = "🙂".repeat(5000);
    const bodies = framesFor(text).map(bodyOf);

    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.map((body) => body.text).join("")).toBe(text);

    for (const body of bodies) {
      expect(body.bytes).toBeLessThanOrEqual(TERM_SLICE_BYTES);
      expect(body.bytes).toBe(Buffer.byteLength(body.text, "utf8"));
      expect(body.bytes % 4).toBe(0);
      expect(Buffer.from(body.text, "utf8").toString("utf8")).toBe(body.text);
    }
  });
});

describe("terminalFramesOf dropping", () => {
  it("returns nothing without a terminal id", () => {
    expect(terminalFramesOf("terminal_output", { data: "x" }, facts())).toEqual([]);
  });

  it("treats an empty terminal id as missing", () => {
    expect(terminalFramesOf("terminal_output", { terminal_id: "", data: "x" }, facts())).toEqual(
      [],
    );
  });

  it("returns nothing when data is absent, empty or not a string", () => {
    expect(terminalFramesOf("terminal_output", { terminal_id: "t-1" }, facts())).toEqual([]);
    expect(terminalFramesOf("terminal_output", { terminal_id: "t-1", data: "" }, facts())).toEqual(
      [],
    );
    expect(terminalFramesOf("terminal_output", { terminal_id: "t-1", data: 42 }, facts())).toEqual(
      [],
    );
  });

  it("returns nothing when the payload is not a record", () => {
    expect(terminalFramesOf("terminal_output", null, facts())).toEqual([]);
    expect(terminalFramesOf("terminal_output", "terminal_output", facts())).toEqual([]);
    expect(terminalFramesOf("terminal_output", undefined, facts())).toEqual([]);
  });

  it("ignores terminal lifecycle events", () => {
    const payload = { terminal_id: "t-1", data: "spawned" };

    expect(terminalFramesOf("terminal_spawned", payload, facts())).toEqual([]);
    expect(terminalFramesOf("terminal_exited", payload, facts())).toEqual([]);
  });

  it("ignores any other event type, even a terminal-shaped payload", () => {
    const payload = { terminal_id: "t-1", data: "queued" };

    expect(terminalFramesOf("update_queue", payload, facts())).toEqual([]);
    expect(terminalFramesOf("", payload, facts())).toEqual([]);
  });
});
