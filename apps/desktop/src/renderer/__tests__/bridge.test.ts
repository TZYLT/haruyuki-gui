import { describe, expect, it, vi } from "vitest";

import { BRIDGE_CHANNEL_NAMES } from "../../shared/bridge.js";
import { createRendererBridge, type RendererBridgeSurface } from "../bridge.js";
import type { TerminalRouter } from "@haruyuki/ui";

/** A bridge surface whose subscriptions can be driven by the test. */
function fakeBridge(): {
  surface: RendererBridgeSurface;
  handlers: Map<string, Array<(payload: unknown) => void>>;
  invoke: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();

  const invoke = vi.fn(() => Promise.resolve({ ok: true }));

  const surface: RendererBridgeSurface = {
    invoke,
    on(channel, listener) {
      handlers.set(channel, [...(handlers.get(channel) ?? []), listener]);

      return () => {
        handlers.set(
          channel,
          (handlers.get(channel) ?? []).filter((candidate) => candidate !== listener),
        );
      };
    },
  };

  return { surface, handlers, invoke };
}

/** A terminal router that records deliveries instead of writing to xterm. */
function fakeTerminal(): { terminal: TerminalRouter; delivered: string[] } {
  const delivered: string[] = [];

  return {
    delivered,
    terminal: {
      register: () => () => {},
      deliver: (body) => delivered.push(body.text),
      notice: () => {},
      dispose: () => {},
      stats: { delivered: 0, noSink: 0, ackedBytes: 0, notices: 0 },
    },
  };
}

const BOOT = { appVersion: "0.1.0", bridgeVersion: "1", frameProtocolVersion: 1 };

function termFrame(text: string): string {
  return JSON.stringify({
    v: 1,
    ch: "stream",
    seq: 1,
    t: "term.output",
    body: {
      terminal_id: "t1",
      slice: 0,
      slices: 1,
      offset: 0,
      bytes: text.length,
      final: true,
      text,
    },
  });
}

describe("createRendererBridge", () => {
  it("sends bridge.ready as the first invoke", async () => {
    const { surface, invoke } = fakeBridge();
    const { terminal } = fakeTerminal();

    createRendererBridge({ bridge: surface, boot: BOOT, terminal, onNotice: () => {} });
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe(BRIDGE_CHANNEL_NAMES.frameSubmit);
    expect(String(invoke.mock.calls[0]?.[1])).toContain('"bridge.ready"');
  });

  it("routes a term.output frame to the terminal router", () => {
    const { surface, handlers } = fakeBridge();
    const { terminal, delivered } = fakeTerminal();

    createRendererBridge({ bridge: surface, boot: BOOT, terminal, onNotice: () => {} });

    const listener = handlers.get(BRIDGE_CHANNEL_NAMES.frameDeliver.stream)?.[0];
    listener?.(termFrame("hello"));

    expect(delivered).toEqual(["hello"]);
  });

  it("does not route a non-terminal stream frame", () => {
    const { surface, handlers } = fakeBridge();
    const { terminal, delivered } = fakeTerminal();

    createRendererBridge({ bridge: surface, boot: BOOT, terminal, onNotice: () => {} });

    const listener = handlers.get(BRIDGE_CHANNEL_NAMES.frameDeliver.stream)?.[0];
    listener?.(
      JSON.stringify({ v: 1, ch: "stream", seq: 1, t: "something.else", body: { text: "x" } }),
    );

    expect(delivered).toEqual([]);
  });

  it("passes a terminal notice to onNotice", () => {
    const { surface, handlers } = fakeBridge();
    const { terminal } = fakeTerminal();
    const onNotice = vi.fn();

    createRendererBridge({ bridge: surface, boot: BOOT, terminal, onNotice });

    handlers.get(BRIDGE_CHANNEL_NAMES.terminalNotice)?.[0]?.({
      terminal_id: "t1",
      droppedBytes: 4096,
    });

    expect(onNotice).toHaveBeenCalledWith({ terminal_id: "t1", droppedBytes: 4096 });
  });

  it("ignores deliveries after dispose", () => {
    const { surface, handlers } = fakeBridge();
    const { terminal, delivered } = fakeTerminal();

    const bridge = createRendererBridge({
      bridge: surface,
      boot: BOOT,
      terminal,
      onNotice: () => {},
    });
    const listener = handlers.get(BRIDGE_CHANNEL_NAMES.frameDeliver.stream)?.[0];

    bridge.dispose();
    listener?.(termFrame("late"));

    expect(delivered).toEqual([]);
    expect(handlers.get(BRIDGE_CHANNEL_NAMES.frameDeliver.stream)).toHaveLength(0);
  });

  it("refuses a garbled boot instead of starting a dead bridge", () => {
    const { surface } = fakeBridge();
    const { terminal } = fakeTerminal();

    expect(() =>
      createRendererBridge({
        bridge: surface,
        boot: { ...BOOT, frameProtocolVersion: Number.NaN },
        terminal,
        onNotice: () => {},
      }),
    ).toThrow(RangeError);
  });
});
