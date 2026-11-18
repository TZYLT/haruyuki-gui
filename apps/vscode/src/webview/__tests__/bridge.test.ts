/** @vitest-environment jsdom */
/**
 * The webview bridge: the handshake, the routing, and the terminal exception.
 *
 * The bridge is tested without a DOM on purpose -- it talks to a page handle and
 * to `window` messages, and neither is what these tests are about. `jsdom` is
 * the environment because the transport under test is loaded through the same
 * module graph the panel uses, and that graph imports React.
 *
 * Every case injects its own page handle. Nothing here reaches for the host
 * global except the one case whose subject is the acquisition rule.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BRIDGE_VERSION_MISMATCH,
  WEBVIEW_BRIDGE_VERSION,
  createWebviewBridge,
  resetWebviewApi,
  webviewApi,
  type VsCodeApi,
} from "../bridge.js";

/** The boot message a host posts before anything else. */
const BOOT = {
  kind: "boot",
  appVersion: "1.0.0",
  bridgeVersion: WEBVIEW_BRIDGE_VERSION,
  frameProtocolVersion: 1,
} as const;

/** One frame envelope, as the core serializes it. */
function frame(channel: string, type: string, body: unknown, seq = 1): string {
  return JSON.stringify({ v: 1, ch: channel, seq, t: type, body });
}

/** A page handle that records what it was handed. */
function createApi(): { api: VsCodeApi; posted: unknown[] } {
  const posted: unknown[] = [];

  return {
    posted,
    api: {
      postMessage(message: unknown): void {
        posted.push(message);
      },
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "acquireVsCodeApi");
  resetWebviewApi();
});

describe("webview bridge", () => {
  it("acquires the page handle once and reuses it for the session", () => {
    const handle = { postMessage: vi.fn() };
    const acquire = vi.fn(() => handle);

    Reflect.set(globalThis, "acquireVsCodeApi", acquire);
    resetWebviewApi();

    // Two bridges are two mounts of the same page, not two pages: the host
    // allows one acquisition per session, so both must post through one handle.
    const first = createWebviewBridge();
    const second = createWebviewBridge();

    expect(webviewApi()).toBe(handle);
    expect(webviewApi()).toBe(handle);
    expect(acquire).toHaveBeenCalledTimes(1);

    first.receive(BOOT);
    second.receive(BOOT);

    expect(handle.postMessage).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("stops at the first frame when the host announces another version", () => {
    const { api, posted } = createApi();
    const bridge = createWebviewBridge({ api });

    bridge.receive({ ...BOOT, bridgeVersion: "2" });

    const snapshot = bridge.snapshot();

    // The assertion that proves the stop: a terminal verdict carrying the code
    // and the two versions, so a notice can say which side is ahead.
    expect(snapshot).toMatchObject({
      state: "rejected",
      code: BRIDGE_VERSION_MISMATCH,
      versions: { expected: WEBVIEW_BRIDGE_VERSION, actual: "2" },
    });

    // Nothing was announced, and nothing can be: a `ready` would claim this
    // panel can read a protocol it cannot.
    expect(posted).toEqual([]);

    bridge.sendAction("openSettings");
    bridge.ackTerminal({ terminal_id: "t1", bytes: 8 });

    expect(posted).toEqual([]);
    expect(bridge.stats().refused).toBe(2);

    // A later boot cannot revive the verdict: the recovery is a reload.
    bridge.receive(BOOT);
    expect(bridge.snapshot().state).toBe("rejected");
  });

  it("announces itself once per boot and routes frames by channel", () => {
    const { api, posted } = createApi();
    const routed: string[] = [];
    const bridge = createWebviewBridge({ api, onFrame: (frame) => routed.push(frame.type) });

    bridge.receive(BOOT);

    expect(posted).toEqual([
      { kind: "ready", appVersion: "1.0.0", bridgeVersion: WEBVIEW_BRIDGE_VERSION },
    ]);

    bridge.receive({
      kind: "frame",
      channel: "control",
      payload: frame("control", "bridge.accept", {}),
    });
    bridge.receive({
      kind: "frame",
      channel: "bulk",
      payload: frame("bulk", "layout.snapshot", {}, 2),
    });
    bridge.receive({
      kind: "frame",
      channel: "stream",
      payload: frame("stream", "delta.message", {}, 3),
    });

    expect(bridge.snapshot().state).toBe("accepted");
    expect(bridge.stats().routed).toEqual({ control: 0, stream: 1, bulk: 1 });
    expect(routed).toEqual(["layout.snapshot", "delta.message"]);

    // The entry keeps counting every frame it admitted, terminal output included.
    expect(bridge.stats().admitted.perChannel).toEqual({ control: 1, stream: 1, bulk: 1 });
  });

  it("hands terminal bytes to the sink without touching the watched value", () => {
    const { api } = createApi();
    const slices: string[] = [];
    const bridge = createWebviewBridge({ api, onTerminal: (slice) => slices.push(slice.text) });

    bridge.receive(BOOT);

    const before = bridge.snapshot();
    const listener = vi.fn();

    bridge.subscribe(listener);

    for (let index = 0; index < 3; index += 1) {
      bridge.receive({
        kind: "frame",
        channel: "stream",
        payload: frame(
          "stream",
          "term.output",
          {
            terminal_id: "t1",
            slice: index,
            slices: 3,
            offset: 0,
            bytes: 4,
            final: index === 2,
            text: "ok",
          },
          index + 1,
        ),
      });
    }

    expect(slices).toEqual(["ok", "ok", "ok"]);
    expect(bridge.stats().terminalSlices).toBe(3);

    // The value a React consumer reads did not change, so it did not re-render:
    // the same object back, and no notification at all.
    expect(bridge.snapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    // Terminal output is not a routed frame either; only the entry saw it.
    expect(bridge.stats().routed).toEqual({ control: 0, stream: 0, bulk: 0 });
  });

  it("settles one command per call id and refuses a reply nobody asked for", async () => {
    const { api, posted } = createApi();
    const bridge = createWebviewBridge({ api });

    bridge.receive(BOOT);

    const answer = bridge.invoke({ capability: "diagnostics.ping", body: {} });
    const invoke = posted.at(-1);

    expect(invoke).toMatchObject({ kind: "command.invoke", callId: "wv-1" });

    bridge.receive({
      kind: "command.reply",
      callId: "wv-1",
      reply: { ok: true, completion: "accepted" },
    });
    bridge.receive({
      kind: "command.reply",
      callId: "wv-1",
      reply: { ok: true, completion: "accepted" },
    });

    await expect(answer).resolves.toEqual({ ok: true, completion: "accepted" });
    expect(bridge.stats().refused).toBe(1);
  });
});
