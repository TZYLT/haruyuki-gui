/**
 * Tests for the sender's handshake wiring.
 *
 * The rule under test is one sentence: after a `bridge.reject`, this side sends
 * nothing. It was true only inside `handshake.test.ts` -- the state machine
 * answered correctly, but no production code asked it anything, so a producer
 * that rejected a peer went on emitting every frame it was given. These cases
 * are about the wiring, not the verdict: `./handshake` owns "what is the
 * right answer", and this file owns "does the sender act on it".
 *
 * The transport is injected and collects payloads, so "nothing was sent" is
 * asserted against the boundary that actually ships bytes rather than against a
 * call count inside the sender.
 */

import { describe, expect, it } from "vitest";

import type { BulkFrame, Frame } from "@haruyuki/protocol";

import { createHandshake } from "./handshake";
import { currentSeq } from "./sequencer";
import { createFrameSender } from "./sender";
import type { FrameSender, FrameSenderOptions } from "./sender";

/** One payload the fake transport accepted, decoded back into a frame. */
interface Delivered {
  v: number;
  ch: string;
  seq: number;
  t: string;
  body: Record<string, unknown>;
  reqId?: string;
  page?: { watermark: number; token: string; more: boolean };
}

/** A transport and everything it received. */
interface FakeTransport {
  readonly received: Delivered[];
  readonly payloads: string[];
  readonly send: (payload: string) => void;
}

/** A transport that records what it is given. */
function fakeTransport(): FakeTransport {
  const received: Delivered[] = [];
  const payloads: string[] = [];

  return {
    received,
    payloads,
    send(payload: string): void {
      payloads.push(payload);
      received.push(JSON.parse(payload) as Delivered);
    },
  };
}

/** A bulk frame the sender will page or deliver. */
function bulkFrame(items: readonly unknown[]): BulkFrame {
  return {
    v: 1,
    ch: "bulk",
    seq: 0,
    t: "bulk.page",
    body: { page: 1, items },
  } as BulkFrame;
}

/** Create a sender over a fake transport. */
function senderWith(
  transport: FakeTransport,
  options: Partial<Omit<FrameSenderOptions, "transport">> = {},
): FrameSender {
  return createFrameSender({ transport: transport.send, ...options });
}

/** A sender wired to a real handshake, as a host would wire it. */
function handshakeSender(transport: FakeTransport, expectedBridgeVersion: string): FrameSender {
  return senderWith(transport, {
    handshake: createHandshake({
      expectedBridgeVersion,
      coreVersion: "0.1.0",
      bulkPages: 1,
    }),
  });
}

/** A `bridge.ready` frame as the renderer announces itself. */
function readyFrame(bridgeVersion: string): Frame {
  return {
    v: 1,
    ch: "control",
    seq: 0,
    t: "bridge.ready",
    body: { appVersion: "0.1.0", bridgeVersion },
    reqId: "r1",
  } as Frame;
}

describe("nothing is sent after a reject", () => {
  it("answers a matching ready with exactly one accept, and sends nothing else", () => {
    const transport = fakeTransport();
    const sender = handshakeSender(transport, "1");

    sender.send(readyFrame("1"));

    // One frame: the accept. The ready is not echoed -- it is the peer's
    // announcement, addressed to this side.
    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]?.t).toBe("bridge.accept");
    expect(transport.received[0]?.ch).toBe("control");
  });

  it("answers a mismatched ready with exactly one reject, then goes silent", () => {
    const transport = fakeTransport();
    const sender = handshakeSender(transport, "1");

    sender.send(readyFrame("2"));

    // The reject itself must get out, which is the one frame permitted after
    // deciding to reject.
    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]?.t).toBe("bridge.reject");
    expect(transport.received[0]?.body["code"]).toBe("BRIDGE_VERSION_MISMATCH");

    // And then nothing. Before the handshake was wired in, this sender had no
    // idea a reject had happened and delivered every one of these.
    for (const _attempt of [0, 1, 2]) {
      expect(() => sender.send(readyFrame("2"))).toThrow(/muted/);
      expect(() => sender.send({ ...bulkFrame(["a"]), ch: "bulk" } as never)).toThrow(/muted/);
      expect(() =>
        sender.send({ v: 1, ch: "stream", seq: 0, t: "term.output", body: {} } as never),
      ).toThrow(/muted/);
    }

    expect(transport.received).toHaveLength(1);
    expect(sender.stats.sent).toBe(1);
  });

  it("spends no sequence number on a frame refused after the reject", () => {
    const transport = fakeTransport();
    const sender = handshakeSender(transport, "1");

    sender.send(readyFrame("2"));

    const afterReject = currentSeq();

    expect(() => sender.send({ ...bulkFrame(["a"]) } as never)).toThrow(/muted/);

    // A muted sender must not perturb the one counter every other sender shares.
    expect(currentSeq()).toBe(afterReject);
  });

  it("does not emit anything for a ready it cannot read", () => {
    const transport = fakeTransport();
    const sender = handshakeSender(transport, "1");

    // Not a version problem, so no verdict: the handshake stays waiting and
    // answers nothing. The ready is still not forwarded.
    sender.send({
      v: 1,
      ch: "control",
      seq: 0,
      t: "bridge.ready",
      body: { appVersion: "0.1.0" },
      reqId: "r1",
    } as Frame);

    expect(transport.received).toHaveLength(0);
  });

  it("behaves exactly as before when no handshake is wired", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    // The option is additive: omitting it keeps the previous behaviour, which is
    // what lets existing hosts adopt the guard when they are ready.
    sender.send(readyFrame("2"));

    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]?.t).toBe("bridge.ready");
  });
});
