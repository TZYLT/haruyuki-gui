/**
 * Tests for runtime marker storage.
 *
 * Every case creates its own `mkdtemp` directory and the shared cleanup removes
 * the direct children by name before removing the directory: no recursive delete
 * of a tree this test did not create.
 *
 * The corruption cases are values, not exceptions, because they happen on the
 * start-up path: a first boot has no marker, a crash can truncate one, and an
 * older build can write a shape this one does not understand.
 */

import { mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearRuntimeMarker,
  listStale,
  moveToStale,
  readRuntimeMarker,
  removeStale,
  RUNTIME_MARKER_FILE_NAME,
  runtimeMarkerPath,
  staleMarkerFileName,
  staleMarkerPath,
  writeRuntimeMarker,
} from "./marker";
import type { EngineMarker, ProcessEvidence, RuntimeMarker, StaleEngineRecord } from "./types";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0).reverse()) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    for (const name of names) {
      // Only direct files exist in these directories. A directory here would be
      // a test bug, so let unlink fail loudly instead of deleting recursively.
      await unlink(join(dir, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }

    await rmdir(dir);
  }
});

/** Tracked temp directory; cleaned point by point in `afterEach`. */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "haruyuki-supervision-marker-"));
  tempDirs.push(dir);
  return dir;
}

function engineMarker(overrides: Partial<EngineMarker> = {}): EngineMarker {
  return {
    pid: 4242,
    startedAt: "2026-11-16T12:00:00.000Z",
    exePath: "C:\\Program Files\\nodejs\\node.exe",
    bundlePath: "C:\\app\\haruyuki.js",
    runToken: "run-token-1",
    watchdog: "active",
    tokenFile: "C:\\app\\engine-token",
    port: null,
    ...overrides,
  };
}

function runtimeMarker(overrides: Partial<RuntimeMarker> = {}): RuntimeMarker {
  return {
    schemaVersion: 1,
    instanceId: "instance-1",
    startedAt: "2026-11-16T12:00:00.000Z",
    appVersion: "0.1.0",
    engine: engineMarker(),
    ...overrides,
  };
}

function processEvidence(overrides: Partial<ProcessEvidence> = {}): ProcessEvidence {
  return {
    pid: 4242,
    alive: true,
    imagePath: "C:\\Program Files\\nodejs\\node.exe",
    createdAt: "2026-11-16T12:00:05.000Z",
    runToken: "run-token-1",
    tokenFileExists: true,
    portListening: false,
    matched: false,
    reason: "only the pid is available",
    ...overrides,
  };
}

function staleRecord(overrides: Partial<StaleEngineRecord> = {}): StaleEngineRecord {
  return {
    schemaVersion: 1,
    detectedAt: "2026-11-16T12:10:00.000Z",
    marker: runtimeMarker(),
    evidence: processEvidence(),
    reason: "only the pid is available",
    ...overrides,
  };
}

describe("runtime marker round-trip", () => {
  it("writes atomically and reads the same marker back", async () => {
    const dir = await createTempDir();
    const marker = runtimeMarker();

    const filePath = await writeRuntimeMarker(dir, marker);

    expect(filePath).toBe(runtimeMarkerPath(dir));
    expect(await readRuntimeMarker(dir)).toEqual({ ok: true, marker });

    // The temp sibling of the atomic rename must not survive a successful write.
    expect(await readdir(dir)).toEqual([RUNTIME_MARKER_FILE_NAME]);

    const raw = await readFile(filePath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(marker);
  });

  it("replaces an existing marker with the next complete document", async () => {
    const dir = await createTempDir();
    await writeRuntimeMarker(dir, runtimeMarker());
    const replacement = runtimeMarker({
      instanceId: "instance-2",
      appVersion: "0.2.0",
      engine: null,
    });

    await writeRuntimeMarker(dir, replacement);

    expect(await readRuntimeMarker(dir)).toEqual({ ok: true, marker: replacement });
    expect(await readdir(dir)).toEqual([RUNTIME_MARKER_FILE_NAME]);
  });

  it("reports a missing marker as a value", async () => {
    const dir = await createTempDir();

    expect(await readRuntimeMarker(dir)).toEqual({ ok: false, reason: "missing" });
  });

  it("reports truncated JSON as corrupt with a one-line detail", async () => {
    const dir = await createTempDir();
    await writeFile(runtimeMarkerPath(dir), '{"schemaVersion": 1,', "utf8");

    const result = await readRuntimeMarker(dir);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected the corrupt marker to be rejected");
    }

    expect(result.reason).toBe("corrupt");
    expect(result.detail).toBeTruthy();
    expect(result.detail?.includes("\n")).toBe(false);
  });

  it("reports valid JSON of the wrong shape as invalid", async () => {
    const dir = await createTempDir();
    await writeFile(runtimeMarkerPath(dir), JSON.stringify({ schemaVersion: 2 }), "utf8");

    const result = await readRuntimeMarker(dir);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected the unsupported marker to be rejected");
    }

    expect(result.reason).toBe("invalid");
    expect(result.detail).toContain("schemaVersion 1");
  });

  it("keeps an engine marker and an engine-less marker intact", async () => {
    const dir = await createTempDir();
    const withEngine = runtimeMarker();
    await writeRuntimeMarker(dir, withEngine);
    expect((await readRuntimeMarker(dir)).ok).toBe(true);

    const withoutEngine = runtimeMarker({ engine: null });
    await writeRuntimeMarker(dir, withoutEngine);

    expect(await readRuntimeMarker(dir)).toEqual({ ok: true, marker: withoutEngine });
  });

  it("rejects a malformed marker before writing it", async () => {
    const dir = await createTempDir();
    const malformed = { ...runtimeMarker(), schemaVersion: 2 } as unknown as RuntimeMarker;

    await expect(writeRuntimeMarker(dir, malformed)).rejects.toThrow(TypeError);
    expect(await readRuntimeMarker(dir)).toEqual({ ok: false, reason: "missing" });
  });

  it("clears a marker and tolerates a second clear", async () => {
    const dir = await createTempDir();
    await writeRuntimeMarker(dir, runtimeMarker());

    await clearRuntimeMarker(dir);
    await clearRuntimeMarker(dir);

    expect(await readRuntimeMarker(dir)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("stale marker transfer", () => {
  it("moves the live marker to a stale file and lists it back", async () => {
    const dir = await createTempDir();
    const marker = runtimeMarker({ instanceId: "run-42" });
    await writeRuntimeMarker(dir, marker);
    const record = staleRecord({ marker });

    const stalePath = await moveToStale(dir, record);

    expect(stalePath).toBe(staleMarkerPath(dir, "run-42"));
    expect(await readRuntimeMarker(dir)).toEqual({ ok: false, reason: "missing" });

    const entries = await listStale(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe(stalePath);
    expect(entries[0]?.record).toEqual(record);
    expect(entries[0]?.detail).toBeNull();

    expect(await removeStale(dir, basename(stalePath))).toBe(true);
    expect(await listStale(dir)).toEqual([]);
    expect(await removeStale(dir, basename(stalePath))).toBe(false);
  });

  it("does not lose a record that has an unusual instance id", async () => {
    const dir = await createTempDir();
    const marker = runtimeMarker({
      instanceId: "../../escape",
      engine: null,
    });
    await writeRuntimeMarker(dir, marker);

    const stalePath = await moveToStale(dir, staleRecord({ marker }));

    expect(basename(stalePath)).toBe(staleMarkerFileName("../../escape"));
    expect(stalePath.startsWith(dir)).toBe(true);
    expect(await readdir(dir)).toEqual([basename(stalePath)]);

    const entries = await listStale(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.record?.marker.instanceId).toBe("../../escape");
  });

  it("lists a damaged stale file with a detail instead of hiding it", async () => {
    const dir = await createTempDir();
    await writeFile(join(dir, "runtime-stale-broken.json"), "{not json", "utf8");
    await writeFile(join(dir, "runtime-stale-wrong-shape.json"), '{"schemaVersion":1}', "utf8");
    await writeFile(join(dir, RUNTIME_MARKER_FILE_NAME), "{}", "utf8");

    const entries = await listStale(dir);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.record).toBeNull();
    expect(entries[0]?.detail).toContain("corrupt");
    expect(entries[1]?.record).toBeNull();
    expect(entries[1]?.detail).toContain("invalid");
  });

  it("refuses to delete a file that is not a stale marker", async () => {
    const dir = await createTempDir();
    await writeRuntimeMarker(dir, runtimeMarker());

    expect(await removeStale(dir, RUNTIME_MARKER_FILE_NAME)).toBe(false);
    expect(await removeStale(dir, join("..", RUNTIME_MARKER_FILE_NAME))).toBe(false);
    expect((await readRuntimeMarker(dir)).ok).toBe(true);
  });

  it("rejects a malformed stale record before writing it", async () => {
    const dir = await createTempDir();
    const malformed = { ...staleRecord(), schemaVersion: 2 } as unknown as StaleEngineRecord;

    await expect(moveToStale(dir, malformed)).rejects.toThrow(TypeError);
    expect(await listStale(dir)).toEqual([]);
  });
});
