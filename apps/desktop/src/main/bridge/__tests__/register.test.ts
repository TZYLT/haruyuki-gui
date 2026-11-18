import { describe, expect, it, vi } from "vitest";

import { APP_PING, FRAME_SUBMIT, LAYOUT_SAVE, TERMINAL_ACK } from "../channels.js";
import {
  BAD_PAYLOAD,
  LAYOUT_STATE,
  LAYOUT_UNAVAILABLE,
  registerBridgeIpc,
  type IpcMainLike,
} from "../register.js";
import type { BridgeSessionHost } from "../types.js";

/** A recording `ipcMain`. */
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

/** A host whose two channels are spies; the rest is inert. */
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

describe("registerBridgeIpc", () => {
  it("registers the five handlers once", () => {
    const { ipc, handlers } = createFakeIpc();
    const host = createFakeHost();

    registerBridgeIpc({ ipc, host });

    expect([...handlers.keys()].sort()).toEqual(
      [APP_PING, FRAME_SUBMIT, LAYOUT_SAVE, LAYOUT_STATE, TERMINAL_ACK].sort(),
    );
  });

  it("answers ping with ok", () => {
    const { ipc, handlers } = createFakeIpc();
    registerBridgeIpc({ ipc, host: createFakeHost() });

    expect(handlers.get(APP_PING)?.(null)).toEqual({ ok: true });
  });

  it("hands a submit payload to the host unchanged", () => {
    const { ipc, handlers } = createFakeIpc();
    const host = createFakeHost();
    registerBridgeIpc({ ipc, host });

    expect(handlers.get(FRAME_SUBMIT)?.(null, "{}")).toEqual({ ok: true });
    expect(host.submit).toHaveBeenCalledWith("{}");
  });

  it("refuses a non-string submit payload without calling the host", () => {
    const { ipc, handlers } = createFakeIpc();
    const host = createFakeHost();
    registerBridgeIpc({ ipc, host });

    expect(handlers.get(FRAME_SUBMIT)?.(null, 42)).toEqual({ ok: false, code: BAD_PAYLOAD });
    expect(host.submit).not.toHaveBeenCalled();
  });

  it("forwards an ack by terminal and byte count", () => {
    const { ipc, handlers } = createFakeIpc();
    const host = createFakeHost();
    registerBridgeIpc({ ipc, host });

    expect(handlers.get(TERMINAL_ACK)?.(null, { terminal_id: "t1", bytes: 8192 })).toEqual({
      ok: true,
    });
    expect(host.ack).toHaveBeenCalledWith("t1", 8192);
  });

  it("refuses malformed acks", () => {
    const { ipc, handlers } = createFakeIpc();
    const host = createFakeHost();
    registerBridgeIpc({ ipc, host });

    for (const payload of [
      null,
      {},
      { terminal_id: "", bytes: 1 },
      { terminal_id: "t", bytes: -1 },
    ]) {
      expect(handlers.get(TERMINAL_ACK)?.(null, payload)).toEqual({
        ok: false,
        code: BAD_PAYLOAD,
      });
    }

    expect(host.ack).not.toHaveBeenCalled();
  });

  it("refuses layout.save explicitly when C4 has not injected a handler", async () => {
    const { ipc, handlers } = createFakeIpc();
    registerBridgeIpc({ ipc, host: createFakeHost() });

    await expect(handlers.get(LAYOUT_SAVE)?.(null, {})).resolves.toEqual({
      ok: false,
      code: LAYOUT_UNAVAILABLE,
    });
  });

  it("uses the injected layout.save and turns a throw into a refusal", async () => {
    const { ipc, handlers } = createFakeIpc();
    const layoutSave = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("x"));
    registerBridgeIpc({ ipc, host: createFakeHost(), layoutSave });

    await expect(handlers.get(LAYOUT_SAVE)?.(null, { a: 1 })).resolves.toEqual({ ok: true });
    expect(layoutSave).toHaveBeenCalledWith({ a: 1 });

    await expect(handlers.get(LAYOUT_SAVE)?.(null, {})).resolves.toEqual({
      ok: false,
      code: "LAYOUT_SAVE_FAILED",
    });
  });

  it("removes every handler and is idempotent", () => {
    const { ipc, removed } = createFakeIpc();
    const dispose = registerBridgeIpc({ ipc, host: createFakeHost() });

    dispose();
    dispose();

    expect(removed.sort()).toEqual(
      [APP_PING, FRAME_SUBMIT, LAYOUT_SAVE, LAYOUT_STATE, TERMINAL_ACK].sort(),
    );
  });
});

describe("registerBridgeIpc control-frame hook", () => {
  it("stops a consumed frame from reaching the host, and answers ok", () => {
    const { ipc, handlers } = createFakeIpc();
    const host = createFakeHost();
    const payload = '{"t":"session.subscribe"}';
    const onControlFrame = vi.fn(() => true);

    registerBridgeIpc({ ipc, host, onControlFrame });

    expect(handlers.get(FRAME_SUBMIT)?.(null, payload)).toEqual({ ok: true });
    expect(onControlFrame).toHaveBeenCalledWith(payload);
    expect(host.submit).not.toHaveBeenCalled();
  });

  it("hands the raw payload over untouched and forwards an unconsumed frame", () => {
    const { ipc, handlers } = createFakeIpc();
    const host = createFakeHost();
    const payload = '{ "t" : "bridge.ready", "body":{"a":1} }';
    const onControlFrame = vi.fn(() => false);

    registerBridgeIpc({ ipc, host, onControlFrame });

    expect(handlers.get(FRAME_SUBMIT)?.(null, payload)).toEqual({ ok: true });
    // Byte for byte: no re-serialization happened on the way to the hook or out
    // of it, so the existing path sees exactly what the renderer sent.
    expect(onControlFrame).toHaveBeenCalledWith(payload);
    expect(host.submit).toHaveBeenCalledWith(payload);
  });

  it("leaves the submit path alone when no hook is injected", () => {
    const { ipc, handlers } = createFakeIpc();
    const host = createFakeHost();

    registerBridgeIpc({ ipc, host });

    expect(handlers.get(FRAME_SUBMIT)?.(null, "{}")).toEqual({ ok: true });
    expect(host.submit).toHaveBeenCalledWith("{}");
  });

  it("forwards the frame when the hook throws instead of failing the invoke", () => {
    const { ipc, handlers } = createFakeIpc();
    const host = createFakeHost();

    registerBridgeIpc({
      ipc,
      host,
      onControlFrame: () => {
        throw new Error("bad hook");
      },
    });

    expect(handlers.get(FRAME_SUBMIT)?.(null, "{}")).toEqual({ ok: true });
    expect(host.submit).toHaveBeenCalledWith("{}");
  });
});
