import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { layoutPath } from "@haruyuki/core";
import type { Frame, LayoutDoc, LayoutSnapshotBody, LayoutState } from "@haruyuki/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BRIDGE_CHANNEL_NAMES } from "../../../shared/bridge.js";
import { FRAME_SUBMIT, LAYOUT_SAVE } from "../channels.js";
import {
  LAYOUT_STATE,
  LAYOUT_UNAVAILABLE,
  registerBridgeIpc,
  type IpcMainLike,
} from "../register.js";
import type { BridgeSessionHost } from "../types.js";
import type { BridgeWiring } from "../wire.js";

/**
 * A recording `electron` module.
 *
 * `wire.ts` imports `ipcMain` at module scope, so the only way to exercise its
 * composition without a browser process is to replace that module. The fake is
 * created through `vi.hoisted` because `vi.mock` is hoisted above the imports
 * that use it.
 */
const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const removed: string[] = [];

  return {
    handlers,
    removed,
    ipcMain: {
      handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
        handlers.set(channel, listener);
      },
      removeHandler(channel: string): void {
        removed.push(channel);
        handlers.delete(channel);
      },
    },
  };
});

vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0" },
  ipcMain: electronMock.ipcMain,
}));

import { createLayoutWiring } from "../../layout/wiring.js";
import { wireBridge } from "../wire.js";

const READY = JSON.stringify({
  v: 1,
  ch: "control",
  seq: 0,
  t: "bridge.ready",
  body: { appVersion: "0.1.0", bridgeVersion: "1" },
});

const DEFAULT_DOC: LayoutDoc = {
  version: 1,
  root: {
    type: "panel",
    id: "p1",
    tabs: [{ tabId: "conversation", pageId: "sample.conversation" }],
    activeTabId: "conversation",
  },
};

const STATE: LayoutState = {
  outcome: "ok",
  writable: true,
  foundVersion: 1,
  unknownPageIds: [],
  revision: 2,
  doc: DEFAULT_DOC,
};

/** A recording `ipcMain`, independent of the mocked Electron one. */
function createFakeIpc(): {
  ipc: IpcMainLike;
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  removed: string[];
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const removed: string[] = [];

  const ipc: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      removed.push(channel);
      handlers.delete(channel);
    },
  };

  return { ipc, handlers, removed };
}

/** A host whose channels are spies; the rest is inert. */
function createFakeHost(): BridgeSessionHost {
  return {
    send: vi.fn(),
    stats: {
      generation: 0,
      accepted: false,
      rejected: false,
      beforeAccept: 0,
      noSession: 0,
      closeFailures: 0,
    },
    attach: vi.fn(),
    detach: vi.fn(),
    submit: vi.fn(),
    ack: vi.fn(),
    dispose: vi.fn(),
  };
}

/** A BrowserWindow-shaped object that records what reaches the renderer. */
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
      // `closed` and friends; nothing in these tests needs to fire them.
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

/** The wireBridge wirings a test created, so teardown cannot leak handlers. */
const wirings: BridgeWiring[] = [];
/** The temp directory the integration case created, if any. */
let tempRoot: string | null = null;

afterEach(async () => {
  while (wirings.length > 0) wirings.pop()?.dispose();

  if (tempRoot !== null) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("registerBridgeIpc layout.state", () => {
  it("keeps the handler's channel identical to the shared allowlist name", () => {
    expect(LAYOUT_STATE).toBe(BRIDGE_CHANNEL_NAMES.layoutState);
  });

  it("refuses with LAYOUT_UNAVAILABLE when no provider was injected", () => {
    const { ipc, handlers } = createFakeIpc();
    registerBridgeIpc({ ipc, host: createFakeHost() });

    expect(handlers.get(LAYOUT_STATE)?.(null)).toEqual({
      ok: false,
      code: LAYOUT_UNAVAILABLE,
    });
  });

  it("returns the injected state object unchanged", () => {
    const { ipc, handlers } = createFakeIpc();
    const layoutState = vi.fn(() => STATE);
    registerBridgeIpc({ ipc, host: createFakeHost(), layoutState });

    expect(handlers.get(LAYOUT_STATE)?.(null)).toBe(STATE);
    expect(layoutState).toHaveBeenCalledTimes(1);
  });

  it("turns a throwing provider into a refusal instead of a rejected invoke", () => {
    const { ipc, handlers } = createFakeIpc();
    registerBridgeIpc({
      ipc,
      host: createFakeHost(),
      layoutState: () => {
        throw new Error("not loaded");
      },
    });

    expect(handlers.get(LAYOUT_STATE)?.(null)).toEqual({
      ok: false,
      code: "LAYOUT_STATE_FAILED",
    });
  });

  it("removes the handler on dispose", () => {
    const { ipc, handlers, removed } = createFakeIpc();
    const dispose = registerBridgeIpc({ ipc, host: createFakeHost() });

    dispose();

    expect(handlers.has(LAYOUT_STATE)).toBe(false);
    expect(removed).toContain(LAYOUT_STATE);
  });
});

describe("wireBridge layout providers", () => {
  it("passes both optional providers through to the IPC handlers", async () => {
    const layoutSave = vi.fn(() => ({ ok: true, revision: 1 }));
    const wiring = wireBridge({
      coreVersion: "0.1.0",
      log: () => undefined,
      layoutSave,
      layoutState: () => STATE,
    });
    wirings.push(wiring);

    await expect(
      electronMock.handlers.get(LAYOUT_SAVE)?.(null, { baseRevision: 0 }),
    ).resolves.toEqual({ ok: true, revision: 1 });
    expect(layoutSave).toHaveBeenCalledWith({ baseRevision: 0 });
    expect(electronMock.handlers.get(LAYOUT_STATE)?.(null)).toBe(STATE);
  });

  it("send hands the frame to the host, which delivers it to the renderer", () => {
    const wiring = wireBridge({ coreVersion: "0.1.0", log: () => undefined });
    wirings.push(wiring);

    const fake = createFakeWindow();
    wiring.attachWindow(fake.window as unknown as Parameters<BridgeWiring["attachWindow"]>[0]);
    fake.fireNavigation();
    electronMock.handlers.get(FRAME_SUBMIT)?.(null, READY);

    const frame: Frame = {
      v: 1,
      ch: "bulk",
      seq: 0,
      t: "layout.snapshot",
      body: {
        outcome: "default",
        writable: true,
        foundVersion: null,
        unknownPageIds: [],
        revision: 0,
        items: [DEFAULT_DOC],
      },
    } as Frame;

    wiring.send(frame);

    const delivered = fake.calls.filter((call) => call.channel === "bridge:bulk.frame.deliver");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload).toContain('"layout.snapshot"');
  });
});

describe("createLayoutWiring", () => {
  it("publishes the loaded default document and flushes a save before refusing", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "haruyuki-layout-wiring-"));
    const frames: Frame[] = [];

    const wiring = await createLayoutWiring({
      userData: tempRoot,
      host: { send: (frame) => frames.push(frame) },
      knownPageIds: new Set(["sample.conversation"]),
      defaultDoc: DEFAULT_DOC,
    });

    wiring.publish();

    expect(frames).toHaveLength(1);
    const snapshot = frames[0];
    expect(snapshot?.t).toBe("layout.snapshot");
    expect(snapshot?.ch).toBe("bulk");

    const body = snapshot?.body as LayoutSnapshotBody;
    expect(body.outcome).toBe("default");
    expect(body.writable).toBe(true);
    expect(body.revision).toBe(0);
    expect(body.items).toEqual([DEFAULT_DOC]);

    const next: LayoutDoc = {
      version: 1,
      root: {
        type: "panel",
        id: "p1",
        tabs: [{ tabId: "conversation", pageId: "sample.conversation" }],
        activeTabId: "conversation",
      },
      activePanelId: "p1",
    };

    // Nothing is written until the debounce window closes; `close` flushes it,
    // which is the quit path a durable save has to survive.
    const pending = wiring.channel.handleSave({ baseRevision: 0, doc: next });
    await wiring.close();
    await expect(pending).resolves.toEqual({ ok: true, revision: 1 });

    const onDisk = JSON.parse(await readFile(layoutPath(tempRoot, "desktop"), "utf8")) as LayoutDoc;
    expect(onDisk).toEqual(next);

    // A closed channel must refuse rather than resurrect its save window.
    await expect(wiring.channel.handleSave({ baseRevision: 1, doc: next })).resolves.toMatchObject({
      ok: false,
    });

    // Close stays idempotent after the first call.
    await expect(wiring.close()).resolves.toBeUndefined();
  });
});
