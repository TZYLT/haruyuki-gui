/**
 * Tests for the command IPC registration.
 *
 * The handler is thin, so the cases are about the three things thin handlers get
 * wrong: they validate the payload a second time (this one must hand it over
 * unchanged), they let a rejection escape (this one must answer
 * `COMMAND_CHANNEL_UNAVAILABLE`), and they leave a handler behind on dispose
 * (this one must remove exactly the channel it registered).
 *
 * The fake `ipc` keeps the handlers in a map rather than a spy list, because the
 * interesting assertion is "the registered listener, when called, does X" - a
 * spy would only prove registration, not behaviour.
 */

import { describe, expect, it, vi } from "vitest";

import type { CommandReply } from "@haruyuki/core";

import { BRIDGE_CHANNEL_NAMES } from "../../../shared/bridge.js";

import { registerCommandIpc } from "../register.js";
import type { CommandIpcLike } from "../register.js";

type Listener = (event: unknown, payload: unknown) => unknown;

/** A recording `ipcMain`: handlers by channel, removals in order. */
function createFakeIpc(): {
  ipc: CommandIpcLike;
  handlers: Map<string, Listener>;
  removed: string[];
} {
  const handlers = new Map<string, Listener>();
  const removed: string[] = [];

  const ipc: CommandIpcLike = {
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

/** The listener registered on the command channel. */
function commandHandler(handlers: Map<string, Listener>): Listener {
  const listener = handlers.get(BRIDGE_CHANNEL_NAMES.commandInvoke);

  if (listener === undefined) {
    throw new Error("no handler was registered on the command channel");
  }

  return listener;
}

describe("registerCommandIpc", () => {
  it("registers exactly the command channel", () => {
    const { ipc, handlers } = createFakeIpc();

    registerCommandIpc({ ipc, invoke: async () => ({ ok: true, completion: "accepted" }) });

    expect([...handlers.keys()]).toEqual([BRIDGE_CHANNEL_NAMES.commandInvoke]);
  });

  it("hands the payload to invoke unchanged and returns the reply unchanged", async () => {
    const { ipc, handlers } = createFakeIpc();
    const invoke = vi.fn(async (_call: unknown) => ({
      ok: true as const,
      completion: "answered" as const,
      data: { backend: "fake" },
    }));
    const payload = { capability: "device.info", body: { nested: [1, 2] } };

    registerCommandIpc({ ipc, invoke });
    const reply = await commandHandler(handlers)({}, payload);

    // Identity, not equality: the dispatcher is the only component allowed to
    // interpret the payload, and the renderer gets back the value it produced.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe(payload);
    expect(reply).toEqual({ ok: true, completion: "answered", data: { backend: "fake" } });
  });

  it("passes a primitive payload through as well", async () => {
    const { ipc, handlers } = createFakeIpc();
    const invoke = vi.fn(async (_call: unknown) => ({
      ok: true as const,
      completion: "accepted" as const,
    }));

    registerCommandIpc({ ipc, invoke });
    await commandHandler(handlers)({}, "not an envelope");

    expect(invoke.mock.calls[0]?.[0]).toBe("not an envelope");
  });

  it("answers COMMAND_CHANNEL_UNAVAILABLE when invoke rejects, instead of rejecting", async () => {
    const { ipc, handlers } = createFakeIpc();
    const invoke = vi.fn(async (_call: unknown) => {
      throw new Error("dispatcher blew up");
    });

    registerCommandIpc({ ipc, invoke });
    const listener = commandHandler(handlers);

    // A rejection here would reach the renderer as a rejected invoke() and break
    // the three-arm reply contract, so the promise must resolve.
    const reply = await Promise.resolve(listener({}, { capability: "device.info", body: {} }));

    expect(reply).toEqual({ ok: false, code: "COMMAND_CHANNEL_UNAVAILABLE" });
  });

  it("answers the same code when invoke throws synchronously", async () => {
    const { ipc, handlers } = createFakeIpc();
    const invoke: (call: unknown) => Promise<CommandReply> = () => {
      throw new Error("wired wrong");
    };

    registerCommandIpc({ ipc, invoke });
    const reply = await commandHandler(handlers)({}, {});

    expect(reply).toEqual({ ok: false, code: "COMMAND_CHANNEL_UNAVAILABLE" });
  });

  it("removes its handler on dispose, once", () => {
    const { ipc, handlers, removed } = createFakeIpc();

    const dispose = registerCommandIpc({
      ipc,
      invoke: async () => ({ ok: true, completion: "accepted" }),
    });

    expect(handlers.size).toBe(1);

    dispose();
    expect(removed).toEqual([BRIDGE_CHANNEL_NAMES.commandInvoke]);
    expect(handlers.size).toBe(0);

    // Idempotent: a second teardown must not remove a handler that a later
    // registration may have installed on the same channel.
    dispose();
    expect(removed).toEqual([BRIDGE_CHANNEL_NAMES.commandInvoke]);
  });
});
