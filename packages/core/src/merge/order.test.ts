/**
 * Tests for the ordering gate.
 *
 * Every case here is a statement about what the gate must do with a sequence
 * number it has never seen, so the assertions are made on the outcome of one
 * `accept` call and on the two pieces of state the merger reads back
 * (`watermark`, `buffered`):
 *
 * - an in-order frame is delivered immediately;
 * - a repeat is reported as a duplicate and delivered once;
 * - a hole is buffered, and a bounded buffer eventually gives up on it, which
 *   is the only way a stalled stream moves again;
 * - a frame the watermark has already passed is dropped rather than inserted,
 *   because the content it belongs to has already been appended;
 * - a run of such frames is the fallback that a re-numbered connection needs,
 *   and it must be visible as a rebaseline rather than silently swallowed;
 * - a reset makes the whole numbering space new again.
 *
 * The shuffled case uses a fixed seed: a random shuffle would make the one test
 * that covers "many holes open at once" fail intermittently, and a flaky test
 * gets skipped rather than fixed.
 */

import { describe, expect, it } from "vitest";

import { createOrderGate, type OrderOutcome } from "./order.js";

/** The sequence numbers an outcome released, in delivery order. */
const released = <T>(outcome: OrderOutcome<T>): number[] =>
  outcome.deliver.map((frame) => frame.seq);

/** A deterministic permutation of `1..count`, so the shuffle test cannot flake. */
function shuffled(count: number, seed: number): number[] {
  const numbers = Array.from({ length: count }, (_unused, index) => index + 1);
  let state = seed;

  for (let index = numbers.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const swapWith = state % (index + 1);
    const atIndex = numbers[index];
    const atSwap = numbers[swapWith];

    if (atIndex === undefined || atSwap === undefined) {
      continue;
    }

    numbers[index] = atSwap;
    numbers[swapWith] = atIndex;
  }

  return numbers;
}

describe("createOrderGate", () => {
  it("delivers a contiguous run one frame at a time", () => {
    const gate = createOrderGate<string>();
    const delivered: number[] = [];

    expect(gate.watermark()).toBeNull();

    for (let seq = 1; seq <= 5; seq += 1) {
      const outcome = gate.accept(seq, `frame-${seq}`);

      expect(outcome.duplicate).toBe(false);
      expect(outcome.late).toBe(false);
      expect(outcome.rebaselined).toBe(false);
      expect(outcome.gaps).toEqual([]);
      expect(outcome.deliver).toHaveLength(1);
      expect(outcome.deliver[0]?.seq).toBe(seq);
      expect(outcome.deliver[0]?.value).toBe(`frame-${seq}`);
      expect(gate.watermark()).toBe(seq);

      delivered.push(...released(outcome));
    }

    expect(delivered).toEqual([1, 2, 3, 4, 5]);
    expect(gate.watermark()).toBe(5);
    expect(gate.buffered()).toBe(0);
  });

  it("releases every buffered frame that the frame filling the hole makes contiguous", () => {
    const gate = createOrderGate<string>();

    for (const seq of [2, 3, 4, 5]) {
      const held = gate.accept(seq, `frame-${seq}`);

      expect(held.deliver).toEqual([]);
      expect(gate.watermark()).toBeNull();
    }

    expect(gate.buffered()).toBe(4);

    const outcome = gate.accept(1, "frame-1");

    expect(released(outcome)).toEqual([1, 2, 3, 4, 5]);
    expect(outcome.deliver.map((frame) => frame.value)).toEqual([
      "frame-1",
      "frame-2",
      "frame-3",
      "frame-4",
      "frame-5",
    ]);
    expect(gate.watermark()).toBe(5);
    expect(gate.buffered()).toBe(0);
  });

  it("reports a repeat as a duplicate and delivers nothing", () => {
    const gate = createOrderGate<string>();

    gate.accept(1, "a");
    gate.accept(2, "b");

    const repeat = gate.accept(2, "b-again");

    expect(repeat.duplicate).toBe(true);
    expect(repeat.late).toBe(false);
    expect(repeat.rebaselined).toBe(false);
    expect(repeat.deliver).toEqual([]);
    expect(gate.watermark()).toBe(2);
  });

  it("reports a repeat that is still buffered as a duplicate", () => {
    const gate = createOrderGate<string>();

    gate.accept(1, "a");
    gate.accept(3, "c");

    const repeat = gate.accept(3, "c-again");

    expect(repeat.duplicate).toBe(true);
    expect(repeat.deliver).toEqual([]);
    expect(gate.buffered()).toBe(1);
    expect(gate.watermark()).toBe(1);
  });

  it("delivers a shuffled run in strict sequence order", () => {
    const gate = createOrderGate<number>();
    const delivered: number[] = [];

    for (const seq of shuffled(20, 7)) {
      const outcome = gate.accept(seq, seq);

      expect(outcome.late).toBe(false);
      expect(outcome.duplicate).toBe(false);
      expect(outcome.gaps).toEqual([]);

      delivered.push(...released(outcome));
    }

    expect(delivered).toEqual(Array.from({ length: 20 }, (_unused, index) => index + 1));
    expect(gate.watermark()).toBe(20);
    expect(gate.buffered()).toBe(0);
  });

  it("declares a gap and advances the watermark when the buffer exceeds its capacity", () => {
    const gate = createOrderGate<string>({ capacity: 4 });

    gate.accept(1, "a");
    gate.accept(2, "b");

    // 6..9 fill the buffer to exactly its capacity, which is still waiting: the
    // hole is only given up on once holding one more frame would exceed it.
    for (const seq of [6, 7, 8, 9]) {
      const held = gate.accept(seq, `frame-${seq}`);

      expect(held.deliver).toEqual([]);
      expect(held.gaps).toEqual([]);
    }

    expect(gate.buffered()).toBe(4);
    expect(gate.watermark()).toBe(2);

    // The fifth held frame is one more than the buffer may carry, so 3..5 are
    // declared lost and the frames behind them are released in order.
    const outcome = gate.accept(10, "frame-10");

    expect(outcome.gaps).toEqual([{ from: 3, to: 5 }]);
    expect(released(outcome)).toEqual([6, 7, 8, 9, 10]);
    expect(gate.watermark()).toBe(10);
    expect(gate.buffered()).toBe(0);
  });

  it("drops a frame that arrives after the watermark has passed it", () => {
    const gate = createOrderGate<string>({ capacity: 4 });

    gate.accept(1, "a");
    gate.accept(2, "b");

    for (const seq of [6, 7, 8, 9, 10]) {
      gate.accept(seq, `frame-${seq}`);
    }

    expect(gate.watermark()).toBe(10);

    const stale = gate.accept(4, "frame-4");

    expect(stale.late).toBe(true);
    expect(stale.duplicate).toBe(false);
    expect(stale.rebaselined).toBe(false);
    expect(stale.deliver).toEqual([]);
    expect(gate.watermark()).toBe(10);

    // The dropped frame is remembered: a resend of it is a repeat rather than a
    // second late arrival, so retransmission cannot inflate the late run.
    const again = gate.accept(4, "frame-4");

    expect(again.duplicate).toBe(true);
    expect(again.late).toBe(false);
  });

  it("rebaselines after a run of late frames and delivers the frame that triggered it", () => {
    const gate = createOrderGate<string>({ capacity: 1, rebaselineThreshold: 3 });

    gate.accept(1, "a");
    gate.accept(2, "b");

    // Holding 6 and then 7 overflows a capacity of one, so 3..5 are declared
    // lost and the watermark moves past them.
    gate.accept(6, "frame-6");

    const jump = gate.accept(7, "frame-7");

    expect(jump.gaps).toEqual([{ from: 3, to: 5 }]);
    expect(gate.watermark()).toBe(7);

    expect(gate.accept(3, "frame-3").late).toBe(true);
    expect(gate.accept(4, "frame-4").late).toBe(true);

    const healed = gate.accept(5, "frame-5");

    expect(healed.rebaselined).toBe(true);
    expect(healed.duplicate).toBe(false);
    expect(healed.late).toBe(false);
    expect(released(healed)).toEqual([5]);
    expect(gate.watermark()).toBe(5);

    // Numbering continues from the new baseline, which is the point of the
    // fallback: the stream is usable again instead of frozen.
    const next = gate.accept(6, "frame-6-again");

    expect(released(next)).toEqual([6]);
    expect(gate.watermark()).toBe(6);
  });

  it("clears the run of late frames whenever a frame is delivered", () => {
    const gate = createOrderGate<string>({ capacity: 1, rebaselineThreshold: 2 });

    gate.accept(1, "a");
    gate.accept(2, "b");
    gate.accept(5, "frame-5");

    const jump = gate.accept(6, "frame-6");

    expect(jump.gaps).toEqual([{ from: 3, to: 4 }]);
    expect(gate.watermark()).toBe(6);

    expect(gate.accept(3, "frame-3").late).toBe(true);

    // A deliverable frame proves the stream is still moving, so the run starts
    // over and the next late frame must not trigger the fallback.
    const fresh = gate.accept(7, "frame-7");

    expect(released(fresh)).toEqual([7]);

    const lateAgain = gate.accept(4, "frame-4");

    expect(lateAgain.late).toBe(true);
    expect(lateAgain.rebaselined).toBe(false);
    expect(gate.watermark()).toBe(7);
  });

  it("forgets the watermark, the buffer and the reported history on reset", () => {
    const gate = createOrderGate<string>();

    gate.accept(1, "a");
    gate.accept(3, "c");

    expect(gate.buffered()).toBe(1);

    gate.reset();

    expect(gate.watermark()).toBeNull();
    expect(gate.buffered()).toBe(0);

    // After a reset the same numbers are news again: the first one is delivered
    // rather than reported as a duplicate, and the gap is reopened.
    const again = gate.accept(1, "a-again");

    expect(again.duplicate).toBe(false);
    expect(again.late).toBe(false);
    expect(released(again)).toEqual([1]);

    const held = gate.accept(3, "c-again");

    expect(held.duplicate).toBe(false);
    expect(held.deliver).toEqual([]);
    expect(gate.buffered()).toBe(1);
  });

  it("ignores a number that cannot be ordered at all", () => {
    const gate = createOrderGate<string>();

    const outcome = gate.accept(Number.NaN, "frame");

    expect(outcome).toEqual({
      deliver: [],
      duplicate: false,
      late: false,
      rebaselined: false,
      gaps: [],
    });
    expect(gate.watermark()).toBeNull();
    expect(gate.buffered()).toBe(0);
  });
});
