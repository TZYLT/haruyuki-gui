/**
 * Which engine this shell starts, and whether it is the build this shell was
 * tested against.
 *
 * Discovery has one fixed order, because each rung is a different promise to the
 * user:
 *
 *   1. `haruyuki.enginePath` - an explicit choice, and the only one that
 *      survives a restart.
 *   2. a directory on `PATH` - the engine installed next to the shell.
 *   3. a directory the user picks by hand. It is written back to the setting,
 *      but only after it passes the structural check, so one bad pick cannot
 *      replace a working configuration with a broken one.
 *
 * A directory is an engine package when it holds `haruyuki.js`, `node_modules`
 * and `package.json`. The check reports every entry that is missing or has the
 * wrong type, because "invalid directory" alone leaves the user nothing to
 * repair.
 *
 * An unusable rung does not block the rest: a setting that has gone stale falls
 * through to the next directory that works, and the failure sentence keeps what
 * each rung found so the user still learns about the broken one. A rung that
 * resolves is returned immediately, in the order above, so the first working
 * answer is the one the shell uses.
 *
 * Two things this module deliberately does not do:
 *
 * - It never connects. A build other than the tested one resolves with
 *   `tested: false` and both versions attached; prompting, refusing and
 *   connecting anyway are the panel's decisions. A resolution is a judgement,
 *   not a start.
 * - It shows no UI and reaches no editor API directly. The settings port is
 *   injected, so the whole order is exercised against fake directories in a
 *   plain Node process.
 */

import { readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import type { EngineSpawnSpec } from "@haruyuki/core";

import type { EngineSource } from "../core/ipc.js";
import { TESTED_ENGINE_VERSION } from "../shared/version.js";
import type { WorkspaceResolution } from "./workspace.js";

/** The settings section and key the shell reads and writes. */
export const ENGINE_SETTING_SECTION = "haruyuki";
export const ENGINE_SETTING_KEY = "enginePath";

/**
 * `vscode.ConfigurationTarget.Global`.
 *
 * Global rather than Workspace because the setting's declared scope is
 * `machine`: a workspace value would be accepted by the editor and then never
 * read back here.
 */
export const GLOBAL_CONFIGURATION_TARGET = 1;

/** The three entries an engine package must hold. */
const ENGINE_ENTRY_FILE = "haruyuki.js";
const ENGINE_MODULES_DIR = "node_modules";
const ENGINE_MANIFEST_FILE = "package.json";

/** The directory name a `PATH` entry may use for its own engine package. */
const PATH_SUBDIRECTORY = "haruyuki";

/** Why a resolution could not name a startable engine. */
export type EngineResolutionFailure = "missing" | "invalid-dir" | "version-unknown";

/** The three rungs an external engine can be found on. */
export type EngineOrigin = "setting" | "path" | "picked";

/**
 * The answer to "which engine, and is it the tested one".
 *
 * The success arm is deliberately not "the engine to start": a build other than
 * the tested one resolves with `tested: false` plus both versions, and nothing
 * in this module can start anything, so `ok: true` alone never connects.
 */
export type EngineResolution =
  | {
      readonly ok: true;
      readonly source: EngineSource;
      /** Version read from the engine's own manifest. */
      readonly version: string;
      /** Build this shell was tested against. */
      readonly expectedVersion: string;
      /** Whether `version` is exactly `expectedVersion`. */
      readonly tested: boolean;
      /**
       * Which rung found it.
       *
       * Kept apart from `source.kind`, which only says whether the engine ships
       * inside the extension. The tooltip has to name the rung -- the setting,
       * PATH or a hand pick -- because that is what tells the user where to go
       * when the engine is not the one they expected.
       */
      readonly origin: EngineOrigin;
    }
  | {
      readonly ok: false;
      readonly reason: EngineResolutionFailure;
      /** One English sentence per rung that failed; never parsed for control flow. */
      readonly detail?: string;
      /**
       * The directories that were opened and refused.
       *
       * Carried as data rather than left to be read back out of `detail`: a
       * caller that has to parse a sentence is a caller that breaks the day the
       * sentence is reworded, and `PATH` is deliberately absent from this list
       * because those directories are inputs, not places anyone can go and fix.
       */
      readonly inspected?: readonly string[];
    };

/**
 * As much of `vscode.WorkspaceConfiguration` as this module reads.
 *
 * Structural on purpose: it keeps this file free of a runtime import of the
 * editor API, and it is the exact surface a fake has to implement.
 */
export type ConfigurationLike = {
  get<T>(section: string, defaultValue: T): T;
  update(section: string, value: string, target?: number): PromiseLike<void>;
};

/** The persisted pick, as this module needs it. */
export type EngineSettingsPort = {
  /** @returns the configured directory, or `undefined` when none is set */
  read(): Promise<string | undefined>;
  /** Persist a directory that already passed the structural check. */
  write(dir: string): Promise<void>;
};

/**
 * Bind the settings port to the editor's configuration API.
 *
 * @param getConfiguration `vscode.workspace.getConfiguration`, bound by the
 *   composition root so this module needs no runtime VS Code import
 * @returns the port the resolver reads the setting through
 */
export function createVSCodeEngineSettings(
  getConfiguration: (section: string) => ConfigurationLike,
): EngineSettingsPort {
  return {
    async read(): Promise<string | undefined> {
      const configured = getConfiguration(ENGINE_SETTING_SECTION).get<string>(
        ENGINE_SETTING_KEY,
        "",
      );

      // The declared default is the empty string, so "not set" arrives as one.
      const trimmed = typeof configured === "string" ? configured.trim() : "";

      return trimmed === "" ? undefined : trimmed;
    },

    async write(dir: string): Promise<void> {
      await getConfiguration(ENGINE_SETTING_SECTION).update(
        ENGINE_SETTING_KEY,
        dir,
        GLOBAL_CONFIGURATION_TARGET,
      );
    },
  };
}

/** One directory this shell could start from, and where that idea came from. */
type Candidate = {
  readonly dir: string;
  readonly origin: "setting" | "path" | "picked";
};

/** How one rung is named in a failure detail. */
const ORIGIN_LABEL: Record<Candidate["origin"], string> = {
  setting: `the ${ENGINE_SETTING_KEY} setting`,
  path: "PATH",
  picked: "the picked directory",
};

/** The success arm of {@link EngineResolution}. */
type EngineFound = Extract<EngineResolution, { ok: true }>;

/** How the result of one attempt is reported back to {@link resolveEngine}. */
type Attempt =
  | { readonly kind: "resolved"; readonly found: EngineFound }
  | {
      readonly kind: "unusable";
      readonly failure: EngineResolutionFailure;
      readonly note: string;
      /** The directory that was opened and refused, when there was one. */
      readonly inspected?: string;
    };

/** Everything {@link resolveEngine} needs. */
export type ResolveEngineOptions = {
  readonly settings: EngineSettingsPort;
  /**
   * Build this shell was tested against.
   *
   * Injectable so a test can exercise a mismatch without the real constant, and
   * optional so a caller cannot accidentally pass a second, drifting number:
   * the default is the one this shell ships.
   */
  readonly testedVersion?: string;
  /** `process.env.PATH`; passed in so a test never mutates the real one. */
  readonly pathEnv?: string;
  /** `path.delimiter`; injectable to exercise another platform's `PATH`. */
  readonly pathDelimiter?: string;
  /** The directory the user picked by hand, if the panel asked for one. */
  readonly manualDir?: string;
};

/**
 * Find the engine in the fixed order and judge its version.
 *
 * A manual pick is written back only when it is the rung that answers, and only
 * after it passed: the setting keeps the last directory that actually worked.
 *
 * @param options the settings port, the expected version and the search inputs
 * @returns the engine to offer the user, or why there is none
 */
export async function resolveEngine(options: ResolveEngineOptions): Promise<EngineResolution> {
  const expectedVersion = (options.testedVersion ?? TESTED_ENGINE_VERSION).trim();
  const notes: string[] = [];
  const failures = new Set<EngineResolutionFailure>();
  const inspected = new Set<string>();

  const candidates: Candidate[] = [];

  const configured = (await options.settings.read())?.trim() ?? "";

  if (configured === "") {
    notes.push(`no ${ENGINE_SETTING_KEY} is configured`);
  } else {
    candidates.push({ dir: configured, origin: "setting" });
  }

  const fromPath = await pathCandidates(
    options.pathEnv ?? process.env["PATH"] ?? "",
    options.pathDelimiter ?? delimiter,
  );

  if (fromPath.length === 0) {
    notes.push("no PATH directory holds an engine package");
  } else {
    for (const dir of fromPath) candidates.push({ dir, origin: "path" });
  }

  const picked = options.manualDir?.trim() ?? "";

  if (picked === "") {
    notes.push("no directory was picked by hand");
  } else {
    candidates.push({ dir: picked, origin: "picked" });
  }

  for (const candidate of candidates) {
    const attempt = await attemptAt(candidate.dir, expectedVersion, candidate.origin);

    if (attempt.kind === "resolved") {
      // The durable record follows the answer: a pick that resolved is the one
      // the next activation should read first. A rung that was already in the
      // setting needs no write, and a failed rung never reaches this line.
      if (candidate.origin === "picked") {
        await options.settings.write(attempt.found.source.dir);
      }

      return attempt.found;
    }

    notes.push(`${ORIGIN_LABEL[candidate.origin]} does not name a usable engine: ${attempt.note}`);
    failures.add(attempt.failure);

    if (attempt.inspected !== undefined) inspected.add(attempt.inspected);
  }

  return {
    ok: false,
    reason: worstFailure(failures),
    detail: `no engine to start: ${notes.join("; ")}`,
    ...(inspected.size === 0 ? {} : { inspected: [...inspected] }),
  };
}

/**
 * Judge one directory against the expected version.
 *
 * @param dir a directory the shell may start from
 * @param expectedVersion the tested build, already trimmed
 * @returns the resolution, or why this directory cannot answer
 */
async function attemptAt(
  dir: string,
  expectedVersion: string,
  origin: EngineOrigin,
): Promise<Attempt> {
  if (!isAbsolute(dir)) {
    return {
      kind: "unusable",
      failure: "invalid-dir",
      note: `${dir} is not an absolute path`,
    };
  }

  const checked = await inspectEngineDirectory(dir);

  if (!checked.ok) {
    return {
      kind: "unusable",
      failure: "invalid-dir",
      note: `${checked.dir}: ${checked.problems.join(", ")}`,
      inspected: checked.dir,
    };
  }

  if (checked.version === undefined) {
    return {
      kind: "unusable",
      failure: "version-unknown",
      note: `${checked.dir} has no readable version in ${ENGINE_MANIFEST_FILE}`,
      inspected: checked.dir,
    };
  }

  return {
    kind: "resolved",
    found: {
      ok: true,
      tested: checked.version === expectedVersion,
      version: checked.version,
      expectedVersion,
      origin,
      source: {
        kind: "external",
        dir: checked.dir,
        bundlePath: checked.bundlePath,
        version: checked.version,
      },
    },
  };
}

/**
 * The structural check on one directory.
 *
 * Exported so a caller that shows a picker can preview the same verdict without
 * resolving a version, and so the missing-entry list has one author.
 */
export type EngineDirectoryCheck =
  | {
      readonly ok: true;
      /** Absolute engine package root; the engine child's working directory. */
      readonly dir: string;
      /** Absolute `haruyuki.js`, the bundle the child loads as ESM. */
      readonly bundlePath: string;
      /** `package.json.version`, when the manifest was readable. */
      readonly version?: string;
    }
  | {
      readonly ok: false;
      /** The directory as it was named, made absolute when it was relative. */
      readonly dir: string;
      /** One sentence per entry that is missing or has the wrong type. */
      readonly problems: readonly string[];
    };

/**
 * Check one directory for the three entries an engine package must hold.
 *
 * @param dir any path; a relative one is resolved against this process
 * @returns the engine package, or every reason it is not one
 */
export async function inspectEngineDirectory(dir: string): Promise<EngineDirectoryCheck> {
  const absolute = resolve(dir);
  const problems: string[] = [];

  const root = await entryState(absolute, "directory");

  if (root === "missing") {
    return { ok: false, dir: absolute, problems: [`${absolute} does not exist`] };
  }

  if (root === "wrong-type") {
    return { ok: false, dir: absolute, problems: [`${absolute} is not a directory`] };
  }

  const entry = await entryState(join(absolute, ENGINE_ENTRY_FILE), "file");

  if (entry === "missing") problems.push(`${ENGINE_ENTRY_FILE} is missing`);
  if (entry === "wrong-type") problems.push(`${ENGINE_ENTRY_FILE} is not a file`);

  const modules = await entryState(join(absolute, ENGINE_MODULES_DIR), "directory");

  if (modules === "missing") problems.push(`${ENGINE_MODULES_DIR} is missing`);
  if (modules === "wrong-type") problems.push(`${ENGINE_MODULES_DIR} is not a directory`);

  const manifest = await entryState(join(absolute, ENGINE_MANIFEST_FILE), "file");

  if (manifest === "missing") problems.push(`${ENGINE_MANIFEST_FILE} is missing`);
  if (manifest === "wrong-type") problems.push(`${ENGINE_MANIFEST_FILE} is not a file`);

  if (problems.length > 0) return { ok: false, dir: absolute, problems };

  const version = await readEngineVersion(absolute);
  const bundlePath = join(absolute, ENGINE_ENTRY_FILE);

  return version === undefined
    ? { ok: true, dir: absolute, bundlePath }
    : { ok: true, dir: absolute, bundlePath, version };
}

/** What one filesystem entry turned out to be. */
type EntryState = "present" | "missing" | "wrong-type";

/**
 * Classify one entry.
 *
 * @param path absolute path
 * @param expected the type the entry must have
 * @returns whether it is there with that type, missing, or something else
 */
async function entryState(path: string, expected: "file" | "directory"): Promise<EntryState> {
  try {
    const stats = await stat(path);
    const matches = expected === "file" ? stats.isFile() : stats.isDirectory();

    return matches ? "present" : "wrong-type";
  } catch {
    // A permission error and an absent entry both mean this rung cannot answer;
    // the detail sentence already names the directory, so the cause adds nothing
    // the user could act on differently.
    return "missing";
  }
}

/**
 * Read `package.json.version`.
 *
 * @param dir absolute engine package root
 * @returns the trimmed version, or `undefined` when it is unreadable or absent
 */
async function readEngineVersion(dir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, ENGINE_MANIFEST_FILE), "utf8"));

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

    const version = (parsed as Record<string, unknown>)["version"];

    if (typeof version !== "string") return undefined;

    const trimmed = version.trim();

    return trimmed === "" ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/**
 * List the directories on `PATH` that look like an engine package.
 *
 * A `PATH` entry is considered twice: as the engine package itself, and as a
 * parent that holds one in `haruyuki/`. Only entries whose `haruyuki.js` exists
 * become candidates, so a long `PATH` does not turn one resolution into dozens
 * of failure sentences.
 *
 * @param pathEnv raw `PATH`
 * @param pathDelimiter the platform's list separator
 * @returns absolute candidate directories, in `PATH` order, without duplicates
 */
async function pathCandidates(pathEnv: string, pathDelimiter: string): Promise<string[]> {
  const seen = new Set<string>();
  const found: string[] = [];

  for (const raw of pathEnv.split(pathDelimiter)) {
    const entry = raw.trim();

    if (entry === "") continue;

    const root = resolve(entry);

    for (const candidate of [root, join(root, PATH_SUBDIRECTORY)]) {
      if (seen.has(candidate)) continue;

      seen.add(candidate);

      const state = await entryState(join(candidate, ENGINE_ENTRY_FILE), "file");

      if (state === "present") found.push(candidate);
    }
  }

  return found;
}

/** Which failure a set of failed rungs should be reported as, most specific first. */
const FAILURE_PRIORITY: readonly EngineResolutionFailure[] = [
  "version-unknown",
  "invalid-dir",
  "missing",
];

/**
 * @param failures every failure that fired while walking the rungs
 * @returns the one that tells the user the most
 */
function worstFailure(failures: ReadonlySet<EngineResolutionFailure>): EngineResolutionFailure {
  return FAILURE_PRIORITY.find((failure) => failures.has(failure)) ?? "missing";
}

/**
 * The spawn-spec seam the core child reaches back through.
 *
 * Two answers have to hold at the moment a process exists, and both can have
 * changed since activation, so both are taken here rather than captured once:
 *
 * - the engine directory is re-checked, so a setting that went stale (the
 *   directory was moved or deleted) cannot spawn an interpreter against it;
 * - the working directory is read again, so a folder the user opened after
 *   activation is used, and a folder-less window refuses instead of running the
 *   engine somewhere nobody chose.
 *
 * `cwd` comes from the workspace, never from the engine package: the engine
 * writes its tree under its cwd and the panel shows that tree, so the two have
 * to be the same directory. The builder's own answer is overridden for exactly
 * that reason.
 *
 * @param options the shell's spec builder and the current workspace answer
 * @returns the function to inject as the core proxy's `resolveSpawnSpec`
 */
export function createSpawnSpecResolver(options: {
  readonly build: (source: EngineSource) => Promise<EngineSpawnSpec>;
  /** Evaluate the workspace now; a caller may have opened a folder meanwhile. */
  readonly readWorkspaceCwd: () => WorkspaceResolution;
}): (source: EngineSource) => Promise<EngineSpawnSpec> {
  return async (source: EngineSource): Promise<EngineSpawnSpec> => {
    const checked = await inspectEngineDirectory(source.dir);

    if (!checked.ok) {
      throw new Error(`the engine directory is no longer usable: ${checked.problems.join(", ")}`);
    }

    const workspace = options.readWorkspaceCwd();

    if (!workspace.ok) {
      throw new Error(workspace.detail);
    }

    // The source's own `bundlePath` is kept rather than replaced: it is what the
    // caller recorded against this directory, and swapping in a computed one
    // would silently accept a source that named a different bundle.
    const spec = await options.build({
      kind: source.kind,
      dir: checked.dir,
      bundlePath: source.bundlePath,
      ...(source.version === undefined ? {} : { version: source.version }),
    });

    return { ...spec, cwd: workspace.cwd };
  };
}
