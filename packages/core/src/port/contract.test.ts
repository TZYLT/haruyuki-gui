/**
 * Contract tests for `HostPortStartup`, the startup subset of the host port.
 *
 * Shape source: no recursive-B1 sections 3.3(a) (HostPortStartup), 3.3(b)
 * (EngineSpawnSpec), 3.4 (watchdog injection), 4.2 , 5.1 (isolation and
 * cleanup rules), 6.1  and 8 (invariants).
 *
 * This file is not a second copy of a behaviour suite: `host-port.test.ts`
 * already pins the headless implementation's own decisions (tokenDir
 * containment, `cwd === paths.userData`, the refusal naming the bundle path).
 * What is asserted here is what ANY implementation must satisfy - the headless
 * one today, the Electron shell and a VSCode shell later - and the assertion is
 * kept implementation-independent by running ONE function,
 * `assertHostPortContract`, against two implementations:
 *
 *   1. the real headless port from `./headless-host-port`;
 *   2. a fake desktop port defined in this file, which answers `true` to all
 *      four capabilities and roots its paths elsewhere.
 *
 * Covered contract points: the capability key set and types; the path key set,
 * absoluteness and existence; `getRuntimeSpawnSpec` being a callable that
 * answers a thenable; the `{ok:true,spec} | {ok:false,reason}` split being
 * mutually exclusive in both directions; the eight-field spec key set; field
 * types; `stdio === "pipe"`; the boolean process flags; the argv auth shape; no
 * injected credential in `env`; and the `NODE_OPTIONS` watchdog form - quoted
 * and absolute - whenever that variable is present.
 *
 * Deliberately NOT covered, listed so the gap is visible rather than assumed:
 * the token file's permissions and lifetime (, V-3/V-4); the refusal being
 * classified as SPAWN_FAILED ; whether a desktop env is complete with
 * respect to Electron and its path conventions (the desktop shell's own suite);
 * path containment of the real token file (`send.ts`/); and any actual process
 * spawn - no engine is ever started here.
 *
 * Every case uses real temporary directories and real files: mocking node:fs
 * would test the mock instead of the host. Cleanup is point-by-point (no recursive
 * section 5.1, rule 3): each bundle is unlinked, each directory is rmdir'd only
 * after its children, so a fixture bug can never delete a tree this suite did
 * not create.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EngineSpawnSpec } from "../engine/types";
import { createHeadlessHostPort } from "./headless-host-port";
import type { HostPortStartup } from "./host-port";

/**
 * Roots created by a case; removed once that case settles.
 *
 * Module-level on purpose: every fixture registers its root here, so a case
 * that throws half way through still gets cleaned up.
 */
const tempRoots = new Set<string>();

afterEach(async () => {
  for (const root of tempRoots) {
    await removeTree(root);
  }

  tempRoots.clear();
});

/** The four capability names `HostPortStartup` freezes; an extra key is a contract breach. */
const CAPABILITY_KEYS = [
  "canNotify",
  "canReadDroppedFiles",
  "canPopout",
  "canFloatingWindow",
] as const;

/** The four directory roots `HostPortStartup` freezes. */
const PATH_KEYS = ["userData", "logs", "cache", "temp"] as const;

/**
 * The eight frozen `EngineSpawnSpec` fields.
 *
 * Keyed by `keyof EngineSpawnSpec` so that a field added to or removed from the
 * type is a compile error on the next line that drifts, while the runtime
 * comparison still uses the literal key list the contract text spells out.
 */
const SPAWN_SPEC_FIELDS: Record<keyof EngineSpawnSpec, true> = {
  exePath: true,
  env: true,
  argvPrefix: true,
  bundlePath: true,
  cwd: true,
  stdio: true,
  windowsHide: true,
  detached: true,
};

/**
 * Engine argv before the bundle path.
 *
 * Invoking the engine is engine knowledge, not a host preference, so every host
 * is expected to pass the same prefix. `--ws-token-file` is the option NAME: the
 * token path is appended later by `Engine.start`, and the token VALUE must never
 * appear in argv.
 */
const ENGINE_ARGV_PREFIX = [
  "server",
  "--listen",
  "ws://127.0.0.1:0",
  "--ws-auth",
  "capability-token",
  "--ws-token-file",
] as const;

/** The only accepted preload form: the watchdog, with the path quoted. */
const WATCHDOG_NODE_OPTIONS = /^--require ".*watchdog\.cjs"$/;

/** Env keys that would carry a credential rather than configuration. */
const CREDENTIAL_KEY = /token|secret|bearer|authorization|password|credential|api[-_]?key/i;

/**
 * Env values shaped like a credential: 32 bytes of hex, a base64 secret of the
 * same size, or a ready-made Bearer header.
 *
 * A heuristic, not a proof: the port never receives the real token, so a value
 * check has to recognise the shape. It is only applied to entries the port
 * itself contributes (see `assertSpawnSpecContract`), which keeps an inherited
 * CI secret from making the suite fail for the wrong reason.
 */
const CREDENTIAL_VALUE = [/^[0-9a-f]{64}$/i, /^[A-Za-z0-9+/]{43}=?$/, /Bearer\s+\S{16,}/];

/**
 * The two implementations under contract.
 *
 * This table is the whole point of the file: the same suite body below runs
 * against both rows, so a statement that only holds for the headless port is a
 * failing test rather than an unstated assumption.
 */
const HEADLESS: Implementation = { name: "headless host port", create: createHeadlessFixture };
const FAKE_DESKTOP: Implementation = {
  name: "fake desktop host port",
  create: createFakeDesktopFixture,
};
const IMPLEMENTATIONS: readonly Implementation[] = [HEADLESS, FAKE_DESKTOP];

describe("host port startup contract (implementation independent)", () => {
  describe.each(IMPLEMENTATIONS)("$name", ({ create }) => {
    it("satisfies the shared host-port contract", async () => {
      const { port, bundlePath } = await create();

      const spec = await assertHostPortContract(port);

      // Cross-host expectation beyond the shape: an accepted spec must point at
      // the bundle the host was configured with, otherwise the ok:true answer
      // describes some other product.
      expect(spec.bundlePath).toBe(bundlePath);
    });

    it("roots all four paths in an existing disposable tree", async () => {
      const { root, port } = await create();

      for (const key of PATH_KEYS) {
        const dir = port.paths[key];

        expect(statSync(dir).isDirectory()).toBe(true);
        expect(isInside(root, dir)).toBe(true);
      }
    });

    it("refuses with a reason instead of a spec when the bundle is missing", async () => {
      const { port, bundlePath } = await create({ bundleExists: false });

      const reason = await assertSpawnSpecRefusal(port);

      // Beyond the minimum (a non-empty string): a refusal is read by a human,
      // so it has to name what the host could not find.
      expect(reason).toContain(bundlePath);
    });
  });

  it("accepts a host that preloads the watchdog through NODE_OPTIONS", async () => {
    // The headless port always injects the preload; a desktop host may be
    // disables the preload fuse may be unable to, so the invariant is
    // invariant is conditional and both branches are exercised by the two
    // fixtures. This case covers the "present" branch on the desktop side.
    const { port } = await FAKE_DESKTOP.create({ withWatchdog: true });

    const spec = await assertHostPortContract(port);

    expect(spec.env["NODE_OPTIONS"]).toMatch(WATCHDOG_NODE_OPTIONS);
  });
});

describe("the shared contract is sensitive to violations", () => {
  // A contract test that cannot fail proves nothing. Each case below tampers
  // with one aspect of an otherwise valid port and expects the shared assertion
  // to reject it, which is what makes the green runs above meaningful.

  it("rejects a capability set with a fifth key", async () => {
    const { port } = await validFakeDesktopPort();

    const broken = asHostPort({
      ...port,
      capabilities: { ...port.capabilities, canFly: true },
    });

    await expect(assertHostPortContract(broken)).rejects.toThrow();
  });

  it("rejects a relative path root", async () => {
    const { port } = await validFakeDesktopPort();

    const broken = asHostPort({
      ...port,
      paths: { ...port.paths, logs: "logs" },
    });

    await expect(assertHostPortContract(broken)).rejects.toThrow();
  });

  it("rejects a spec missing one frozen field", async () => {
    const { port, spec } = await validFakeDesktopPort();
    const { detached: _detached, ...incomplete } = spec;

    const broken = asHostPort({
      ...port,
      async getRuntimeSpawnSpec() {
        return { ok: true, spec: incomplete };
      },
    });

    await expect(assertHostPortContract(broken)).rejects.toThrow();
  });

  it("rejects a result that carries both a spec and a reason", async () => {
    const { port, spec } = await validFakeDesktopPort();

    const broken = asHostPort({
      ...port,
      async getRuntimeSpawnSpec() {
        return { ok: true, spec, reason: "mixed shape" };
      },
    });

    await expect(assertHostPortContract(broken)).rejects.toThrow();
  });

  it("rejects an empty refusal reason", async () => {
    const { port } = await validFakeDesktopPort();

    const broken = asHostPort({
      ...port,
      async getRuntimeSpawnSpec() {
        return { ok: false, reason: "   " };
      },
    });

    await expect(assertHostPortContract(broken)).rejects.toThrow();
  });

  it("rejects a NODE_OPTIONS preload that is not the watchdog", async () => {
    const { port, spec } = await validFakeDesktopPort();

    const broken = asHostPort({
      ...port,
      async getRuntimeSpawnSpec() {
        return {
          ok: true,
          spec: withEnv(spec, { NODE_OPTIONS: "--require ./something-else.cjs" }),
        };
      },
    });

    await expect(assertHostPortContract(broken)).rejects.toThrow();
  });

  it("rejects a watchdog preload named by a relative path", async () => {
    const { port, spec } = await validFakeDesktopPort();

    const broken = asHostPort({
      ...port,
      async getRuntimeSpawnSpec() {
        // Matches the frozen regex, so only the absoluteness check can catch it.
        return { ok: true, spec: withEnv(spec, { NODE_OPTIONS: '--require "watchdog.cjs"' }) };
      },
    });

    await expect(assertHostPortContract(broken)).rejects.toThrow();
  });

  it("rejects a credential injected through env", async () => {
    const { port, spec } = await validFakeDesktopPort();

    const broken = asHostPort({
      ...port,
      async getRuntimeSpawnSpec() {
        return {
          ok: true,
          spec: withEnv(spec, { WS_TOKEN: "9f".repeat(32) }),
        };
      },
    });

    await expect(assertHostPortContract(broken)).rejects.toThrow();
  });

  it("rejects a spec whose bundle path does not exist", async () => {
    const { port, spec, root } = await validFakeDesktopPort();

    const broken = asHostPort({
      ...port,
      async getRuntimeSpawnSpec() {
        return { ok: true, spec: { ...spec, bundlePath: path.join(root, "absent.mjs") } };
      },
    });

    await expect(assertHostPortContract(broken)).rejects.toThrow();
  });
});

describe("implementation differences stay inside host facts", () => {
  it("differs only in capabilities, path roots and host-specific env", async () => {
    const headless = await HEADLESS.create();
    const desktop = await FAKE_DESKTOP.create();

    const headlessSpec = await assertHostPortContract(headless.port);
    const desktopSpec = await assertHostPortContract(desktop.port);

    // Same capability names; only the answers differ, and they differ in the
    // direction the two hosts actually go.
    expect(Object.keys(desktop.port.capabilities).sort()).toEqual(
      Object.keys(headless.port.capabilities).sort(),
    );
    expect(Object.values(headless.port.capabilities).every((value) => value === false)).toBe(true);
    expect(Object.values(desktop.port.capabilities).every((value) => value === true)).toBe(true);

    // Same path names; different roots.
    expect(Object.keys(desktop.port.paths).sort()).toEqual(Object.keys(headless.port.paths).sort());

    for (const key of PATH_KEYS) {
      expect(desktop.port.paths[key]).not.toBe(headless.port.paths[key]);
    }

    // Same spec key set and the same transport decisions: those are contract,
    // not host preference.
    expect(Object.keys(desktopSpec).sort()).toEqual(Object.keys(headlessSpec).sort());
    expect(desktopSpec.stdio).toBe(headlessSpec.stdio);
    expect(desktopSpec.windowsHide).toBe(headlessSpec.windowsHide);
    expect(desktopSpec.detached).toBe(headlessSpec.detached);
    expect(desktopSpec.argvPrefix).toEqual(headlessSpec.argvPrefix);

    // Each host's cwd follows its own userData root.
    expect(headlessSpec.cwd).toBe(headless.port.paths.userData);
    expect(desktopSpec.cwd).toBe(desktop.port.paths.userData);

    // The remaining differences are env facts, not shape facts.
    expect(headlessSpec.env["HARUYUKI_HOME"]).toBeDefined();
    expect(desktopSpec.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(desktopSpec.env["NODE_OPTIONS"]).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- *
 * Assertions: the contract itself.
 * ------------------------------------------------------------------------- */

/**
 * Assert everything `HostPortStartup` requires of a host port, whatever its implementation.
 *
 * Returns the accepted spawn spec so a caller can add host-specific checks
 * without opening the assertion. A refusal is not an acceptable answer here: it
 * means the fixture failed to place the bundle, so it throws with the reason to
 * keep the failure readable.
 */
async function assertHostPortContract(port: HostPortStartup): Promise<EngineSpawnSpec> {
  assertCapabilities(port.capabilities);
  assertPaths(port.paths);

  expect(typeof port.getRuntimeSpawnSpec).toBe("function");

  // Snapshot before the call: the comparison below asks what the port itself
  // contributed to env, so the reference has to predate the port's own work.
  const ambientEnv = snapshotEnv();

  const pending = port.getRuntimeSpawnSpec();

  // The interface promises a Promise, and a synchronous answer would let a
  // caller's `await` pass while hiding I/O that was never deferred.
  expect(typeof pending.then).toBe("function");

  const result = await pending;

  expect(result).not.toBeNull();
  expect(typeof result).toBe("object");
  expect(Object.hasOwn(result, "ok")).toBe(true);
  expect(typeof result.ok).toBe("boolean");

  if (!result.ok) {
    // Reference shape: a reason, and nothing that looks like a spec.
    expect(Object.hasOwn(result, "reason")).toBe(true);
    expect(Object.hasOwn(result, "spec")).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect(result.reason.trim().length).toBeGreaterThan(0);

    throw new Error(`expected a spawn spec, got a refusal: ${result.reason}`);
  }

  // Accept shape: a spec, and no reason. The two variants are mutually
  // exclusive in both directions, so a caller never has to guess which field
  // is authoritative.
  expect(Object.hasOwn(result, "spec")).toBe(true);
  expect(Object.hasOwn(result, "reason")).toBe(false);

  assertSpawnSpecContract(result.spec, ambientEnv);

  return result.spec;
}

/**
 * Assert the frozen spawn-spec shape and the three spawn-time invariants.
 */
function assertSpawnSpecContract(
  spec: EngineSpawnSpec,
  ambientEnv: ReadonlyMap<string, string>,
): void {
  // Exactly the eight frozen fields. An extra field would let a host smuggle a
  // decision into the spawn call that no other implementation knows about.
  expect(Object.keys(spec).sort()).toEqual(Object.keys(SPAWN_SPEC_FIELDS).sort());

  expect(typeof spec.exePath).toBe("string");
  expect(spec.exePath.length).toBeGreaterThan(0);

  expect(typeof spec.bundlePath).toBe("string");
  expect(spec.bundlePath.length).toBeGreaterThan(0);

  // ok:true means "this is spawnable", so both the entry script and the working
  // directory must already exist. A spec that names a missing target would only
  // fail later, inside spawn, and be classified as the wrong error.
  expect(existsSync(spec.bundlePath)).toBe(true);
  expect(statSync(spec.bundlePath).isFile()).toBe(true);
  expect(typeof spec.cwd).toBe("string");
  expect(path.isAbsolute(spec.cwd)).toBe(true);
  expect(existsSync(spec.cwd)).toBe(true);
  expect(statSync(spec.cwd).isDirectory()).toBe(true);

  expect(Array.isArray(spec.argvPrefix)).toBe(true);

  for (const arg of spec.argvPrefix) {
    expect(typeof arg).toBe("string");
  }

  // Invariant 1: the token travels through a file, so the argv may name the
  // option but must never carry a credential.
  expect(spec.argvPrefix).toContain("--ws-token-file");
  expect(spec.argvPrefix.filter((arg) => matchesCredentialValue(arg))).toEqual([]);

  expect(typeof spec.env).toBe("object");
  expect(Array.isArray(spec.env)).toBe(false);

  const envEntries = Object.entries(spec.env);

  expect(envEntries.length).toBeGreaterThan(0);

  for (const [key, value] of envEntries) {
    expect(key.length).toBeGreaterThan(0);
    expect(typeof value).toBe("string");
  }

  // Invariant 2: the watchdog is the only preload the core accepts. If a host
  // sets NODE_OPTIONS at all, it must be the quoted --require form; anything
  // else preloads foreign code into the engine process.
  const nodeOptions = spec.env["NODE_OPTIONS"];

  if (nodeOptions !== undefined) {
    expect(nodeOptions).toMatch(WATCHDOG_NODE_OPTIONS);

    // The child resolves a relative preload against its own cwd, which is the
    // host's userData directory, not the package - so only an absolute path in
    // the quotes can load the script the core shipped.
    const quotedPath = /^--require "(.*)"$/.exec(nodeOptions)?.[1] ?? "";

    expect(path.isAbsolute(quotedPath)).toBe(true);

    // On Windows the quoted path must use forward slashes: Node unescapes
    // backslashes inside NODE_OPTIONS, so a native `C:\a\watchdog.cjs` preload
    // becomes `C:awatchdog.cjs` and the watchdog silently never loads (measured,
    // on Windows). This is the form the headless port produces, and the one a
    // second host port has to reproduce.
    if (process.platform === "win32") {
      expect(quotedPath).not.toContain("\\");
    }
  }

  // Invariant 3: no credential may be injected through env either. Entries the
  // port only inherited from process.env are not its doing and are skipped, so
  // an ambient CI secret cannot make this suite fail for the wrong reason.
  const injectedCredentials = envEntries
    .filter(([key, value]) => ambientEnv.get(key) !== value)
    .filter(([key, value]) => CREDENTIAL_KEY.test(key) || matchesCredentialValue(value))
    .map(([key]) => key);

  expect(injectedCredentials).toEqual([]);

  // stdout carries the port announcement and stdin the watchdog heartbeat, so
  // the pipe decision is frozen; the two process flags stay booleans so a call
  // site never branches on a platform.
  expect(spec.stdio).toBe("pipe");
  expect(typeof spec.windowsHide).toBe("boolean");
  expect(typeof spec.detached).toBe("boolean");
}

/**
 * Assert the capability answer: exactly the four frozen keys, all booleans.
 *
 * The values are deliberately not asserted here - a headless host answers false
 * and a desktop host answers true, and both are valid. What is contractual is
 * that the set is closed and that every member is a real boolean, never a
 * truthy stand-in.
 */
function assertCapabilities(capabilities: HostPortStartup["capabilities"]): void {
  expect(Object.keys(capabilities).sort()).toEqual([...CAPABILITY_KEYS].sort());

  for (const key of CAPABILITY_KEYS) {
    expect(typeof capabilities[key]).toBe("boolean");
  }
}

/**
 * Assert the path answer: exactly the four frozen keys, every root absolute.
 *
 * Absoluteness is the contract: the core must never resolve a host root against
 * its own cwd, so a relative root is a breach even when it happens to resolve.
 */
function assertPaths(paths: HostPortStartup["paths"]): void {
  expect(Object.keys(paths).sort()).toEqual([...PATH_KEYS].sort());

  for (const key of PATH_KEYS) {
    const dir = paths[key];

    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
    expect(path.isAbsolute(dir)).toBe(true);
  }
}

/**
 * Assert the reference shape and return the reason for further checks.
 *
 * Only the shape is contractual here: the wording belongs to the implementation
 * (`host-port.test.ts` pins the bundle path in it).
 */
async function assertSpawnSpecRefusal(port: HostPortStartup): Promise<string> {
  const result = await port.getRuntimeSpawnSpec();

  expect(result.ok).toBe(false);

  if (result.ok) {
    throw new Error(`expected a refusal, got a spec for ${result.spec.bundlePath}`);
  }

  expect(Object.hasOwn(result, "spec")).toBe(false);
  expect(typeof result.reason).toBe("string");
  expect(result.reason.trim().length).toBeGreaterThan(0);

  return result.reason;
}

/** True when `value` has the shape of a credential rather than a setting. */
function matchesCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE.some((pattern) => pattern.test(value));
}

/** Copy `process.env` into a string map, dropping the unrepresentable entries. */
function snapshotEnv(): Map<string, string> {
  const env = new Map<string, string>();

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env.set(key, value);
    }
  }

  return env;
}

/**
 * Present a value as a host port the compiler never checked.
 *
 * The tampering cases below stand in for a JS shell, which can answer with any
 * object shape; a cast is the only honest way to produce data outside the type
 * so the runtime assertions can be shown to reject it.
 */
function asHostPort(value: unknown): HostPortStartup {
  return value as HostPortStartup;
}

/** Return `spec` with `overrides` merged into its env, for tampering cases. */
function withEnv(spec: EngineSpawnSpec, overrides: Record<string, string>): EngineSpawnSpec {
  return { ...spec, env: { ...spec.env, ...overrides } };
}

/* ------------------------------------------------------------------------- *
 * Fixtures: two implementations of the same contract.
 * ------------------------------------------------------------------------- */

/** One fixture root, the bundle it contains, and the port built on it. */
type Fixture = {
  root: string;
  bundlePath: string;
  port: HostPortStartup;
};

type FixtureOptions = {
  /** Create the bundle file. Default true; false exercises the refusal path. */
  bundleExists?: boolean;
  /** Preload the watchdog through NODE_OPTIONS (desktop fixture only). */
  withWatchdog?: boolean;
};

/** One row of the implementation table above. */
type Implementation = {
  name: string;
  create(options?: FixtureOptions): Promise<Fixture>;
};

/**
 * Build the real headless port on a disposable root.
 *
 * `engineHome` is explicit so the whole tree lives under our single root and the
 * point-by-point cleanup in `afterEach` covers it.
 */
async function createHeadlessFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await makeRoot();
  const bundlePath = path.join(root, "engine.mjs");

  if (options.bundleExists !== false) {
    writeFileSync(bundlePath, "");
  }

  const port = await createHeadlessHostPort({
    bundlePath,
    engineHome: path.join(root, "engine-home"),
  });

  return { root, bundlePath, port };
}

/** Build the fake desktop port on a disposable root. */
async function createFakeDesktopFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await makeRoot();
  const bundlePath = path.join(root, "engine.mjs");

  if (options.bundleExists !== false) {
    writeFileSync(bundlePath, "");
  }

  const port = await createFakeDesktopHostPort({
    root,
    bundlePath,
    withWatchdog: options.withWatchdog === true,
  });

  return { root, bundlePath, port };
}

/**
 * Capabilities of the fake desktop host: the opposite of the headless answer.
 *
 * Different values on purpose - a suite where both implementations answer false
 * could not tell "the contract reads capabilities" from "the contract hardcodes
 * four falses".
 */
const FAKE_DESKTOP_CAPABILITIES: HostPortStartup["capabilities"] = Object.freeze({
  canNotify: true,
  canReadDroppedFiles: true,
  canPopout: true,
  canFloatingWindow: true,
});

type FakeDesktopOptions = {
  /** Existing root for the four path directories. Omitted: a fresh mkdtemp. */
  root?: string;
  /** Bundle location. Omitted: `engine-bundle.mjs` inside the root. */
  bundlePath?: string;
  /** Preload the watchdog through NODE_OPTIONS. Default false. */
  withWatchdog?: boolean;
};

/**
 * A second implementation of the same contract, test-only.
 *
 * Not product code and not exported: it exists so that a statement in
 * `assertHostPortContract` can be shown to hold for a host that answers
 * differently, which is exactly the claim the contract makes about a future
 * shell. It mirrors the headless refusal behaviour (a missing bundle is
 * `ok:false`) because that too is contract, not implementation detail.
 */
async function createFakeDesktopHostPort(
  options: FakeDesktopOptions = {},
): Promise<HostPortStartup> {
  const root = options.root ?? (await makeRoot());
  const bundlePath = options.bundlePath ?? path.join(root, "engine-bundle.mjs");

  const paths: HostPortStartup["paths"] = {
    userData: path.join(root, "userData"),
    logs: path.join(root, "logs"),
    cache: path.join(root, "cache"),
    temp: path.join(root, "temp"),
  };

  await Promise.all(Object.values(paths).map((dir) => mkdir(dir, { recursive: true })));

  // A path, never a file: this stand-in must not depend on the watchdog script
  // existing, and only the shape of the NODE_OPTIONS string is contractual.
  const watchdogPath = path.join(root, "runtime", "watchdog.cjs");

  const port: HostPortStartup = {
    capabilities: FAKE_DESKTOP_CAPABILITIES,
    paths,

    async getRuntimeSpawnSpec() {
      // Checked per call, like the headless port: a desktop shell may unpack its
      // bundle after the host object exists.
      if (!existsSync(bundlePath)) {
        return { ok: false, reason: `engine bundle not found: ${bundlePath}` };
      }

      const spec: EngineSpawnSpec = {
        // A real desktop host passes its own Electron binary; the contract only
        // requires a non-empty string, so the current interpreter keeps the
        // fixture executable-looking without pretending to be Electron.
        exePath: process.execPath,
        env: fakeDesktopEnv(paths, watchdogPath, options.withWatchdog === true),
        argvPrefix: [...ENGINE_ARGV_PREFIX],
        bundlePath,
        cwd: paths.userData,
        stdio: "pipe",
        windowsHide: true,
        // A platform fact, not a host-capability fact: both implementations must
        // agree, because the stop path decides between a group signal and
        // `taskkill /T /F` from this value alone.
        detached: process.platform !== "win32",
      };

      return { ok: true, spec };
    },
  };

  return port;
}

/**
 * Environment for the fake desktop child.
 *
 * Complete rather than additive, as the contract requires, and different from
 * the headless env in the two ways a desktop host legitimately differs:
 * `ELECTRON_RUN_AS_NODE` marks the Electron binary as a plain Node runtime, and
 * `NODE_OPTIONS` is dropped unless the watchdog preload was requested (a host
 * with the preload fuse disabled cannot inject one).
 */
function fakeDesktopEnv(
  paths: HostPortStartup["paths"],
  watchdogPath: string,
  withWatchdog: boolean,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }

    if (key === "NODE_OPTIONS" && !withWatchdog) {
      continue;
    }

    env[key] = value;
  }

  env["ELECTRON_RUN_AS_NODE"] = "1";
  env["HARUYUKI_HOME"] = paths.userData;

  if (withWatchdog) {
    // Forward slashes, exactly as the headless port does: Node strips
    // backslashes inside NODE_OPTIONS as escapes, so `C:\...\watchdog.cjs`
    // preloads as `C:...watchdog.cjs` and fails with MODULE_NOT_FOUND
    // (measured on Windows). A stand-in that used `path.join` here would
    // make the suite accept a form the real runtime rejects.
    env["NODE_OPTIONS"] = `--require "${watchdogPath.split("\\").join("/")}"`;
  }

  return env;
}

/** A valid fake desktop port plus the spec it accepts, for the tampering cases. */
async function validFakeDesktopPort(): Promise<{
  port: HostPortStartup;
  spec: EngineSpawnSpec;
  root: string;
}> {
  const { port, root } = await FAKE_DESKTOP.create();
  const result = await port.getRuntimeSpawnSpec();

  if (!result.ok) {
    throw new Error(`the fixture must accept its own bundle: ${result.reason}`);
  }

  return { port, spec: result.spec, root };
}

/** Create a disposable root and remember it for cleanup. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "haruyuki-contract-test-"));

  tempRoots.add(root);

  return root;
}

/** True when `candidate` is a strict descendant of `root`. */
function isInside(root: string, candidate: string): boolean {
  const fromRoot = path.relative(root, candidate);

  return fromRoot !== "" && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot);
}

/**
 * Remove a tree depth-first, one entry per call.
 *
 * A missing entry is ignored: cleanup runs after a case that may have removed
 * part of the tree already, and cleanup must never mask the real failure.
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
