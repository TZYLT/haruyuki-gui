import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readRuntimeMarker,
  runtimeMarkerPath,
  writeRuntimeMarker,
  type Engine,
  type RuntimeMarker,
} from "@haruyuki/core";

import type { EngineHost } from "../supervision/engine-host.js";
import {
  installQuitSupervisor,
  runQuitSequence,
  type QuitApp,
  type QuitEvent,
  type QuitSupervisor,
} from "../supervision/quit.js";

const created: string[] = [];
const supervisors: QuitSupervisor[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-supervision-quit-"));

  created.push(dir);

  return dir;
}

afterEach(async () => {
  while (supervisors.length > 0) supervisors.pop()?.remove();

  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** A scripted engine; `stopGraceful` is the only member the quit path uses. */
class FakeEngine {
  state = "ready";
  pid: number | null = 4242;
  stopTimeouts: number[] = [];
  stopError: Error | null = null;
  stopFinalState = "closed";
  stopClearsPid = true;

  async stopGraceful(timeoutMs = 5_000): Promise<void> {
    this.stopTimeouts.push(timeoutMs);

    if (this.stopError !== null) throw this.stopError;

    this.state = this.stopFinalState;
    if (this.stopClearsPid) this.pid = null;
  }
}

function hostFor(engine: FakeEngine, userData: string): EngineHost {
  return {
    engine: engine as unknown as Engine,
    pid: engine.pid ?? 4242,
    bundlePath: "/repo/engine/haruyuki.js",
    watchdog: "unknown",
    markerPath: runtimeMarkerPath(userData),
    tokenFile: path.join(userData, "engine-token", "engine-token"),
    startedAt: "2026-11-16T12:00:00.000Z",
  };
}

/** The smallest `app` that can drive `before-quit`. */
class FakeApp implements QuitApp {
  quitCalls = 0;

  private readonly listeners = new Set<(event: QuitEvent) => void>();

  on(_event: "before-quit", listener: (event: QuitEvent) => void): unknown {
    this.listeners.add(listener);

    return this;
  }

  removeListener(_event: "before-quit", listener: (event: QuitEvent) => void): unknown {
    this.listeners.delete(listener);

    return this;
  }

  quit(): void {
    this.quitCalls += 1;
  }

  /** Fire `before-quit`; return whether the first listener cancelled it. */
  fire(): boolean {
    let prevented = false;

    for (const listener of [...this.listeners]) {
      listener({
        preventDefault: () => {
          prevented = true;
        },
      });
    }

    return prevented;
  }
}

function runtimeMarker(instanceId = "quit-run"): RuntimeMarker {
  return {
    schemaVersion: 1,
    instanceId,
    startedAt: "2026-11-16T12:00:00.000Z",
    appVersion: "0.1.0",
    engine: null,
  };
}

describe("runQuitSequence", () => {
  it("stops, clears the marker, then quits", async () => {
    const calls: string[] = [];

    const result = await runQuitSequence({
      stop: async () => {
        calls.push("stop");

        return { stopped: true };
      },
      clearMarker: async () => {
        calls.push("clear");
      },
      quit: () => calls.push("quit"),
    });

    expect(calls).toEqual(["stop", "clear", "quit"]);
    expect(result).toEqual({ stopped: true, markerCleared: true });
  });

  it("keeps the marker when the stop is not confirmed, but still quits", async () => {
    const clearMarker = vi.fn(async () => undefined);
    const quit = vi.fn();

    const result = await runQuitSequence({
      stop: async () => ({ stopped: false, reason: "still running" }),
      clearMarker,
      quit,
    });

    expect(clearMarker).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      stopped: false,
      markerCleared: false,
      reason: "still running",
    });
  });

  it("turns a throwing stop into a failure and still quits", async () => {
    const clearMarker = vi.fn(async () => undefined);
    const quit = vi.fn();

    const result = await runQuitSequence({
      stop: async () => {
        throw new Error("taskkill denied");
      },
      clearMarker,
      quit,
    });

    expect(clearMarker).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("taskkill denied");
  });
});

describe("installQuitSupervisor", () => {
  it("uses the 5 s stop budget and quits once the stop resolves", async () => {
    const dir = await tempDir();
    const engine = new FakeEngine();
    const app = new FakeApp();
    const supervisor = installQuitSupervisor({
      host: hostFor(engine, dir),
      userData: dir,
      app,
    });

    supervisors.push(supervisor);

    expect(app.fire()).toBe(true);

    await vi.waitFor(() => expect(app.quitCalls).toBe(1));

    expect(engine.stopTimeouts).toEqual([5_000]);
  });

  it("refuses a host attached after the quit has started", async () => {
    const dir = await tempDir();
    const app = new FakeApp();
    const supervisor = installQuitSupervisor({ host: null, userData: dir, app });

    supervisors.push(supervisor);

    expect(supervisor.isQuitting()).toBe(false);
    expect(app.fire()).toBe(true);
    expect(supervisor.isQuitting()).toBe(true);

    await vi.waitFor(() => expect(app.quitCalls).toBe(1));

    expect(supervisor.setHost(hostFor(new FakeEngine(), dir))).toBe(false);
  });

  it("holds a second before-quit while the stop is in flight, then lets the final quit through", async () => {
    const dir = await tempDir();
    const app = new FakeApp();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stopCalls = 0;

    class GatedEngine extends FakeEngine {
      async stopGraceful(): Promise<void> {
        stopCalls += 1;
        await gate;
        this.state = "closed";
        this.pid = null;
      }
    }

    const supervisor = installQuitSupervisor({
      host: hostFor(new GatedEngine(), dir),
      userData: dir,
      app,
    });

    supervisors.push(supervisor);

    expect(app.fire()).toBe(true);
    expect(app.fire()).toBe(true);
    expect(stopCalls).toBe(1);

    if (release !== null) (release as () => void)();

    await vi.waitFor(() => expect(app.quitCalls).toBe(1));

    // After `finished`, the quit triggered by `app.quit()` must be allowed.
    expect(app.fire()).toBe(false);
  });

  it("keeps the runtime marker when the stop cannot be confirmed", async () => {
    const dir = await tempDir();
    const app = new FakeApp();
    const engine = new FakeEngine();

    await writeRuntimeMarker(dir, runtimeMarker("kept-run"));

    engine.pid = process.pid;
    engine.stopFinalState = "ready";
    engine.stopClearsPid = false;

    const supervisor = installQuitSupervisor({
      host: hostFor(engine, dir),
      userData: dir,
      app,
    });

    supervisors.push(supervisor);

    expect(app.fire()).toBe(true);

    await vi.waitFor(() => expect(app.quitCalls).toBe(1));

    const read = await readRuntimeMarker(dir);

    expect(read.ok).toBe(true);
    if (read.ok) expect(read.marker.instanceId).toBe("kept-run");
  });

  it("clears the runtime marker when the host stops", async () => {
    const dir = await tempDir();
    const app = new FakeApp();

    await writeRuntimeMarker(dir, runtimeMarker("cleared-run"));

    const supervisor = installQuitSupervisor({
      host: hostFor(new FakeEngine(), dir),
      userData: dir,
      app,
    });

    supervisors.push(supervisor);

    expect(app.fire()).toBe(true);

    await vi.waitFor(() => expect(app.quitCalls).toBe(1));

    const read = await readRuntimeMarker(dir);

    expect(read.ok).toBe(false);
  });

  it("clears the boot marker even when no engine was ever started", async () => {
    const dir = await tempDir();
    const app = new FakeApp();

    await writeRuntimeMarker(dir, runtimeMarker("bundle-less-run"));

    const supervisor = installQuitSupervisor({ host: null, userData: dir, app });

    supervisors.push(supervisor);

    expect(app.fire()).toBe(true);

    await vi.waitFor(() => expect(app.quitCalls).toBe(1));

    const read = await readRuntimeMarker(dir);

    expect(read.ok).toBe(false);
  });
});
