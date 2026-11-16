/**
 * Startup is where a wrong lock becomes a user-visible refusal, so these tests
 * exercise the real files: a staged engine, a generated-shaped lock and a state
 * file. The assertions are about the decision, not about Electron.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashFile, hashTree } from "../runtime/lock.js";
import type { RuntimeLayout } from "../runtime/layout.js";
import { prepareRuntime } from "../runtime/startup.js";

let work: string | null = null;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "g1-startup-"));
});

afterEach(async () => {
  if (work !== null) await rm(work, { recursive: true, force: true });
  work = null;
});

/** Create an engine and layout under the temp root. */
async function fixture(): Promise<{ layout: RuntimeLayout; engineDir: string }> {
  const root = work!;
  const appRoot = path.join(root, "app");
  const resources = path.join(root, "resources");
  const engineDir = path.join(resources, "engine");
  const logsDir = path.join(root, "logs");

  await mkdir(path.join(engineDir, "node_modules"), { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(path.join(engineDir, "haruyuki.js"), "entry", "utf8");
  await writeFile(
    path.join(engineDir, "package.json"),
    JSON.stringify({ name: "haruyuki", version: "0.6.0" }),
    "utf8",
  );
  await writeFile(path.join(engineDir, "node_modules", "a.js"), "a", "utf8");

  return {
    engineDir,
    layout: {
      mode: "packaged",
      appRoot,
      resourcesRoot: resources,
      engineDir,
      bundlePath: path.join(engineDir, "haruyuki.js"),
      watchdogPath: path.join(resources, "runtime", "watchdog.cjs"),
      lockPath: path.join(appRoot, "runtime-lock.json"),
      statePath: path.join(root, "userData", "runtime-state.json"),
      logsDir,
    },
  };
}

/** Write a lock that matches the fixture engine. */
async function writeLock(layout: RuntimeLayout): Promise<void> {
  const entry = await hashFile(layout.bundlePath);
  const tree = await hashTree(layout.engineDir);
  const lock = {
    lockVersion: 1,
    engineVersion: "0.6.0",
    bundle: { name: "haruyuki", entry: "haruyuki.js", bytes: entry.bytes },
    sha256: entry.sha256,
    source: { kind: "npm", spec: "haruyuki@0.6.0" },
    builtAt: "2026-11-16T00:00:00.000Z",
    runtime: { electron: "45.3.2", node: "24.22.2", modules: "150" },
    tree,
  };

  await writeFile(layout.lockPath, JSON.stringify(lock), "utf8");
}

describe("prepareRuntime", () => {
  it("starts a matching bundled engine and records the app version", async () => {
    const { layout } = await fixture();
    await writeLock(layout);

    const plan = await prepareRuntime({ layout, appVersion: "0.1.0" });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.source).toBe("bundled");
    expect(plan.treeChecked).toBe(true);
    expect(plan.state.lastAppVersion).toBe("0.1.0");
    expect(plan.state.lastResult).toBe("ok");
  });

  it("refuses a changed entry with the expected and actual hashes", async () => {
    const { layout } = await fixture();
    await writeLock(layout);
    await writeFile(layout.bundlePath, "tampered", "utf8");

    const plan = await prepareRuntime({ layout, appVersion: "0.1.0" });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure.kind).toBe("entry-mismatch");
    expect(plan.failure.expectedSha256).toHaveLength(64);
    expect(plan.failure.actualSha256).toHaveLength(64);
    expect(plan.state.lastResult).toBe("entry-mismatch");
  });

  it("does not tree-check a second time when the app version is unchanged", async () => {
    const { layout } = await fixture();
    await writeLock(layout);
    await prepareRuntime({ layout, appVersion: "0.1.0" });

    const second = await prepareRuntime({ layout, appVersion: "0.1.0" });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.treeChecked).toBe(false);
  });

  it("reports a missing bundled engine instead of starting something else", async () => {
    const { layout } = await fixture();
    await writeLock(layout);
    await rm(path.join(layout.engineDir, "haruyuki.js"));

    const plan = await prepareRuntime({ layout, appVersion: "0.1.0" });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.failure.kind).toBe("missing-bundle");
  });

  it("falls back from a gone external directory and carries the reason", async () => {
    const { layout } = await fixture();
    await writeLock(layout);
    await mkdir(path.dirname(layout.statePath), { recursive: true });
    await writeFile(
      layout.statePath,
      JSON.stringify({
        stateVersion: 1,
        lastAppVersion: "0.1.0",
        lastVerifiedAt: "",
        lastResult: "ok",
        externalEngineDir: path.join(work!, "gone"),
      }),
      "utf8",
    );

    const plan = await prepareRuntime({ layout, appVersion: "0.1.0" });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.source).toBe("bundled");
    expect(plan.externalInvalid?.dir).toContain("gone");
  });

  it("uses an external engine without requiring the bundled lock", async () => {
    const { layout } = await fixture();
    await rm(layout.lockPath, { force: true });
    await mkdir(path.dirname(layout.statePath), { recursive: true });

    const externalDir = path.join(work!, "external");
    await mkdir(path.join(externalDir, "node_modules"), { recursive: true });
    await writeFile(path.join(externalDir, "haruyuki.js"), "external", "utf8");
    await writeFile(
      path.join(externalDir, "package.json"),
      JSON.stringify({ name: "haruyuki", version: "0.6.0" }),
      "utf8",
    );
    await writeFile(
      layout.statePath,
      JSON.stringify({
        stateVersion: 1,
        lastAppVersion: "0.1.0",
        lastVerifiedAt: "",
        lastResult: "ok",
        externalEngineDir: externalDir,
      }),
      "utf8",
    );

    const plan = await prepareRuntime({ layout, appVersion: "0.1.0" });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.source).toBe("external");
    expect(plan.bundlePath).toBe(path.join(externalDir, "haruyuki.js"));
  });
});
