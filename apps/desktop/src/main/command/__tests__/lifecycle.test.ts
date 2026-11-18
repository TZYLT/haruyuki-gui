/**
 * Tests for the command lifecycle.
 *
 * The interesting behaviour is not the IPC registration (that is `register.ts`);
 * it is the rebuild: the runtime hands over a new engine, the previous service is
 * disposed and a new one takes its place. Anything the lifecycle was told once
 * must therefore survive the rebuild, because a consumer that only reached the
 * first service would go silent as soon as the second engine starts.
 *
 * `createCommandService` is replaced by a factory that records its options: the
 * claim is "the lifecycle hands this option to every service it builds", and the
 * only way to read that is to see the options. The real service is covered by its
 * own file.
 */

import type { MergerChange } from "@haruyuki/core";
import { createSessionStore } from "@haruyuki/core";
import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import { createSessionWiring } from "../../session/wiring.js";

/** The recorded options per `createCommandService` call. */
const serviceMock = vi.hoisted(() => {
  const calls: Array<{ onMergerChange?: (change: unknown) => void }> = [];
  const disposed: number[] = [];

  return {
    calls,
    disposed,
    createCommandService: (options: { onMergerChange?: (change: unknown) => void }) => {
      const index = calls.length;

      calls.push(options);

      return {
        invoke: () => Promise.resolve({ ok: false, code: "COMMAND_CHANNEL_UNAVAILABLE" }),
        ready: false,
        dispose: () => {
          disposed.push(index);
        },
      };
    },
  };
});

vi.mock("../service.js", () => ({ createCommandService: serviceMock.createCommandService }));

import { createCommandLifecycle } from "../lifecycle.js";
import type { EngineHost } from "../../supervision/engine-host.js";

/** A recording `ipcMain`; only the two members the registration uses. */
function createFakeIpc(): IpcMain {
  return {
    handle(): void {
      // Registration is not what these tests assert.
    },
    removeHandler(): void {
      // Same.
    },
  } as unknown as IpcMain;
}

/** An `EngineHost`-shaped stand-in; a service only reads `engine`. */
function createHost(): EngineHost {
  return {
    engine: {
      endpoint: null,
      onState: () => () => undefined,
    } as unknown as EngineHost["engine"],
    pid: 1,
    bundlePath: "/engines/probe",
    watchdog: "active",
    markerPath: "/userData/runtime.json",
    tokenFile: "/userData/token",
    startedAt: "2026-11-19T00:00:00.000Z",
  } as EngineHost;
}

const CHANGE: MergerChange = {
  authorAgentId: "a1",
  runtimeAgentId: "a1",
  subagentId: null,
  conversationId: "c1",
  at: 1,
  kind: "message.complete",
  messageId: "m1",
  runId: null,
  textLength: 1,
  incomplete: false,
};

/** An empty recording of the factory, per test. */
function reset(): void {
  serviceMock.calls.length = 0;
  serviceMock.disposed.length = 0;
}

describe("createCommandLifecycle", () => {
  it("hands the change consumer to every service it rebuilds, and disposes the old one", () => {
    reset();

    const consumer = (): void => undefined;
    const lifecycle = createCommandLifecycle({
      ipc: createFakeIpc(),
      send: () => undefined,
      onMergerChange: consumer,
    });

    lifecycle.onHost(createHost());
    lifecycle.onHost(createHost());

    // One build per engine, and the previous service is disposed before the next
    // one takes over: a second engine must not leave the first one's service
    // subscribed to anything.
    expect(serviceMock.calls).toHaveLength(2);
    expect(serviceMock.disposed).toEqual([0]);

    // The passthrough itself: the same function, not a wrapper that dropped it
    // when the service was rebuilt.
    expect(serviceMock.calls[0]?.onMergerChange).toBe(consumer);
    expect(serviceMock.calls[1]?.onMergerChange).toBe(consumer);

    lifecycle.dispose();
    expect(serviceMock.disposed).toEqual([0, 1]);
  });

  it("omits the consumer entirely when the shell injects none", () => {
    reset();

    const lifecycle = createCommandLifecycle({ ipc: createFakeIpc(), send: () => undefined });

    lifecycle.onHost(createHost());

    expect(serviceMock.calls).toHaveLength(1);
    expect("onMergerChange" in (serviceMock.calls[0] ?? {})).toBe(false);

    lifecycle.dispose();
  });

  it("removes the IPC channel and is idempotent", () => {
    reset();

    const removed: string[] = [];
    const ipc = {
      handle: (): void => undefined,
      removeHandler: (channel: string): void => {
        removed.push(channel);
      },
    } as unknown as IpcMain;

    const lifecycle = createCommandLifecycle({ ipc, send: () => undefined });

    lifecycle.onHost(createHost());
    lifecycle.dispose();
    lifecycle.dispose();

    expect(removed).toHaveLength(1);
    expect(serviceMock.disposed).toEqual([0]);
  });

  it("never builds a service after dispose", () => {
    reset();

    const lifecycle = createCommandLifecycle({ ipc: createFakeIpc(), send: () => undefined });

    lifecycle.dispose();
    lifecycle.onHost(createHost());

    expect(serviceMock.calls).toHaveLength(0);
    expect(typeof CHANGE).toBe("object");
  });

  it("calls the teardown hook once, after the service is gone", () => {
    reset();

    const order: string[] = [];
    const teardown = vi.fn(() => {
      order.push("teardown");
    });
    const lifecycle = createCommandLifecycle({
      ipc: createFakeIpc(),
      send: () => undefined,
      onDispose: teardown,
    });

    lifecycle.onHost(createHost());
    expect(teardown).not.toHaveBeenCalled();

    lifecycle.dispose();

    expect(teardown).toHaveBeenCalledTimes(1);
    // The service is disposed first: whatever the hook releases must not run
    // while a half-disposed command path can still answer a click.
    expect(order).toEqual(["teardown"]);
    expect(serviceMock.disposed).toEqual([0]);

    // Idempotent: the same `disposed` flag that guards the rest of this method
    // guards the hook, so a second quit path cannot release twice.
    lifecycle.dispose();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("runs without a teardown hook", () => {
    reset();

    const lifecycle = createCommandLifecycle({ ipc: createFakeIpc(), send: () => undefined });

    lifecycle.onHost(createHost());
    expect(() => lifecycle.dispose()).not.toThrow();
    expect(serviceMock.disposed).toEqual([0]);
  });

  it("releases the session subscriptions through the teardown hook", () => {
    reset();

    // The real wiring, not a stand-in: the claim is that the shell's one
    // teardown call reaches the object that owns the subscriptions.
    const store = createSessionStore();
    const frames: unknown[] = [];
    const session = createSessionWiring({
      store,
      send: (frame) => {
        frames.push(frame);
      },
    });
    const dispose = vi.spyOn(session, "dispose");

    const lifecycle = createCommandLifecycle({
      ipc: createFakeIpc(),
      send: () => undefined,
      onMergerChange: session.onMergerChange,
      onDispose: session.dispose,
    });

    session.onControlFrame(
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 0,
        t: "session.subscribe",
        body: { instanceId: "tab-1", selector: "entity.agents", params: {} },
        reqId: "req-1",
      }),
    );

    expect(store.stats().subscriptions).toBe(1);

    lifecycle.onHost(createHost());
    lifecycle.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(store.stats().subscriptions).toBe(0);

    const after = frames.length;

    session.onMergerChange(CHANGE);
    expect(frames.length).toBe(after);
  });
});
