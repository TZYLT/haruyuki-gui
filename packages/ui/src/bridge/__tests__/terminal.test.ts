/**
 * Tests for the terminal router.
 *
 * The sink owns the write and acknowledgements are batched. The two claims
 * that matter operationally are that a 1 MiB payload arrives as text and costs
 * a bounded number of acks, and that an ack is never claimed for bytes the sink
 * has not confirmed.
 *
 * Why fake timers
 *   The ack deadline is the only timer in the module, and the interesting cases
 *   are its edges -- confirmed but still under the batch size, a batch that
 *   reaches the threshold before the deadline, and a deadline that must not fire
 *   after disposal. Those are all orders of events, so time is driven explicitly
 *   rather than slept through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalRouter } from "../terminal.js";
import type {
  TerminalNotice,
  TerminalRouter,
  TerminalRouterOptions,
  TerminalSink,
  TermOutputBody,
} from "../terminal.js";

/** The fixed slice size for `term.output`. */
const SLICE_BYTES = 8 * 1024;

/** The batch size the router defaults to. */
const BATCH_BYTES = 32 * 1024;

/** The default ack deadline, in milliseconds. */
const INTERVAL_MS = 16;

/** 1 MiB: 128 slices, 32 full batches. */
const MEGABYTE = 1024 * 1024;

/** One acknowledgement, as the router emits it. */
interface Ack {
  terminal_id: string;
  bytes: number;
}

/**
 * A sink that records what it was asked to write.
 *
 * With `autoDone` it confirms immediately, like a plain text node. Without it,
 * every `done` is held in {@link RecordingSink.pending} so a test can choose when
 * the write "completes" -- and can assert what the router does before it does.
 */
interface RecordingSink {
  sink: TerminalSink;
  texts: string[];
  pending: (() => void)[];
  /** Confirm every held write, oldest first. */
  settle(): void;
}

/**
 * Build a recording sink.
 *
 * @param options `autoDone: true` confirms each write inside `write`
 * @returns the sink, the recorded text, and the held callbacks
 */
function recordingSink(options: { autoDone?: boolean } = {}): RecordingSink {
  const texts: string[] = [];
  const pending: (() => void)[] = [];

  const sink: TerminalSink = {
    write(text, done) {
      texts.push(text);

      if (options.autoDone === true) {
        done();
      } else {
        pending.push(done);
      }
    },
  };

  return {
    sink,
    texts,
    pending,
    settle(): void {
      for (const done of pending.splice(0)) {
        done();
      }
    },
  };
}

/**
 * Build one output slice.
 *
 * @param terminalId the terminal it belongs to
 * @param index zero-based slice index
 * @param total number of slices in the message
 * @param bytes payload size, also the text length
 * @returns a body shaped like the protocol's `term.output`
 */
function slice(terminalId: string, index: number, total: number, bytes: number): TermOutputBody {
  return {
    terminal_id: terminalId,
    slice: index,
    slices: total,
    offset: index * bytes,
    bytes,
    final: index === total - 1,
    text: "x".repeat(bytes),
  };
}

/** A router plus the two channels it reports through. */
interface Harness {
  router: TerminalRouter;
  acks: Ack[];
  notices: TerminalNotice[];
}

/**
 * Build a router whose ack and notice sinks record into arrays.
 *
 * @param options overrides for the batching policy
 * @returns the router and its recorded output
 */
function harness(options: Partial<TerminalRouterOptions> = {}): Harness {
  const acks: Ack[] = [];
  const notices: TerminalNotice[] = [];

  const router = createTerminalRouter({
    ack: (ack) => acks.push(ack),
    onNotice: (notice) => notices.push(notice),
    ...options,
  });

  return { router, acks, notices };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("deliver: writes and batched acknowledgement", () => {
  it("writes every slice of a 1 MiB payload and acks 32 times, not once per slice", () => {
    const { router, acks } = harness();
    const target = recordingSink({ autoDone: true });
    const slices = MEGABYTE / SLICE_BYTES;

    router.register("t-1", target.sink);

    for (let index = 0; index < slices; index += 1) {
      router.deliver(slice("t-1", index, slices, SLICE_BYTES));
    }

    // The text is handed over whole and in order; the router neither rewrites
    // nor drops it.
    expect(target.texts).toHaveLength(slices);
    expect(target.texts.every((text) => text.length === SLICE_BYTES)).toBe(true);
    expect(target.texts.join("")).toHaveLength(MEGABYTE);

    // One ack per full batch, and the bytes add up to exactly the payload.
    expect(acks).toHaveLength(MEGABYTE / BATCH_BYTES);
    expect(acks).toHaveLength(32);
    expect(acks.every((ack) => ack.terminal_id === "t-1")).toBe(true);
    expect(acks.every((ack) => ack.bytes === BATCH_BYTES)).toBe(true);
    expect(acks.reduce((sum, ack) => sum + ack.bytes, 0)).toBe(MEGABYTE);
    expect(acks.length).toBeLessThan(slices);

    // A full batch acks on the confirming call, so nothing is left to a timer.
    expect(vi.getTimerCount()).toBe(0);
    expect(router.stats).toEqual({
      delivered: slices,
      noSink: 0,
      ackedBytes: MEGABYTE,
      notices: 0,
    });
  });

  it("does not ack before the sink confirms, and flushes on the interval", () => {
    const { router, acks } = harness();
    const target = recordingSink();

    router.register("t-1", target.sink);
    router.deliver(slice("t-1", 0, 1, SLICE_BYTES));

    expect(target.pending).toHaveLength(1);

    // No confirmation means no queue entry and no timer: advancing time cannot
    // acknowledge text the sink has not rendered.
    vi.advanceTimersByTime(100);
    expect(acks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    target.settle();

    // Confirmed, but under the batch size: the ack waits for the deadline.
    expect(acks).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(INTERVAL_MS - 1);
    expect(acks).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(acks).toEqual([{ terminal_id: "t-1", bytes: SLICE_BYTES }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(router.stats.ackedBytes).toBe(SLICE_BYTES);

    // A second slice opens a fresh batch and a fresh deadline.
    router.deliver(slice("t-1", 1, 2, SLICE_BYTES));
    target.settle();
    expect(acks).toHaveLength(1);

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(acks).toEqual([
      { terminal_id: "t-1", bytes: SLICE_BYTES },
      { terminal_id: "t-1", bytes: SLICE_BYTES },
    ]);
  });

  it("acks immediately when a batch crosses the threshold, even with a deadline armed", () => {
    const { router, acks } = harness();
    const target = recordingSink({ autoDone: true });

    router.register("t-1", target.sink);

    // Three slices arm the deadline; the fourth crosses 32 KiB.
    for (let index = 0; index < 4; index += 1) {
      router.deliver(slice("t-1", index, 4, SLICE_BYTES));
    }

    expect(acks).toEqual([{ terminal_id: "t-1", bytes: BATCH_BYTES }]);
    expect(vi.getTimerCount()).toBe(0);

    // The flushed deadline must not fire a second, empty ack.
    vi.advanceTimersByTime(INTERVAL_MS * 4);
    expect(acks).toHaveLength(1);
  });

  it("honours an explicit batch size and interval", () => {
    const { router, acks } = harness({ batchBytes: 1024, intervalMs: 5 });
    const target = recordingSink({ autoDone: true });

    router.register("t-1", target.sink);
    router.deliver(slice("t-1", 0, 2, 1024));

    expect(acks).toEqual([{ terminal_id: "t-1", bytes: 1024 }]);

    router.deliver(slice("t-1", 1, 2, 100));
    expect(acks).toHaveLength(1);

    vi.advanceTimersByTime(5);
    expect(acks).toEqual([
      { terminal_id: "t-1", bytes: 1024 },
      { terminal_id: "t-1", bytes: 100 },
    ]);
  });

  it("acks a write whose sink calls done twice only once", () => {
    const { router, acks } = harness();
    const sink: TerminalSink = {
      write(_text, done) {
        done();
        done();
      },
    };

    router.register("t-1", sink);
    router.deliver(slice("t-1", 0, 1, 2 * SLICE_BYTES));

    expect(acks).toEqual([]);

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(acks).toEqual([{ terminal_id: "t-1", bytes: 2 * SLICE_BYTES }]);
  });
});

describe("deliver: no sink", () => {
  it("counts the slice instead of buffering it, acking it or throwing", () => {
    const { router, acks } = harness();

    expect(() => {
      router.deliver(slice("ghost", 0, 1, SLICE_BYTES));
    }).not.toThrow();

    expect(router.stats).toEqual({
      delivered: 0,
      noSink: 1,
      ackedBytes: 0,
      notices: 0,
    });

    // Not buffered: there is nothing for a later timer to acknowledge.
    vi.advanceTimersByTime(INTERVAL_MS * 4);
    expect(acks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still delivers to the terminals that do have a sink", () => {
    const { router, acks } = harness();
    const target = recordingSink({ autoDone: true });

    router.register("t-1", target.sink);
    router.deliver(slice("ghost", 0, 1, SLICE_BYTES));
    router.deliver(slice("t-1", 0, 1, SLICE_BYTES));

    expect(target.texts).toHaveLength(1);
    expect(router.stats.noSink).toBe(1);

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(acks).toEqual([{ terminal_id: "t-1", bytes: SLICE_BYTES }]);
  });
});

describe("two terminals", () => {
  it("batches and acknowledges each terminal on its own", () => {
    const { router, acks } = harness();
    const first = recordingSink({ autoDone: true });
    const second = recordingSink();

    router.register("t-a", first.sink);
    router.register("t-b", second.sink);

    // t-a reaches the batch size on its own; t-b has confirmed 1 KiB only.
    for (let index = 0; index < 4; index += 1) {
      router.deliver(slice("t-a", index, 4, SLICE_BYTES));
    }

    router.deliver(slice("t-b", 0, 2, 1024));
    second.settle();

    // t-a's ack must not carry t-b's bytes.
    expect(acks).toEqual([{ terminal_id: "t-a", bytes: BATCH_BYTES }]);

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(acks).toEqual([
      { terminal_id: "t-a", bytes: BATCH_BYTES },
      { terminal_id: "t-b", bytes: 1024 },
    ]);

    expect(router.stats.delivered).toBe(5);
    expect(router.stats.ackedBytes).toBe(BATCH_BYTES + 1024);
  });
});

describe("notice", () => {
  it("forwards the peer's notice and counts it", () => {
    const { router, notices } = harness();

    const first: TerminalNotice = { terminal_id: "t-1", droppedBytes: 4096 };
    router.notice(first);
    router.notice({ terminal_id: "t-2", droppedBytes: 1 });

    expect(notices).toEqual([first, { terminal_id: "t-2", droppedBytes: 1 }]);
    expect(router.stats.notices).toBe(2);
  });

  it("forwards a notice for a terminal that has no sink", () => {
    const { router, notices } = harness();

    router.notice({ terminal_id: "ghost", droppedBytes: 8 });

    expect(notices).toEqual([{ terminal_id: "ghost", droppedBytes: 8 }]);
  });
});

describe("register", () => {
  it("stops delivering to a terminal after its unregister", () => {
    const { router, acks } = harness();
    const target = recordingSink({ autoDone: true });

    const unregister = router.register("t-1", target.sink);
    router.deliver(slice("t-1", 0, 2, SLICE_BYTES));
    expect(target.texts).toHaveLength(1);

    unregister();
    router.deliver(slice("t-1", 1, 2, SLICE_BYTES));

    expect(target.texts).toHaveLength(1);
    expect(router.stats.noSink).toBe(1);
  });

  it("lets the newest sink win and ignores a stale unregister", () => {
    const { router } = harness();
    const first = recordingSink({ autoDone: true });
    const second = recordingSink({ autoDone: true });

    const releaseFirst = router.register("t-1", first.sink);
    const releaseSecond = router.register("t-1", second.sink);

    // The first sink's unregister no longer owns the terminal.
    releaseFirst();
    router.deliver(slice("t-1", 0, 1, SLICE_BYTES));

    expect(first.texts).toHaveLength(0);
    expect(second.texts).toHaveLength(1);

    releaseSecond();
    releaseSecond();
    router.deliver(slice("t-1", 1, 2, SLICE_BYTES));

    expect(second.texts).toHaveLength(1);
    expect(router.stats.noSink).toBe(1);
  });

  it("drops queued bytes when a terminal is unregistered", () => {
    const { router, acks } = harness();
    const target = recordingSink();

    const unregister = router.register("t-1", target.sink);
    router.deliver(slice("t-1", 0, 1, SLICE_BYTES));
    target.settle();

    // Confirmed and waiting on the deadline; the view goes away before it fires.
    expect(vi.getTimerCount()).toBe(1);
    unregister();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(INTERVAL_MS * 4);
    expect(acks).toEqual([]);
  });

  it("still acks bytes a replaced sink had already rendered", () => {
    const { router, acks } = harness();
    const first = recordingSink();
    const second = recordingSink({ autoDone: true });

    router.register("t-1", first.sink);
    router.deliver(slice("t-1", 0, 3, SLICE_BYTES));

    // The sink is replaced while its write is still in flight; the text it
    // rendered is real, so its confirmation must still reach the peer.
    router.register("t-1", second.sink);
    first.settle();

    vi.advanceTimersByTime(INTERVAL_MS);
    expect(acks).toEqual([{ terminal_id: "t-1", bytes: SLICE_BYTES }]);
  });
});

describe("dispose", () => {
  it("releases timers, sinks and queued bytes, and is idempotent", () => {
    const { router, acks } = harness();
    const target = recordingSink({ autoDone: true });

    router.register("t-1", target.sink);
    router.deliver(slice("t-1", 0, 2, SLICE_BYTES));

    expect(vi.getTimerCount()).toBe(1);

    router.dispose();
    router.dispose();

    expect(vi.getTimerCount()).toBe(0);

    // The queued bytes must not be acknowledged once the session is gone.
    vi.advanceTimersByTime(INTERVAL_MS * 4);
    expect(acks).toEqual([]);

    // And the sink is released: later slices are counted, not written.
    router.deliver(slice("t-1", 1, 2, SLICE_BYTES));

    expect(target.texts).toHaveLength(1);
    expect(router.stats.noSink).toBe(1);
    expect(router.stats.ackedBytes).toBe(0);
  });

  it("ignores a confirmation that arrives after disposal", () => {
    const { router, acks } = harness();
    const target = recordingSink();

    router.register("t-1", target.sink);
    router.deliver(slice("t-1", 0, 1, SLICE_BYTES));

    router.dispose();
    target.settle();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(INTERVAL_MS * 4);
    expect(acks).toEqual([]);
  });
});

describe("stats", () => {
  it("is a fresh snapshot that cannot be used to mutate the router", () => {
    const { router } = harness();
    const snapshot = router.stats;

    snapshot.delivered = 99;
    snapshot.ackedBytes = 99;

    expect(router.stats.delivered).toBe(0);
    expect(router.stats.ackedBytes).toBe(0);
    expect(router.stats).not.toBe(snapshot);
  });
});

describe("options", () => {
  it("refuses a batch size that would ack every slice", () => {
    expect(() =>
      createTerminalRouter({
        ack: () => undefined,
        onNotice: () => undefined,
        batchBytes: 0,
      }),
    ).toThrow(RangeError);
  });

  it("refuses a negative deadline", () => {
    expect(() =>
      createTerminalRouter({
        ack: () => undefined,
        onNotice: () => undefined,
        intervalMs: -1,
      }),
    ).toThrow(RangeError);
  });
});
