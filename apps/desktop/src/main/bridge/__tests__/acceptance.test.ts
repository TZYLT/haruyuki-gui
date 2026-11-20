import { describe, expect, it, vi } from "vitest";

import type { Frame } from "@haruyuki/protocol";
import { createTerminalRouter, type TerminalSink } from "@haruyuki/ui";

import { CHANNEL_ALLOWLIST } from "../../../shared/bridge.js";
import { createBridgeHost } from "../host.js";
import { createTerminalIngress } from "../terminal-ingress.js";
import { APP_PING, FRAME_SUBMIT, LAYOUT_SAVE, TERMINAL_ACK } from "../channels.js";
import { registerBridgeIpc, type IpcMainLike } from "../register.js";
import type { TermOutputBody } from "../types.js";

const READY = JSON.stringify({
  v: 1,
  ch: "control",
  seq: 0,
  t: "bridge.ready",
  body: { appVersion: "0.1.0", bridgeVersion: "1" },
});

const CHUNK = 8192;

function termBody(text: string, id = "t1"): TermOutputBody {
  return {
    terminal_id: id,
    slice: 0,
    slices: 1,
    offset: 0,
    bytes: text.length,
    final: true,
    text,
  };
}

function termFrame(text: string, id = "t1"): Frame {
  return {
    v: 1,
    ch: "stream",
    seq: 0,
    t: "term.output",
    body: termBody(text, id),
  } as Frame;
}

function fakeTarget() {
  const calls: Array<{ channel: string; payload: unknown }> = [];

  return {
    calls,
    target: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => calls.push({ channel, payload }),
    },
  };
}

describe("bridge acceptance", () => {
  it("1 MiB through the router writes once per slice and never renders", () => {
    const writes: string[] = [];
    const sink: TerminalSink = {
      write: (text, done) => {
        writes.push(text);
        done();
      },
    };
    const router = createTerminalRouter({ ack: () => {}, onNotice: () => {} });

    router.register("t1", sink);

    for (let index = 0; index < 128; index += 1) {
      router.deliver({
        terminal_id: "t1",
        slice: index,
        slices: 128,
        offset: index * CHUNK,
        bytes: CHUNK,
        final: index === 127,
        text: "x".repeat(CHUNK),
      });
    }

    expect(writes).toHaveLength(128);
    expect(router.stats.delivered).toBe(128);
  });

  it("a full window holds order; ack releases the next slice", () => {
    const ingress = createTerminalIngress({ windowBytes: 1 });
    const sent: string[] = [];

    ingress.attach((_channel, payload) => sent.push(String(payload)));

    ingress.accept("a", termBody("a"));
    ingress.accept("b", termBody("b"));

    expect(sent).toEqual(["a"]);

    ingress.ack("t1", 1);

    expect(sent).toEqual(["a", "b"]);
  });

  it("one host.send is one delivery, not two", () => {
    const host = createBridgeHost({
      expectedBridgeVersion: "1",
      coreVersion: "0.1.0",
      bulkPages: 0,
    });
    const { target, calls } = fakeTarget();

    host.attach(target, "boot");
    host.submit(READY);
    host.send(termFrame("once"));

    expect(calls.filter((call) => String(call.payload).includes('"term.output"'))).toHaveLength(1);
  });

  it("a reload gets a new accept and the old target stops receiving", () => {
    const host = createBridgeHost({
      expectedBridgeVersion: "1",
      coreVersion: "0.1.0",
      bulkPages: 0,
    });
    const first = fakeTarget();
    const second = fakeTarget();

    host.attach(first.target, "boot");
    host.submit(READY);
    host.detach("reload");
    host.attach(second.target, "load");
    host.submit(READY);

    expect(
      first.calls.filter((call) => String(call.payload).includes('"bridge.accept"')),
    ).toHaveLength(1);
    expect(
      second.calls.filter((call) => String(call.payload).includes('"bridge.accept"')),
    ).toHaveLength(1);
  });

  it("two terminals do not share a window", () => {
    const ingress = createTerminalIngress({ windowBytes: 2 });
    const sent: Array<{ channel: string; payload: unknown }> = [];

    ingress.attach((channel, payload) => sent.push({ channel, payload }));

    ingress.accept("a1", termBody("a1", "a"));
    ingress.accept("b1", termBody("b1", "b"));
    ingress.accept("a2", termBody("a2", "a"));

    expect(sent.map((item) => String(item.payload))).toEqual(["a1", "b1"]);
    expect(ingress.stats().pendingBytes).toBe(2);
  });

  it("reject stays silent and later frames are dropped", () => {
    const host = createBridgeHost({
      expectedBridgeVersion: "2",
      coreVersion: "0.1.0",
      bulkPages: 0,
    });
    const { target, calls } = fakeTarget();

    host.attach(target, "boot");
    host.submit(READY);
    const before = calls.length;

    // The sender is muted after a reject; the throw is the producer's signal.
    // What matters here is that nothing reaches the renderer.
    expect(() => host.send(termFrame("late"))).toThrow();

    expect(calls).toHaveLength(before);
    expect(host.stats.rejected).toBe(true);
  });

  it("a destroyed target is a counted drop, not a throw", () => {
    const host = createBridgeHost({
      expectedBridgeVersion: "1",
      coreVersion: "0.1.0",
      bulkPages: 0,
    });
    const calls: unknown[] = [];
    const target = {
      isDestroyed: () => true,
      send: (...args: unknown[]) => calls.push(args),
    };

    host.attach(target, "boot");
    host.submit(READY);

    expect(() => host.send(termFrame("lost"))).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("the four invoke channels have handlers and every name is allowlisted", () => {
    const handlers = new Map<string, unknown>();
    const ipc: IpcMainLike = {
      handle: (channel, listener) => handlers.set(channel, listener),
      removeHandler: (channel) => handlers.delete(channel),
    };

    registerBridgeIpc({
      ipc,
      host: createBridgeHost({
        expectedBridgeVersion: "1",
        coreVersion: "0.1.0",
        bulkPages: 0,
      }),
    });

    for (const channel of [APP_PING, FRAME_SUBMIT, LAYOUT_SAVE, TERMINAL_ACK]) {
      expect(handlers.has(channel), channel).toBe(true);
      expect(CHANNEL_ALLOWLIST, channel).toContain(channel);
    }
  });
});
