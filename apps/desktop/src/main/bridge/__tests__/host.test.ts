import { describe, expect, it, vi } from "vitest";

import type { Frame } from "@haruyuki/protocol";

import { createBridgeHost } from "../host.js";
import { BRIDGE_NO_SESSION, type SendTarget } from "../types.js";

const READY = JSON.stringify({
  v: 1,
  ch: "control",
  seq: 0,
  t: "bridge.ready",
  body: { appVersion: "0.1.0", bridgeVersion: "1" },
});

const BULK: Frame = {
  v: 1,
  ch: "bulk",
  seq: 0,
  t: "bulk.page",
  body: { items: [], page: 0 },
} as Frame;

const TERM: Frame = {
  v: 1,
  ch: "stream",
  seq: 0,
  t: "term.output",
  body: {
    terminal_id: "t1",
    slice: 0,
    slices: 1,
    offset: 0,
    bytes: 5,
    final: true,
    text: "hello",
  },
} as Frame;

function fakeTarget(): { target: SendTarget; calls: Array<{ channel: string; payload: unknown }> } {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  let destroyed = false;

  return {
    calls,
    target: {
      isDestroyed: () => destroyed,
      send: (channel, payload) => calls.push({ channel, payload }),
    },
  };
}

function createHost() {
  return createBridgeHost({
    expectedBridgeVersion: "1",
    coreVersion: "0.1.0",
    bulkPages: 0,
  });
}

describe("createBridgeHost", () => {
  it("accepts when the renderer's ready matches", () => {
    const host = createHost();
    const { target, calls } = fakeTarget();

    host.attach(target, "boot");
    host.submit(READY);

    expect(host.stats.accepted).toBe(true);
    expect(calls.some((call) => String(call.payload).includes('"bridge.accept"'))).toBe(true);
  });

  it("delivers a non-terminal frame after accept", () => {
    const host = createHost();
    const { target, calls } = fakeTarget();

    host.attach(target, "boot");
    host.submit(READY);
    host.send(BULK);

    const delivered = calls.filter((call) => call.channel === "bridge:bulk.frame.deliver");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload).toContain('"bulk.page"');
  });

  it("drops a non-terminal frame before accept", () => {
    const host = createHost();
    const { target, calls } = fakeTarget();

    host.attach(target, "boot");
    host.send(BULK);

    expect(calls).toHaveLength(0);
    expect(host.stats.beforeAccept).toBeGreaterThan(0);
  });

  it("buffers terminal bytes before accept and flushes them after", () => {
    const host = createHost();
    const { target, calls } = fakeTarget();

    host.attach(target, "boot");
    host.send(TERM);

    expect(calls).toHaveLength(0);

    host.submit(READY);

    const streams = calls.filter((call) => call.channel === "bridge:stream.frame.deliver");
    expect(streams).toHaveLength(1);
    expect(streams[0]?.payload).toContain('"term.output"');
  });

  it("delivers a reject even though the session is not accepted", () => {
    const host = createBridgeHost({
      expectedBridgeVersion: "2",
      coreVersion: "0.1.0",
      bulkPages: 0,
    });
    const { target, calls } = fakeTarget();

    host.attach(target, "boot");
    host.submit(READY);

    expect(calls.some((call) => String(call.payload).includes('"bridge.reject"'))).toBe(true);
    expect(host.stats.rejected).toBe(true);
  });

  it("gives the new generation a new accept after detach and reattach", () => {
    const host = createHost();
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

  it("throws BRIDGE_NO_SESSION when the producer sends before attach", () => {
    const host = createHost();

    expect(() => host.send(TERM)).toThrow(BRIDGE_NO_SESSION);
    expect(host.stats.noSession).toBe(1);
  });

  it("does not send to a destroyed target", () => {
    const host = createHost();
    const { target, calls } = fakeTarget();

    host.attach(target, "boot");
    host.submit(READY);
    // A destroyed target is simulated by the target's own flag; the transport
    // and the ingress both check it rather than trusting the window.
    (target as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;

    host.send(BULK);

    expect(calls.filter((call) => call.channel === "bridge:bulk.frame.deliver")).toHaveLength(0);
  });
});
