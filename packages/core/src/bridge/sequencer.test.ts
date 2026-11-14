/**
 * Tests for the global sequence issuer (C5).
 *
 * The claim under test is narrow and load-bearing: `seq` is a total order over
 * every frame this process emits, produced by exactly one counter, so a
 * consumer can compare the number of any two frames whatever channel or sender
 * they came from. Every case below exists because a different design (one
 * counter per sender, per channel, or per import) would pass the obvious
 * "increases" test and still be wrong -- the renderer would classify frames it
 * has not seen as stale after a restart.
 *
 * The overflow case is driven through `setSeqForTesting`: reaching
 * `Number.MAX_SAFE_INTEGER` by calling `nextSeq` is not something a test can do,
 * and an untestable branch is a branch that rots.
 */

import { afterEach, describe, expect, it } from "vitest";

import { currentSeq, nextSeq, resetSeq, setSeqForTesting } from "./sequencer";

/** Reset between cases: the counter is module state by design. */
afterEach(() => {
  resetSeq();
});

describe("nextSeq", () => {
  it("starts at 1 and increases by exactly one", () => {
    resetSeq();

    expect(nextSeq()).toBe(1);
    expect(nextSeq()).toBe(2);
    expect(nextSeq()).toBe(3);
  });

  it("never repeats a number over a long run", () => {
    resetSeq();

    const issued: number[] = [];

    for (let index = 0; index < 1000; index += 1) {
      issued.push(nextSeq());
    }

    expect(issued).toEqual(Array.from({ length: 1000 }, (_unused, index) => index + 1));
    expect(new Set(issued).size).toBe(issued.length);
  });

  it("hands out one shared range across different call sites", () => {
    resetSeq();

    // Two independent producers of different channels, each with its own local
    // notion of "the last frame I sent". A per-sender counter would give both
    // of them 1, 2, 3; the single issuer gives the renderer one total order.
    const controlSender = (): number => nextSeq();
    const bulkSender = (): number => nextSeq();

    const interleaved = [
      controlSender(),
      bulkSender(),
      controlSender(),
      bulkSender(),
      controlSender(),
    ];

    expect(interleaved).toEqual([1, 2, 3, 4, 5]);
  });

  it("shares one counter with a second importer of this module", async () => {
    resetSeq();
    expect(nextSeq()).toBe(1);

    // A separate module instance (which a bundler duplicate, a re-implemented
    // counter or a per-sender issuer would create) would start again at 1.
    const secondImporter = await import("./sequencer");

    expect(secondImporter.nextSeq).toBe(nextSeq);
    expect(secondImporter.nextSeq()).toBe(2);
    expect(currentSeq()).toBe(2);
  });

  it("emits only safe integers", () => {
    resetSeq();

    for (let index = 0; index < 10; index += 1) {
      expect(Number.isSafeInteger(nextSeq())).toBe(true);
    }
  });
});

describe("currentSeq", () => {
  it("is 0 before anything has been issued", () => {
    resetSeq();

    expect(currentSeq()).toBe(0);
  });

  it("reads the last issued number without issuing one", () => {
    resetSeq();
    nextSeq();
    nextSeq();

    expect(currentSeq()).toBe(2);
    expect(currentSeq()).toBe(2);
    expect(nextSeq()).toBe(3);
  });
});

describe("resetSeq", () => {
  it("returns the issuer to its initial state", () => {
    resetSeq();
    nextSeq();
    nextSeq();

    resetSeq();

    expect(currentSeq()).toBe(0);
    expect(nextSeq()).toBe(1);
  });

  it("is idempotent", () => {
    resetSeq();
    resetSeq();

    expect(currentSeq()).toBe(0);
  });
});

describe("overflow at Number.MAX_SAFE_INTEGER", () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  it("issues the ceiling itself and then throws", () => {
    resetSeq();
    setSeqForTesting(MAX - 1);

    expect(nextSeq()).toBe(MAX);
    expect(currentSeq()).toBe(MAX);
    expect(() => nextSeq()).toThrow(RangeError);
  });

  it("throws rather than wrapping or clamping, and keeps the last number", () => {
    resetSeq();
    setSeqForTesting(MAX);

    expect(() => nextSeq()).toThrow(RangeError);
    expect(currentSeq()).toBe(MAX);

    // Still exhausted: the failed call must not have half-advanced the counter,
    // and a second attempt must not sneak the number MAX + 1 out.
    expect(() => nextSeq()).toThrow(RangeError);
    expect(currentSeq()).toBe(MAX);
  });

  it("is recoverable only through an explicit reset", () => {
    resetSeq();
    setSeqForTesting(MAX);
    expect(() => nextSeq()).toThrow(RangeError);

    resetSeq();

    expect(currentSeq()).toBe(0);
    expect(nextSeq()).toBe(1);
  });
});

describe("setSeqForTesting", () => {
  it("records a valid position", () => {
    resetSeq();
    setSeqForTesting(41);

    expect(currentSeq()).toBe(41);
    expect(nextSeq()).toBe(42);
  });

  it("accepts 0", () => {
    resetSeq();
    setSeqForTesting(0);

    expect(currentSeq()).toBe(0);
    expect(nextSeq()).toBe(1);
  });

  it("rejects a position a real run could never produce, and keeps the old one", () => {
    resetSeq();
    setSeqForTesting(7);

    for (const invalid of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(() => setSeqForTesting(invalid)).toThrow(RangeError);
      expect(currentSeq()).toBe(7);
    }
  });
});
