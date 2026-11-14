/**
 * A terminal stream's last slice is short, and it must still arrive.
 *
 * The criterion is not "slices are not lost" in the abstract -- that is what
 * every other sender test already shows. It is the specific shape a fixed-size
 * slice stream produces: a whole number of full slices followed by one short
 * remainder. A producer that flushes only on a full buffer, or a batching window
 * that treats "short" as "incomplete", drops exactly that final piece, and the
 * terminal then renders output that simply stops a few hundred bytes early.
 *
 * The corpus (`fixtures/bridge/term-output.jsonl`) carries the real shape: one
 * 20480-byte stream cut into 8192 / 8192 / 4096. This test drives those frames
 * through the sender and asserts the last one reaches the transport.
 *
 * Why through the sender and not the renderer entry
 *   The renderer entry receives frames; it cannot drop one for being short --
 *   it has no buffer to flush. The loss, if it happens, happens on the way out.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createFrameSender } from "./sender.js";
import type { Frame } from "@haruyuki/protocol";

// From packages/core/src/bridge up to the repository root: four levels.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const CORPUS = path.join(REPO_ROOT, "fixtures", "bridge", "term-output.jsonl");

/** One parsed corpus line, as `unknown` until narrowed. */
type UnknownRecord = Record<string, unknown>;

/**
 * Read the corpus and return its frame lines, header excluded.
 *
 * @returns frame-shaped records in file order
 */
function readFrames(): UnknownRecord[] {
  const text = readFileSync(CORPUS, "utf8");
  const lines = text.split("\n").filter((line) => line.trim() !== "");

  return lines.slice(1).map((line) => JSON.parse(line) as UnknownRecord);
}

/** A set containing exactly the types this corpus uses. */
const CORPUS_TYPES = new Set([
  "bridge.ready",
  "bridge.accept",
  "bridge.reject",
  "bulk.page",
  "term.output",
]);

describe("the short final slice of a terminal stream still arrives", () => {
  it("sends every slice, including the 4096-byte last one", () => {
    const frames = readFrames();
    const terminal = frames.filter((frame) => frame["t"] === "term.output");

    expect(terminal).toHaveLength(3);

    /** Every payload the transport was handed, parsed back. */
    const delivered: UnknownRecord[] = [];

    const sender = createFrameSender({
      transport: (payload) => {
        delivered.push(JSON.parse(payload) as UnknownRecord);
      },
      frameTypes: CORPUS_TYPES,
    });

    try {
      for (const frame of frames) {
        sender.send(frame as unknown as Frame);
      }

      sender.flush();
    } finally {
      sender.close();
    }

    const outputSlices = delivered.filter((frame) => frame["t"] === "term.output");

    expect(outputSlices).toHaveLength(3);

    // The claim: the short remainder is delivered, and delivered last.
    const bodies = outputSlices.map((frame) => frame["body"] as UnknownRecord);
    const byteCounts = bodies.map((body) => body["bytes"]);

    expect(byteCounts).toEqual([8192, 8192, 4096]);
    expect(bodies[2]?.["final"]).toBe(true);

    // The stream is contiguous: slice n starts where slice n-1 ended. A dropped
    // slice would leave a gap here even if the count happened to match.
    const offsets = bodies.map((body) => body["offset"]);

    expect(offsets).toEqual([0, 8192, 16384]);

    let expected = 0;

    for (const body of bodies) {
      expect(body["offset"]).toBe(expected);
      expected += body["bytes"] as number;
    }

    expect(expected).toBe(20480);
  });

  it("keeps the final slice even when it is the only one flushed explicitly", () => {
    const terminal = readFrames().filter((frame) => frame["t"] === "term.output");
    const last = terminal[2];

    expect(last).toBeDefined();

    const delivered: UnknownRecord[] = [];

    const sender = createFrameSender({
      transport: (payload) => {
        delivered.push(JSON.parse(payload) as UnknownRecord);
      },
      frameTypes: CORPUS_TYPES,
    });

    try {
      // Only the short remainder goes through. A window that waits for a full
      // buffer would hold it forever; `stream` must not be batched at all.
      sender.send(last as unknown as Frame);
    } finally {
      sender.close();
    }

    expect(delivered).toHaveLength(1);
    expect((delivered[0]?.["body"] as UnknownRecord)["bytes"]).toBe(4096);
  });
});
