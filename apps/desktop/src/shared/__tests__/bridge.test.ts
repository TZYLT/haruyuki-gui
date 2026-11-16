import { describe, expect, it, vi } from "vitest";

import {
  BRIDGE_CHANNEL_DENIED,
  BRIDGE_CHANNELS,
  BRIDGE_GLOBAL_NAME,
  type BridgeIpc,
  CHANNEL_ALLOWLIST,
  createBridge,
  guardChannel,
  type HaruyukiBridge,
  validateChannelName,
} from "../bridge.js";

/** An IPC fake that records calls, so the deny path can be shown to skip them. */
function createFakeIpc() {
  const handlers = new Map<string, Array<(event: unknown, payload: unknown) => void>>();

  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve(undefined),
  );

  const on = (channel: string, listener: (event: unknown, payload: unknown) => void): void => {
    handlers.set(channel, [...(handlers.get(channel) ?? []), listener]);
  };

  const removeListener = (
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void => {
    handlers.set(
      channel,
      (handlers.get(channel) ?? []).filter((candidate) => candidate !== listener),
    );
  };

  const ipc: BridgeIpc = { invoke, on, removeListener };

  return { ipc, invoke, handlers };
}

/** The one channel D1 answers, so a test failure names the freeze rather than a literal. */
const PING = "bridge:control.app.ping";

describe("bridge shape", () => {
  it("exposes exactly the three frozen members", () => {
    const { ipc } = createFakeIpc();
    const bridge = createBridge(ipc);

    expect(Object.keys(bridge).sort()).toEqual(["channelAllowlist", "invoke", "on"]);
  });

  it("exposes nothing from Electron such as ipcRenderer or require", () => {
    const { ipc } = createFakeIpc();
    const bridge = createBridge(ipc) as HaruyukiBridge & Record<string, unknown>;

    expect(bridge.ipcRenderer).toBeUndefined();
    expect(bridge.require).toBeUndefined();
    expect(bridge.process).toBeUndefined();
    expect(bridge.Buffer).toBeUndefined();
  });

  it("uses the frozen global name the requirement doc names", () => {
    expect(BRIDGE_GLOBAL_NAME).toBe("haruyuki");
  });
});

describe("channel names", () => {
  it("freezes the three channels and their prefixes from the route doc", () => {
    expect(BRIDGE_CHANNELS).toEqual({
      control: "bridge:control",
      stream: "bridge:stream",
      bulk: "bridge:bulk",
    });
  });

  it("accepts a well-formed name on each of the three channels", () => {
    for (const prefix of Object.values(BRIDGE_CHANNELS)) {
      const result = validateChannelName(`${prefix}.app.ping`);

      expect(result.ok).toBe(true);
    }
  });

  it("accepts kebab-case and digits inside a segment", () => {
    expect(validateChannelName("bridge:stream.delta-batch.pull-2").ok).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(validateChannelName("")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects a whitespace-only name as empty", () => {
    expect(validateChannelName("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects a name with the wrong prefix", () => {
    expect(validateChannelName("ipc:control.app.ping")).toEqual({
      ok: false,
      reason: "wrong-prefix",
    });
  });

  it("rejects a scheme-like prefix", () => {
    // A scheme is the shape an attacker would choose to look familiar while
    // pointing somewhere else entirely.
    expect(validateChannelName("app://haruyuki/control.app.ping")).toEqual({
      ok: false,
      reason: "wrong-prefix",
    });
  });

  it("rejects an unknown channel", () => {
    expect(validateChannelName("bridge:admin.app.ping")).toEqual({
      ok: false,
      reason: "unknown-channel",
    });
  });

  it("rejects a prototype key as an unknown channel", () => {
    // `Object.hasOwn` rather than `in`, so this stays a refusal.
    expect(validateChannelName("bridge:toString.app.ping")).toEqual({
      ok: false,
      reason: "unknown-channel",
    });
  });

  it("rejects a missing action", () => {
    expect(validateChannelName("bridge:control.app")).toEqual({
      ok: false,
      reason: "missing-action",
    });
  });

  it("rejects a bare channel with no domain or action", () => {
    expect(validateChannelName("bridge:control")).toEqual({ ok: false, reason: "missing-action" });
  });

  it("rejects a name containing a space", () => {
    expect(validateChannelName("bridge:control.app.pi ng")).toEqual({
      ok: false,
      reason: "bad-shape",
    });
  });

  it("rejects an uppercase segment", () => {
    expect(validateChannelName("bridge:control.App.ping")).toEqual({
      ok: false,
      reason: "bad-shape",
    });
  });

  it("rejects an extra segment", () => {
    expect(validateChannelName("bridge:control.app.ping.extra")).toEqual({
      ok: false,
      reason: "bad-shape",
    });
  });

  it("rejects a segment with a path separator", () => {
    expect(validateChannelName("bridge:control.app/../../ping")).toEqual({
      ok: false,
      reason: "bad-shape",
    });
  });
});

describe("allowlist", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(CHANNEL_ALLOWLIST)).toBe(true);
  });

  it("cannot be extended through the exported array", () => {
    const mutable = CHANNEL_ALLOWLIST as string[];
    const length = CHANNEL_ALLOWLIST.length;

    expect(() => mutable.push("bridge:control.app.evil")).toThrow();
    expect(CHANNEL_ALLOWLIST).toHaveLength(length);
  });

  it("registers ping plus the D4 diagnostics channels", () => {
    expect(CHANNEL_ALLOWLIST).toEqual([
      PING,
      "bridge:control.diagnostics.export",
      "bridge:control.diagnostics.relaunch",
      "bridge:control.diagnostics.quit",
    ]);
  });

  it("contains only names the validator accepts", () => {
    for (const name of CHANNEL_ALLOWLIST) {
      expect(validateChannelName(name).ok).toBe(true);
    }
  });

  it("is the array the bridge hands the renderer", () => {
    const { ipc } = createFakeIpc();

    expect(createBridge(ipc).channelAllowlist).toBe(CHANNEL_ALLOWLIST);
  });
});

describe("guardChannel", () => {
  it("admits a channel in the allowlist", () => {
    expect(guardChannel(PING)).toEqual({ ok: true, channel: "control" });
  });

  it("rejects a well-formed channel that is not in the allowlist", () => {
    expect(guardChannel("bridge:stream.delta.pull")).toEqual({
      ok: false,
      reason: "not-allowed",
      code: BRIDGE_CHANNEL_DENIED,
    });
  });

  it("rejects a shape violation before consulting the allowlist", () => {
    expect(guardChannel("bridge:bulk")).toEqual({
      ok: false,
      reason: "missing-action",
      code: BRIDGE_CHANNEL_DENIED,
    });
  });

  it("does not admit a channel that merely shares the allowlisted prefix", () => {
    // A prefix test would let this through, which is the whole point of exact
    // membership.
    expect(guardChannel(`${PING}.extra`).ok).toBe(false);
  });
});

describe("invoke", () => {
  it("forwards an allowlisted channel to IPC", async () => {
    const { ipc, invoke } = createFakeIpc();
    const bridge = createBridge(ipc);

    await bridge.invoke(PING, { n: 1 });

    expect(invoke).toHaveBeenCalledWith(PING, { n: 1 });
  });

  it("forwards no argument when no payload was supplied", async () => {
    const { ipc, invoke } = createFakeIpc();

    await createBridge(ipc).invoke(PING);

    expect(invoke).toHaveBeenCalledWith(PING);
  });

  it("rejects a channel outside the allowlist", async () => {
    const { ipc } = createFakeIpc();

    await expect(createBridge(ipc).invoke("bridge:stream.delta.pull")).rejects.toMatchObject({
      code: BRIDGE_CHANNEL_DENIED,
      reason: "not-allowed",
    });
  });

  it("rejects without touching IPC", async () => {
    const { ipc, invoke } = createFakeIpc();

    await expect(createBridge(ipc).invoke("bridge:control.app.nope")).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("on", () => {
  it("delivers the payload without the Electron event", () => {
    const { ipc, handlers } = createFakeIpc();
    const listener = vi.fn();

    createBridge(ipc).on(PING, listener);
    handlers.get(PING)?.[0]?.({ sender: "ignored" }, { pending: 2 });

    expect(listener).toHaveBeenCalledWith({ pending: 2 });
  });

  it("returns an unsubscribe function that removes the wrapper", () => {
    const { ipc, handlers } = createFakeIpc();
    const bridge = createBridge(ipc);

    const unsubscribe = bridge.on(PING, vi.fn());
    expect(handlers.get(PING)).toHaveLength(1);

    unsubscribe();
    expect(handlers.get(PING)).toHaveLength(0);
  });

  it("is idempotent on repeated unsubscribe", () => {
    const { ipc, handlers } = createFakeIpc();
    const unsubscribe = createBridge(ipc).on(PING, vi.fn());

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
    expect(handlers.get(PING)).toHaveLength(0);
  });

  it("keeps two subscriptions to one channel independent", () => {
    const { ipc, handlers } = createFakeIpc();
    const bridge = createBridge(ipc);
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = bridge.on(PING, first);
    bridge.on(PING, second);

    unsubscribeFirst();
    handlers.get(PING)?.[0]?.({}, { ok: true });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ ok: true });
  });

  it("throws on a channel outside the allowlist instead of ignoring it", () => {
    const { ipc, handlers } = createFakeIpc();

    expect(() => createBridge(ipc).on("bridge:bulk.page.pull", vi.fn())).toThrow(
      BRIDGE_CHANNEL_DENIED,
    );
    expect(handlers.size).toBe(0);
  });
});
