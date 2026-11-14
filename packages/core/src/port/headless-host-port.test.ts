/**
 * Smoke tests for the headless host port as `nine-item contract` (nine items).
 *
 * The shape is declared in `host-port.ts`, `host-port-contract.test.ts` is the
 * per-item semantic table, and `headless-host-port.ts` is the implementation
 * these cases drive. The startup subset already has its own
 * suite in `host-port.test.ts` and its cross-implementation suite in
 * `contract.test.ts`; this file is a deliberately small smoke pass over the six
 * new items plus the two headless additions (`dispose`, `calls`).
 *
 * Scope on purpose: one happy path and the frozen failure mode per member, not
 * the full contract table. A later package extends this file into that table, so
 * every case here is written to stay green when it does - real temporary
 * directories, no mocks of `node:fs`, no engine process ever started, and no
 * assertion on internals that a stricter contract test is free to change.
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
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createHeadlessHostPort,
  type HeadlessHostPort,
  type HeadlessHostPortOptions,
} from "./headless-host-port";

/** Roots created by a test; removed once the test settles. */
const tempRoots = new Set<string>();

afterEach(async () => {
  for (const root of tempRoots) {
    await removeTree(root);
  }

  tempRoots.clear();
});

describe("headless host port: nine-item contract", () => {
  it("exposes the nine contract members plus the headless additions", async () => {
    const { port } = await createFixture();

    // The frozen nine, in contract order, plus `dispose`. A missing member would
    // otherwise only fail at the call site of whichever consumer needs it.
    const members = [
      "secureGet",
      "secureSet",
      "secureDelete",
      "openExternal",
      "pickPaths",
      "resolveLocalResource",
      "onShutdown",
      "notify",
      "readDroppedFiles",
      "dispose",
    ] as const;

    for (const name of members) {
      expect(typeof port[name]).toBe("function");
    }

    expect(port.calls).toEqual({ openExternal: [], notify: [], pickPaths: 0 });
    expect(Object.keys(port.paths).sort()).toEqual(["cache", "logs", "temp", "userData"]);
  });

  it("accepts a token directory whose name starts with two dots", async () => {
    const root = await makeRoot();
    const engineHome = path.join(root, "engine-home");
    const bundlePath = path.join(root, "engine.mjs");

    writeFileSync(bundlePath, "// fake engine bundle\n");

    const port = await createHeadlessHostPort({ bundlePath, engineHome, tokenDir: "..tokens" });

    // "..tokens" is a child of the home, not the parent. A bare
    // `startsWith("..")` read the name as an escape and refused a valid
    // configuration, while `isInsideRoot` in the same file already used the
    // separator-aware form.
    expect(port.paths.temp).toBe(path.join(engineHome, "..tokens"));
    expect(statSync(port.paths.temp).isDirectory()).toBe(true);
  });

  it("rejects a token directory that leaves the engine home", async () => {
    const root = await makeRoot();
    const engineHome = path.join(root, "engine-home");
    const bundlePath = path.join(root, "engine.mjs");

    writeFileSync(bundlePath, "// fake engine bundle\n");

    for (const tokenDir of ["..", "../outside", path.join(root, "sibling")]) {
      await expect(createHeadlessHostPort({ bundlePath, engineHome, tokenDir })).rejects.toThrow(
        /inside engineHome/,
      );
    }
  });

  it("removes the disposable engine home when construction fails", async () => {
    const parent = await makeRoot();
    const bundlePath = path.join(parent, "engine.mjs");
    const saved = ["TMP", "TEMP", "TMPDIR"].map((key) => [key, process.env[key]] as const);

    writeFileSync(bundlePath, "// fake engine bundle\n");

    // `mkdtemp` follows os.tmpdir(), which reads TMP/TEMP/TMPDIR: pointing them
    // at a known directory is the only way to observe a leaked home.
    for (const [key] of saved) {
      process.env[key] = parent;
    }

    try {
      await expect(createHeadlessHostPort({ bundlePath, tokenDir: "../escape" })).rejects.toThrow(
        /inside engineHome/,
      );

      // The home the factory made must not outlive the rejection: the caller
      // never learns its path, so nothing else could ever remove it.
      expect(await readdir(parent)).toEqual(["engine.mjs"]);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("keeps the startup subset intact: four false capabilities and a usable spec", async () => {
    const { bundlePath, engineHome, port } = await createFixture();

    expect(port.capabilities).toEqual({
      canNotify: false,
      canReadDroppedFiles: false,
      canPopout: false,
      canFloatingWindow: false,
    });

    for (const key of ["userData", "logs", "cache", "temp"] as const) {
      expect(statSync(port.paths[key]).isDirectory()).toBe(true);
      expect(isInside(engineHome, port.paths[key])).toBe(true);
    }

    const result = await port.getRuntimeSpawnSpec();

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(`expected a spawn spec, got a refusal: ${result.reason}`);
    }

    expect(result.spec.bundlePath).toBe(bundlePath);
    expect(result.spec.cwd).toBe(port.paths.userData);
  });

  it("serves the secure store from memory with the frozen codes", async () => {
    const { port } = await createFixture({ secureSeed: { token: "seeded-value" } });

    expect(await port.secureGet("token")).toEqual({ ok: true, value: "seeded-value" });
    expect(await port.secureGet("missing")).toEqual({ ok: false, code: "NOT_FOUND" });

    expect(await port.secureSet("added", "second-value")).toEqual({ ok: true });
    expect(await port.secureGet("added")).toEqual({ ok: true, value: "second-value" });

    // Overwriting is the token-refresh path and is not an error.
    expect(await port.secureSet("added", "third-value")).toEqual({ ok: true });
    expect(await port.secureGet("added")).toEqual({ ok: true, value: "third-value" });

    expect(await port.secureDelete("added")).toEqual({ ok: true });
    expect(await port.secureGet("added")).toEqual({ ok: false, code: "NOT_FOUND" });

    // Deleting an absent key is still a success: idempotent by contract.
    expect(await port.secureDelete("added")).toEqual({ ok: true });

    // A second port does not inherit the first one's store: persistence is
    // 4.1 row 3: in-process persistence, not shared across instances).
    const { port: other } = await createFixture();

    expect(await other.secureGet("token")).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("accepts http and https only, and records only accepted URLs", async () => {
    const { port } = await createFixture();

    expect(await port.openExternal("https://example.com/a")).toEqual({ ok: true });
    expect(await port.openExternal("http://example.com")).toEqual({ ok: true });

    const rejected = [
      "mailto:dev@example.com",
      "file:///C:/Windows/win.ini",
      "javascript:alert(1)",
      "../relative/path",
      "not a url",
    ];

    for (const url of rejected) {
      expect(await port.openExternal(url)).toEqual({ ok: false, code: "REJECTED_SCHEME" });
    }

    // A refusal must not appear in the accepted trace: the trace answers what
    // the shell was actually asked to open.
    expect(port.calls.openExternal).toEqual(["https://example.com/a", "http://example.com"]);
  });

  it("consumes one queued answer per pickPaths call and reports cancellation as []", async () => {
    const answers = [
      path.join(tmpdir(), "haruyuki-pick-1.txt"),
      [path.join(tmpdir(), "haruyuki-pick-2.txt"), path.join(tmpdir(), "haruyuki-pick-3.txt")],
    ];

    const { port } = await createFixture({ pickQueue: answers });

    expect(await port.pickPaths({ kind: "file" })).toEqual([answers[0]]);
    // A list answer is what a `multiple: true` dialog returns; the same answer
    // asked for one path truncates, the way a real dialog honours its properties.
    expect(await port.pickPaths({ kind: "directory", multiple: true })).toEqual(answers[1]);
    expect(await port.pickPaths({ kind: "file", multiple: true })).toEqual([]);

    // An empty queue is a cancellation, which is an empty array and not an error
    // .
    expect(await port.pickPaths({ kind: "file" })).toEqual([]);

    // Every call counts, including the cancelled ones.
    expect(port.calls.pickPaths).toBe(4);
  });

  it("resolves a path inside an allowed root and refuses everything outside", async () => {
    const { root, engineHome, port } = await createFixture();
    const inside = path.join(engineHome, "userData", "state.json");

    // Default whitelist is [engineHome] when the caller supplied one.
    expect(await port.resolveLocalResource(inside)).toEqual({
      ok: true,
      url: pathToFileURL(inside).href,
    });

    const refused = [
      path.join(engineHome, "..", "sibling.txt"),
      path.join(root, "outside-engine-home.txt"),
      "../relative.txt",
      "state.json",
    ];

    for (const candidate of refused) {
      expect(await port.resolveLocalResource(candidate)).toEqual({
        ok: false,
        code: "OUT_OF_ROOT",
      });
    }

    // An explicit whitelist replaces the default: a path beside engineHome is
    // now allowed, while the old default is no longer special.
    const widened = await createFixture({ allowedRoots: [root] });

    expect(
      (await widened.port.resolveLocalResource(path.join(root, "bundle-adjacent.json"))).ok,
    ).toBe(true);
  });

  it("runs shutdown callbacks once, in registration order, and is idempotent", async () => {
    const { port } = await createFixture();
    const order: string[] = [];

    // onShutdown is synchronous registration: no promise, no await.
    const registration = port.onShutdown(() => order.push("first"));

    expect(registration).toBeUndefined();

    port.onShutdown(() => order.push("second"));

    await port.dispose();

    expect(order).toEqual(["first", "second"]);

    // A second dispose must not re-run a callback: these stop child processes.
    await port.dispose();

    expect(order).toEqual(["first", "second"]);
  });

  it("records notify calls and resolves even though canNotify is false", async () => {
    const { port } = await createFixture();

    expect(port.capabilities.canNotify).toBe(false);

    await expect(port.notify("info", "engine started")).resolves.toBeUndefined();
    await port.notify("warn", "slow frame");
    await port.notify("error", "spawn failed");

    expect(port.calls.notify).toEqual([
      { level: "info", message: "engine started" },
      { level: "warn", message: "slow frame" },
      { level: "error", message: "spawn failed" },
    ]);
  });

  it("refuses every dropped-file list as UNSUPPORTED, without reading", async () => {
    const { engineHome, port } = await createFixture();
    const droppedPath = path.join(engineHome, "dropped.txt");

    // The answer does not depend on the input: empty list, name-only entries,
    // empty list, name-only entries, an entry with a path, and a mixture.
    const lists: { name: string; path?: string }[][] = [
      [],
      [{ name: "one.txt" }, { name: "two.txt" }],
      [{ name: "dropped.txt", path: droppedPath }],
      [{ name: "one.txt" }, { name: "dropped.txt", path: droppedPath }],
    ];

    for (const files of lists) {
      expect(await port.readDroppedFiles(files)).toEqual({ ok: false, code: "UNSUPPORTED" });
    }

    // The path deliberately does not exist: an implementation that tried to
    // read it would fail instead of answering the frozen refusal.
  });
});

type Fixture = {
  root: string;
  engineHome: string;
  bundlePath: string;
  port: HeadlessHostPort;
};

type FixtureOptions = {
  pickQueue?: Array<string | string[]>;
  allowedRoots?: string[];
  secureSeed?: Record<string, string>;
};

/**
 * Create one engine home plus one fake bundle and build a headless port on it.
 *
 * `engineHome` is explicit so the whole tree lives under our single root and the
 * point-by-point cleanup in `afterEach` covers it.
 */
async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await makeRoot();
  const engineHome = path.join(root, "engine-home");
  const bundlePath = path.join(root, "engine.mjs");

  writeFileSync(bundlePath, "// fake engine bundle\n");

  const portOptions: HeadlessHostPortOptions = { bundlePath, engineHome };

  if (options.pickQueue !== undefined) {
    portOptions.pickQueue = options.pickQueue;
  }

  if (options.allowedRoots !== undefined) {
    portOptions.allowedRoots = options.allowedRoots;
  }

  if (options.secureSeed !== undefined) {
    portOptions.secureSeed = options.secureSeed;
  }

  const port = await createHeadlessHostPort(portOptions);

  return { root, engineHome, bundlePath, port };
}

/** Create a disposable root and remember it for cleanup. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "haruyuki-hostport-smoke-"));

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
