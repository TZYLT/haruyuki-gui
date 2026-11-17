/**
 * Tests for the sink that renders one terminal's output.
 *
 * The claim under test is a negative one, so it is stated as such: a sink must
 * confirm each slice exactly once, and only after the emulator says the slice is
 * painted. Both halves are silent failures in production -- confirming nothing
 * stalls the peer's window, confirming early makes the peer forget bytes the user
 * can still be scrolled to -- so each half gets a case that fails loudly here.
 *
 * Why the acknowledgement threshold is tested against the real router
 *   The sink has no ack channel: it confirms one slice, and the router that handed
 *   the slice over accumulates confirmations into one ack per 32 KiB or per 16 ms.
 *   The threshold therefore belongs to the router, and a second copy in this
 *   module would be a number with two owners that drift the first time either is
 *   tuned. What this file can honestly assert is the integration: a real router
 *   with this sink registered acknowledges at the byte where it says it will, and
 *   acknowledges nothing when the sink withholds its confirmation. That second
 *   case is the one that makes the first meaningful.
 *
 * Why fake timers only where a deadline is involved
 *   The sink's notice window and the router's ack deadline are the only clocks in
 *   play. Every other case is an ordering of calls, so time is driven explicitly
 *   rather than slept through.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTerminalRouter } from "../bridge/terminal.js";
import type { TermOutputBody } from "../bridge/terminal.js";
import { createTerminalSink } from "./sink.js";
import type { TerminalSinkOptions } from "./sink.js";

/** The router's default ack batch, which is the number the contract quotes. */
const BATCH_BYTES = 32 * 1024;

/** One slice's payload, for the threshold arithmetic. */
const SLICE_BYTES = 1024;

/**
 * A write that records its calls and completes only when told to.
 *
 * The completion is held rather than fired so a test can assert what the sink did
 * *before* the emulator reported the text painted -- which is the only moment
 * where an early `done` is distinguishable from a correct one.
 */
interface ManualWrite {
  readonly write: (text: string, done: () => void) => void;
  readonly texts: string[];
  /** Fire the oldest held completion. */
  settle(): void;
  /** Fire every held completion, oldest first. */
  settleAll(): void;
  /** How many completions are outstanding. */
  readonly pending: number;
}

/**
 * @returns a write whose completions the test releases by hand
 */
function manualWrite(): ManualWrite {
  const texts: string[] = [];
  const held: (() => void)[] = [];

  return {
    write: (text, done) => {
      texts.push(text);
      held.push(done);
    },
    texts,
    settle: () => {
      const next = held.shift();

      if (next === undefined) throw new Error("no completion is pending");
      next();
    },
    settleAll: () => {
      while (held.length > 0) held.shift()?.();
    },
    get pending() {
      return held.length;
    },
  };
}

/**
 * @param write the emulator's write
 * @param extra any other option override
 * @returns options for the sink
 */
function options(
  write: (text: string, done: () => void) => void,
  extra: Partial<TerminalSinkOptions> = {},
): TerminalSinkOptions {
  return { write, ...extra };
}

/** @param bytes the slice size @param text the slice text @returns one output slice */
function slice(bytes: number, text = "x".repeat(bytes)): TermOutputBody {
  return {
    terminal_id: "t-1",
    slice: 0,
    slices: 1,
    offset: 0,
    bytes,
    final: true,
    text,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("confirmation follows the paint, never the call", () => {
  it("withholds the confirmation while the emulator has not reported the text painted, because those bytes are not on screen yet", () => {
    const manual = manualWrite();
    const sink = createTerminalSink(options(manual.write));
    const confirmations: number[] = [];

    sink.write("hello", () => confirmations.push(1));

    expect(confirmations).toEqual([]);
    expect(manual.pending).toBe(1);
  });

  it("confirms once the emulator reports the text painted, because that is the moment the bytes are really on screen", () => {
    const manual = manualWrite();
    const sink = createTerminalSink(options(manual.write));
    const confirmations: number[] = [];

    sink.write("hello", () => confirmations.push(1));
    manual.settle();

    expect(confirmations).toEqual([1]);
  });

  it("hands the emulator the text verbatim, because this module is not allowed an opinion about bytes", () => {
    const manual = manualWrite();
    const sink = createTerminalSink(options(manual.write));

    sink.write("汉字 and ascii", () => {});
    sink.write("", () => {});

    expect(manual.texts).toEqual(["汉字 and ascii", ""]);
  });

  it("confirms a slice exactly once even if the emulator re-enters its completion, because a double confirmation acknowledges the same bytes twice", () => {
    // Captured directly rather than through the manual helper, because the point
    // is the same callback fired twice -- the helper deliberately fires each one
    // once and a test built on it could not tell the two apart.
    let completion: (() => void) | undefined;
    const sink = createTerminalSink(
      options((_text, done) => {
        completion = done;
      }),
    );
    const confirmations: number[] = [];

    sink.write("hello", () => confirmations.push(1));
    completion?.();
    completion?.();

    expect(confirmations).toEqual([1]);
    expect(sink.stats.confirmed).toBe(1);
  });

  it("counts the slice in bytes rather than in UTF-16 units, because the peer's window is counted in bytes", () => {
    const manual = manualWrite();
    const sink = createTerminalSink(options(manual.write));

    // Three CJK characters are three bytes each; `length` would say three.
    sink.write("汉", () => {});

    expect(sink.stats.bytes).toBe(3);
  });
});

describe("a renderer that fails does not claim a paint", () => {
  it("never confirms a write that throws, because the callback will never arrive and the bytes were never painted", () => {
    const sink = createTerminalSink(
      options(() => {
        throw new Error("emulator disposed under the write");
      }),
    );
    const confirmations: number[] = [];

    sink.write("hello", () => confirmations.push(1));

    expect(confirmations).toEqual([]);
    expect(sink.stats.abandoned).toBe(1);
    expect(sink.stats.confirmed).toBe(0);
  });

  it("does not throw out of a write, because a sink is called from the router's delivery loop", () => {
    const sink = createTerminalSink(
      options(() => {
        throw new Error("boom");
      }),
    );

    expect(() => sink.write("hello", () => {})).not.toThrow();
  });
});

describe("a disposed sink confirms nothing", () => {
  it("ignores a write after disposal, because a torn-down emulator never calls back", () => {
    const manual = manualWrite();
    const sink = createTerminalSink(options(manual.write));

    sink.write("before", () => {});
    sink.dispose();
    sink.write("after", () => {});

    expect(manual.texts).toEqual(["before"]);
    expect(sink.stats.slices).toBe(1);
  });

  it("drops a completion that arrives after disposal, because there is no longer a view to confirm it for", () => {
    const manual = manualWrite();
    const sink = createTerminalSink(options(manual.write));
    const confirmations: number[] = [];

    sink.write("hello", () => confirmations.push(1));
    sink.dispose();
    manual.settle();

    expect(confirmations).toEqual([]);
    expect(sink.stats.confirmed).toBe(0);
  });

  it("can be disposed more than once, because a teardown path may run twice", () => {
    const sink = createTerminalSink(options(manualWrite().write));

    sink.dispose();
    expect(() => sink.dispose()).not.toThrow();
  });
});

describe("dropped-bytes notices", () => {
  it("paints the marker through the emulator's own write, because the gap belongs where the missing output would have been", () => {
    vi.useFakeTimers();

    const manual = manualWrite();
    const sink = createTerminalSink(
      options(manual.write, { formatNotice: (bytes) => `omitted ${bytes}` }),
    );

    sink.notice({ terminal_id: "t-1", droppedBytes: 4096 });
    vi.advanceTimersByTime(250);

    expect(manual.texts).toEqual(["omitted 4096"]);
    expect(sink.stats.markers).toBe(1);
  });

  it("coalesces a burst into one marker, because one marker per incident scrolls the terminal with explanations of the gap", () => {
    vi.useFakeTimers();

    const manual = manualWrite();
    const sink = createTerminalSink(
      options(manual.write, { formatNotice: (bytes) => `omitted ${bytes}` }),
    );

    sink.notice({ terminal_id: "t-1", droppedBytes: 1000 });
    vi.advanceTimersByTime(100);
    sink.notice({ terminal_id: "t-1", droppedBytes: 2000 });
    sink.notice({ terminal_id: "t-1", droppedBytes: 3000 });
    vi.advanceTimersByTime(200);

    expect(manual.texts).toEqual(["omitted 6000"]);
    expect(sink.stats.notices).toBe(3);
    expect(sink.stats.markers).toBe(1);
  });

  it("does not re-arm the window per report, because a sustained overload would then never paint", () => {
    vi.useFakeTimers();

    const manual = manualWrite();
    const sink = createTerminalSink(
      options(manual.write, { formatNotice: (bytes) => `omitted ${bytes}` }),
    );

    sink.notice({ terminal_id: "t-1", droppedBytes: 1 });
    vi.advanceTimersByTime(200);
    sink.notice({ terminal_id: "t-1", droppedBytes: 1 });

    // The first report's deadline still fires: 250 ms after the burst began, not
    // 250 ms after the last report.
    vi.advanceTimersByTime(50);

    expect(sink.stats.markers).toBe(1);
  });

  it("does not confirm the marker, because those bytes were dropped and confirming the explanation would over-acknowledge", () => {
    vi.useFakeTimers();

    const manual = manualWrite();
    const sink = createTerminalSink(
      options(manual.write, { formatNotice: (bytes) => `omitted ${bytes}` }),
    );

    sink.notice({ terminal_id: "t-1", droppedBytes: 4096 });
    vi.advanceTimersByTime(250);

    // A marker is painted, but it is local text: it must not enter the counters
    // the peer is asked to acknowledge.
    expect(sink.stats.markers).toBe(1);
    expect(sink.stats.bytes).toBe(0);
    expect(sink.stats.confirmed).toBe(0);
    expect(manual.pending).toBe(1);
  });

  it("paints nothing when no marker text was supplied, because a word for it belongs to the message catalogue", () => {
    vi.useFakeTimers();

    const manual = manualWrite();
    const sink = createTerminalSink(options(manual.write));

    sink.notice({ terminal_id: "t-1", droppedBytes: 4096 });
    vi.advanceTimersByTime(250);

    expect(manual.texts).toEqual([]);
    expect(sink.stats.markers).toBe(0);
  });

  it("ignores a notice that reports nothing dropped, because a zero-byte gap is not a gap", () => {
    vi.useFakeTimers();

    const manual = manualWrite();
    const sink = createTerminalSink(
      options(manual.write, { formatNotice: (bytes) => `omitted ${bytes}` }),
    );

    sink.notice({ terminal_id: "t-1", droppedBytes: 0 });
    sink.notice({ terminal_id: "t-1", droppedBytes: -1 });
    sink.notice({ terminal_id: "t-1", droppedBytes: Number.NaN });
    vi.advanceTimersByTime(250);

    expect(manual.texts).toEqual([]);
    expect(sink.stats.notices).toBe(0);
  });

  it("releases the notice timer on disposal, so a torn-down panel leaves no callback behind", () => {
    vi.useFakeTimers();

    const manual = manualWrite();
    const sink = createTerminalSink(
      options(manual.write, { formatNotice: (bytes) => `omitted ${bytes}` }),
    );

    sink.notice({ terminal_id: "t-1", droppedBytes: 4096 });
    sink.dispose();
    vi.advanceTimersByTime(1000);

    expect(manual.texts).toEqual([]);
    expect(sink.stats.unnotifiedBytes).toBe(0);
  });

  it("reports the pending dropped bytes, so a diagnostic can see drops that have not been painted yet", () => {
    vi.useFakeTimers();

    const sink = createTerminalSink(options(manualWrite().write));

    sink.notice({ terminal_id: "t-1", droppedBytes: 4096 });

    expect(sink.stats.unnotifiedBytes).toBe(4096);
  });

  it("rejects a negative notice window instead of silently painting never", () => {
    expect(() => createTerminalSink({ write: () => {}, noticeMs: -1 })).toThrow(RangeError);
  });
});

describe("the router acknowledges where it says it will", () => {
  /**
   * A router with this sink registered, and the acks it emitted.
   *
   * @param sink the sink to register
   * @param bytes the router's ack batch
   * @returns the router, the emitted acks and the sink's registration
   */
  function wire(
    sink: ReturnType<typeof createTerminalSink>,
    bytes = BATCH_BYTES,
  ): {
    router: ReturnType<typeof createTerminalRouter>;
    acks: { terminal_id: string; bytes: number }[];
  } {
    const acks: { terminal_id: string; bytes: number }[] = [];
    const router = createTerminalRouter({
      ack: (ack) => acks.push(ack),
      onNotice: () => {},
      batchBytes: bytes,
      intervalMs: 16,
    });

    router.register("t-1", sink);

    return { router, acks };
  }

  it("emits exactly one ack once the confirmed bytes reach the batch, and one for the remainder after the deadline", () => {
    vi.useFakeTimers();

    const sink = createTerminalSink(options(manualWrite().write));
    const { router, acks } = wire(sink);

    // 40 slices of 1 KiB: 32 of them are exactly one 32 KiB batch.
    for (let index = 0; index < 40; index += 1) {
      router.deliver(slice(SLICE_BYTES));
    }

    expect(acks).toEqual([]);

    // A write that completes synchronously with the delivery is the common case
    // for an emulator whose parser keeps up, so it is reached through a sink over
    // a write that confirms inline.
    const inline = createTerminalSink(options((text, done) => done()));
    const { router: fast, acks: fastAcks } = wire(inline);

    for (let index = 0; index < 32; index += 1) {
      fast.deliver(slice(SLICE_BYTES));
    }

    // The 32nd slice lands exactly on the batch: one ack, at the batch boundary.
    expect(fastAcks).toEqual([{ terminal_id: "t-1", bytes: BATCH_BYTES }]);

    for (let index = 0; index < 8; index += 1) {
      fast.deliver(slice(SLICE_BYTES));
    }

    // 8 KiB is below the batch, so it waits for the deadline.
    expect(fastAcks).toHaveLength(1);
    vi.advanceTimersByTime(16);

    expect(fastAcks).toEqual([
      { terminal_id: "t-1", bytes: BATCH_BYTES },
      { terminal_id: "t-1", bytes: 8 * SLICE_BYTES },
    ]);
  });

  it("acknowledges nothing at all when the sink withholds its confirmation, which is the failure the contract exists to prevent", () => {
    vi.useFakeTimers();

    // This is the red case for the whole module, expressed through a real router:
    // 40 KiB delivered, not one byte acknowledged, because no slice was painted.
    const manual = manualWrite();
    const sink = createTerminalSink(options(manual.write));
    const { router, acks } = wire(sink);

    for (let index = 0; index < 40; index += 1) {
      router.deliver(slice(SLICE_BYTES));
    }

    vi.advanceTimersByTime(1000);

    expect(acks).toEqual([]);
    expect(sink.stats.confirmed).toBe(0);
    expect(router.stats.delivered).toBe(40);
    expect(router.stats.ackedBytes).toBe(0);
  });

  it("acknowledges once the same writes are confirmed, so the withholding above is the only difference", () => {
    vi.useFakeTimers();

    const manual = manualWrite();
    const sink = createTerminalSink(options(manual.write));
    const { router, acks } = wire(sink);

    for (let index = 0; index < 40; index += 1) {
      router.deliver(slice(SLICE_BYTES));
    }

    manual.settleAll();
    vi.advanceTimersByTime(16);

    expect(acks).toEqual([
      { terminal_id: "t-1", bytes: BATCH_BYTES },
      { terminal_id: "t-1", bytes: 8 * SLICE_BYTES },
    ]);
    expect(router.stats.ackedBytes).toBe(40 * SLICE_BYTES);
  });

  it("acknowledges a CJK payload by its byte count, because that is what the peer's window holds", () => {
    vi.useFakeTimers();

    const sink = createTerminalSink(options((text, done) => done()));
    const { router, acks } = wire(sink, 1024);

    // Four CJK characters are 12 bytes; a router counting `length` would see 4.
    router.deliver(slice(12, "汉字汉字"));
    vi.advanceTimersByTime(16);

    expect(acks).toEqual([{ terminal_id: "t-1", bytes: 12 }]);
    expect(sink.stats.bytes).toBe(12);
  });
});
