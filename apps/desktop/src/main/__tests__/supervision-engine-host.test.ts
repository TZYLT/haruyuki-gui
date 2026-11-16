import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Engine,
  readRuntimeMarker,
  runtimeMarkerPath,
  writeRuntimeMarker,
  type EngineDegradation,
  type EngineSpawnSpec,
  type RuntimeMarker,
} from "@haruyuki/core";

import { crashDirFor, readCrashRecords } from "../crash/records.js";
import { startEngineHost, stopEngineHost, type EngineHost } from "../supervision/engine-host.js";

const created: string[] = [];
const hosts: EngineHost[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-engine-host-"));

  created.push(dir);

  return dir;
}

afterEach(async () => {
  while (hosts.length > 0) {
    const host = hosts.pop();

    if (host !== undefined) await stopEngineHost(host).catch(() => undefined);
  }

  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const NOW = new Date("2026-11-16T12:00:00.000Z");

type StartArgs = {
  spawnSpec: EngineSpawnSpec;
  tokenDir: string;
  expectedEngineVersion?: string;
};

/** A scripted stand-in for the facade; it never spawns anything. */
class FakeEngine {
  state = "idle";
  pid: number | null = null;
  appServerInfo: { engineVersion: string; protocolVersion: number } | null = null;
  lastExit: { code: number | null; signal: string | null } | null = null;
  degradations: EngineDegradation[] = [];

  startCalls = 0;
  /** Number of state listeners present when `start` was entered. */
  listenerCountAtStart = 0;
  stopCalls = 0;
  stopTimeouts: number[] = [];
  lastStart: StartArgs | null = null;
  startError: Error | null = null;
  stopError: Error | null = null;
  stopFinalState = "closed";
  stopClearsPid = true;
  stderr = ["WATCHDOG_OK=4242"];

  private readonly listeners = new Set<(state: string) => void>();

  async start(args: StartArgs): Promise<{ engineVersion: string; protocolVersion: number }> {
    this.startCalls += 1;
    this.lastStart = args;
    this.listenerCountAtStart = this.listeners.size;

    if (this.startError !== null) {
      this.state = "failed";
      throw this.startError;
    }

    this.pid = 4242;
    this.state = "ready";
    this.appServerInfo = { engineVersion: "0.6.0", protocolVersion: 1 };

    return this.appServerInfo;
  }

  async stopGraceful(timeoutMs = 5_000): Promise<void> {
    this.stopCalls += 1;
    this.stopTimeouts.push(timeoutMs);

    if (this.stopError !== null) throw this.stopError;

    this.state = this.stopFinalState;
    if (this.stopClearsPid) this.pid = null;
  }

  stderrTail(): readonly string[] {
    return this.stderr;
  }

  onState(callback: (state: string) => void): () => void {
    this.listeners.add(callback);

    return () => {
      this.listeners.delete(callback);
    };
  }

  emitState(state: string): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function asEngine(engine: FakeEngine): Engine {
  return engine as unknown as Engine;
}

function bootMarker(instanceId = "boot-run"): RuntimeMarker {
  return {
    schemaVersion: 1,
    instanceId,
    startedAt: NOW.toISOString(),
    appVersion: "0.1.0",
    engine: null,
  };
}

async function bundleIn(dir: string): Promise<string> {
  const bundle = path.join(dir, "haruyuki.js");

  await writeFile(bundle, "// stand-in engine bundle\n", "utf8");

  return bundle;
}

describe("startEngineHost", () => {
  it("skips without starting, writing or throwing when no bundle exists", async () => {
    const dir = await tempDir();
    const engine = new FakeEngine();
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];

    const result = await startEngineHost({
      userData: dir,
      appVersion: "0.1.0",
      searchFrom: [dir],
      engineFactory: () => asEngine(engine),
      resolveWatchdog: () => null,
      onLog: (event, detail) => events.push({ event, ...(detail === undefined ? {} : { detail }) }),
    });

    expect(result).toEqual({ ok: false, reason: "missing-bundle" });
    expect(engine.startCalls).toBe(0);

    const read = await readRuntimeMarker(dir);

    expect(read.ok).toBe(false);
    expect(events.some((entry) => entry.event === "supervision.engine.bootstrap")).toBe(true);
    expect(events.at(-1)?.detail?.["state"]).toBe("skipped");
  });

  it("starts the engine, writes the marker and exposes the same instance", async () => {
    const dir = await tempDir();
    const bundle = await bundleIn(dir);

    await writeRuntimeMarker(dir, bootMarker("live-run"));

    const engine = new FakeEngine();

    const result = await startEngineHost({
      userData: dir,
      appVersion: "0.1.0",
      bundlePath: bundle,
      now: () => NOW,
      engineFactory: () => asEngine(engine),
      resolveWatchdog: () => null,
      onCrash: () => undefined,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    hosts.push(result.host);

    expect(result.host.engine).toBe(engine);
    expect(engine.listenerCountAtStart).toBe(1);
    expect(result.host.pid).toBe(4242);
    expect(result.host.bundlePath).toBe(bundle);
    expect(result.host.watchdog).toBe("unknown");

    const start = engine.lastStart;

    expect(start).not.toBeNull();
    if (start === null) return;

    expect(start.tokenDir).toBe(path.join(dir, "engine-token"));
    expect(start.spawnSpec.exePath).toBe(process.execPath);
    expect(start.spawnSpec.bundlePath).toBe(bundle);
    expect(start.spawnSpec.argvPrefix).toEqual([
      "server",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
    ]);
    expect(start.spawnSpec.cwd).toBe(dir);
    expect(start.spawnSpec.stdio).toBe("pipe");
    expect(start.spawnSpec.windowsHide).toBe(true);
    expect(start.spawnSpec.detached).toBe(false);
    expect(start.spawnSpec.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(start.spawnSpec.env["HARUYUKI_HOME"]).toBe(path.join(dir, "engine-home"));
    expect(start.spawnSpec.env["NODE_OPTIONS"]).toBeUndefined();

    const read = await readRuntimeMarker(dir);

    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.marker.instanceId).toBe("live-run");
    expect(read.marker.appVersion).toBe("0.1.0");
    expect(read.marker.engine).not.toBeNull();
    expect(read.marker.engine?.pid).toBe(4242);
    expect(read.marker.engine?.bundlePath).toBe(bundle);
    expect(read.marker.engine?.exePath).toBe(process.execPath);
    expect(read.marker.engine?.tokenFile).toBe(path.join(dir, "engine-token", "engine-token"));
    expect(read.marker.engine?.port).toBeNull();
    expect(read.marker.engine?.watchdog).toBe("unknown");
    expect(read.marker.engine?.runToken).not.toBe("");
    expect(read.marker.engine?.startedAt).toBe(NOW.toISOString());
  });

  it("injects the watchdog with forward slashes and records it as active", async () => {
    const dir = await tempDir();
    const bundle = await bundleIn(dir);
    const watchdog = path.join(dir, "spawn-spec", "watchdog.cjs");

    await mkdir(path.dirname(watchdog), { recursive: true });
    await writeFile(watchdog, "// watchdog\n", "utf8");

    const engine = new FakeEngine();

    const result = await startEngineHost({
      userData: dir,
      appVersion: "0.1.0",
      bundlePath: bundle,
      engineFactory: () => asEngine(engine),
      resolveWatchdog: () => watchdog,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    hosts.push(result.host);

    expect(result.host.watchdog).toBe("active");

    const nodeOptions = engine.lastStart?.spawnSpec.env["NODE_OPTIONS"];

    expect(nodeOptions).toBe(`--require "${watchdog.replaceAll("\\", "/")}"`);
    expect(nodeOptions).not.toContain("\\");
  });

  it("finds the core watchdog without an override", async () => {
    const dir = await tempDir();
    const bundle = await bundleIn(dir);
    const engine = new FakeEngine();

    const result = await startEngineHost({
      userData: dir,
      appVersion: "0.1.0",
      bundlePath: bundle,
      engineFactory: () => asEngine(engine),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    hosts.push(result.host);

    expect(result.host.watchdog).toBe("active");

    const nodeOptions = engine.lastStart?.spawnSpec.env["NODE_OPTIONS"] ?? "";

    expect(nodeOptions).toContain("runtime/watchdog.cjs");
    expect(nodeOptions).not.toContain("\\");
  });

  it("returns start-failed, writes no engine marker and never throws", async () => {
    const dir = await tempDir();
    const bundle = await bundleIn(dir);
    const engine = new FakeEngine();

    engine.startError = new Error("spawn failed");

    const result = await startEngineHost({
      userData: dir,
      appVersion: "0.1.0",
      bundlePath: bundle,
      engineFactory: () => asEngine(engine),
      resolveWatchdog: () => null,
    });

    expect(result).toMatchObject({ ok: false, reason: "start-failed", detail: "spawn failed" });
    expect(engine.stopCalls).toBe(1);

    const read = await readRuntimeMarker(dir);

    expect(read.ok).toBe(false);
  });

  it("leaves the boot marker with engine null when the start fails", async () => {
    const dir = await tempDir();
    const bundle = await bundleIn(dir);

    await writeRuntimeMarker(dir, bootMarker("failed-start-run"));

    const engine = new FakeEngine();

    engine.startError = new Error("spawn failed");

    const result = await startEngineHost({
      userData: dir,
      appVersion: "0.1.0",
      bundlePath: bundle,
      engineFactory: () => asEngine(engine),
      resolveWatchdog: () => null,
    });

    expect(result.ok).toBe(false);

    const read = await readRuntimeMarker(dir);

    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.marker.instanceId).toBe("failed-start-run");
    expect(read.marker.engine).toBeNull();
  });

  it("refuses a second start while one host is live", async () => {
    const dir = await tempDir();
    const bundle = await bundleIn(dir);
    const engine = new FakeEngine();

    const first = await startEngineHost({
      userData: dir,
      appVersion: "0.1.0",
      bundlePath: bundle,
      engineFactory: () => asEngine(engine),
      resolveWatchdog: () => null,
    });

    expect(first.ok).toBe(true);
    if (!first.ok) return;

    hosts.push(first.host);

    const second = await startEngineHost({
      userData: dir,
      appVersion: "0.1.0",
      bundlePath: bundle,
      engineFactory: () => asEngine(new FakeEngine()),
      resolveWatchdog: () => null,
    });

    expect(second).toEqual({ ok: false, reason: "already-started" });
    expect(engine.startCalls).toBe(1);
  });

  it("installs the P3 crash watcher when onCrash is supplied", async () => {
    const dir = await tempDir();
    const bundle = await bundleIn(dir);
    const engine = new FakeEngine();
    const crashes: string[] = [];

    const result = await startEngineHost({
      userData: dir,
      appVersion: "0.1.0",
      bundlePath: bundle,
      engineFactory: () => asEngine(engine),
      resolveWatchdog: () => null,
      onCrash: (record) => crashes.push(record.kind),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    hosts.push(result.host);

    engine.lastExit = { code: 1, signal: null };
    engine.emitState("failed");

    await vi.waitFor(() => expect(crashes).toEqual(["engine"]));

    expect(readCrashRecords(crashDirFor(dir))).toHaveLength(1);
  });
});
