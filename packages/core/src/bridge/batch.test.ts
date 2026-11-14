/**
 * Tests for the batching window.
 *
 * The window exists for two measured reasons, and the cases below pin both of
 * them down:
 *
 *   1. The host timer only honours 15.625 ms steps, so the window is a duration
 *      and must be configurable inside [8, 64] ms, with an out-of-range value
 *      refused rather than clamped.
 *   2. The first frame of a burst is latency the user can feel, so it bypasses
 *      the window entirely. Every later payload of that burst waits, which
 *      is the coalescing the window is for.
 *
 * No case waits on a real 15.6 ms timer. Most of them inject a virtual clock and
 * advance it by hand, which is what makes "the flush happens only when the
 * window expires" an assertion instead of a race. One small group runs the
 * DEFAULT scheduler under `vi.useFakeTimers()` instead, because a virtual clock
 * proves the module's logic and fake timers additionally prove the default
 * `setTimeout`/`clearTimeout` wiring -- neither covers the other.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BATCH_WINDOW_DEFAULT_MS,
  BATCH_WINDOW_MAX_MS,
  BATCH_WINDOW_MIN_MS,
  createBatchWindow,
} from "./batch";
import type { BatchWindowOptions } from "./batch";

/** One entry the virtual clock is holding. */
interface PendingTimer {
  handle: number;
  callback: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

/**
 * A hand-driven clock shaped like the module's `schedule`/`cancelSchedule` pair.
 *
 * `runNext` fires the earliest still-live timer, so a test states "the window
 * expires" explicitly and a missing arm shows up as "nothing to run" rather than
 * as a silent pass.
 */
function createClock() {
  const timers: PendingTimer[] = [];
  const requestedMs: number[] = [];
  const cancelled: unknown[] = [];
  let nextHandle = 1;

  return {
    /** Every window length the module asked for, in order. */
    requestedMs,

    /** Every handle the module cancelled, in order. */
    cancelled,

    schedule(callback: () => void, ms: number): unknown {
      const handle = nextHandle;
      nextHandle += 1;
      requestedMs.push(ms);
      timers.push({ handle, callback, ms, cancelled: false, fired: false });

      return handle;
    },

    cancelSchedule(handle: unknown): void {
      cancelled.push(handle);

      const timer = timers.find((candidate) => candidate.handle === handle);

      if (timer !== undefined) {
        timer.cancelled = true;
      }
    },

    /** How many timers are armed and not cancelled. */
    armCount(): number {
      return timers.filter((timer) => !timer.cancelled && !timer.fired).length;
    },

    /** Fire the earliest live timer; returns whether one was available. */
    runNext(): boolean {
      const timer = timers.find((candidate) => !candidate.cancelled && !candidate.fired);

      if (timer === undefined) {
        return false;
      }

      timer.fired = true;
      timer.callback();

      return true;
    },
  };
}

/** A clock plus the delivery recorder most cases share. */
function createHarness(overrides: Partial<BatchWindowOptions> = {}) {
  const clock = createClock();
  const batches: string[][] = [];

  const window = createBatchWindow({
    deliver: (payloads) => {
      batches.push([...payloads]);
    },
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
    ...overrides,
  });

  return { window, clock, batches };
}

/** Flattened delivered payloads, in delivery order. */
function delivered(batches: readonly string[][]): string[] {
  return batches.flat();
}

describe("first frame of a burst is sent directly", () => {
  it("delivers synchronously, returns true and arms no timer", () => {
    const { window, clock, batches } = createHarness();

    expect(window.submit("first")).toBe(true);

    // Synchronous: the batch is already there before anything is advanced.
    expect(batches).toEqual([["first"]]);
    // Nothing to coalesce with, so nothing was scheduled.
    expect(clock.requestedMs).toEqual([]);
    expect(window.size()).toBe(0);
  });

  it("keeps the direct send out of the buffer and out of a later flush", () => {
    const { window, clock, batches } = createHarness();

    window.submit("first");
    window.submit("second");

    expect(window.size()).toBe(1);
    expect(clock.runNext()).toBe(true);
    // The first frame is not re-delivered by the window flush.
    expect(batches).toEqual([["first"], ["second"]]);
  });

  it("treats the payload after a flush as a new burst's first frame", () => {
    const { window, batches } = createHarness();

    window.submit("first");
    window.submit("second");
    window.flush();

    expect(window.submit("third")).toBe(true);
    expect(delivered(batches)).toEqual(["first", "second", "third"]);
  });
});

describe("later payloads wait for the window", () => {
  it("returns false and delivers only after the window expires", () => {
    const { window, clock, batches } = createHarness();

    expect(window.submit("first")).toBe(true);
    expect(window.submit("second")).toBe(false);

    // Buffered, not sent: this is the whole point of the window.
    expect(batches).toEqual([["first"]]);
    expect(window.size()).toBe(1);

    expect(clock.runNext()).toBe(true);

    expect(batches).toEqual([["first"], ["second"]]);
    expect(window.size()).toBe(0);
  });

  it("coalesces the rest of a burst into one delivery", () => {
    const { window, clock, batches } = createHarness();

    window.submit("first");

    for (const payload of ["b", "c", "d"]) {
      expect(window.submit(payload)).toBe(false);
    }

    expect(clock.requestedMs).toHaveLength(1);
    expect(batches).toEqual([["first"]]);

    clock.runNext();

    expect(batches).toEqual([["first"], ["b", "c", "d"]]);
  });

  it("arms exactly one window for a burst and never re-arms per payload", () => {
    const { window, clock } = createHarness();

    window.submit("first");

    // On-demand arming: the burst's first frame is direct, so nothing is armed.
    expect(clock.requestedMs).toHaveLength(0);

    window.submit("b");
    window.submit("c");
    window.submit("d");

    expect(clock.requestedMs).toHaveLength(1);

    clock.runNext();

    // The expired window is not re-armed by itself; an empty buffer owns no
    // timer, so there is no polling loop and nothing left to advance.
    expect(clock.requestedMs).toHaveLength(1);
    expect(clock.armCount()).toBe(0);
    expect(clock.runNext()).toBe(false);
  });

  it("tolerates a scheduler that runs the callback inline", () => {
    const batches: string[][] = [];
    const requestedMs: number[] = [];

    const window = createBatchWindow({
      deliver: (payloads) => {
        batches.push([...payloads]);
      },
      schedule: (callback, ms) => {
        requestedMs.push(ms);
        callback();

        return requestedMs.length;
      },
      cancelSchedule: () => {
        /* nothing is pending: the window already fired inline */
      },
    });

    expect(window.submit("first")).toBe(true);
    // A zero-length window delivers within the submit, but that is not a first
    // frame, so the boolean still reports false.
    expect(window.submit("second")).toBe(false);

    expect(batches).toEqual([["first"], ["second"]]);
    expect(window.size()).toBe(0);
    expect(requestedMs).toEqual([BATCH_WINDOW_DEFAULT_MS]);
  });

  it("arms on demand: no timer exists while the buffer is empty", () => {
    const schedule = vi.fn(() => 1);
    const cancelSchedule = vi.fn();

    const window = createBatchWindow({
      deliver: () => {
        /* not under test here */
      },
      schedule,
      cancelSchedule,
    });

    // A fresh window owns no timer.
    expect(schedule).not.toHaveBeenCalled();

    // The direct first frame arms nothing: the buffer stays empty.
    window.submit("first");
    expect(schedule).toHaveBeenCalledTimes(0);
    expect(window.size()).toBe(0);

    // The first buffered payload arms exactly one.
    window.submit("second");
    expect(schedule).toHaveBeenCalledTimes(1);

    // Further payloads join the same window rather than arming again.
    window.submit("third");
    window.submit("fourth");
    expect(schedule).toHaveBeenCalledTimes(1);

    // Emptying the buffer cancels the one armed timer and leaves none behind.
    window.reset();
    expect(cancelSchedule).toHaveBeenCalledTimes(1);
    expect(window.size()).toBe(0);

    // An idle window never re-arms itself: no polling loop exists.
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("restarts a fresh window for the next burst", () => {
    const { window, clock, batches } = createHarness();

    window.submit("a1");
    window.submit("a2");
    clock.runNext();

    // After the window expired, the next payload is a new burst's first frame.
    expect(window.submit("b1")).toBe(true);
    expect(window.submit("b2")).toBe(false);

    expect(clock.requestedMs).toHaveLength(2);
    clock.runNext();

    expect(batches).toEqual([["a1"], ["a2"], ["b1"], ["b2"]]);
  });
});

describe("overflow flushes immediately", () => {
  it("delivers as soon as the buffer reaches maxBatch", () => {
    const { window, clock, batches } = createHarness({ maxBatch: 2 });

    window.submit("first");
    expect(window.submit("b")).toBe(false);

    // Still inside the window, but the ceiling is reached.
    expect(window.submit("c")).toBe(false);

    expect(batches).toEqual([["first"], ["b", "c"]]);
    expect(window.size()).toBe(0);
    // The pending window was cancelled: the batch is already out.
    expect(clock.cancelled).toHaveLength(1);
    expect(clock.armCount()).toBe(0);
  });

  it("does not wait for the window, and the expired timer cannot fire a flush", () => {
    const { window, clock, batches } = createHarness({ maxBatch: 3 });

    window.submit("first");
    window.submit("b");
    window.submit("c");
    window.submit("d");

    expect(batches).toEqual([["first"], ["b", "c", "d"]]);
    expect(clock.runNext()).toBe(false);
    expect(batches).toHaveLength(2);
  });

  it("uses the default ceiling when maxBatch is not configured", () => {
    const { window, clock } = createHarness();

    window.submit("first");

    // One short of the default ceiling: still buffered behind the window.
    for (let index = 0; index < 30; index += 1) {
      window.submit(`p${String(index)}`);
    }

    expect(window.size()).toBe(30);

    window.submit("p30");
    // 31 buffered is still under the default of 32.
    expect(window.size()).toBe(31);

    window.submit("p31");
    // The 32nd buffered payload crosses the default ceiling and flushes.
    expect(window.size()).toBe(0);
    expect(clock.cancelled).toHaveLength(1);
  });

  it("starts a new burst after the overflow flush, with a direct first frame", () => {
    const { window, batches } = createHarness({ maxBatch: 2 });

    window.submit("p0");
    window.submit("p1");
    window.submit("p2");

    expect(batches).toEqual([["p0"], ["p1", "p2"]]);

    expect(window.submit("p3")).toBe(true);
    expect(batches).toEqual([["p0"], ["p1", "p2"], ["p3"]]);
  });

  it("never waits for the window when maxBatch is 1", () => {
    const { window, clock, batches } = createHarness({ maxBatch: 1 });

    // A ceiling of 1 means a buffered payload always crosses it on arrival, so
    // nothing ever waits for the window: the direct frame, then an immediate
    // flush, then a direct frame again because that flush closed the burst.
    expect(window.submit("first")).toBe(true);
    expect(window.submit("second")).toBe(false);
    expect(window.submit("third")).toBe(true);

    expect(batches).toEqual([["first"], ["second"], ["third"]]);
    expect(clock.requestedMs).toEqual([]);
  });

  it("rejects a maxBatch that cannot describe a batch", () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createBatchWindow({
          maxBatch: invalid,
          deliver: () => {
            /* unreachable: the guard runs first */
          },
        }),
      ).toThrow(RangeError);
    }
  });
});

describe("window guard", () => {
  it("exposes the measured default and the accepted range", () => {
    expect(BATCH_WINDOW_DEFAULT_MS).toBe(15.6);
    expect(BATCH_WINDOW_MIN_MS).toBe(8);
    expect(BATCH_WINDOW_MAX_MS).toBe(64);
  });

  it("schedules the default window when none is configured", () => {
    const { window, clock } = createHarness();

    window.submit("first");
    window.submit("second");

    expect(clock.requestedMs).toEqual([BATCH_WINDOW_DEFAULT_MS]);
  });

  it("rejects a window outside [8, 64] instead of clamping it", () => {
    for (const invalid of [7.9, 64.1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createBatchWindow({
          windowMs: invalid,
          deliver: () => {
            /* unreachable: the guard runs first */
          },
        }),
      ).toThrow(RangeError);
    }
  });

  it("accepts both boundaries of the range", () => {
    for (const accepted of [BATCH_WINDOW_MIN_MS, BATCH_WINDOW_MAX_MS]) {
      const { window, clock } = createHarness({ windowMs: accepted });

      window.submit("first");
      window.submit("second");

      expect(clock.requestedMs).toEqual([accepted]);
    }
  });

  it("names the value it refused, so the caller can see the mistake", () => {
    let thrown: unknown;

    try {
      createBatchWindow({
        windowMs: 7.9,
        deliver: () => {
          /* unreachable */
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RangeError);

    if (!(thrown instanceof RangeError)) {
      throw new Error("expected a RangeError");
    }

    expect(thrown.message).toContain("7.9");
    expect(thrown.message).toContain("8");
    expect(thrown.message).toContain("64");
  });
});

describe("flush", () => {
  it("returns an empty array and does not deliver when nothing is buffered", () => {
    const { window, clock, batches } = createHarness();

    expect(window.flush()).toEqual([]);
    expect(window.flush()).toEqual([]);

    expect(batches).toEqual([]);
    // No timer was armed or cancelled by flushing an empty buffer.
    expect(clock.requestedMs).toEqual([]);
    expect(clock.cancelled).toEqual([]);
  });

  it("returns the flushed payloads in order and empties the buffer", () => {
    const { window, batches } = createHarness();

    window.submit("first");
    window.submit("b");
    window.submit("c");

    expect(window.flush()).toEqual(["b", "c"]);
    expect(window.size()).toBe(0);
    expect(delivered(batches)).toEqual(["first", "b", "c"]);
    // A second flush has nothing left to say.
    expect(window.flush()).toEqual([]);
  });

  it("closes the burst even when it had nothing to send", () => {
    const { window, clock, batches } = createHarness();

    window.submit("first");
    // Nothing is buffered yet, so this flush delivers nothing...
    expect(window.flush()).toEqual([]);
    expect(batches).toEqual([["first"]]);

    // ...but the burst is over, so the next payload is a first frame and is
    // not queued behind a window that will never be armed for it.
    expect(window.submit("important")).toBe(true);
    expect(batches).toEqual([["first"], ["important"]]);
    expect(clock.requestedMs).toEqual([]);
  });

  it("cancels the pending window so it cannot deliver a second time", () => {
    const { window, clock, batches } = createHarness();

    window.submit("first");
    window.submit("b");
    window.flush();

    expect(clock.cancelled).toHaveLength(1);
    expect(clock.runNext()).toBe(false);
    expect(batches).toEqual([["first"], ["b"]]);
  });
});

describe("reset", () => {
  it("drops the buffer without delivering and cancels the window", () => {
    const { window, clock, batches } = createHarness();

    window.submit("first");
    window.submit("b");
    window.submit("c");

    window.reset();

    expect(window.size()).toBe(0);
    expect(clock.cancelled).toHaveLength(1);
    expect(clock.runNext()).toBe(false);
    expect(batches).toEqual([["first"]]);
  });

  it("returns the window to idle, so the next payload is a first frame again", () => {
    const { window, batches } = createHarness();

    window.submit("first");
    window.submit("b");
    window.reset();

    expect(window.submit("after-reset")).toBe(true);
    expect(batches).toEqual([["first"], ["after-reset"]]);
  });

  it("is a no-op when nothing is buffered and nothing is armed", () => {
    const { window, clock } = createHarness();

    window.reset();

    expect(clock.requestedMs).toEqual([]);
    expect(clock.cancelled).toEqual([]);
    expect(window.size()).toBe(0);
  });

  it("neutralises a callback the clock had already queued", () => {
    const batches: string[][] = [];
    const queued: Array<() => void> = [];

    const window = createBatchWindow({
      deliver: (payloads) => {
        batches.push([...payloads]);
      },
      schedule: (callback) => {
        queued.push(callback);

        return queued.length;
      },
      cancelSchedule: () => {
        // Deliberately forgets the callback, the way a host timer already
        // queued for its next turn cannot be pulled back.
      },
    });

    window.submit("first");
    window.submit("buffered");
    window.reset();

    // A stale window must not flush a buffer that was dropped.
    for (const callback of queued) {
      callback();
    }

    expect(batches).toEqual([["first"]]);
    expect(window.size()).toBe(0);
  });

  it("neutralises a queued callback after an overflow flush already sent the batch", () => {
    const batches: string[][] = [];
    const queued: Array<() => void> = [];

    const window = createBatchWindow({
      maxBatch: 2,
      deliver: (payloads) => {
        batches.push([...payloads]);
      },
      schedule: (callback) => {
        queued.push(callback);

        return queued.length;
      },
      cancelSchedule: () => {
        /* the queued callback stays reachable, as above */
      },
    });

    window.submit("first");
    window.submit("b");
    window.submit("c");

    expect(batches).toEqual([["first"], ["b", "c"]]);

    // The cancelled window firing late must not deliver an empty second batch.
    for (const callback of queued) {
      callback();
    }

    expect(batches).toHaveLength(2);
  });
});

describe("order", () => {
  it("preserves submit order across the direct frame and the window batch", () => {
    const { window, clock, batches } = createHarness();

    const payloads = Array.from({ length: 10 }, (_unused, index) => `p${String(index)}`);

    expect(window.submit(payloads[0] ?? "")).toBe(true);

    for (const payload of payloads.slice(1)) {
      expect(window.submit(payload)).toBe(false);
    }

    clock.runNext();

    expect(delivered(batches)).toEqual(payloads);
    // Two deliveries: the direct frame, then one batch.
    expect(batches).toHaveLength(2);
  });

  it("preserves order across an overflow flush", () => {
    const { window, batches } = createHarness({ maxBatch: 3 });

    window.submit("p0");

    for (let index = 1; index < 4; index += 1) {
      window.submit(`p${String(index)}`);
    }

    expect(delivered(batches)).toEqual(["p0", "p1", "p2", "p3"]);
  });
});

describe("deliver failures", () => {
  it("propagates a failed window flush and leaves the window empty and unarmed", () => {
    const clock = createClock();
    const failure = new Error("transport down");
    let deliveries = 0;

    const window = createBatchWindow({
      deliver: () => {
        deliveries += 1;

        // The direct first frame succeeds; the window flush is the one that
        // fails, which is the case that has a buffer to lose.
        if (deliveries > 1) {
          throw failure;
        }
      },
      schedule: clock.schedule,
      cancelSchedule: clock.cancelSchedule,
    });

    window.submit("first");
    window.submit("buffered");

    // A buffered flush throws from the window callback, having detached first.
    expect(() => clock.runNext()).toThrow(failure);

    expect(window.size()).toBe(0);
    expect(clock.armCount()).toBe(0);
    // The failed batch is gone rather than retried: a retry would duplicate
    // payloads the transport may already have accepted.
    expect(window.flush()).toEqual([]);
  });

  it("propagates a failed direct send and treats the next payload as a first frame", () => {
    const clock = createClock();
    const batches: string[][] = [];
    let failing = true;

    const window = createBatchWindow({
      deliver: (payloads) => {
        if (failing) {
          throw new Error("transport down");
        }

        batches.push([...payloads]);
      },
      schedule: clock.schedule,
      cancelSchedule: clock.cancelSchedule,
    });

    // The first frame is delivered inline, so it throws inline too.
    expect(() => window.submit("first")).toThrow();

    // Nothing was buffered for the failed direct send and nothing is armed.
    expect(window.size()).toBe(0);
    expect(clock.armCount()).toBe(0);

    failing = false;

    // A failed delivery never leaves the window believing a burst started.
    expect(window.submit("second")).toBe(true);
    expect(batches).toEqual([["second"]]);
  });
});

describe("the default host timer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes on a real timeout and never before it", () => {
    vi.useFakeTimers();

    const batches: string[][] = [];
    const window = createBatchWindow({
      deliver: (payloads) => {
        batches.push([...payloads]);
      },
    });

    window.submit("first");
    window.submit("second");

    // Still buffered: the window has not expired.
    expect(batches).toEqual([["first"]]);

    // The default is one quantum, so advancing by exactly the configured value
    // is enough to fire the timer.
    vi.advanceTimersByTime(BATCH_WINDOW_DEFAULT_MS);

    expect(batches).toEqual([["first"], ["second"]]);
  });

  it("cancels the real timer on reset, so nothing is delivered later", () => {
    vi.useFakeTimers();

    const batches: string[][] = [];
    const window = createBatchWindow({
      deliver: (payloads) => {
        batches.push([...payloads]);
      },
    });

    window.submit("first");
    window.submit("second");
    window.reset();

    vi.advanceTimersByTime(BATCH_WINDOW_MAX_MS * 4);

    expect(batches).toEqual([["first"]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
