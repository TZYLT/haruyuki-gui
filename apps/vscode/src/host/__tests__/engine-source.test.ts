/**
 * Engine discovery, its fixed order, and the two refusals it makes.
 *
 * Every engine here is a real directory under the OS temp directory with the
 * three entries a package must hold, because the check under test is a
 * filesystem check and a mock of it would only prove the mock.
 *
 * The cases that matter:
 *
 *   order     the setting wins over PATH and over a manual pick, PATH wins over
 *             a manual pick, and a pick is written back only when it answered.
 *   invalid   every missing or mistyped entry is named, not summarised.
 *   version   a build other than the tested one resolves with `tested: false`
 *             and both versions, so the caller can ask instead of connecting.
 *   spawn     a directory that stopped being usable after activation is refused
 *             by the seam rather than spawning against it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EngineSource } from "../../core/ipc.js";
import { TESTED_ENGINE_VERSION } from "../../shared/version.js";
import {
  createSpawnSpecResolver,
  createVSCodeEngineSettings,
  GLOBAL_CONFIGURATION_TARGET,
  inspectEngineDirectory,
  resolveEngine,
  type ConfigurationLike,
  type EngineSettingsPort,
} from "../engine-source.js";

/** The build this shell was tested against; the module's own default. */
const TESTED = "0.6.0";

/** Temp roots created by one test, removed afterwards. */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * @returns a fresh temp root this suite owns
 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "haruyuki-engine-source-"));

  roots.push(root);

  return root;
}

/**
 * Write an engine package with the three required entries.
 *
 * @param parent directory to create it under
 * @param version the manifest version, or `undefined` for a manifest without one
 * @param name subdirectory name, so one root can hold two packages
 * @returns the absolute package directory
 */
function makeEngine(parent: string, version: string | undefined, name = "engine"): string {
  const dir = join(parent, name);

  writeFileSync(join(mkdirOf(dir), "haruyuki.js"), "// entry\n", "utf8");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(version === undefined ? { name: "haruyuki" } : { name: "haruyuki", version }),
    "utf8",
  );

  return dir;
}

/**
 * @param dir a directory to create
 * @returns it, so the caller can write inside it in one expression
 */
function mkdirOf(dir: string): string {
  mkdirSync(dir, { recursive: true });

  return dir;
}

/** A settings port that records writes and answers one configured value. */
type FakeSettings = EngineSettingsPort & {
  readonly writes: { readonly dir: string }[];
  readonly stored: () => string | undefined;
};

/**
 * @param configured the persisted pick, if any
 * @returns the port and the writes it received
 */
function fakeSettings(configured?: string): FakeSettings {
  let value = configured;
  const writes: { readonly dir: string }[] = [];

  return {
    writes,
    stored: () => value,
    async read() {
      return value;
    },
    async write(dir: string) {
      value = dir;
      writes.push({ dir });
    },
  };
}

describe("resolveEngine discovery order", () => {
  it("takes the engine the setting names before PATH and before a manual pick", async () => {
    const root = makeRoot();
    const configured = makeEngine(root, TESTED, "configured");
    const onPath = makeEngine(root, TESTED, "on-path");
    const picked = makeEngine(root, TESTED, "picked");
    const settings = fakeSettings(configured);

    const resolution = await resolveEngine({
      settings,
      testedVersion: TESTED,
      pathEnv: onPath,
      manualDir: picked,
    });

    expect(resolution.ok).toBe(true);
    expect(resolution.ok && resolution.source.dir).toBe(configured);
    expect(resolution.ok && resolution.tested).toBe(true);
    // The winning rung was already persisted, so a pick that also worked must
    // not overwrite it.
    expect(settings.writes).toEqual([]);
  });

  it("falls to a PATH directory when the setting names nothing, and never writes back", async () => {
    const root = makeRoot();
    const onPath = makeEngine(root, TESTED, "bin");
    const settings = fakeSettings();

    const resolution = await resolveEngine({
      settings,
      testedVersion: TESTED,
      pathEnv: [join(root, "empty"), onPath, onPath].join(delimiter),
    });

    expect(resolution.ok && resolution.source.dir).toBe(onPath);
    expect(settings.writes).toEqual([]);
  });

  it("finds an engine package in a haruyuki/ subdirectory of a PATH entry", async () => {
    const root = makeRoot();
    const onPath = makeEngine(root, TESTED, "haruyuki");
    const settings = fakeSettings();

    const resolution = await resolveEngine({
      settings,
      testedVersion: TESTED,
      pathEnv: root,
    });

    expect(resolution.ok && resolution.source.dir).toBe(onPath);
  });

  it("uses the picked directory and writes it back globally when nothing else answers", async () => {
    const root = makeRoot();
    const picked = makeEngine(root, TESTED, "picked");
    const settings = fakeSettings();

    const resolution = await resolveEngine({
      settings,
      testedVersion: TESTED,
      pathEnv: "",
      manualDir: picked,
    });

    expect(resolution.ok && resolution.source.dir).toBe(picked);
    // Only the directory that actually resolved is persisted.
    expect(settings.writes).toEqual([{ dir: picked }]);
    expect(settings.stored()).toBe(picked);
  });

  it("refuses when no rung names an engine, and says what each rung found", async () => {
    const settings = fakeSettings();

    const resolution = await resolveEngine({ settings, testedVersion: TESTED, pathEnv: "" });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.reason).toBe("missing");
    expect(resolution.ok === false && resolution.detail).toContain("no engine to start");
    expect(settings.writes).toEqual([]);
  });

  it("does not write back a pick that failed, and keeps the previous setting", async () => {
    const root = makeRoot();
    // Both directories exist and are both empty, which is the case a picker
    // actually produces: the user chose a folder, not an engine package.
    const broken = mkdirOf(join(root, "broken"));
    const picked = mkdirOf(join(root, "also-broken"));
    const settings = fakeSettings(broken);

    const resolution = await resolveEngine({
      settings,
      testedVersion: TESTED,
      pathEnv: "",
      manualDir: picked,
    });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.reason).toBe("invalid-dir");
    // Every absent entry is named, so the user can repair the directory.
    expect(resolution.ok === false && resolution.detail).toContain("haruyuki.js is missing");
    expect(resolution.ok === false && resolution.detail).toContain("node_modules is missing");
    expect(resolution.ok === false && resolution.detail).toContain("package.json is missing");
    // A failed pick never replaces a configuration that may still be working.
    expect(settings.writes).toEqual([]);
    expect(settings.stored()).toBe(broken);
  });

  it("reports the directories it opened and refused, as data", async () => {
    // The failure arm carries what was inspected so a caller does not have to
    // read it back out of `detail`. That reading was the defect: every note
    // starts with prose, so a line-anchored path pattern could never match and
    // the page's list was always just the configured value.
    const root = makeRoot();
    const broken = mkdirOf(join(root, "broken"));

    const resolution = await resolveEngine({
      settings: fakeSettings(broken),
      testedVersion: TESTED,
      pathEnv: "",
    });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.inspected).toEqual([broken]);
  });

  it("names no directory when nothing was opened", async () => {
    // `PATH` directories are inputs, not places a user can go and repair, so a
    // run that only walked them reports nothing rather than a wall of noise.
    const resolution = await resolveEngine({
      settings: fakeSettings(),
      testedVersion: TESTED,
      pathEnv: [join("/opt/noise-a", "bin"), join("/opt/noise-b", "bin")].join(
        process.platform === "win32" ? ";" : ":",
      ),
    });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.inspected).toBeUndefined();
  });
});

describe("inspectEngineDirectory", () => {
  it("names every entry that is missing", async () => {
    const root = makeRoot();
    const empty = join(root, "empty");

    mkdirSync(empty, { recursive: true });

    const checked = await inspectEngineDirectory(empty);

    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.problems).toEqual([
      "haruyuki.js is missing",
      "node_modules is missing",
      "package.json is missing",
    ]);
  });

  it("names an entry with the wrong type rather than calling the directory invalid", async () => {
    const root = makeRoot();
    const dir = join(root, "typed");

    // All three present, all three the wrong type.
    mkdirSync(join(dir, "haruyuki.js"), { recursive: true });
    writeFileSync(join(dir, "node_modules"), "not a directory", "utf8");
    mkdirSync(join(dir, "package.json"), { recursive: true });

    const checked = await inspectEngineDirectory(dir);

    expect(checked.ok === false && checked.problems).toEqual([
      "haruyuki.js is not a file",
      "node_modules is not a directory",
      "package.json is not a file",
    ]);
  });

  it("refuses a directory that does not exist", async () => {
    const missing = join(makeRoot(), "absent");
    const checked = await inspectEngineDirectory(missing);

    expect(checked.ok === false && checked.problems).toEqual([`${missing} does not exist`]);
  });

  it("resolves a valid package to its absolute bundle path and version", async () => {
    const dir = makeEngine(makeRoot(), TESTED);

    const checked = await inspectEngineDirectory(dir);

    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.bundlePath).toBe(join(dir, "haruyuki.js"));
    expect(checked.ok && checked.version).toBe(TESTED);
  });

  it("reports a package without a version as valid but versionless", async () => {
    const dir = makeEngine(makeRoot(), undefined);

    const checked = await inspectEngineDirectory(dir);

    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.version).toBeUndefined();
  });
  it("starts from the version this shell ships when the caller passes none", async () => {
    const dir = makeEngine(makeRoot(), "0.7.0");

    const resolution = await resolveEngine({ settings: fakeSettings(dir), pathEnv: "" });

    // The expected version is the shipped constant, not a second literal.
    expect(resolution.ok && resolution.expectedVersion).toBe(TESTED_ENGINE_VERSION);
    expect(resolution.ok && resolution.tested).toBe(false);
  });
});

describe("version judgement", () => {
  it("resolves a build other than the tested one with tested false and both versions", async () => {
    const dir = makeEngine(makeRoot(), "0.7.0");
    const settings = fakeSettings(dir);

    const resolution = await resolveEngine({ settings, testedVersion: TESTED, pathEnv: "" });

    // Resolved, not refused: whether to connect anyway is the panel's decision,
    // and nothing here can start an engine.
    expect(resolution.ok).toBe(true);
    expect(resolution.ok && resolution.tested).toBe(false);
    expect(resolution.ok && resolution.version).toBe("0.7.0");
    expect(resolution.ok && resolution.expectedVersion).toBe(TESTED);
  });

  it("refuses a configured directory with no readable version", async () => {
    const dir = makeEngine(makeRoot(), undefined);
    const settings = fakeSettings(dir);

    const resolution = await resolveEngine({ settings, testedVersion: TESTED, pathEnv: "" });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.reason).toBe("version-unknown");
    expect(resolution.ok === false && resolution.detail).toContain(`no readable version`);
  });

  it("refuses a relative configured path instead of resolving it against the editor's cwd", async () => {
    const settings = fakeSettings("relative/engine");

    const resolution = await resolveEngine({ settings, testedVersion: TESTED, pathEnv: "" });

    expect(resolution.ok === false && resolution.reason).toBe("invalid-dir");
    expect(resolution.ok === false && resolution.detail).toContain("is not an absolute path");
  });
});

describe("createVSCodeEngineSettings", () => {
  it("reads the declared empty default as no setting", async () => {
    const port = createVSCodeEngineSettings(() => fakeConfiguration(""));

    expect(await port.read()).toBeUndefined();
  });

  it("writes back to the global target, because the setting's scope is machine", async () => {
    const updates: { readonly value: string; readonly target: number | undefined }[] = [];
    const configuration = fakeConfiguration("", updates);

    await createVSCodeEngineSettings(() => configuration).write("/opt/engine");

    expect(updates).toEqual([{ value: "/opt/engine", target: GLOBAL_CONFIGURATION_TARGET }]);
    expect(GLOBAL_CONFIGURATION_TARGET).toBe(1);
  });
});

/**
 * A `WorkspaceConfiguration` stand-in over one key.
 *
 * @param initial the configured value
 * @param updates receives every `update` call
 * @returns the configuration
 */
function fakeConfiguration(
  initial: string,
  updates: { readonly value: string; readonly target: number | undefined }[] = [],
): ConfigurationLike {
  let stored = initial;

  return {
    get<T>(_section: string, defaultValue: T): T {
      return (stored === "" ? defaultValue : stored) as T;
    },
    async update(_section: string, value: string, target?: number): Promise<void> {
      stored = value;
      updates.push({ value, target });
    },
  };
}

describe("createSpawnSpecResolver", () => {
  it("builds a spec from the directory the caller recorded, in the workspace", async () => {
    const dir = makeEngine(makeRoot(), TESTED);
    const asked: EngineSource[] = [];
    const resolve = createSpawnSpecResolver({
      build: async (source) => {
        asked.push(source);

        return {
          exePath: "/usr/bin/node",
          env: {},
          argvPrefix: [],
          bundlePath: source.bundlePath,
          // The builder's own cwd is the engine package; the workspace wins.
          cwd: source.dir,
          stdio: "pipe",
          windowsHide: true,
          detached: false,
        };
      },
      readWorkspaceCwd: () => ({
        ok: true,
        cwd: "/projects/one",
        fileTreeRoot: "/projects/one",
        origin: "workspace",
      }),
    });

    const spec = await resolve({
      kind: "external",
      dir,
      bundlePath: join(dir, "haruyuki.js"),
      version: TESTED,
    });

    expect(spec.cwd).toBe("/projects/one");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.version).toBe(TESTED);
  });

  it("refuses a directory that stopped being usable, naming what is gone", async () => {
    const dir = makeEngine(makeRoot(), TESTED);
    const resolve = createSpawnSpecResolver({
      build: async () => {
        throw new Error("must not be called");
      },
      readWorkspaceCwd: () => ({
        ok: true,
        cwd: "/projects/one",
        fileTreeRoot: "/projects/one",
        origin: "workspace",
      }),
    });

    rmSync(join(dir, "node_modules"), { recursive: true, force: true });

    await expect(
      resolve({ kind: "external", dir, bundlePath: join(dir, "haruyuki.js") }),
    ).rejects.toThrowError(/node_modules is missing/);
  });

  it("refuses to spawn when no workspace folder is open", async () => {
    const dir = makeEngine(makeRoot(), TESTED);
    const resolve = createSpawnSpecResolver({
      build: async () => {
        throw new Error("must not be called");
      },
      readWorkspaceCwd: () => ({
        ok: false,
        reason: "no-workspace",
        needsConfirmation: true,
        homeDir: "/home/somebody",
        detail: "no workspace folder is open",
      }),
    });

    await expect(
      resolve({ kind: "external", dir, bundlePath: join(dir, "haruyuki.js") }),
    ).rejects.toThrowError(/no workspace folder is open/);
  });
});
