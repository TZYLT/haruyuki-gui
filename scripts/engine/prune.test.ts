/**
 * Pruning is the one operation in G1 that destroys files, so the tests assert
 * both sides: the named rules fire, and the files that must survive do survive.
 *
 * The fixture is a miniature engine. It deliberately includes a map, two foreign
 * prebuilds, a linux-only sharp tree, TypeScript's lib declarations, `@types`,
 * a README and a LICENSE -- the exact classes the route says must be treated
 * differently.
 */

import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planPrune, pruneEngine } from "./prune.mjs";
import { stageRuntime } from "./stage-runtime.mjs";

let work: string | null = null;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "g1-prune-"));
});

afterEach(async () => {
  if (work !== null) await rm(work, { recursive: true, force: true });
  work = null;
});

/** Write one file, creating parents. */
async function put(relative: string, content = "x"): Promise<void> {
  const absolute = path.join(work!, relative);

  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

/** Build the miniature engine. */
async function engineFixture(): Promise<string> {
  const root = path.join(work!, "engine");

  await put("engine/haruyuki.js", "entry");
  await put("engine/package.json", JSON.stringify({ name: "haruyuki", version: "0.6.0" }));
  await put("engine/README.md", "readme");
  await put("engine/LICENSE", "license");
  await put("engine/node_modules/node-pty/prebuilds/win32-x64/a.node");
  await put("engine/node_modules/node-pty/prebuilds/win32-arm64/b.node");
  await put("engine/node_modules/node-pty/prebuilds/darwin-x64/c.node");
  await put("engine/node_modules/@janhapke/sharp-electron/linux-x64/lib.so", "lib.so");
  await put("engine/node_modules/@janhapke/sharp-electron/index.js", "module.exports = 1");
  await put("engine/node_modules/@janhapke/sharp-electron/node_modules/sharp/index.js");
  await put("engine/node_modules/typescript/lib/typescript.js");
  await put("engine/node_modules/typescript/lib/lib.es2020.d.ts");
  await put("engine/node_modules/@types/node/index.d.ts");
  await put("engine/node_modules/other/index.d.ts");
  await put("engine/node_modules/other/index.js.map", "map");

  return root;
}

/** Whether a path exists. */
async function exists(absolute: string): Promise<boolean> {
  try {
    await access(absolute);
    return true;
  } catch {
    return false;
  }
}

describe("planPrune", () => {
  it("names maps, foreign prebuilds and foreign sharp, and keeps the rest", async () => {
    const root = await engineFixture();
    const plan = await planPrune({ root, platform: "win32", arch: "x64" });

    const removed = plan.files.map((file) => file.relative).sort();

    expect(removed).toEqual([
      "node_modules/@janhapke/sharp-electron/linux-x64/lib.so",
      "node_modules/node-pty/prebuilds/darwin-x64/c.node",
      "node_modules/node-pty/prebuilds/win32-arm64/b.node",
      "node_modules/other/index.js.map",
    ]);
    expect(plan.byReason["source-map"]).toEqual({ files: 1, bytes: 3 });
    expect(plan.byReason["foreign-prebuild"]).toEqual({ files: 2, bytes: 2 });
    expect(plan.byReason["foreign-sharp"]).toEqual({ files: 1, bytes: 6 });
  });

  it("keeps win32-x64, TypeScript lib declarations, @types and licenses", async () => {
    const root = await engineFixture();
    const plan = await planPrune({ root, platform: "win32", arch: "x64" });
    const removed = new Set(plan.files.map((file) => file.relative));

    for (const kept of [
      "node_modules/node-pty/prebuilds/win32-x64/a.node",
      "node_modules/typescript/lib/lib.es2020.d.ts",
      "node_modules/@types/node/index.d.ts",
      "node_modules/@janhapke/sharp-electron/index.js",
      "node_modules/@janhapke/sharp-electron/node_modules/sharp/index.js",
      "LICENSE",
    ]) {
      expect(removed.has(kept), `${kept} must not be pruned`).toBe(false);
    }
  });

  it("removes non-TypeScript declarations only when --drop-dts is on", async () => {
    const root = await engineFixture();
    const plan = await planPrune({ root, platform: "win32", arch: "x64", dropDts: true });
    const removed = new Set(plan.files.map((file) => file.relative));

    expect(removed.has("node_modules/other/index.d.ts")).toBe(true);
    expect(removed.has("node_modules/typescript/lib/lib.es2020.d.ts")).toBe(false);
    expect(removed.has("node_modules/@types/node/index.d.ts")).toBe(false);
  });
});

describe("pruneEngine", () => {
  it("removes only the planned files and leaves the source untouched", async () => {
    const source = await engineFixture();
    const target = path.join(work!, "pruned");

    const result = await pruneEngine({
      sourceDir: source,
      targetDir: target,
      platform: "win32",
      arch: "x64",
    });

    expect(result.plan.files).toHaveLength(4);
    await expect(exists(path.join(target, "node_modules/other/index.js.map"))).resolves.toBe(false);
    await expect(
      exists(path.join(target, "node_modules/node-pty/prebuilds/win32-arm64/b.node")),
    ).resolves.toBe(false);
    await expect(
      exists(path.join(target, "node_modules/node-pty/prebuilds/win32-x64/a.node")),
    ).resolves.toBe(true);
    await expect(
      readFile(path.join(source, "node_modules/other/index.js.map"), "utf8"),
    ).resolves.toBe("map");
    await expect(readFile(path.join(target, "LICENSE"), "utf8")).resolves.toBe("license");
  });

  it("removes the empty directory of a fully pruned prebuild", async () => {
    const source = await engineFixture();
    const target = path.join(work!, "pruned");

    await pruneEngine({ sourceDir: source, targetDir: target, platform: "win32", arch: "x64" });

    await expect(
      exists(path.join(target, "node_modules/node-pty/prebuilds/win32-arm64")),
    ).resolves.toBe(false);
  });

  it("refuses a target inside the source", async () => {
    const source = await engineFixture();

    await expect(
      pruneEngine({
        sourceDir: source,
        targetDir: path.join(source, "out"),
        platform: "win32",
        arch: "x64",
      }),
    ).rejects.toThrow(/inside source/);
  });

  it("refuses a target that contains the source", async () => {
    const source = await engineFixture();
    const parent = path.dirname(source);

    await expect(
      pruneEngine({
        sourceDir: source,
        targetDir: parent,
        platform: "win32",
        arch: "x64",
      }),
    ).rejects.toThrow(/contain source/);

    await expect(stat(path.join(source, "haruyuki.js"))).resolves.toBeDefined();
  });

  it("refuses a source that is not an engine", async () => {
    const empty = path.join(work!, "empty");

    await mkdir(empty);

    await expect(
      pruneEngine({
        sourceDir: empty,
        targetDir: path.join(work!, "out"),
        platform: "win32",
        arch: "x64",
      }),
    ).rejects.toThrow(/not an engine directory/);
  });
});

describe("stageRuntime", () => {
  it("copies the pruned engine and the real watchdog into runtime/", async () => {
    const source = await engineFixture();
    const watchdog = path.join(work!, "watchdog.cjs");
    const target = path.join(work!, "runtime");

    await writeFile(watchdog, "// watchdog\n", "utf8");

    const result = await stageRuntime({
      sourceDir: source,
      targetDir: target,
      watchdogSource: watchdog,
      platform: "win32",
      arch: "x64",
    });

    expect(result.targetDir).toBe(target);
    expect(result.engineDir).toBe(path.join(target, "engine"));
    expect(result.watchdogPath).toBe(path.join(target, "watchdog.cjs"));
    await expect(stat(path.join(target, "engine", "haruyuki.js"))).resolves.toBeTruthy();
    await expect(readFile(path.join(target, "watchdog.cjs"), "utf8")).resolves.toBe(
      "// watchdog\n",
    );
    await expect(
      exists(path.join(target, "engine", "node_modules/other/index.js.map")),
    ).resolves.toBe(false);
  });

  it("replaces an existing target and removes its stale files", async () => {
    const source = await engineFixture();
    const watchdog = path.join(work!, "watchdog.cjs");
    const target = path.join(work!, "runtime");

    await writeFile(watchdog, "// watchdog\n", "utf8");
    await mkdir(path.join(target, "engine"), { recursive: true });
    await writeFile(path.join(target, "engine", "stale.js"), "stale", "utf8");

    await stageRuntime({
      sourceDir: source,
      targetDir: target,
      watchdogSource: watchdog,
      platform: "win32",
      arch: "x64",
    });

    await expect(exists(path.join(target, "engine", "stale.js"))).resolves.toBe(false);
  });

  it("fails loudly when the watchdog source is missing", async () => {
    const source = await engineFixture();

    await expect(
      stageRuntime({
        sourceDir: source,
        targetDir: path.join(work!, "runtime"),
        watchdogSource: path.join(work!, "absent.cjs"),
        platform: "win32",
        arch: "x64",
      }),
    ).rejects.toThrow(/watchdog source is missing/);
  });
});
