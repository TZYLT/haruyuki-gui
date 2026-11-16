/**
 * Lock and state are the two files that decide whether the engine may start.
 * These tests pin the parts that fail silently in production:
 *
 *   the tree algorithm (a different one would verify a different tree),
 *   the entry/tree distinction (normal start checks one file, upgrade checks all),
 *   recovery from a corrupt state (one extra check, never a refused start).
 */

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hashFile,
  hashTree,
  readRuntimeLock,
  verifyRuntime,
  type RuntimeLockV1,
} from "../runtime/lock.js";
import {
  defaultRuntimeState,
  readRuntimeState,
  writeRuntimeState,
  type RuntimeStateV1,
} from "../runtime/state.js";

/** A temporary engine tree plus its expected digests. */
interface Fixture {
  root: string;
  engineDir: string;
  bundlePath: string;
  lock: RuntimeLockV1;
}

let work: string | null = null;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "g1-runtime-"));
});

afterEach(async () => {
  if (work !== null) await rm(work, { recursive: true, force: true });
  work = null;
});

/**
 * Build a two-file engine and a matching lock.
 *
 * The hashes are computed from the actual bytes rather than hard-coded, so the
 * lock generator and the verifier are checked against each other; the algorithm
 * itself is pinned separately.
 */
async function fixture(): Promise<Fixture> {
  const root = work!;
  const engineDir = path.join(root, "engine");
  const bundlePath = path.join(engineDir, "haruyuki.js");

  await mkdir(path.join(engineDir, "node_modules"), { recursive: true });
  await writeFile(bundlePath, "entry", "utf8");
  await writeFile(path.join(engineDir, "node_modules", "a.js"), "a", "utf8");

  const entry = await hashFile(bundlePath);
  const tree = await hashTree(engineDir);

  return {
    root,
    engineDir,
    bundlePath,
    lock: {
      lockVersion: 1,
      engineVersion: "0.6.0",
      bundle: { name: "haruyuki", entry: "haruyuki.js", bytes: entry.bytes },
      sha256: entry.sha256,
      source: { kind: "npm", spec: "haruyuki@0.6.0", integrity: "sha512-test" },
      builtAt: "2026-11-16T00:00:00.000Z",
      runtime: { electron: "45.3.2", node: "24.22.2", modules: "150" },
      tree,
    },
  };
}

describe("hashTree", () => {
  it("pins the frozen manifest algorithm", async () => {
    const { engineDir } = await fixture();
    const entryHash = createHash("sha256").update("entry").digest("hex");
    const fileHash = createHash("sha256").update("a").digest("hex");
    const expected = createHash("sha256")
      .update(`${entryHash}  haruyuki.js\n${fileHash}  node_modules/a.js`)
      .digest("hex");

    const tree = await hashTree(engineDir);

    expect(tree.sha256).toBe(expected);
    expect(tree.files).toBe(2);
    expect(tree.bytes).toBe(6);
  });

  it("rejects a symlink instead of following it", async () => {
    const { engineDir } = await fixture();
    const link = path.join(engineDir, "node_modules", "link.js");

    try {
      await symlink(path.join(engineDir, "haruyuki.js"), link, "file");
    } catch {
      // Windows without developer mode cannot create symlinks. The rule is
      // still asserted on POSIX and on Windows where the privilege exists.
      return;
    }

    await expect(hashTree(engineDir)).rejects.toThrow(/symlink/);
  });
});

describe("readRuntimeLock", () => {
  it("reads a valid lock", async () => {
    const { root, lock } = await fixture();
    const file = path.join(root, "runtime-lock.json");

    await writeFile(file, JSON.stringify(lock), "utf8");

    await expect(readRuntimeLock(file)).resolves.toEqual({ ok: true, lock });
  });

  it("distinguishes a missing lock from an invalid one", async () => {
    const { root, lock } = await fixture();
    const missing = path.join(root, "absent.json");
    const invalid = path.join(root, "invalid.json");

    await writeFile(invalid, "{not json", "utf8");

    const missingResult = await readRuntimeLock(missing);
    const invalidResult = await readRuntimeLock(invalid);

    expect(missingResult).toMatchObject({ ok: false, problem: "missing" });
    expect(invalidResult).toMatchObject({ ok: false, problem: "invalid" });

    // A syntactically valid but shape-wrong file is also invalid, not missing.
    await writeFile(invalid, JSON.stringify({ ...lock, lockVersion: 2 }), "utf8");
    await expect(readRuntimeLock(invalid)).resolves.toMatchObject({
      ok: false,
      problem: "invalid",
    });
  });

  it("rejects a malformed digest", async () => {
    const { root, lock } = await fixture();
    const file = path.join(root, "runtime-lock.json");

    await writeFile(file, JSON.stringify({ ...lock, sha256: "not-a-digest" }), "utf8");

    await expect(readRuntimeLock(file)).resolves.toMatchObject({
      ok: false,
      problem: "invalid",
    });
  });
});

describe("verifyRuntime", () => {
  it("passes entry-only when the entry and bytes match", async () => {
    const { engineDir, bundlePath, lock } = await fixture();

    const result = await verifyRuntime({ lock, engineDir, bundlePath, full: false });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ ok: true, entry: { bytes: 5 } });
  });

  it("rejects an entry whose bytes changed", async () => {
    const { engineDir, bundlePath, lock } = await fixture();

    await writeFile(bundlePath, "entry!", "utf8");

    await expect(
      verifyRuntime({ lock, engineDir, bundlePath, full: false }),
    ).resolves.toMatchObject({
      ok: false,
      problem: "entry-mismatch",
    });
  });

  it("does not look at nested files in entry-only mode", async () => {
    const { engineDir, bundlePath, lock } = await fixture();

    await writeFile(path.join(engineDir, "node_modules", "a.js"), "tampered", "utf8");

    await expect(
      verifyRuntime({ lock, engineDir, bundlePath, full: false }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("reports a disappeared entry as missing instead of throwing ENOENT", async () => {
    const { engineDir, bundlePath, lock } = await fixture();

    await rm(bundlePath);

    await expect(
      verifyRuntime({ lock, engineDir, bundlePath, full: false }),
    ).resolves.toMatchObject({
      ok: false,
      problem: "missing",
    });
  });

  it("rejects a changed nested file in full mode", async () => {
    const { engineDir, bundlePath, lock } = await fixture();

    await writeFile(path.join(engineDir, "node_modules", "a.js"), "tampered", "utf8");

    await expect(verifyRuntime({ lock, engineDir, bundlePath, full: true })).resolves.toMatchObject(
      {
        ok: false,
        problem: "tree-mismatch",
      },
    );
  });

  it("rejects an added file in full mode", async () => {
    const { engineDir, bundlePath, lock } = await fixture();

    await writeFile(path.join(engineDir, "extra.js"), "x", "utf8");

    await expect(verifyRuntime({ lock, engineDir, bundlePath, full: true })).resolves.toMatchObject(
      { ok: false, problem: "tree-mismatch" },
    );
  });

  it("passes full mode when the tree is untouched", async () => {
    const { engineDir, bundlePath, lock } = await fixture();

    const result = await verifyRuntime({ lock, engineDir, bundlePath, full: true });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ ok: true, tree: { files: 2 } });
  });
});

describe("runtime state", () => {
  it("writes and reads a state atomically", async () => {
    const root = work!;
    const file = path.join(root, "nested", "runtime-state.json");
    const state: RuntimeStateV1 = {
      ...defaultRuntimeState(),
      lastAppVersion: "0.1.0",
      lastVerifiedAt: "2026-11-16T00:00:00.000Z",
      lastResult: "ok",
      externalEngineDir: "D:/engines/haruyuki",
      externalEngineVersion: "0.6.0",
    };

    await writeRuntimeState(file, state);

    await expect(readRuntimeState(file)).resolves.toEqual({ state, recovered: false });
    await expect(readFile(file, "utf8")).resolves.toContain('"stateVersion": 1');
  });

  it("recovers a missing state as first run", async () => {
    const result = await readRuntimeState(path.join(work!, "absent.json"));

    expect(result.recovered).toBe(true);
    expect(result.state.lastAppVersion).toBe("");
    expect(result.state.lastResult).toBe("missing");
  });

  it("recovers a corrupt state instead of refusing to start", async () => {
    const file = path.join(work!, "runtime-state.json");

    await writeFile(file, "{broken", "utf8");

    const result = await readRuntimeState(file);

    expect(result.recovered).toBe(true);
    expect(result.state.stateVersion).toBe(1);
  });

  it("recovers a state with an unknown lastResult", async () => {
    const file = path.join(work!, "runtime-state.json");

    await writeFile(
      file,
      JSON.stringify({ ...defaultRuntimeState(), lastResult: "unknown" }),
      "utf8",
    );

    await expect(readRuntimeState(file)).resolves.toMatchObject({ recovered: true });
  });
});
