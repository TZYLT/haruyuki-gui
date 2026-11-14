/**
 * Behaviour tests for the headless host port in `headless-host-port.ts`.
 *
 * Every case uses a real temporary directory tree: the contract is about
 * directories existing and about the shape of the spawn instruction, so mocking
 * `node:fs` would test the mock instead of the host. The engine bundle is an
 * empty `.mjs` file, and no engine process is ever started.
 *
 * Cleanup is point-by-point rather than recursive removal (no recursive section 5.1,
 * rule 3): each file is unlinked and each directory is removed only after its
 * children, so a bug in the fixture can never delete a tree this suite did not
 * create.
 */

import { statSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHeadlessHostPort, type HeadlessHostPortOptions } from "./headless-host-port";
import type { HostPortStartup } from "./host-port";

/** Roots created by a test; removed once the test settles. */
const tempRoots = new Set<string>();

afterEach(async () => {
  for (const root of tempRoots) {
    await removeTree(root);
  }

  tempRoots.clear();
});

describe("createHeadlessHostPort", () => {
  it("reports all four capabilities as false", async () => {
    const { port } = await createFixture();

    expect(port.capabilities).toEqual({
      canNotify: false,
      canReadDroppedFiles: false,
      canPopout: false,
      canFloatingWindow: false,
    });
  });

  it("creates the four path roots inside engineHome", async () => {
    const { engineHome, port } = await createFixture();

    for (const key of ["userData", "logs", "cache", "temp"] as const) {
      const dir = port.paths[key];

      expect(path.isAbsolute(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(isInside(engineHome, dir)).toBe(true);
    }

    expect(port.paths.temp).toBe(path.join(engineHome, "temp"));
  });

  it("uses a relative tokenDir as paths.temp inside engineHome", async () => {
    const { engineHome, port } = await createFixture({ tokenDir: "tokens" });

    expect(port.paths.temp).toBe(path.join(engineHome, "tokens"));
    expect(statSync(port.paths.temp).isDirectory()).toBe(true);
    expect(isInside(engineHome, port.paths.temp)).toBe(true);
  });

  it("rejects a tokenDir outside engineHome", async () => {
    const root = await makeRoot();
    const engineHome = path.join(root, "engine-home");
    const outside = path.join(root, "outside-tokens");

    await expect(
      createHeadlessHostPort({
        bundlePath: path.join(root, "engine.mjs"),
        engineHome,
        tokenDir: outside,
      }),
    ).rejects.toThrow(/tokenDir must stay inside engineHome/);
  });
});

describe("getRuntimeSpawnSpec", () => {
  it("returns the complete spawn spec for an existing bundle", async () => {
    const { engineHome, bundlePath, port } = await createFixture();

    const result = await port.getRuntimeSpawnSpec();

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(`expected a spawn spec, got a refusal: ${result.reason}`);
    }

    const { spec } = result;

    // The frozen `EngineSpawnSpec` shape has exactly these eight fields.
    expect(Object.keys(spec).sort()).toEqual([
      "argvPrefix",
      "bundlePath",
      "cwd",
      "detached",
      "env",
      "exePath",
      "stdio",
      "windowsHide",
    ]);
    expect(spec.exePath).toBe(process.execPath);
    expect(spec.argvPrefix).toEqual([
      "server",
      "--listen",
      "ws://127.0.0.1:0",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
    ]);
    expect(spec.bundlePath).toBe(bundlePath);
    expect(spec.stdio).toBe("pipe");
    expect(spec.windowsHide).toBe(true);
    expect(spec.detached).toBe(false);
    expect(spec.env.HARUYUKI_HOME).toBe(engineHome);

    const nodeOptions = spec.env.NODE_OPTIONS;

    expect(nodeOptions).toMatch(/^--require ".*watchdog\.cjs"$/);

    // The quoted path must be absolute and must point at the watchdog file
    // location derived from this module, not at a bare relative name.
    const match = /^--require "(.*)"$/.exec(nodeOptions ?? "");
    const watchdogPath = match?.[1] ?? "";

    expect(path.isAbsolute(watchdogPath)).toBe(true);
    expect(watchdogPath.endsWith("watchdog.cjs")).toBe(true);
    expect(watchdogPath).toMatch(/runtime[\\/]watchdog\.cjs$/);

    // The token value never travels through the environment; only the token
    // file PATH may be passed later, by Engine.start.
    expect(Object.keys(spec.env).filter((key) => /token/i.test(key))).toEqual([]);
  });

  it("refuses a bundle that does not exist and names its path", async () => {
    const { bundlePath, port } = await createFixture({ bundleExists: false });

    const result = await port.getRuntimeSpawnSpec();

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("expected a refusal for a missing bundle");
    }

    expect(result.reason).toContain(bundlePath);
  });

  it("sets cwd to the existing userData directory", async () => {
    const { port } = await createFixture();

    const result = await port.getRuntimeSpawnSpec();

    if (!result.ok) {
      throw new Error(`expected a spawn spec, got a refusal: ${result.reason}`);
    }

    expect(result.spec.cwd).toBe(port.paths.userData);
    expect(statSync(result.spec.cwd).isDirectory()).toBe(true);
  });

  it("checks the bundle again on every call", async () => {
    const { bundlePath, port } = await createFixture({ bundleExists: false });

    expect((await port.getRuntimeSpawnSpec()).ok).toBe(false);

    writeFileSync(bundlePath, "// engine appears later\n");

    expect((await port.getRuntimeSpawnSpec()).ok).toBe(true);
  });
});

type Fixture = {
  root: string;
  engineHome: string;
  bundlePath: string;
  port: HostPortStartup;
};

type FixtureOptions = {
  bundleExists?: boolean;
  tokenDir?: string;
};

/**
 * Create one engine home plus one fake bundle and build a headless port on it.
 */
async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await makeRoot();
  const engineHome = path.join(root, "engine-home");
  const bundlePath = path.join(root, "engine.mjs");

  if (options.bundleExists !== false) {
    writeFileSync(bundlePath, "// fake engine bundle\n");
  }

  const portOptions: HeadlessHostPortOptions = { bundlePath, engineHome };

  if (options.tokenDir !== undefined) {
    portOptions.tokenDir = options.tokenDir;
  }

  const port = await createHeadlessHostPort(portOptions);

  return { root, engineHome, bundlePath, port };
}

/** Create a disposable root and remember it for cleanup. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "haruyuki-headless-test-"));

  tempRoots.add(root);

  return root;
}

/** True when `candidate` is `root` itself or a descendant of it. */
function isInside(root: string, candidate: string): boolean {
  const fromRoot = path.relative(root, candidate);

  return fromRoot !== "" && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot);
}

/**
 * Remove a tree depth-first, one entry per call.
 *
 * A missing entry is ignored: cleanup runs after a test that may have already
 * removed part of the tree, and cleanup must never mask the real failure.
 */
async function removeTree(root: string): Promise<void> {
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const child = path.join(root, entry.name);

    if (entry.isDirectory()) {
      await removeTree(child);
      continue;
    }

    await unlink(child).catch(() => undefined);
  }

  await rmdir(root).catch(() => undefined);
}
