import { describe, expect, it } from "vitest";

import { FRAME_DELIVER, TERMINAL_NOTICE } from "../channels.js";
import {
  ACK_INTERVAL_MS,
  ACK_WINDOW_BYTES,
  ACK_BATCH_BYTES,
  NOTICE_COALESCE_MS,
  PENDING_CAP_BYTES,
  createTerminalIngress,
} from "../terminal-ingress.js";
import type { TermOutputBody } from "../types.js";

/** The 8 KB slice size C5 froze for `term.output` (doc 38 section 6.2). */
const CHUNK = 8 * 1024;

/** One sent IPC call, in order. */
interface SentMessage {
  channel: string;
  payload: unknown;
}

/** A recording send function and the list it fills. */
function recorder(): { sent: SentMessage[]; send: (channel: string, payload: unknown) => void } {
  const sent: SentMessage[] = [];

  return {
    sent,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  };
}

/** A minimal well-formed slice; only `terminal_id` and `bytes` matter here. */
function slice(
  terminalId: string,
  bytes: number,
  overrides: Partial<TermOutputBody> = {},
): TermOutputBody {
  return {
    terminal_id: terminalId,
    slice: 0,
    slices: 1,
    offset: 0,
    bytes,
    final: false,
    text: "x".repeat(Math.max(0, Math.min(bytes, 8))),
    ...overrides,
  };
}

describe("terminal ingress constants", () => {
  it("exports the frozen limits", () => {
    expect(ACK_WINDOW_BYTES).toBe(256 * 1024);
    expect(PENDING_CAP_BYTES).toBe(1024 * 1024);
    expect(ACK_BATCH_BYTES).toBe(32 * 1024);
    expect(ACK_INTERVAL_MS).toBe(16);
    expect(NOTICE_COALESCE_MS).toBe(250);
  });
});

describe("createTerminalIngress", () => {
  it("sends inside the window immediately and charges every byte", () => {
    const ingress = createTerminalIngress();
    const sink = recorder();

    ingress.attach(sink.send);

    for (let index = 0; index < 32; index += 1) {
      ingress.accept(`p${index}`, slice("t1", CHUNK));
    }

    expect(sink.sent).toHaveLength(32);
    expect(sink.sent.every((message) => message.channel === FRAME_DELIVER.stream)).toBe(true);
    expect(sink.sent.map((message) => message.payload)).toEqual(
      Array.from({ length: 32 }, (_, index) => `p${index}`),
    );
    expect(ingress.stats()).toEqual({
      terminals: 1,
      sentBytes: ACK_WINDOW_BYTES,
      ackedBytes: 0,
      droppedBytes: 0,
      pendingBytes: 0,
      unackedBytes: ACK_WINDOW_BYTES,
    });
  });

  it("trusts a finite body.bytes and measures text otherwise", () => {
    const ingress = createTerminalIngress({ windowBytes: 10 });

    ingress.attach(recorder().send);

    // Declared 10 for a two-character text: the declared number wins.
    ingress.accept("declared", slice("t1", 10, { text: "ab" }));
    expect(ingress.stats().unackedBytes).toBe(10);

    // NaN falls back to UTF-8: U+00E9 is two bytes.
    ingress.accept("nan", slice("t1", Number.NaN, { text: "\u00e9" }));
    expect(ingress.stats().pendingBytes).toBe(2);

    // A negative number is not a byte count; "abcd" is four bytes.
    ingress.accept("negative", slice("t1", -4, { text: "abcd" }));
    expect(ingress.stats().pendingBytes).toBe(6);
  });

  it("queues past the window and pumps in FIFO order on ack", () => {
    const ingress = createTerminalIngress();
    const sink = recorder();

    ingress.attach(sink.send);

    for (let index = 0; index < 32; index += 1) {
      ingress.accept(`p${index}`, slice("t1", CHUNK));
    }

    ingress.accept("p32", slice("t1", CHUNK));
    ingress.accept("p33", slice("t1", CHUNK));

    expect(sink.sent).toHaveLength(32);
    expect(ingress.stats().pendingBytes).toBe(2 * CHUNK);
    expect(ingress.stats().unackedBytes).toBe(ACK_WINDOW_BYTES);

    ingress.ack("t1", CHUNK);

    expect(sink.sent).toHaveLength(33);
    expect(sink.sent[32]?.payload).toBe("p32");
    expect(ingress.stats().ackedBytes).toBe(CHUNK);
    expect(ingress.stats().pendingBytes).toBe(CHUNK);
    expect(ingress.stats().unackedBytes).toBe(ACK_WINDOW_BYTES);

    ingress.ack("t1", CHUNK);

    expect(sink.sent).toHaveLength(34);
    expect(sink.sent[33]?.payload).toBe("p33");
    expect(ingress.stats().pendingBytes).toBe(0);
  });

  it("clamps unacked at zero when the renderer over-acks", () => {
    const ingress = createTerminalIngress();
    const sink = recorder();

    ingress.attach(sink.send);
    ingress.accept("only", slice("t1", CHUNK));

    ingress.ack("t1", 4 * CHUNK);

    expect(ingress.stats().unackedBytes).toBe(0);
    expect(ingress.stats().ackedBytes).toBe(4 * CHUNK);
  });

  it("drops the oldest queued slices once the cap is passed", () => {
    const ingress = createTerminalIngress({ windowBytes: CHUNK, pendingCapBytes: 2 * CHUNK });
    const sink = recorder();

    ingress.attach(sink.send);

    ingress.accept("head", slice("t1", CHUNK));
    ingress.accept("a", slice("t1", CHUNK));
    ingress.accept("b", slice("t1", CHUNK));

    expect(ingress.stats().pendingBytes).toBe(2 * CHUNK);
    expect(ingress.stats().droppedBytes).toBe(0);

    ingress.accept("c", slice("t1", CHUNK));

    expect(sink.sent.map((message) => message.payload)).toEqual(["head"]);
    expect(ingress.stats().pendingBytes).toBe(2 * CHUNK);
    expect(ingress.stats().droppedBytes).toBe(CHUNK);

    // The oldest remaining slice is the one that pumps next: "a" is gone and
    // the queue still starts at "b".
    ingress.ack("t1", CHUNK);
    expect(sink.sent.map((message) => message.payload)).toEqual(["head", "b"]);

    ingress.accept("d", slice("t1", CHUNK));
    ingress.accept("e", slice("t1", CHUNK));

    expect(ingress.stats().pendingBytes).toBe(2 * CHUNK);
    expect(ingress.stats().droppedBytes).toBe(2 * CHUNK);

    ingress.ack("t1", CHUNK);
    expect(sink.sent.map((message) => message.payload)).toEqual(["head", "b", "d"]);
  });

  it("buffers before the handshake and drains in arrival order on attach", () => {
    const ingress = createTerminalIngress();

    ingress.accept("a", slice("t1", CHUNK));
    ingress.accept("b", slice("t1", CHUNK));

    expect(ingress.stats().pendingBytes).toBe(2 * CHUNK);
    expect(ingress.stats().droppedBytes).toBe(0);
    expect(ingress.stats().sentBytes).toBe(0);

    const sink = recorder();
    ingress.attach(sink.send);

    expect(sink.sent.map((message) => message.payload)).toEqual(["a", "b"]);
    expect(sink.sent.every((message) => message.channel === FRAME_DELIVER.stream)).toBe(true);
    expect(ingress.stats().pendingBytes).toBe(0);
    expect(ingress.stats().unackedBytes).toBe(2 * CHUNK);
    expect(ingress.stats().sentBytes).toBe(2 * CHUNK);
  });

  it("stops sending on detach but keeps the queue for the next attach", () => {
    const ingress = createTerminalIngress({ windowBytes: CHUNK });
    const first = recorder();

    ingress.attach(first.send);
    ingress.accept("a", slice("t1", CHUNK));
    ingress.accept("b", slice("t1", CHUNK));

    ingress.detach();
    ingress.accept("c", slice("t1", CHUNK));

    expect(first.sent.map((message) => message.payload)).toEqual(["a"]);
    expect(ingress.stats().pendingBytes).toBe(2 * CHUNK);

    const second = recorder();
    ingress.attach(second.send);

    // The old renderer's unacked byte died with it, so the new sender starts
    // with a full window and drains the oldest queued slice immediately.
    expect(second.sent.map((message) => message.payload)).toEqual(["b"]);
    expect(ingress.stats().pendingBytes).toBe(CHUNK);

    ingress.ack("t1", CHUNK);

    expect(second.sent.map((message) => message.payload)).toEqual(["b", "c"]);
    expect(ingress.stats().pendingBytes).toBe(0);
  });

  it("gives each terminal its own window and queue", () => {
    const ingress = createTerminalIngress({ windowBytes: CHUNK });
    const sink = recorder();

    ingress.attach(sink.send);

    ingress.accept("t1-a", slice("t1", CHUNK));
    ingress.accept("t1-b", slice("t1", CHUNK));
    ingress.accept("t2-a", slice("t2", CHUNK));

    expect(sink.sent.map((message) => message.payload)).toEqual(["t1-a", "t2-a"]);
    expect(ingress.stats().terminals).toBe(2);
    expect(ingress.stats().pendingBytes).toBe(CHUNK);
    expect(ingress.stats().unackedBytes).toBe(2 * CHUNK);

    // Acking t1 frees only t1's window.
    ingress.ack("t1", CHUNK);

    expect(sink.sent.map((message) => message.payload)).toEqual(["t1-a", "t2-a", "t1-b"]);
    expect(ingress.stats().pendingBytes).toBe(0);
    expect(ingress.stats().unackedBytes).toBe(2 * CHUNK);

    // Acking a terminal that never had bytes is inert, not an error.
    ingress.ack("t9", CHUNK);
    expect(ingress.stats().ackedBytes).toBe(CHUNK);
  });

  it("reports dropped bytes on TERMINAL_NOTICE and clears the debt", () => {
    const ingress = createTerminalIngress({ windowBytes: CHUNK, pendingCapBytes: 2 * CHUNK });
    const sink = recorder();

    ingress.attach(sink.send);
    ingress.accept("head", slice("t1", CHUNK));
    ingress.accept("a", slice("t1", CHUNK));
    ingress.accept("b", slice("t1", CHUNK));
    ingress.accept("c", slice("t1", CHUNK)); // 3 queued -> "a" dropped

    ingress.flushNotices();

    expect(sink.sent.at(-1)).toEqual({
      channel: TERMINAL_NOTICE,
      payload: { terminal_id: "t1", droppedBytes: CHUNK },
    });

    // Nothing new to say: the debt is cleared, not re-sent.
    ingress.flushNotices();
    expect(sink.sent.filter((message) => message.channel === TERMINAL_NOTICE)).toHaveLength(1);

    ingress.accept("d", slice("t1", CHUNK)); // "b" dropped
    ingress.flushNotices();

    const notices = sink.sent.filter((message) => message.channel === TERMINAL_NOTICE);

    expect(notices).toHaveLength(2);
    expect(notices[1]).toEqual({
      channel: TERMINAL_NOTICE,
      payload: { terminal_id: "t1", droppedBytes: CHUNK },
    });
    expect(ingress.stats().droppedBytes).toBe(2 * CHUNK);
  });

  it("reports a drop per terminal rather than one merged total", () => {
    const ingress = createTerminalIngress({ windowBytes: CHUNK, pendingCapBytes: 2 * CHUNK });
    const sink = recorder();

    ingress.attach(sink.send);

    for (const terminalId of ["t1", "t2"]) {
      ingress.accept(`${terminalId}-head`, slice(terminalId, CHUNK));
      ingress.accept(`${terminalId}-a`, slice(terminalId, CHUNK));
      ingress.accept(`${terminalId}-b`, slice(terminalId, CHUNK));
      ingress.accept(`${terminalId}-c`, slice(terminalId, CHUNK));
    }

    ingress.flushNotices();

    const notices = sink.sent.filter((message) => message.channel === TERMINAL_NOTICE);

    expect(notices.map((message) => message.payload)).toEqual([
      { terminal_id: "t1", droppedBytes: CHUNK },
      { terminal_id: "t2", droppedBytes: CHUNK },
    ]);
  });

  it("keeps the notice debt until a sender is attached", () => {
    const ingress = createTerminalIngress({ windowBytes: CHUNK, pendingCapBytes: CHUNK });

    ingress.accept("a", slice("t1", CHUNK));
    ingress.accept("b", slice("t1", CHUNK)); // cap passed: "a" dropped

    ingress.flushNotices();

    expect(ingress.stats().droppedBytes).toBe(CHUNK);

    const sink = recorder();
    ingress.attach(sink.send);

    expect(sink.sent.map((message) => message.payload)).toEqual(["b"]);

    ingress.flushNotices();

    expect(sink.sent[1]).toEqual({
      channel: TERMINAL_NOTICE,
      payload: { terminal_id: "t1", droppedBytes: CHUNK },
    });
  });

  it("bounds the queue, and Infinity is what makes the same traffic unbounded", () => {
    // 10 MiB of 8 KB slices, none acked: the window takes 256 KB, the rest hits
    // the queue.
    const slices = 1280;
    const bounded = createTerminalIngress();
    const unbounded = createTerminalIngress({ pendingCapBytes: Infinity });
    const boundedSink = recorder();
    const unboundedSink = recorder();

    bounded.attach(boundedSink.send);
    unbounded.attach(unboundedSink.send);

    for (let index = 0; index < slices; index += 1) {
      bounded.accept(`b${index}`, slice("bounded", CHUNK));
      unbounded.accept(`u${index}`, slice("unbounded", CHUNK));
    }

    // The normal entry is bounded by PENDING_CAP_BYTES and reports what it lost.
    expect(bounded.stats().pendingBytes).toBe(PENDING_CAP_BYTES);
    expect(bounded.stats().pendingBytes).toBeLessThanOrEqual(PENDING_CAP_BYTES);
    expect(bounded.stats().droppedBytes).toBe((slices - 32 - 128) * CHUNK);
    expect(bounded.stats().sentBytes).toBe(ACK_WINDOW_BYTES);

    // The discriminating expectation: with `pendingCapBytes: Infinity` the same
    // 10 MiB traffic keeps 9.75 MiB queued, so this line fails for the bounded
    // implementation and the cap is proven to be the thing doing the bounding.
    expect(unbounded.stats().pendingBytes).toBe((slices - 32) * CHUNK);
    expect(unbounded.stats().pendingBytes).toBeGreaterThan(PENDING_CAP_BYTES);
    expect(unbounded.stats().droppedBytes).toBe(0);
  });

  it("clears the unacknowledged window on detach but keeps pending bytes", () => {
    const ingress = createTerminalIngress();
    const first = recorder();

    ingress.attach(first.send);
    ingress.accept("a", slice("t1", CHUNK));
    expect(ingress.stats().unackedBytes).toBe(CHUNK);

    ingress.detach();
    expect(ingress.stats().unackedBytes).toBe(0);

    // A slice that arrives while detached waits; the new renderer must start
    // with a full window, not inherit the dead renderer's debt.
    ingress.accept("b", slice("t1", CHUNK));
    expect(ingress.stats().pendingBytes).toBe(CHUNK);

    const second = recorder();
    ingress.attach(second.send);

    expect(second.sent).toHaveLength(1);
    expect(ingress.stats().pendingBytes).toBe(0);
    expect(ingress.stats().unackedBytes).toBe(CHUNK);
  });

  it("clears every bucket on dispose and ignores later accepts", () => {
    const ingress = createTerminalIngress();
    const sink = recorder();

    ingress.attach(sink.send);
    ingress.accept("a", slice("t1", CHUNK));

    ingress.dispose();

    expect(ingress.stats()).toEqual({
      terminals: 0,
      sentBytes: CHUNK,
      ackedBytes: 0,
      droppedBytes: 0,
      pendingBytes: 0,
      unackedBytes: 0,
    });

    expect(() => ingress.accept("b", slice("t2", CHUNK))).not.toThrow();
    expect(ingress.stats().terminals).toBe(0);

    // No sender any more, and no throw: the dispatcher may still call this.
    ingress.flushNotices();
    expect(sink.sent).toHaveLength(1);
  });
});
