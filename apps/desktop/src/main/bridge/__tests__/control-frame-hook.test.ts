/**
 * The submit path's control-frame hook, exercised through the real `wireBridge`.
 *
 * The hook's two claims are ordering claims, not type claims, so they can only be
 * made end to end: a consumed frame must not reach the host (which would number
 * it and send it back to the renderer that asked), and an unconsumed one must
 * take exactly the path it took before the hook existed.
 *
 * The Electron module is replaced for the same reason as in the neighbouring
 * wiring tests: `wire.ts` imports `ipcMain` at module scope.
 */

import { createSessionStore } from "@haruyuki/core";
import type { Frame, SessionViewBody } from "@haruyuki/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FRAME_SUBMIT } from "../channels.js";
import { createSessionWiring } from "../../session/wiring.js";
import type { BridgeWiring } from "../wire.js";

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

  return {
    handlers,
    ipcMain: {
      handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
        handlers.set(channel, listener);
      },
      removeHandler(channel: string): void {
        handlers.delete(channel);
      },
    },
  };
});

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0" },
  ipcMain: electronMock.ipcMain,
}));

import { wireBridge } from "../wire.js";

const READY = JSON.stringify({
  v: 1,
  ch: "control",
  seq: 0,
  t: "bridge.ready",
  body: { appVersion: "0.1.0", bridgeVersion: "1" },
});

const SUBSCRIBE = JSON.stringify({
  v: 1,
  ch: "control",
  seq: 0,
  t: "session.subscribe",
  body: { instanceId: "tab-1", selector: "entity.agents", params: {}, active: true },
  reqId: "req-1",
});

/** A window whose `webContents` records what reaches the renderer. */
function createFakeWindow(): {
  window: unknown;
  calls: Array<{ channel: string; payload: unknown }>;
  fireNavigation(): void;
} {
  const contentListeners = new Map<string, (...args: unknown[]) => void>();
  const calls: Array<{ channel: string; payload: unknown }> = [];

  const window = {
    webContents: {
      on(event: string, listener: (...args: unknown[]) => void): void {
        contentListeners.set(event, listener);
      },
      send(channel: string, payload: unknown): void {
        calls.push({ channel, payload });
      },
      isDestroyed: (): boolean => false,
    },
    on(): void {
      // Nothing here needs a `closed` event.
    },
  };

  return {
    window,
    calls,
    fireNavigation(): void {
      contentListeners.get("did-start-navigation")?.({}, "http://localhost/", false, true);
    },
  };
}

/** Every wiring a test created, so teardown cannot leak handlers. */
const wirings: BridgeWiring[] = [];

afterEach(() => {
  while (wirings.length > 0) wirings.pop()?.dispose();
});

/** Bring one window to an accepted generation. */
function accepted(wiring: BridgeWiring): ReturnType<typeof createFakeWindow> {
  const fake = createFakeWindow();

  wiring.attachWindow(fake.window as unknown as Parameters<BridgeWiring["attachWindow"]>[0]);
  fake.fireNavigation();
  electronMock.handlers.get(FRAME_SUBMIT)?.(null, READY);

  return fake;
}

describe("wireBridge control-frame hook", () => {
  it("carries a session.subscribe to the store and puts one session.view in the renderer", () => {
    const wiring = wireBridge({ coreVersion: "0.1.0", log: () => undefined });
    wirings.push(wiring);

    const sink: Frame[] = [];
    const session = createSessionWiring({
      store: createSessionStore(),
      send: (frame) => {
        sink.push(frame);
        wiring.send(frame);
      },
    });

    wiring.setControlFrameHook(session.onControlFrame);

    const fake = accepted(wiring);

    expect(electronMock.handlers.get(FRAME_SUBMIT)?.(null, SUBSCRIBE)).toEqual({ ok: true });

    const delivered = fake.calls.filter((call) => String(call.payload).includes('"session.view"'));

    expect(sink).toHaveLength(1);
    expect(delivered).toHaveLength(1);

    const frame = sink[0] as Frame<"session.view", SessionViewBody>;

    expect(frame.t).toBe("session.view");
    expect(frame.body.selector).toBe("entity.agents");
    expect(String(delivered[0]?.payload)).toContain('"instanceId":"tab-1"');
  });

  it("leaves every other control frame on the path it took before the hook", () => {
    const wiring = wireBridge({ coreVersion: "0.1.0", log: () => undefined });
    wirings.push(wiring);

    const sink: Frame[] = [];
    const verdicts: boolean[] = [];
    const session = createSessionWiring({
      store: createSessionStore(),
      send: (frame) => {
        sink.push(frame);
        wiring.send(frame);
      },
    });

    // Wrapped so the test can read the hook's own verdict: whether the frame was
    // consumed is the claim, and a spy around it is the only place that answer
    // exists.
    wiring.setControlFrameHook((payload) => {
      const consumed = session.onControlFrame(payload);

      verdicts.push(consumed);

      return consumed;
    });

    accepted(wiring);

    verdicts.length = 0;

    expect(electronMock.handlers.get(FRAME_SUBMIT)?.(null, READY)).toEqual({ ok: true });

    // The handshake's own frame is handed back, not swallowed: the existing path
    // still decides what a second ready means.
    expect(verdicts).toEqual([false]);
    expect(sink).toHaveLength(0);
  });

  it("restores the absent state when the hook is cleared", () => {
    const wiring = wireBridge({ coreVersion: "0.1.0", log: () => undefined });
    wirings.push(wiring);

    const session = createSessionWiring({
      store: createSessionStore(),
      send: (frame) => wiring.send(frame),
    });

    wiring.setControlFrameHook(session.onControlFrame);
    wiring.setControlFrameHook(null);

    const fake = accepted(wiring);
    const before = fake.calls.length;

    // With no consumer installed the request takes the submit path again, which
    // numbers it and echoes it back to the renderer.
    electronMock.handlers.get(FRAME_SUBMIT)?.(null, SUBSCRIBE);

    const echoed = fake.calls
      .slice(before)
      .filter((call) => String(call.payload).includes("session."));

    expect(echoed).toHaveLength(1);
  });
});
