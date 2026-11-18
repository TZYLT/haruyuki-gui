/** @vitest-environment jsdom */
/**
 * The transport seam: the listener, the layout store, and the terminal router.
 *
 * These cases are about the wiring rather than about React: a `boot` that arrives
 * through `window` has to be answered, a layout change has to reach the store
 * without touching the page, and a terminal slice has to reach a view without
 * becoming a value anything compares. The store is also read the way a component
 * reads it, so the identity rule `useSyncExternalStore` depends on is proven
 * here rather than assumed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { WEBVIEW_BRIDGE_VERSION, resetWebviewApi, type VsCodeApi } from "../bridge.js";
import { createTransport } from "../transport.js";

/** The boot message a host posts before anything else. */
const BOOT = {
  kind: "boot",
  appVersion: "1.0.0",
  bridgeVersion: WEBVIEW_BRIDGE_VERSION,
  frameProtocolVersion: 1,
} as const;

/** A page handle that records what it was handed. */
function createApi(): { api: VsCodeApi; posted: Record<string, unknown>[] } {
  const posted: Record<string, unknown>[] = [];

  return {
    posted,
    api: {
      postMessage(message: unknown): void {
        posted.push(message as Record<string, unknown>);
      },
    },
  };
}

/**
 * Post a message the way the extension host does.
 *
 * @param data the message
 */
function deliver(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "acquireVsCodeApi");
  resetWebviewApi();
});

describe("webview transport", () => {
  it("answers a boot that arrives through the window with one ready", () => {
    const { api, posted } = createApi();
    const transport = createTransport({ api });

    deliver(BOOT);

    expect(posted).toEqual([
      { kind: "ready", appVersion: "1.0.0", bridgeVersion: WEBVIEW_BRIDGE_VERSION },
    ]);

    // A boot only lets the panel speak. Whether the core accepted it is the
    // core's fact, and it arrives as its own frame.
    expect(transport.bridge.snapshot().state).toBe("waiting");

    deliver({
      kind: "frame",
      channel: "control",
      payload: JSON.stringify({ v: 1, ch: "control", seq: 1, t: "bridge.accept", body: {} }),
    });

    expect(transport.bridge.snapshot().state).toBe("accepted");

    transport.dispose();

    // A disposed transport must not leave a listener behind: the next message
    // would otherwise be routed by a session nobody owns.
    deliver(BOOT);
    expect(posted).toHaveLength(1);
  });

  it("publishes a layout change to the store and to nobody else", () => {
    const { api, posted } = createApi();
    const transport = createTransport({ api });
    const listener = vi.fn();

    transport.layout.subscribe(listener);

    const before = transport.layout.getSnapshot();

    deliver(BOOT);

    // Reading twice with no change in between is the same object, which is what
    // `useSyncExternalStore` compares.
    expect(transport.layout.getSnapshot()).toBe(before);

    transport.layout.setDoc({ ...before.doc });

    const after = transport.layout.getSnapshot();

    expect(after).not.toBe(before);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.doc).not.toBe(before.doc);
    expect(listener).toHaveBeenCalledTimes(1);

    // No save request in this build: the host is not asked to persist anything.
    expect(posted.map((message) => message["kind"])).toEqual(["ready"]);

    transport.dispose();
  });

  it("writes a terminal slice into the registered view and acknowledges it once", () => {
    const { api, posted } = createApi();
    const transport = createTransport({ api });
    const written: string[] = [];

    deliver(BOOT);

    const detach = transport.registerTerminal("t1", (text, done) => {
      written.push(text);
      done();
    });

    deliver({
      kind: "frame",
      channel: "stream",
      payload: JSON.stringify({
        v: 1,
        ch: "stream",
        seq: 1,
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
      }),
    });

    expect(written).toEqual(["hello"]);
    expect(transport.terminalStats.delivered).toBe(1);

    // The acknowledgement is batched by the router, so the message may arrive
    // after this assertion; what matters is that it is one ack, not one per
    // write, and that it names the bytes the view confirmed.
    return vi.waitFor(() => {
      expect(posted.filter((message) => message["kind"] === "terminal.ack")).toEqual([
        { kind: "terminal.ack", terminal_id: "t1", bytes: 5 },
      ]);

      detach();

      // The view is gone, so the next slice is counted as unsinkable and is not
      // buffered for a screen that may never come back.
      deliver({
        kind: "frame",
        channel: "stream",
        payload: JSON.stringify({
          v: 1,
          ch: "stream",
          seq: 2,
          t: "term.output",
          body: {
            terminal_id: "t1",
            slice: 1,
            slices: 2,
            offset: 5,
            bytes: 5,
            final: true,
            text: "again",
          },
        }),
      });

      expect(written).toEqual(["hello"]);
      expect(transport.terminalStats.noSink).toBe(1);

      transport.dispose();
    });
  });

  it("keeps a terminal slice out of the value a consumer compares", () => {
    const { api } = createApi();
    const transport = createTransport({ api });
    const listener = vi.fn();

    // A frame before the boot is refused, so the order here is the real order.
    deliver(BOOT);

    const afterBoot = transport.bridge.snapshot();

    transport.bridge.subscribe(listener);

    deliver({
      kind: "frame",
      channel: "control",
      payload: JSON.stringify({ v: 1, ch: "control", seq: 1, t: "bridge.accept", body: {} }),
    });

    const afterAccept = transport.bridge.snapshot();

    expect(afterAccept).not.toBe(afterBoot);
    expect(afterAccept.state).toBe("accepted");
    expect(listener).toHaveBeenCalledTimes(1);

    deliver({
      kind: "frame",
      channel: "stream",
      payload: JSON.stringify({
        v: 1,
        ch: "stream",
        seq: 2,
        t: "term.output",
        body: {
          terminal_id: "t9",
          slice: 0,
          slices: 1,
          offset: 0,
          bytes: 3,
          final: true,
          text: "abc",
        },
      }),
    });

    // A slice for a terminal nobody renders still must not repaint the shell:
    // the value is the same object and no listener heard about it.
    expect(transport.bridge.snapshot()).toBe(afterAccept);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(transport.bridge.stats().terminalSlices).toBe(1);

    transport.dispose();
  });
});
