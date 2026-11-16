/**
 * Tests for the bounded stderr tail.
 *
 * The class is deliberately independent of Electron and of the engine facade:
 * the caps are the whole contract, and they are easy to get wrong at the edges
 * (a partial line, a single line larger than the byte budget, a chunk with
 * several lines).
 */

import { describe, expect, it } from "vitest";

import { StderrTail } from "./stderr-tail";

describe("StderrTail", () => {
  it("keeps only the configured number of lines", () => {
    const tail = new StderrTail({ maxLines: 2 });

    tail.push("one\ntwo\nthree\n");

    expect(tail.snapshot()).toEqual(["two", "three"]);
  });

  it("reports a trailing partial line instead of dropping it", () => {
    const tail = new StderrTail();

    tail.push("first\nsecond");

    expect(tail.snapshot()).toEqual(["first", "second"]);
  });

  it("drops the oldest line when the byte budget is exceeded", () => {
    const tail = new StderrTail({ maxBytes: 4 });

    tail.push("abc\nde\n");

    expect(tail.snapshot()).toEqual(["de"]);
  });

  it("returns the last N lines when a limit is supplied", () => {
    const tail = new StderrTail();

    tail.push("a\nb\nc\n");

    expect(tail.snapshot(1)).toEqual(["c"]);
    expect(tail.snapshot(2)).toEqual(["b", "c"]);
  });

  it("clears all state", () => {
    const tail = new StderrTail();

    tail.push("a\nb\n");
    tail.clear();

    expect(tail.snapshot()).toEqual([]);
  });
});
