/**
 * The runtime channel contract: the three handlers the shell answers, the one
 * push it sends, and nothing else. A typo here would be a button that rejects.
 */

import { describe, expect, it, vi } from "vitest";

import {
  RUNTIME_CHANNELS,
  RUNTIME_FAILED_CHANNEL,
  RUNTIME_LOG_CHANNEL,
  RUNTIME_PICK_CHANNEL,
  RUNTIME_RESET_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
  registerRuntimeChannels,
  type RuntimeChannelHost,
  type RuntimeIpcMain,
  type RuntimePickResult,
  type RuntimeResetResult,
} from "../runtime-channels.js";
import type { RuntimeStatus } from "../runtime.js";

/** A fake `ipcMain` that records handlers by channel. */
function fakeIpc(): {
  ipc: RuntimeIpcMain;
  handlers: Map<string, () => Promise<unknown> | unknown>;
} {
  const handlers = new Map<string, () => Promise<unknown> | unknown>();

  return {
    handlers,
    ipc: {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    },
  };
}

const READY: RuntimeStatus = { phase: "ready", appVersion: "0.1.0", source: "bundled" };

describe("runtime channels", () => {
  it("declares exactly the five channels, frozen", () => {
    expect(RUNTIME_CHANNELS).toEqual([
      "bridge:control.runtime.status",
      "bridge:control.runtime.pick",
      "bridge:control.runtime.reset",
      "bridge:control.runtime.failed",
      "bridge:control.runtime.log",
    ]);
    expect(Object.isFrozen(RUNTIME_CHANNELS)).toBe(true);
  });

  it("registers status, pick, reset and log; failed is a push, not a handler", () => {
    const { ipc, handlers } = fakeIpc();
    const host: RuntimeChannelHost = {
      status: vi.fn(async () => READY),
      pick: vi.fn(async (): Promise<RuntimePickResult> => ({ ok: true, engineDir: "D:/engine" })),
      reset: vi.fn(async (): Promise<RuntimeResetResult> => ({ ok: true })),
      log: vi.fn(async () => ({ ok: true })),
    };

    registerRuntimeChannels(ipc, host);

    expect([...handlers.keys()].sort()).toEqual(
      [
        RUNTIME_LOG_CHANNEL,
        RUNTIME_PICK_CHANNEL,
        RUNTIME_RESET_CHANNEL,
        RUNTIME_STATUS_CHANNEL,
      ].sort(),
    );
    expect(handlers.has(RUNTIME_FAILED_CHANNEL)).toBe(false);
  });

  it("delegates each handler to the host", async () => {
    const { ipc, handlers } = fakeIpc();
    const host: RuntimeChannelHost = {
      status: vi.fn(async () => READY),
      pick: vi.fn(async (): Promise<RuntimePickResult> => ({ ok: true, engineDir: "D:/engine" })),
      reset: vi.fn(async (): Promise<RuntimeResetResult> => ({ ok: true })),
      log: vi.fn(async () => ({ ok: true })),
    };

    registerRuntimeChannels(ipc, host);

    await expect(handlers.get(RUNTIME_STATUS_CHANNEL)!()).resolves.toEqual(READY);
    await expect(handlers.get(RUNTIME_PICK_CHANNEL)!()).resolves.toEqual({
      ok: true,
      engineDir: "D:/engine",
    });
    await expect(handlers.get(RUNTIME_RESET_CHANNEL)!()).resolves.toEqual({ ok: true });
    await expect(handlers.get(RUNTIME_LOG_CHANNEL)!()).resolves.toEqual({ ok: true });
    expect(host.status).toHaveBeenCalledOnce();
    expect(host.pick).toHaveBeenCalledOnce();
    expect(host.reset).toHaveBeenCalledOnce();
    expect(host.log).toHaveBeenCalledOnce();
  });
});
