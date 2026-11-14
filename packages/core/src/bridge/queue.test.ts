/**
 * Tests for the three-channel bounded queue (C5).
 *
 * The hard semantics under test come from a measurement, not from taste: a
 * producer that blocks on a full buffer stalls the engine, and silently
 * dropping a frame corrupts a channel whose frames are not interchangeable. So
 * the cases below pin down three things that a "reasonable" implementation
 * would get wrong:
 *
 *   1. A full channel REFUSES with `BRIDGE_QUEUE_OVERFLOW` and nothing moves --
 *      no partial push, no eviction of the oldest payload, no blocked caller.
 *   2. Channels are budgeted independently, so one full channel cannot stop
 *      another one from accepting work.
 *   3. Limits are configurable per channel, and 0 is a legal "buffer nothing"
 *      setting rather than a synonym for unbounded.
 */

import { describe, expect, it } from "vitest";

import {
  BRIDGE_QUEUE_OVERFLOW,
  BridgeQueueOverflowError,
  DEFAULT_LIMITS,
  createBoundedQueue,
} from "./queue";

/** Read the marker off any thrown value, so an assertion cannot crash on a wrong type. */
function codeOf(thrown: unknown): unknown {
  return thrown instanceof BridgeQueueOverflowError ? thrown.code : undefined;
}

describe("DEFAULT_LIMITS", () => {
  it("budgets all three channels separately", () => {
    expect(Object.keys(DEFAULT_LIMITS).sort()).toEqual(["bulk", "control", "stream"]);
  });

  it("gives control the deepest backlog and bulk the shallowest", () => {
    // control: high frequency, smallest frames. stream: medium frequency, fixed
    // 8 KB slices. bulk: low frequency, largest frames.
    expect(DEFAULT_LIMITS.control).toBeGreaterThan(DEFAULT_LIMITS.stream);
    expect(DEFAULT_LIMITS.stream).toBeGreaterThan(DEFAULT_LIMITS.bulk);
    expect(DEFAULT_LIMITS.bulk).toBeGreaterThan(0);
  });

  it("is frozen, so a queue's defaults cannot be changed from outside", () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });
});

describe("push and drain", () => {
  it("drains in FIFO order and empties the channel", () => {
    const queue = createBoundedQueue();

    queue.push("control", "a");
    queue.push("control", "b");
    queue.push("control", "c");

    expect(queue.drain("control")).toEqual(["a", "b", "c"]);
    expect(queue.size("control")).toBe(0);
  });

  it("drains only the named channel", () => {
    const queue = createBoundedQueue();

    queue.push("control", "c1");
    queue.push("stream", "s1");
    queue.push("bulk", "b1");

    expect(queue.drain("stream")).toEqual(["s1"]);
    expect(queue.size("control")).toBe(1);
    expect(queue.size("bulk")).toBe(1);
    expect(queue.total()).toBe(2);
  });

  it("returns an empty array for a channel that was never used", () => {
    const queue = createBoundedQueue();

    expect(queue.drain("bulk")).toEqual([]);
    expect(queue.drain("bulk")).toEqual([]);
  });

  it("hands the caller an array that later pushes cannot reach", () => {
    const queue = createBoundedQueue();

    queue.push("stream", "first");
    const drained = queue.drain("stream");

    queue.push("stream", "second");

    expect(drained).toEqual(["first"]);
    expect(queue.drain("stream")).toEqual(["second"]);
  });

  it("keeps draining correct after the channel refills to its limit", () => {
    const queue = createBoundedQueue({ control: 2 });

    queue.push("control", "1");
    queue.push("control", "2");
    expect(queue.total()).toBe(2);

    expect(queue.drain("control")).toEqual(["1", "2"]);
    expect(queue.total()).toBe(0);

    queue.push("control", "3");
    expect(queue.drain("control")).toEqual(["3"]);
  });

  it("stores payloads verbatim, without interpreting them", () => {
    const queue = createBoundedQueue();
    const payload = '{"v":1,"ch":"control","seq":1,"t":"bridge.ready","body":{}}';

    queue.push("control", payload);

    expect(queue.drain("control")).toEqual([payload]);
  });
});

describe("overflow", () => {
  it("throws BRIDGE_QUEUE_OVERFLOW at the limit", () => {
    const queue = createBoundedQueue({ stream: 2 });

    queue.push("stream", "a");
    queue.push("stream", "b");

    let thrown: unknown;
    try {
      queue.push("stream", "c");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BridgeQueueOverflowError);
    expect(codeOf(thrown)).toBe(BRIDGE_QUEUE_OVERFLOW);
  });

  it("leaves the channel contents unchanged when it refuses", () => {
    const queue = createBoundedQueue({ stream: 2 });

    queue.push("stream", "a");
    queue.push("stream", "b");
    expect(() => queue.push("stream", "c")).toThrow();

    // Not half-advanced, not evicted: still the first two, in order.
    expect(queue.size("stream")).toBe(2);
    expect(queue.total()).toBe(2);
    expect(queue.drain("stream")).toEqual(["a", "b"]);
  });

  it("refuses every further push while the channel stays full", () => {
    const queue = createBoundedQueue({ bulk: 1 });

    queue.push("bulk", "page-1");

    for (const attempt of ["page-2", "page-3"]) {
      expect(() => queue.push("bulk", attempt)).toThrow(BridgeQueueOverflowError);
    }

    expect(queue.drain("bulk")).toEqual(["page-1"]);
  });

  it("accepts again once the channel is drained", () => {
    const queue = createBoundedQueue({ bulk: 1 });

    queue.push("bulk", "page-1");
    expect(() => queue.push("bulk", "page-2")).toThrow();

    queue.drain("bulk");

    expect(() => queue.push("bulk", "page-2")).not.toThrow();
    expect(queue.drain("bulk")).toEqual(["page-2"]);
  });

  it("names the channel, the limit and the queued count on the error", () => {
    const queue = createBoundedQueue({ control: 1 });
    const refused = "refused-payload-marker";
    queue.push("control", "queued-payload-marker");

    let thrown: unknown;
    try {
      queue.push("control", refused);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BridgeQueueOverflowError);

    if (!(thrown instanceof BridgeQueueOverflowError)) {
      throw new Error("expected a BridgeQueueOverflowError");
    }

    expect(thrown.channel).toBe("control");
    expect(thrown.limit).toBe(1);
    expect(thrown.queued).toBe(1);
    // Payloads must never be echoed into the message: a stream payload holds
    // terminal bytes, and an error message is the easiest thing to log.
    expect(thrown.message).not.toContain(refused);
    expect(thrown.message).not.toContain("queued-payload-marker");
  });

  it("never blocks: a refused push returns control to the caller", () => {
    const queue = createBoundedQueue({ control: 1 });
    queue.push("control", "a");

    // A blocking producer would hang here and the test would time out.
    expect(() => queue.push("control", "b")).toThrow();

    expect(queue.size("control")).toBe(1);
  });
});

describe("channel independence", () => {
  it("lets another channel push while one is full", () => {
    const queue = createBoundedQueue({ control: 1, stream: 1, bulk: 1 });

    queue.push("control", "c1");
    expect(() => queue.push("control", "c2")).toThrow();

    // A shared buffer, or one shared limit, would fail here.
    expect(() => queue.push("stream", "s1")).not.toThrow();
    expect(() => queue.push("bulk", "b1")).not.toThrow();

    expect(queue.size("control")).toBe(1);
    expect(queue.size("stream")).toBe(1);
    expect(queue.size("bulk")).toBe(1);
    expect(queue.total()).toBe(3);
  });

  it("keeps each channel's own limit", () => {
    const queue = createBoundedQueue({ control: 3, stream: 1, bulk: 2 });

    queue.push("control", "c1");
    queue.push("control", "c2");
    queue.push("control", "c3");
    expect(queue.size("control")).toBe(3);

    queue.push("stream", "s1");
    expect(() => queue.push("stream", "s2")).toThrow();

    queue.push("bulk", "b1");
    queue.push("bulk", "b2");
    expect(() => queue.push("bulk", "b3")).toThrow();

    expect(queue.drain("control")).toEqual(["c1", "c2", "c3"]);
    expect(queue.drain("stream")).toEqual(["s1"]);
    expect(queue.drain("bulk")).toEqual(["b1", "b2"]);
  });

  it("draining one channel does not disturb another channel's backlog", () => {
    const queue = createBoundedQueue();

    queue.push("stream", "s1");
    queue.push("stream", "s2");
    queue.push("bulk", "b1");

    queue.drain("stream");

    expect(queue.size("bulk")).toBe(1);
    expect(queue.drain("bulk")).toEqual(["b1"]);
  });
});

describe("custom limits", () => {
  it("applies an override to the named channel only", () => {
    const queue = createBoundedQueue({ stream: 1 });

    queue.push("stream", "s1");
    expect(() => queue.push("stream", "s2")).toThrow();

    // control keeps its default, which is far deeper than 1.
    for (let index = 0; index < 10; index += 1) {
      queue.push("control", `c${String(index)}`);
    }

    expect(queue.size("control")).toBe(10);
  });

  it("falls back to DEFAULT_LIMITS for every channel when given none", () => {
    const queue = createBoundedQueue();

    for (let index = 0; index < DEFAULT_LIMITS.control; index += 1) {
      queue.push("control", `c${String(index)}`);
    }

    expect(queue.size("control")).toBe(DEFAULT_LIMITS.control);
    expect(() => queue.push("control", "one-too-many")).toThrow(BridgeQueueOverflowError);
  });

  it("accepts an explicit limit equal to the default without changing behaviour", () => {
    const queue = createBoundedQueue({ bulk: DEFAULT_LIMITS.bulk });

    expect(() => queue.push("bulk", "page")).not.toThrow();
  });

  it("accepts a limit of 1, the smallest non-zero budget", () => {
    const queue = createBoundedQueue({ bulk: 1 });

    queue.push("bulk", "only");
    expect(() => queue.push("bulk", "second")).toThrow();

    expect(queue.drain("bulk")).toEqual(["only"]);
  });

  it("rejects a limit that is not a non-negative safe integer", () => {
    for (const invalid of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(() => createBoundedQueue({ stream: invalid })).toThrow(RangeError);
    }
  });
});

describe("a limit of 0 means the channel buffers nothing", () => {
  it("throws on the very first push", () => {
    const queue = createBoundedQueue({ stream: 0 });

    let thrown: unknown;
    try {
      queue.push("stream", "s1");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BridgeQueueOverflowError);
    expect(codeOf(thrown)).toBe(BRIDGE_QUEUE_OVERFLOW);
    expect(queue.size("stream")).toBe(0);
    expect(queue.drain("stream")).toEqual([]);
  });

  it("does not quietly turn 0 into the default or into 'unbounded'", () => {
    const queue = createBoundedQueue({ control: 0 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() => queue.push("control", `c${String(attempt)}`)).toThrow(BridgeQueueOverflowError);
    }

    expect(queue.size("control")).toBe(0);
  });

  it("leaves the other channels usable", () => {
    const queue = createBoundedQueue({ bulk: 0 });

    queue.push("control", "c1");
    queue.push("stream", "s1");

    expect(() => queue.push("bulk", "b1")).toThrow();

    expect(queue.size("control")).toBe(1);
    expect(queue.size("stream")).toBe(1);
  });
});

describe("size and total", () => {
  it("reports 0 for every channel on a fresh queue", () => {
    const queue = createBoundedQueue();

    expect(queue.size("control")).toBe(0);
    expect(queue.size("stream")).toBe(0);
    expect(queue.size("bulk")).toBe(0);
    expect(queue.total()).toBe(0);
  });

  it("tracks pushes, drains and clear in every combination", () => {
    const queue = createBoundedQueue();

    queue.push("control", "c1");
    queue.push("control", "c2");
    queue.push("stream", "s1");
    expect(queue.size("control")).toBe(2);
    expect(queue.size("stream")).toBe(1);
    expect(queue.total()).toBe(3);

    queue.drain("control");
    expect(queue.size("control")).toBe(0);
    expect(queue.total()).toBe(1);

    queue.push("bulk", "b1");
    queue.push("bulk", "b2");
    expect(queue.total()).toBe(3);

    queue.clear();
    expect(queue.total()).toBe(0);
    expect(queue.size("bulk")).toBe(0);
  });

  it("stays exact across a long mixed run", () => {
    const queue = createBoundedQueue({ control: 100, stream: 100, bulk: 100 });
    let expected = 0;

    for (let index = 0; index < 50; index += 1) {
      queue.push("control", `c${String(index)}`);
      queue.push("stream", `s${String(index)}`);
      expected += 2;
      expect(queue.total()).toBe(expected);
    }

    queue.drain("stream");
    expected -= 50;
    expect(queue.total()).toBe(expected);

    for (let index = 0; index < 10; index += 1) {
      queue.push("bulk", `b${String(index)}`);
      expected += 1;
    }

    expect(queue.total()).toBe(expected);
    expect(queue.size("control")).toBe(50);
    expect(queue.size("stream")).toBe(0);
    expect(queue.size("bulk")).toBe(10);
  });
});

describe("clear", () => {
  it("empties every channel", () => {
    const queue = createBoundedQueue();

    queue.push("control", "c1");
    queue.push("stream", "s1");
    queue.push("bulk", "b1");

    queue.clear();

    expect(queue.total()).toBe(0);
    expect(queue.drain("control")).toEqual([]);
    expect(queue.drain("stream")).toEqual([]);
    expect(queue.drain("bulk")).toEqual([]);
  });

  it("keeps the configured limits", () => {
    const queue = createBoundedQueue({ stream: 2 });

    queue.push("stream", "s1");
    queue.push("stream", "s2");
    queue.clear();

    queue.push("stream", "s3");
    queue.push("stream", "s4");
    expect(() => queue.push("stream", "s5")).toThrow(BridgeQueueOverflowError);
  });

  it("is idempotent", () => {
    const queue = createBoundedQueue();

    queue.push("control", "c1");
    queue.clear();
    queue.clear();

    expect(queue.total()).toBe(0);
  });
});

describe("unknown channel", () => {
  it("is rejected instead of creating a fourth backlog", () => {
    const queue = createBoundedQueue();
    const bogus = "metrics" as unknown as "control";

    expect(() => queue.push(bogus, "x")).toThrow(RangeError);
    expect(() => queue.drain(bogus)).toThrow(RangeError);
    expect(queue.size("control")).toBe(0);
    expect(queue.total()).toBe(0);
  });
});
