/**
 * The lock generator is a build tool, but a wrong byte count or a different
 * tree order is a start-up refusal on the user's machine. These tests pin the
 * fields and the frozen manifest; the packaged smoke run is the end-to-end check
 * that the TypeScript verifier agrees with this generator.
 */

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateLock, hashFile, hashTree } from "./lock.mjs";

let work: string | null = null;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "g1-lockgen-"));
});

afterEach(async () => {
  if (work !== null) await rm(work, { recursive: true, force: true });
  work = null;
});

/** Build a three-file staged runtime (entry, package.json, one module). */
async function stageFixture(): Promise<{
  stageDir: string;
  engineDir: string;
  packageJson: string;
}> {
  const stageDir = path.join(work!, "runtime");
  const engineDir = path.join(stageDir, "engine");
  const packageJson = JSON.stringify({ name: "haruyuki", version: "0.6.0" });

  await mkdir(path.join(engineDir, "node_modules"), { recursive: true });
  await writeFile(path.join(engineDir, "haruyuki.js"), "entry", "utf8");
  await writeFile(path.join(engineDir, "package.json"), packageJson, "utf8");
  await writeFile(path.join(engineDir, "node_modules", "a.js"), "a", "utf8");

  return { stageDir, engineDir, packageJson };
}

describe("generateLock", () => {
  it("records the entry, tree and runtime facts", async () => {
    const { stageDir, packageJson } = await stageFixture();
    const outFile = path.join(work!, "runtime-lock.json");

    const lock = await generateLock({
      stageDir,
      outFile,
      runtime: { electron: "45.3.2", node: "24.22.2", modules: "150" },
      builtAt: "2026-11-16T00:00:00.000Z",
    });

    expect(lock).toMatchObject({
      lockVersion: 1,
      engineVersion: "0.6.0",
      bundle: { name: "haruyuki", entry: "haruyuki.js", bytes: 5 },
      source: { kind: "npm", spec: "haruyuki@0.6.0" },
      runtime: { electron: "45.3.2", node: "24.22.2", modules: "150" },
      tree: { files: 3, bytes: 5 + packageJson.length + 1 },
    });
    expect(lock.sha256).toHaveLength(64);
    await expect(readFile(outFile, "utf8")).resolves.toContain('"lockVersion": 1');
  });

  it("uses the frozen manifest, not directory order", async () => {
    const { stageDir, engineDir, packageJson } = await stageFixture();
    const outFile = path.join(work!, "runtime-lock.json");
    const entryHash = createHash("sha256").update("entry").digest("hex");
    const fileHash = createHash("sha256").update("a").digest("hex");
    const packageHash = createHash("sha256").update(packageJson).digest("hex");
    const expectedTree = createHash("sha256")
      .update(
        `${entryHash}  haruyuki.js\n${fileHash}  node_modules/a.js\n` +
          `${packageHash}  package.json`,
      )
      .digest("hex");

    const lock = await generateLock({
      stageDir,
      outFile,
      runtime: { electron: "45.3.2", node: "24.22.2", modules: "150" },
    });
    const tree = await hashTree(engineDir);

    expect(lock.tree.sha256).toBe(expectedTree);
    expect(tree.sha256).toBe(expectedTree);
  });

  it("includes an integrity only when one is supplied", async () => {
    const { stageDir } = await stageFixture();

    const without = await generateLock({
      stageDir,
      outFile: path.join(work!, "a.json"),
      runtime: { electron: "45.3.2", node: "24.22.2", modules: "150" },
    });
    const withIntegrity = await generateLock({
      stageDir,
      outFile: path.join(work!, "b.json"),
      sourceIntegrity: "sha512-abc",
      runtime: { electron: "45.3.2", node: "24.22.2", modules: "150" },
    });

    expect(without.source).not.toHaveProperty("integrity");
    expect(withIntegrity.source.integrity).toBe("sha512-abc");
  });
});

describe("hashFile", () => {
  it("counts bytes and hashes content", async () => {
    const file = path.join(work!, "file.bin");

    await writeFile(file, Buffer.from([0, 1, 2, 3]));

    await expect(hashFile(file)).resolves.toEqual({
      sha256: createHash("sha256")
        .update(Buffer.from([0, 1, 2, 3]))
        .digest("hex"),
      bytes: 4,
    });
  });
});
