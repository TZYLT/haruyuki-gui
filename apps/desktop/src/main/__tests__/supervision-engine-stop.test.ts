import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runtimeMarkerPath, type Engine } from "@haruyuki/core";

import { stopEngineHost, type EngineHost } from "../supervision/engine-host.js";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-engine-stop-"));

  created.push(dir);

  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

/** The only facade member `stopEngineHost` reads. */
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

describe("stopEngineHost", () => {
  it("reports success for a closed engine and uses the 5 s default", async () => {
    const dir = await tempDir();
    const engine = new FakeEngine();

    engine.state = "ready";
    engine.pid = 4242;

    const result = await stopEngineHost(hostFor(engine, dir));

    expect(result).toEqual({ stopped: true });
    expect(engine.stopTimeouts).toEqual([5_000]);
  });

  it("reports failure when the engine is still alive and not closed", async () => {
    const dir = await tempDir();
    const engine = new FakeEngine();

    engine.state = "ready";
    engine.pid = process.pid;
    engine.stopFinalState = "ready";
    engine.stopClearsPid = false;

    const result = await stopEngineHost(hostFor(engine, dir));

    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("engine state is ready");
  });

  it("reports failure, not an exception, when the stop itself throws", async () => {
    const dir = await tempDir();
    const engine = new FakeEngine();

    engine.state = "ready";
    engine.pid = process.pid;
    engine.stopError = new Error("taskkill denied");
    engine.stopFinalState = "ready";
    engine.stopClearsPid = false;

    const result = await stopEngineHost(hostFor(engine, dir));

    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("taskkill denied");
  });

  it("treats a failed engine with no pid as stopped", async () => {
    const dir = await tempDir();
    const engine = new FakeEngine();

    engine.state = "failed";
    engine.pid = null;
    engine.stopFinalState = "failed";

    const result = await stopEngineHost(hostFor(engine, dir));

    expect(result).toEqual({ stopped: true });
  });
});
