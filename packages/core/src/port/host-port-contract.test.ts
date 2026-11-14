/**
 * Semantic table for the nine-item `HostPort` contract: every item exercised
 * implementation.
 *
 * Shape source: docs/18-A3 section 3.4.1 (the frozen nine-item contract), read
 * against the per-item headless semantics of docs/17-A3 section 4.1 and the
 * cross-shell semantics of docs/01-3 section 2.2. Where a sentence in those
 * documents describes a failure mode, this file has a case that fires it - the
 * point of `V-1` is that every documented failure mode is reachable and returns
 * the frozen code, not that the happy path works.
 *
 * Deliberately not a copy of the neighbouring suites:
 *
 * - `host-port.test.ts` (B1) pins the startup subset's own decisions.
 * - `headless-host-port.test.ts` is the smoke pass over the six new items.
 * - `contract.test.ts` runs one implementation-independent body over the
 *   startup subset.
 *
 * This file is the semantic table: one case per documented failure mode per
 * item, plus the shape claims the contract cannot express at runtime alone.
 * three-adapter parity suite (`testing/adapters.test.ts`) is a different claim
 * different claim and lives elsewhere.
 *
 * `STORAGE_UNAVAILABLE` needs a word. It is part of the frozen `secureGet` /
 * `secureSet` unions, and an in-memory headless store cannot produce it, so
 * asserting that it *fires* would be asserting a lie about the implementation.
 * The case below asserts the stronger, honest pair: the code is documented in
 * the contract and no reachable headless path ever answers it.
 *
 * Cleanup is point-by-point: each file is unlinked and each directory is
 * unlinked and each directory is removed only after its children, so a fixture
 * bug can never delete a tree this suite did not create.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { EngineSpawnSpec } from "../engine/types";
import {
  createHeadlessHostPort,
  type HeadlessHostPort,
  type HeadlessHostPortOptions,
} from "./headless-host-port";
import type { HostPort, HostPortStartup } from "./host-port";

/** Roots created by a case; removed once that case settles. */
const tempRoots = new Set<string>();

afterEach(async () => {
  for (const root of tempRoots) {
    await removeTree(root);
  }

  tempRoots.clear();
});

/** The four capability names item 0 freezes; an extra key is a contract breach. */
const CAPABILITY_KEYS = ["canNotify", "canReadDroppedFiles", "canPopout", "canFloatingWindow"];

/** The four directory roots item 1 freezes. */
const PATH_KEYS = ["userData", "logs", "cache", "temp"] as const;

/** The eight frozen `EngineSpawnSpec` fields. */
const SPAWN_SPEC_FIELDS = [
  "exePath",
  "env",
  "argvPrefix",
  "bundlePath",
  "cwd",
  "stdio",
  "windowsHide",
  "detached",
] as const;

/** Engine argv before the bundle path; the token path is appended by the facade. */
const ENGINE_ARGV_PREFIX = [
  "server",
  "--listen",
  "ws://127.0.0.1:0",
  "--ws-auth",
  "capability-token",
  "--ws-token-file",
] as const;

/**
 * URLs item 4 must reject. `mailto:` and `file:` are the two a "helpful" parser
 * would be tempted to accept; they are rejected with everything else.
 */
const REJECTED_URLS = [
  "mailto:dev@example.com",
  "file:///C:/Windows/win.ini",
  "javascript:alert(1)",
  "data:text/html,hello",
  "ftp://example.com/file",
  "../relative/path",
  "not a url",
  "",
];

/**
 * The two source files the shape claims read from.
 *
 * `host-port.ts` is the frozen contract itself; reading it as text is how this
 * suite asserts a declaration (`extends`) and the presence of a documented
 * unreachable code without pretending to execute either.
 */
const HOST_PORT_SOURCE = readFileSync(new URL("./host-port.ts", import.meta.url), "utf8");
const HEADLESS_SOURCE = readFileSync(new URL("./headless-host-port.ts", import.meta.url), "utf8");

/**
 * Structural equality at the type level.
 *
 * Both directions are required: a wider return type is a contract breach just as
 * a narrower one is.
 */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compile-time proof: `false` is a type error at the alias, not a red test. */
type Assert<T extends true> = T;

type HostPortExtendsStartup = Assert<HostPort extends HostPortStartup ? true : false>;

type CapabilitiesTypeIsFrozen = Assert<
  Equals<
    HostPortStartup["capabilities"],
    {
      canNotify: boolean;
      canReadDroppedFiles: boolean;
      canPopout: boolean;
      canFloatingWindow: boolean;
    }
  >
>;

type PathsTypeIsFrozen = Assert<
  Equals<
    HostPortStartup["paths"],
    {
      userData: string;
      logs: string;
      cache: string;
      temp: string;
    }
  >
>;

type SpawnSpecReturnTypeIsFrozen = Assert<
  Equals<
    ReturnType<HostPortStartup["getRuntimeSpawnSpec"]>,
    Promise<{ ok: true; spec: EngineSpawnSpec } | { ok: false; reason: string }>
  >
>;

/**
 * The four type claims as runtime values.
 *
 * The tuple only compiles when every alias above resolved to `true`, so a
 * drifted shape breaks `pnpm --filter @haruyuki/core typecheck`; the assertion
 * additionally makes the claim visible in the test report.
 */
const FROZEN_STARTUP_SHAPE: [
  HostPortExtendsStartup,
  CapabilitiesTypeIsFrozen,
  PathsTypeIsFrozen,
  SpawnSpecReturnTypeIsFrozen,
] = [true, true, true, true];

describe("nine-item host port contract semantic table: headless host port", () => {
  it("item 0 - capabilities: the four documented flags, all false", async () => {
    const { port } = await createFixture();

    // Item 0's documented failure mode is a consumer reading a missing field as
    // `false`. The headless answer gives all four explicitly, which is the
    // stronger state: there is no missing field left to work around.
    expect(Object.keys(port.capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());

    for (const key of CAPABILITY_KEYS) {
      expect(port.capabilities[key as keyof HostPortStartup["capabilities"]]).toBe(false);
    }
  });

  it("item 1 - paths: four absolute roots created under the injected engine home", async () => {
    const { engineHome, port } = await createFixture();

    expect(Object.keys(port.paths).sort()).toEqual([...PATH_KEYS].sort());

    for (const key of PATH_KEYS) {
      const root = port.paths[key];

      expect(path.isAbsolute(root)).toBe(true);
      expect(statSync(root).isDirectory()).toBe(true);
      expect(isInside(engineHome, root)).toBe(true);
    }
  });

  it("item 1 - paths: a root that cannot be created fails startup instead of degrading", async () => {
    const root = await makeRoot();
    const engineHomeIsAFile = path.join(root, "engine-home-is-a-file");

    // A file where the engine home should be: the factory cannot create the
    // four roots, which the contract maps to a startup failure rather than a
    // port with unusable paths. `bundlePath` is irrelevant here - the bundle is
    // only checked by `getRuntimeSpawnSpec`, after construction.
    writeFileSync(engineHomeIsAFile, "not a directory\n");

    await expect(
      createHeadlessHostPort({
        bundlePath: path.join(root, "engine.mjs"),
        engineHome: engineHomeIsAFile,
      }),
    ).rejects.toThrow();
  });

  it("item 2 - getRuntimeSpawnSpec: the eight frozen fields and the headless values", async () => {
    const { bundlePath, engineHome, port } = await createFixture();
    const result = await port.getRuntimeSpawnSpec();

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(`expected a spawn spec, got a refusal: ${result.reason}`);
    }

    const spec = result.spec;

    expect(Object.keys(spec).sort()).toEqual([...SPAWN_SPEC_FIELDS].sort());
    expect(spec.exePath).toBe(process.execPath);
    expect(spec.bundlePath).toBe(bundlePath);
    expect(spec.cwd).toBe(port.paths.userData);
    expect(spec.stdio).toBe("pipe");
    expect(spec.windowsHide).toBe(true);
    expect(spec.detached).toBe(process.platform !== "win32");
    expect(spec.argvPrefix).toEqual([...ENGINE_ARGV_PREFIX]);

    // The env is complete (each value a string) and carries the two headless
    // contract entries: the isolation root and the quoted absolute watchdog.
    expect(Object.keys(spec.env).length).toBeGreaterThan(0);

    for (const value of Object.values(spec.env)) {
      expect(typeof value).toBe("string");
    }

    // The isolation root is the user-data directory, the one path a desktop
    // shell also has (`app.getPath("userData")`); its logs, cache and temp come
    // from other answers and share no parent, so a parent-of-four reading could
    // not be implemented by the real shells.
    expect(spec.env["HARUYUKI_HOME"]).toBe(port.paths.userData);
    expect(spec.env["NODE_OPTIONS"]).toMatch(/^--require ".*watchdog\.cjs"$/);
  });

  it("item 2 - getRuntimeSpawnSpec: a missing bundle is a refusal value, not a throw", async () => {
    const { bundlePath, port } = await createFixture({ bundleExists: false });
    const result = await port.getRuntimeSpawnSpec();

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("expected a refusal for a bundle that does not exist");
    }

    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
    // A refusal is read by a human and classified as SPAWN_FAILED, so it has to
    // name what the host could not find.
    expect(result.reason).toContain(bundlePath);
  });

  it("item 2 - getRuntimeSpawnSpec: a relative bundle is refused as well", async () => {
    const { port } = await createFixture({ relativeBundle: true });
    const result = await port.getRuntimeSpawnSpec();

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("expected a refusal for a relative bundle path");
    }

    expect(result.reason).toContain("absolute");
  });

  it("item 3 - secure store: in-process persistence with the frozen codes", async () => {
    const { port } = await createFixture({ secureSeed: { token: "seeded-value" } });

    expect(await port.secureGet("token")).toEqual({ ok: true, value: "seeded-value" });
    // The documented failure mode: an absent key is NOT_FOUND, never an empty
    // string and never a plaintext fallback.
    expect(await port.secureGet("missing")).toEqual({ ok: false, code: "NOT_FOUND" });

    expect(await port.secureSet("added", "second-value")).toEqual({ ok: true });
    expect(await port.secureGet("added")).toEqual({ ok: true, value: "second-value" });

    // Overwriting is the token-refresh path and is not an error.
    expect(await port.secureSet("added", "third-value")).toEqual({ ok: true });
    expect(await port.secureGet("added")).toEqual({ ok: true, value: "third-value" });

    // An empty string is a stored value, distinct from an absent key: Map.get
    // is what keeps those apart.
    expect(await port.secureSet("empty", "")).toEqual({ ok: true });
    expect(await port.secureGet("empty")).toEqual({ ok: true, value: "" });

    expect(await port.secureDelete("added")).toEqual({ ok: true });
    expect(await port.secureGet("added")).toEqual({ ok: false, code: "NOT_FOUND" });

    // Deleting an absent key is still a success: `secureDelete` is idempotent.
    expect(await port.secureDelete("added")).toEqual({ ok: true });
    expect(await port.secureDelete("never-existed")).toEqual({ ok: true });
  });

  it("item 3 - secure store: STORAGE_UNAVAILABLE is documented, and never fires", async () => {
    // Documented: both unions in the frozen contract carry the code. Two quoted
    // occurrences - one per union - is the contract text as frozen.
    expect(HOST_PORT_SOURCE.match(/"STORAGE_UNAVAILABLE"/g) ?? []).toHaveLength(2);
    expect(HOST_PORT_SOURCE).toMatch(/code: "NOT_FOUND" \| "STORAGE_UNAVAILABLE"/);

    // The implementation documents why the code is unreachable, and has no
    // reachable return of it: one occurrence in the file, a comment.
    expect(HEADLESS_SOURCE.match(/STORAGE_UNAVAILABLE/g) ?? []).toHaveLength(1);
    expect(HEADLESS_SOURCE).toMatch(/STORAGE_UNAVAILABLE[\s\S]{0,120}?unreachable/);

    // Not fired: probe every reachable branch of the three members.
    const { port } = await createFixture({ secureSeed: { token: "value" } });
    const answers = [
      await port.secureGet("token"),
      await port.secureGet("missing"),
      await port.secureSet("key", "value"),
      await port.secureDelete("key"),
      await port.secureDelete("absent"),
    ];

    for (const answer of answers) {
      if (answer.ok) {
        continue;
      }

      expect(answer.code).not.toBe("STORAGE_UNAVAILABLE");
    }
  });

  it("item 4 - openExternal: http and https only, everything else REJECTED_SCHEME", async () => {
    const { port } = await createFixture();

    expect(await port.openExternal("https://example.com/a")).toEqual({ ok: true });
    expect(await port.openExternal("http://example.com")).toEqual({ ok: true });

    for (const url of REJECTED_URLS) {
      expect(await port.openExternal(url)).toEqual({ ok: false, code: "REJECTED_SCHEME" });
    }

    // A refusal is not recorded: the trace lists what the shell was actually
    // asked to open, so it cannot disagree with the return value.
    expect(port.calls.openExternal).toEqual(["https://example.com/a", "http://example.com"]);
  });

  it("item 5 - pickPaths: one queued answer per call, cancellation is []", async () => {
    const answers = [
      path.join(tmpdir(), "haruyuki-pick-1.txt"),
      path.join(tmpdir(), "haruyuki-pick-2.txt"),
    ];

    const { port } = await createFixture({ pickQueue: answers });

    expect(await port.pickPaths({ kind: "file" })).toEqual([answers[0]]);
    // `multiple: true` does not invent a second answer: the queue is the whole
    // deterministic answer of a headless host.
    expect(await port.pickPaths({ kind: "directory", multiple: true })).toEqual([answers[1]]);

    // The documented failure mode: cancellation is an empty array, not an error.
    expect(await port.pickPaths({ kind: "file" })).toEqual([]);

    // Every call counts, including the cancelled one.
    expect(port.calls.pickPaths).toBe(3);
  });

  it("item 6 - resolveLocalResource: a path inside a root becomes a file URL", async () => {
    const { engineHome, port } = await createFixture();
    const inside = path.join(engineHome, "userData", "state.json");

    expect(await port.resolveLocalResource(inside)).toEqual({
      ok: true,
      url: pathToFileURL(inside).href,
    });

    // The root itself is inside the root, by the same lexical rule.
    expect(await port.resolveLocalResource(engineHome)).toEqual({
      ok: true,
      url: pathToFileURL(engineHome).href,
    });
  });

  it("item 6 - resolveLocalResource: OUT_OF_ROOT for every documented escape", async () => {
    const { root, engineHome, port } = await createFixture();

    const refused = [
      // Absolute, but outside the whitelist.
      path.join(root, "outside-engine-home.txt"),
      // A `..` escape that starts inside and lands outside.
      path.join(engineHome, "..", "sibling.txt"),
      path.join(engineHome, "userData", "..", "..", "sibling.txt"),
      // Relative inputs: no root a relative path could be inside of.
      "state.json",
      "../relative.txt",
      "..",
      "",
    ];

    // Another drive: `path.relative` answers an absolute path there, which the
    // containment rule must read as outside. Windows-only; the concept does not
    // exist on POSIX, where the case is covered by the absolute-escape entry.
    const otherDrive = anotherDrivePath(root);

    if (otherDrive !== undefined) {
      refused.push(otherDrive);
    }

    for (const candidate of refused) {
      expect(await port.resolveLocalResource(candidate)).toEqual({
        ok: false,
        code: "OUT_OF_ROOT",
      });
    }
  });

  it("item 7 - onShutdown: synchronous registration, dispose runs it once", async () => {
    const { port } = await createFixture();
    const order: string[] = [];

    // Synchronous registration: no promise, no await, and nothing runs at
    // registration time.
    const registration = port.onShutdown(() => order.push("first"));

    expect(registration).toBeUndefined();
    expect(order).toEqual([]);

    port.onShutdown(() => order.push("second"));

    await port.dispose();

    expect(order).toEqual(["first", "second"]);

    // Idempotent: these callbacks stop child processes, so a second dispose must
    // not re-run them.
    await port.dispose();

    expect(order).toEqual(["first", "second"]);
  });

  it("item 8 - notify: silent success for all three levels when canNotify is false", async () => {
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

  it("item 9 - readDroppedFiles: UNSUPPORTED unconditionally, without reading", async () => {
    const { engineHome, port } = await createFixture();
    const droppedPath = path.join(engineHome, "dropped.txt");

    // The answer does not depend on the input: an empty list, name-only entries,
    // an entry with a path and a mixture all get the frozen refusal.
    const lists: { name: string; path?: string }[][] = [
      [],
      [{ name: "one.txt" }, { name: "two.txt" }],
      [{ name: "dropped.txt", path: droppedPath }],
      [{ name: "one.txt" }, { name: "dropped.txt", path: droppedPath }],
    ];

    for (const files of lists) {
      expect(await port.readDroppedFiles(files)).toEqual({ ok: false, code: "UNSUPPORTED" });
    }

    // The path deliberately does not exist: an implementation that tried to read
    // it would fail instead of answering the frozen refusal.
  });
});

describe("nine-item host port contract frozen shape", () => {
  it("HostPort extends HostPortStartup, so a headless port is a startup port", async () => {
    // Declaration-level claim: the v2 contract is a pure extension of v1, which
    // is what lets B1's startup consumers keep compiling : persistence is
    // 4.4: "three semantics unchanged, pure addition").
    expect(HOST_PORT_SOURCE).toMatch(/export interface HostPort extends HostPortStartup\s*\{/);

    const { port } = await createFixture();

    // Assignability: a value typed as the full port must be usable where only
    // the startup subset is expected.
    const startupSubset: HostPortStartup = port;

    expect(startupSubset.capabilities).toBe(port.capabilities);
    expect(startupSubset.paths).toBe(port.paths);
    expect(typeof startupSubset.getRuntimeSpawnSpec).toBe("function");
  });

  it("HostPortStartup keeps its frozen members and return types", async () => {
    // Compile-time proof (see the aliases above) surfaced as a runtime claim.
    expect(FROZEN_STARTUP_SHAPE).toEqual([true, true, true, true]);

    const { port } = await createFixture();
    const spec = await port.getRuntimeSpawnSpec();

    expect(spec.ok).toBe(true);

    if (!spec.ok) {
      throw new Error("expected a spawn spec from the headless port");
    }

    expect(Object.keys(spec.spec).sort()).toEqual([...SPAWN_SPEC_FIELDS].sort());
  });
});

type Fixture = {
  root: string;
  engineHome: string;
  bundlePath: string;
  port: HeadlessHostPort;
};

type FixtureOptions = {
  /** Create the bundle file. Default true; false exercises the refusal path. */
  bundleExists?: boolean;
  /** Pass a relative bundle path instead of an absolute one. Default false. */
  relativeBundle?: boolean;
  pickQueue?: string[];
  allowedRoots?: string[];
  secureSeed?: Record<string, string>;
};

/**
 * Build one engine home plus one fake bundle and a headless port on it.
 *
 * `engineHome` is explicit so the whole tree lives under our single root and the
 * point-by-point cleanup covers it.
 */
async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await makeRoot();
  const engineHome = path.join(root, "engine-home");
  const absoluteBundle = path.join(root, "engine.mjs");

  if (options.bundleExists !== false) {
    writeFileSync(absoluteBundle, "// fake engine bundle\n");
  }

  const bundlePath = options.relativeBundle === true ? "engine.mjs" : absoluteBundle;
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
  const root = await mkdtemp(path.join(tmpdir(), "haruyuki-fz2-contract-"));

  tempRoots.add(root);

  return root;
}

/**
 * A path on a drive other than the fixture root's, or `undefined` on POSIX.
 *
 * The path need not exist: containment is lexical, so the answer is the same
 * whether or not the drive is mounted.
 */
function anotherDrivePath(root: string): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const currentRoot = path.parse(path.resolve(root)).root;
  const currentLetter = currentRoot.slice(0, 1).toUpperCase();
  const otherLetter = currentLetter === "C" ? "D" : "C";

  return `${otherLetter}:\\outside-root.txt`;
}

/** True when `candidate` is `root` itself or a descendant of it. */
function isInside(root: string, candidate: string): boolean {
  const fromRoot = path.relative(root, candidate);

  return fromRoot === "" || (!fromRoot.startsWith("..") && !path.isAbsolute(fromRoot));
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
