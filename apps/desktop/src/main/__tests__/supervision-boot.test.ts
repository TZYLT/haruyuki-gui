import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readRuntimeMarker,
  runtimeMarkerPath,
  staleMarkerPath,
  writeRuntimeMarker,
  type EngineMarker,
  type KillResult,
  type ProcessEvidence,
  type RuntimeMarker,
  type StaleEngineRecord,
} from "@haruyuki/core";

import {
  clearMarkerAfterStop,
  runBootSupervision,
  writeMarkerEngine,
} from "../supervision/boot.js";

/** Directories this file made; each one is removed by its exact path. */
const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-supervision-boot-"));

  created.push(dir);

  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const NOW = new Date("2026-11-16T12:00:00.000Z");
const TOKEN_NAME = "engine-token";

function engineMarker(overrides: Partial<EngineMarker> = {}): EngineMarker {
  return {
    pid: 4242,
    startedAt: NOW.toISOString(),
    exePath: process.execPath,
    bundlePath: "/repo/engine/haruyuki.js",
    runToken: "run-token",
    watchdog: "active",
    tokenFile: null,
    port: null,
    ...overrides,
  };
}

function marker(engine: EngineMarker | null, instanceId = "old-instance"): RuntimeMarker {
  return {
    schemaVersion: 1,
    instanceId,
    startedAt: NOW.toISOString(),
    appVersion: "0.1.0",
    engine,
  };
}

function evidence(overrides: Partial<ProcessEvidence> = {}): ProcessEvidence {
  return {
    pid: 4242,
    alive: true,
    imagePath: process.execPath,
    createdAt: NOW.toISOString(),
    runToken: "run-token",
    tokenFileExists: true,
    portListening: false,
    matched: false,
    reason: "",
    ...overrides,
  };
}

async function readMarker(dir: string): Promise<RuntimeMarker> {
  const read = await readRuntimeMarker(dir);

  expect(read.ok).toBe(true);

  if (!read.ok) throw new Error(`marker unreadable: ${read.reason}`);

  return read.marker;
}

describe("runBootSupervision", () => {
  it("writes a fresh marker when none exists", async () => {
    const dir = await tempDir();

    const result = await runBootSupervision({
      userData: dir,
      appVersion: "0.1.0",
      now: () => NOW,
    });

    expect(result).toEqual({ stale: [], reclaimed: [] });

    const written = await readMarker(dir);

    expect(written.engine).toBeNull();
    expect(written.appVersion).toBe("0.1.0");
    expect(written.startedAt).toBe(NOW.toISOString());
    expect(written.instanceId).not.toBe("");
  });

  it("loads a stale candidate from an earlier boot", async () => {
    const dir = await tempDir();
    const record: StaleEngineRecord = {
      schemaVersion: 1,
      detectedAt: NOW.toISOString(),
      marker: marker(engineMarker(), "loaded-instance"),
      evidence: evidence({ matched: false, reason: "createdAt and imagePath do not match" }),
      reason: "createdAt and imagePath do not match",
    };

    await writeFile(staleMarkerPath(dir, "loaded-instance"), JSON.stringify(record), "utf8");

    const result = await runBootSupervision({
      userData: dir,
      appVersion: "0.1.0",
      now: () => NOW,
    });

    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]?.pid).toBe(4242);
    expect(result.stale[0]?.decision).toBe("ambiguous");
    expect(result.stale[0]?.staleFile).toBe("runtime-stale-loaded-instance.json");
    expect((await readMarker(dir)).engine).toBeNull();
  });

  it("replaces a corrupt marker instead of failing boot", async () => {
    const dir = await tempDir();

    await writeFile(runtimeMarkerPath(dir), "{ this is not a marker", "utf8");

    const result = await runBootSupervision({
      userData: dir,
      appVersion: "0.1.0",
      now: () => NOW,
    });

    expect(result).toEqual({ stale: [], reclaimed: [] });

    const written = await readMarker(dir);

    expect(written.engine).toBeNull();
    expect(written.appVersion).toBe("0.1.0");
  });

  it("replaces the marker and kills nothing when the recorded pid is gone", async () => {
    const dir = await tempDir();

    await writeRuntimeMarker(dir, marker(engineMarker(), "gone-instance"));

    const killed: number[] = [];
    const result = await runBootSupervision({
      userData: dir,
      appVersion: "0.1.0",
      now: () => NOW,
      collectEvidence: async () =>
        evidence({ alive: false, imagePath: null, createdAt: null, tokenFileExists: false }),
      kill: async (target) => {
        killed.push(target.pid);

        return { ok: true };
      },
    });

    expect(result).toEqual({ stale: [], reclaimed: [] });
    expect(killed).toEqual([]);

    const written = await readMarker(dir);

    expect(written.instanceId).not.toBe("gone-instance");
    expect(written.engine).toBeNull();
  });

  it("kills a confident stale engine, removes its token file and records the reclaim", async () => {
    const dir = await tempDir();
    const tokenFile = path.join(dir, TOKEN_NAME, TOKEN_NAME);

    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, "capability-token\n", "utf8");
    await writeRuntimeMarker(dir, marker(engineMarker({ tokenFile }), "confident-instance"));

    const killed: number[] = [];
    const result = await runBootSupervision({
      userData: dir,
      appVersion: "0.1.0",
      now: () => NOW,
      collectEvidence: async (target) =>
        evidence({ pid: target.pid, imagePath: target.exePath, createdAt: target.startedAt }),
      kill: async (target) => {
        killed.push(target.pid);

        return { ok: true };
      },
    });

    expect(killed).toEqual([4242]);
    expect(result.stale).toEqual([]);
    expect(result.reclaimed).toHaveLength(1);
    expect(result.reclaimed[0]?.pid).toBe(4242);
    expect(result.reclaimed[0]?.decision).toBe("confident");

    await expect(access(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });

    const written = await readMarker(dir);

    expect(written.instanceId).not.toBe("confident-instance");
    expect(written.engine).toBeNull();
  });

  it("removes the token file only when it is exactly this shell's path", async () => {
    const dir = await tempDir();
    const foreign = path.join(dir, TOKEN_NAME, "some-other-token");

    await mkdir(path.dirname(foreign), { recursive: true });
    await writeFile(foreign, "do-not-delete\n", "utf8");
    await writeRuntimeMarker(dir, marker(engineMarker({ tokenFile: foreign }), "foreign-token"));

    const result = await runBootSupervision({
      userData: dir,
      appVersion: "0.1.0",
      now: () => NOW,
      collectEvidence: async (target) =>
        evidence({ pid: target.pid, imagePath: target.exePath, createdAt: target.startedAt }),
      kill: async () => ({ ok: true }),
    });

    expect(result.reclaimed).toHaveLength(1);
    await expect(access(foreign)).resolves.toBeUndefined();
  });

  it("keeps an ambiguous marker as a stale file and writes a fresh live marker", async () => {
    const dir = await tempDir();
    const target = engineMarker();

    await writeRuntimeMarker(dir, marker(target, "ambiguous-instance"));

    const kill = vi.fn(async (): Promise<KillResult> => ({ ok: true }));
    const result = await runBootSupervision({
      userData: dir,
      appVersion: "0.1.0",
      now: () => NOW,
      collectEvidence: async () =>
        evidence({ imagePath: null, createdAt: null, tokenFileExists: false }),
      kill,
    });

    expect(kill).not.toHaveBeenCalled();
    expect(result.reclaimed).toEqual([]);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]?.pid).toBe(target.pid);
    expect(result.stale[0]?.decision).toBe("ambiguous");

    const stalePath = staleMarkerPath(dir, "ambiguous-instance");
    const stored = JSON.parse(await readFile(stalePath, "utf8")) as StaleEngineRecord;

    expect(stored.marker.instanceId).toBe("ambiguous-instance");
    expect(stored.evidence.pid).toBe(target.pid);
    expect(stored.reason).not.toBe("");

    const written = await readMarker(dir);

    expect(written.instanceId).not.toBe("ambiguous-instance");
    expect(written.engine).toBeNull();
  });

  it("keeps the evidence when the confident kill fails, and does not delete the token", async () => {
    const dir = await tempDir();
    const tokenFile = path.join(dir, TOKEN_NAME, TOKEN_NAME);

    await mkdir(path.dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, "still-in-use\n", "utf8");
    await writeRuntimeMarker(dir, marker(engineMarker({ tokenFile }), "failed-kill"));

    const result = await runBootSupervision({
      userData: dir,
      appVersion: "0.1.0",
      now: () => NOW,
      collectEvidence: async (target) =>
        evidence({ pid: target.pid, imagePath: target.exePath, createdAt: target.startedAt }),
      kill: async () => ({ ok: false, reason: "access denied" }),
    });

    expect(result.reclaimed).toEqual([]);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]?.reason).toContain("access denied");
    expect(result.stale[0]?.decision).toBe("confident");

    await expect(access(tokenFile)).resolves.toBeUndefined();

    const stored = JSON.parse(
      await readFile(staleMarkerPath(dir, "failed-kill"), "utf8"),
    ) as StaleEngineRecord;

    expect(stored.marker.instanceId).toBe("failed-kill");
  });

  it("does not throw when the marker directory is unusable", async () => {
    const root = await tempDir();
    const blocker = path.join(root, "blocker");

    await writeFile(blocker, "not a directory", "utf8");

    const events: string[] = [];
    const result = await runBootSupervision({
      userData: path.join(blocker, "userData"),
      appVersion: "0.1.0",
      now: () => NOW,
      onLog: (event) => events.push(event),
    });

    expect(result).toEqual({ stale: [], reclaimed: [] });
    expect(events).toContain("supervision.marker.read");
    expect(events).toContain("supervision.marker.write");
  });

  it("treats a collector failure as ambiguous instead of killing or crashing", async () => {
    const dir = await tempDir();

    await writeRuntimeMarker(dir, marker(engineMarker(), "collector-failure"));

    const kill = vi.fn(async (): Promise<KillResult> => ({ ok: true }));
    const result = await runBootSupervision({
      userData: dir,
      appVersion: "0.1.0",
      now: () => NOW,
      collectEvidence: async () => {
        throw new Error("wmic unavailable");
      },
      kill,
    });

    expect(kill).not.toHaveBeenCalled();
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]?.evidence.reason).toContain("wmic unavailable");

    const stored = JSON.parse(
      await readFile(staleMarkerPath(dir, "collector-failure"), "utf8"),
    ) as StaleEngineRecord;

    expect(stored.marker.instanceId).toBe("collector-failure");
  });
});

describe("writeMarkerEngine", () => {
  it("adds the engine to the existing marker without losing the run identity", async () => {
    const dir = await tempDir();

    await writeRuntimeMarker(dir, marker(null, "live-instance"));

    const target = engineMarker();

    await expect(writeMarkerEngine(runtimeMarkerPath(dir), target)).resolves.toBe(true);

    const written = await readMarker(dir);

    expect(written.instanceId).toBe("live-instance");
    expect(written.appVersion).toBe("0.1.0");
    expect(written.engine).toEqual(target);
  });

  it("still writes an engine marker when the boot marker is missing", async () => {
    const dir = await tempDir();
    const target = engineMarker();

    await expect(writeMarkerEngine(runtimeMarkerPath(dir), target)).resolves.toBe(true);

    const written = await readMarker(dir);

    expect(written.appVersion).toBe("unknown");
    expect(written.engine).toEqual(target);
  });
});

describe("clearMarkerAfterStop", () => {
  it("deletes the marker and tolerates a second call", async () => {
    const dir = await tempDir();

    await writeRuntimeMarker(dir, marker(null));

    await expect(clearMarkerAfterStop(dir)).resolves.toBe(true);
    await expect(clearMarkerAfterStop(dir)).resolves.toBe(true);

    const read = await readRuntimeMarker(dir);

    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("missing");
  });
});
