import { describe, expect, it, vi } from "vitest";

import { FRAME_DELIVER } from "../channels.js";
import { createBridgeTransport } from "../transport.js";
import type { SendTarget } from "../types.js";

/** A target that records every call and can be marked destroyed mid-test. */
interface FakeTarget extends SendTarget {
  readonly calls: { channel: string; payload: unknown }[];
  destroyed: boolean;
}

function createFakeTarget(): FakeTarget {
  const calls: { channel: string; payload: unknown }[] = [];
  const target: FakeTarget = {
    calls,
    destroyed: false,
    isDestroyed: () => target.destroyed,
    send: (channel, payload) => {
      calls.push({ channel, payload });
    },
  };

  return target;
}

/**
 * Hand-written payloads rather than `JSON.stringify`: a fixture produced by
 * stringify could never catch the bug these tests exist for.
 */
const CONTROL = '{"v":1,"ch":"control","seq":11,"t":"ui.intent","body":{"action":"open"}}';
const STREAM = '{"v":1,"ch":"stream","seq":12,"t":"stream.progress","body":{"bytes":3}}';
const BULK = '{"v":1,"ch":"bulk","seq":13,"t":"bulk.page","body":{"items":[]}}';

const TERMINAL_BODY = {
  terminal_id: "t1",
  slice: 0,
  slices: 1,
  offset: 0,
  bytes: 2,
  final: true,
  text: "hi",
};

const TERMINAL = `{"v":1,"ch":"stream","seq":14,"t":"term.output","body":${JSON.stringify(TERMINAL_BODY)}}`;

describe("createBridgeTransport delivery", () => {
  it("routes each channel to its delivery channel", () => {
    const target = createFakeTarget();
    const transport = createBridgeTransport();
    transport.attach(target, "boot");

    for (const [channel, payload] of [
      ["control", CONTROL],
      ["stream", STREAM],
      ["bulk", BULK],
    ] as const) {
      transport.deliver(payload);

      expect(target.calls.at(-1)).toEqual({ channel: FRAME_DELIVER[channel], payload });
      expect(target.calls.at(-1)?.payload).toBe(payload);
    }

    expect(transport.stats()).toMatchObject({ sent: 3, parseFailures: 0, beforeAccept: 0 });
  });

  it("forwards whitespace, escape spelling and Unicode byte for byte", () => {
    const payload =
      '{ "v" : 1 , "ch" : "control" , "seq" : 7 , "t" : "ui.intent" , "body" : { "label" : "caf\\u00e9" , "raw" : "😀 a b" } }';
    const target = createFakeTarget();
    const transport = createBridgeTransport();
    transport.attach(target, "boot");

    transport.deliver(payload);

    expect(target.calls).toHaveLength(1);
    expect(target.calls[0]?.payload).toBe(payload);
  });

  it("never re-serializes a payload", () => {
    // This string is not what `JSON.stringify(JSON.parse(...))` produces, so a
    // transport that re-serialized would fail the identity assertion below.
    const payload =
      '{ "ch" : "control" , "seq" : 3 , "t" : "ui.intent" , "body" : { "label" : "caf\\u00e9" } }';
    const target = createFakeTarget();
    const transport = createBridgeTransport();
    transport.attach(target, "boot");

    const stringify = vi.spyOn(JSON, "stringify");
    let received: unknown;

    try {
      transport.deliver(payload);
      received = target.calls[0]?.payload;
    } finally {
      stringify.mockRestore();
    }

    expect(stringify).not.toHaveBeenCalled();
    expect(received).toBe(payload);
    expect(JSON.stringify(JSON.parse(payload))).not.toBe(payload);
  });

  it("keeps call order and does not coalesce", () => {
    const target = createFakeTarget();
    const transport = createBridgeTransport();
    transport.attach(target, "boot");

    const payloads = [CONTROL, STREAM, CONTROL, BULK];

    for (const payload of payloads) transport.deliver(payload);

    expect(target.calls.map((call) => call.payload)).toEqual(payloads);
  });

  it("records the last seq of a frame that crossed IPC", () => {
    const target = createFakeTarget();
    const transport = createBridgeTransport();
    const onTerminal = vi.fn<(payload: string, body: unknown) => void>();

    expect(transport.stats().lastSeq).toBeNull();

    // No target: the frame is dropped, so it must not move the marker.
    transport.deliver(CONTROL);
    expect(transport.stats().lastSeq).toBeNull();

    transport.attach(target, "boot");
    transport.deliver(CONTROL);
    expect(transport.stats().lastSeq).toBe(11);

    // Terminal slices go through the ingress, not IPC; they do not move it.
    const withSink = createBridgeTransport({ onTerminal });
    withSink.attach(target, "boot");
    withSink.deliver(TERMINAL);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(withSink.stats().lastSeq).toBeNull();
  });
});

describe("createBridgeTransport parse failures", () => {
  it("counts and drops payloads that are not frames on a known channel", () => {
    const target = createFakeTarget();
    const transport = createBridgeTransport();
    transport.attach(target, "boot");

    const payloads = [
      "",
      "{not json",
      "null",
      "42",
      '"control"',
      "[]",
      "{}",
      '{"ch":"controlz","seq":1,"t":"ui.intent"}',
      '{"ch":"toString","seq":1}',
      '{"ch":"__proto__","seq":1}',
      '{"ch":1,"seq":1}',
    ];

    for (const payload of payloads) {
      expect(() => transport.deliver(payload)).not.toThrow();
    }

    expect(transport.stats()).toMatchObject({ parseFailures: payloads.length, sent: 0 });
    expect(transport.stats().dropped).toEqual({ control: 0, stream: 0, bulk: 0 });
    expect(target.calls).toEqual([]);
  });

  it("does not move lastSeq on a bad parse", () => {
    const transport = createBridgeTransport();

    transport.deliver('{"ch":"control","seq":99,"t":"ui.intent"');

    expect(transport.stats().lastSeq).toBeNull();
  });
});

describe("createBridgeTransport terminal hand-off", () => {
  it("hands term.output to the terminal sink and never to a frame channel", () => {
    const target = createFakeTarget();
    const onTerminal = vi.fn<(payload: string, body: unknown) => void>();
    // The gate is closed on purpose: terminal bytes are accepted before the
    // handshake, which is the whole reason they have their own ingress.
    const transport = createBridgeTransport({ onTerminal, isAccepted: () => false });
    transport.attach(target, "boot");

    transport.deliver(TERMINAL);

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(TERMINAL, TERMINAL_BODY);
    expect(target.calls).toEqual([]);
    expect(transport.stats()).toMatchObject({
      sent: 0,
      beforeAccept: 0,
      parseFailures: 0,
      lastSeq: null,
    });
    expect(transport.stats().dropped).toEqual({ control: 0, stream: 0, bulk: 0 });
  });

  it("accepts term.output with no renderer attached", () => {
    const onTerminal = vi.fn<(payload: string, body: unknown) => void>();
    const transport = createBridgeTransport({ onTerminal });

    transport.deliver(TERMINAL);

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(transport.stats().dropped).toEqual({ control: 0, stream: 0, bulk: 0 });
  });

  it("counts a term.output with no sink as dropped", () => {
    const transport = createBridgeTransport();

    transport.deliver(TERMINAL);

    expect(transport.stats().dropped.stream).toBe(1);
    expect(transport.stats()).toMatchObject({ sent: 0, parseFailures: 0 });
  });
});

describe("createBridgeTransport acceptance gate", () => {
  it("drops non-terminal frames before acceptance and delivers after", () => {
    let accepted = false;
    const target = createFakeTarget();
    const transport = createBridgeTransport({ isAccepted: () => accepted });
    transport.attach(target, "boot");

    transport.deliver(CONTROL);

    expect(target.calls).toEqual([]);
    expect(transport.stats()).toMatchObject({ beforeAccept: 1, sent: 0 });
    expect(transport.stats().dropped).toEqual({ control: 0, stream: 0, bulk: 0 });

    accepted = true;
    transport.deliver(CONTROL);

    expect(target.calls).toHaveLength(1);
    expect(transport.stats()).toMatchObject({ beforeAccept: 1, sent: 1 });
  });

  it("delivers when no gate is injected", () => {
    const target = createFakeTarget();
    const transport = createBridgeTransport();
    transport.attach(target, "boot");

    transport.deliver(CONTROL);

    expect(target.calls).toHaveLength(1);
    expect(transport.stats()).toMatchObject({ beforeAccept: 0, sent: 1 });
  });
});

describe("createBridgeTransport missing targets", () => {
  it("counts frames that arrive with no target", () => {
    const transport = createBridgeTransport();

    transport.deliver(CONTROL);
    transport.deliver(BULK);

    expect(transport.stats().dropped).toEqual({ control: 1, stream: 0, bulk: 1 });
    expect(transport.stats().sent).toBe(0);
  });

  it("counts a destroyed target per channel without throwing", () => {
    const target = createFakeTarget();
    const transport = createBridgeTransport();
    transport.attach(target, "boot");
    target.destroyed = true;

    expect(() => transport.deliver(STREAM)).not.toThrow();
    expect(() => transport.deliver(BULK)).not.toThrow();

    expect(target.calls).toEqual([]);
    expect(transport.stats()).toMatchObject({
      sent: 0,
      dropped: { control: 0, stream: 1, bulk: 1 },
    });
  });

  it("stops sending after detach and resumes on the next attach", () => {
    const first = createFakeTarget();
    const second = createFakeTarget();
    const transport = createBridgeTransport();
    transport.attach(first, "boot");

    transport.deliver(CONTROL);
    transport.detach("reload");

    expect(() => transport.deliver(CONTROL)).not.toThrow();
    expect(first.calls).toHaveLength(1);
    expect(transport.stats().dropped.control).toBe(1);

    transport.attach(second, "load");
    transport.deliver(CONTROL);

    expect(second.calls).toHaveLength(1);
    expect(transport.stats().generation).toBe(2);
  });
});

describe("createBridgeTransport lifecycle", () => {
  it("is safe to attach and detach repeatedly", () => {
    const target = createFakeTarget();
    const transport = createBridgeTransport();

    expect(() => transport.detach("close")).not.toThrow();
    expect(() => transport.detach("close")).not.toThrow();

    transport.attach(target, "boot");
    transport.attach(target, "rebuild");

    expect(transport.stats().generation).toBe(2);

    expect(() => transport.detach("crash")).not.toThrow();
    expect(() => transport.detach("reload")).not.toThrow();
    expect(transport.stats().generation).toBe(2);
  });

  it("returns a copy of its stats", () => {
    const transport = createBridgeTransport();
    transport.attach(createFakeTarget(), "boot");

    const snapshot = transport.stats();
    snapshot.sent = 99;
    snapshot.dropped.control = 99;

    expect(transport.stats()).toMatchObject({ sent: 0, dropped: { control: 0 } });
  });

  it("stops delivery after dispose and is idempotent", () => {
    const target = createFakeTarget();
    const onTerminal = vi.fn<(payload: string, body: unknown) => void>();
    const transport = createBridgeTransport({ onTerminal });
    transport.attach(target, "boot");

    transport.dispose();
    transport.dispose();

    transport.deliver(CONTROL);
    transport.deliver(TERMINAL);

    expect(target.calls).toEqual([]);
    expect(onTerminal).not.toHaveBeenCalled();
    expect(transport.stats()).toMatchObject({
      sent: 0,
      dropped: { control: 1, stream: 1, bulk: 0 },
    });
  });

  it("re-arms on attach after dispose", () => {
    // The transport owns no OS resource, so a host that recreates its window
    // after disposing gets a working pipe rather than a silently dead one.
    const target = createFakeTarget();
    const transport = createBridgeTransport();
    transport.attach(target, "boot");
    transport.dispose();

    transport.attach(target, "rebuild");
    transport.deliver(CONTROL);

    expect(target.calls).toHaveLength(1);
    expect(transport.stats()).toMatchObject({ generation: 2, sent: 1 });
  });
});
