/**
 * The composition root's own claim: that its teardown chain reaches the session.
 *
 * `lifecycle.test.ts` proves the mechanism (a `dispose()` runs the injected hook
 * once). This file proves the wiring: that `createShellServices` actually
 * installs the session's disposer on it, and that the subscription the renderer
 * opened is gone after the shell's one teardown call.
 *
 * The claim needs the real `createShellServices` rather than a hand-assembled
 * pair, because the bug it guards against is precisely a missing line in the
 * assembly -- a session built, returned, and never released.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Frame } from "@haruyuki/protocol";
import type { IpcMain } from "electron";
import { afterEach, describe, expect, it } from "vitest";

import { createShellServices } from "../services.js";
import type { BridgeWiring } from "../bridge/wire.js";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "w18-services-"));

  created.push(dir);

  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

/** An `ipcMain` that only records what the two registrations asked it to hold. */
function createFakeIpc(): IpcMain {
  return {
    handle(): void {
      // The handlers are exercised elsewhere; this file is about teardown.
    },
    removeHandler(): void {
      // Same.
    },
  } as unknown as IpcMain;
}

/** A `BridgeWiring` stand-in; the sink records and the hook is a spy. */
function createFakeHost(): { host: BridgeWiring; frames: Frame[]; hooks: unknown[] } {
  const frames: Frame[] = [];
  const hooks: unknown[] = [];

  const host = {
    send: (frame: Frame): void => {
      frames.push(frame);
    },
    setControlFrameHook: (hook: ((payload: string) => boolean) | null): void => {
      hooks.push(hook);
    },
    attachWindow: (): void => undefined,
    bootParams: (): Record<string, string> => ({}),
    dispose: (): void => undefined,
  } as unknown as BridgeWiring;

  return { host, frames, hooks };
}

const SUBSCRIBE = JSON.stringify({
  v: 1,
  ch: "control",
  seq: 0,
  t: "session.subscribe",
  body: { instanceId: "tab-1", selector: "entity.agents", params: {} },
  reqId: "req-1",
});

describe("createShellServices", () => {
  it("hands the session's consume hook to the bridge and releases it on dispose", async () => {
    const userData = await tempDir();
    const { host, hooks, frames } = createFakeHost();

    const services = await createShellServices({
      userData,
      ipc: createFakeIpc(),
      host,
      log: () => undefined,
    });

    // The bridge was pointed at this session, and at a live function rather than
    // a snapshot of one: the hook it holds must dispatch into the store.
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toBe(services.session.onControlFrame);

    expect(services.session.onControlFrame(SUBSCRIBE)).toBe(true);
    expect(frames.filter((frame) => frame.t === "session.view")).toHaveLength(1);

    // The effect is the assertion, not a spy on the method: the assembly passes
    // the function itself, so a spy installed afterwards would replace a property
    // the lifecycle no longer reads. A disposed session refuses the next frame
    // and pushes nothing, which is what "released" means here.
    services.command.dispose();

    expect(services.session.onControlFrame(SUBSCRIBE)).toBe(false);
    expect(frames.filter((frame) => frame.t === "session.view")).toHaveLength(1);
  });

  it("survives a teardown with nothing subscribed", async () => {
    const userData = await tempDir();
    const { host } = createFakeHost();

    const services = await createShellServices({
      userData,
      ipc: createFakeIpc(),
      host,
      log: () => undefined,
    });

    expect(() => services.command.dispose()).not.toThrow();
  });
});
