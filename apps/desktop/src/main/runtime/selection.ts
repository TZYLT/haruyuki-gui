/**
 * Which engine bundle this run should start, in the order the requirement fixes:
 * external pick > bundled > PATH > missing.
 *
 * Selection is a pure read: it never writes state, never shows UI and never
 * starts the engine. The caller (the startup coordinator) owns the two visible
 * consequences -- an external pick that has become invalid quietly falls back to
 * the bundled engine and leaves a status note, and a missing bundle opens the
 * error surface.
 *
 * PATH is searched for `haruyuki.js` itself, not for a `haruyuki` command. A
 * global command would need a system Node to run the bundle, and a system Node
 * has a different ABI from Electron 45 (137 vs 150 here), so the native modules
 * the engine ships with would fail to load. The bundle found on PATH is still
 * started with `process.execPath` and `ELECTRON_RUN_AS_NODE=1`.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Where a usable bundle came from. */
export type BundleSource = "external" | "bundled" | "path" | "missing";

/** An engine directory that passed the structural check. */
export interface BundleLocation {
  readonly source: Exclude<BundleSource, "missing">;
  readonly engineDir: string;
  readonly bundlePath: string;
  /** `package.json.version`, when readable; absent is not a selection failure. */
  readonly version?: string;
}

/** An external pick that no longer works. */
export interface InvalidExternal {
  readonly dir: string;
  readonly reason: string;
}

/** The selection result. `externalInvalid` is present only when a fallback happened. */
export type BundleSelection =
  | {
      readonly kind: "selected";
      readonly location: BundleLocation;
      readonly externalInvalid?: InvalidExternal;
    }
  | {
      readonly kind: "missing";
      readonly reason: string;
      readonly externalInvalid?: InvalidExternal;
    };

/** What the selector needs; all injectable for tests. */
export interface SelectBundleOptions {
  /** Absolute path of the bundled engine. */
  readonly bundledDir: string;
  /** Persisted external pick, if any. */
  readonly externalDir?: string;
  /** `process.env.PATH`; passed in so a test does not mutate the real one. */
  readonly pathEnv?: string;
  /** `path.delimiter`; injectable for a test on another platform. */
  readonly pathDelimiter?: string;
}

/**
 * Select the bundle in requirement order.
 *
 * @param options bundled path, external pick and PATH
 * @returns selected location, or a missing reason
 */
export async function selectBundle(options: SelectBundleOptions): Promise<BundleSelection> {
  let externalInvalid: InvalidExternal | undefined;

  if (options.externalDir !== undefined && options.externalDir !== "") {
    const external = await inspectEngineDir(options.externalDir, "external", options.externalDir);

    if (external.kind === "valid") {
      return { kind: "selected", location: external.location };
    }

    externalInvalid = external.invalid;
  }

  const bundled = await inspectEngineDir(options.bundledDir, "bundled");

  if (bundled.kind === "valid") {
    return externalInvalid === undefined
      ? { kind: "selected", location: bundled.location }
      : { kind: "selected", location: bundled.location, externalInvalid };
  }

  const fromPath = await findOnPath(
    options.pathEnv ?? process.env["PATH"] ?? "",
    options.pathDelimiter ?? path.delimiter,
  );

  if (fromPath !== undefined) {
    return externalInvalid === undefined
      ? { kind: "selected", location: fromPath }
      : { kind: "selected", location: fromPath, externalInvalid };
  }

  const reason =
    externalInvalid === undefined
      ? "no engine bundle: not selected, not bundled, not on PATH"
      : `selected engine is invalid (${externalInvalid.reason}) and no bundled/PATH engine was found`;

  return externalInvalid === undefined
    ? { kind: "missing", reason }
    : { kind: "missing", reason, externalInvalid };
}

/**
 * Read `package.json.version` without making it a selection criterion.
 *
 * A version mismatch is a warning in the UI, not a refusal (Q49). A missing or
 * malformed package.json is also not a refusal: the structural check only
 * requires the entry and `node_modules`.
 *
 * @param engineDir absolute engine directory
 * @returns version string, or undefined
 */
export async function readEngineVersion(engineDir: string): Promise<string | undefined> {
  try {
    const text = await readFile(path.join(engineDir, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const version = (parsed as Record<string, unknown>)["version"];

      return typeof version === "string" && version !== "" ? version : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/** Inspect one engine directory. */
async function inspectEngineDir(
  dir: string,
  source: BundleLocation["source"],
  externalDir?: string,
): Promise<
  { kind: "valid"; location: BundleLocation } | { kind: "invalid"; invalid: InvalidExternal }
> {
  const engineDir = path.resolve(dir);
  const bundlePath = path.join(engineDir, "haruyuki.js");

  try {
    const entry = await stat(bundlePath);

    if (!entry.isFile()) {
      return {
        kind: "invalid",
        invalid: {
          dir: externalDir ?? engineDir,
          reason: `entry is not a file: ${bundlePath}`,
        },
      };
    }

    const modules = await stat(path.join(engineDir, "node_modules"));

    if (!modules.isDirectory()) {
      return {
        kind: "invalid",
        invalid: {
          dir: externalDir ?? engineDir,
          reason: `node_modules is not a directory: ${path.join(engineDir, "node_modules")}`,
        },
      };
    }
  } catch (error) {
    return {
      kind: "invalid",
      invalid: {
        dir: externalDir ?? engineDir,
        reason: `${engineDir}: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  const version = await readEngineVersion(engineDir);

  return {
    kind: "valid",
    location: {
      source,
      engineDir,
      bundlePath,
      ...(version === undefined ? {} : { version }),
    },
  };
}

/**
 * Search PATH directories for `haruyuki.js` with a sibling `node_modules`.
 *
 * @param pathEnv raw PATH
 * @param delimiter platform delimiter
 * @returns the first usable location, or undefined
 */
async function findOnPath(pathEnv: string, delimiter: string): Promise<BundleLocation | undefined> {
  const seen = new Set<string>();

  for (const raw of pathEnv.split(delimiter)) {
    const dir = raw.trim();

    if (dir === "") continue;

    const resolved = path.resolve(dir);

    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const result = await inspectEngineDir(resolved, "path");

    if (result.kind === "valid") {
      return {
        source: result.location.source,
        engineDir: resolved,
        bundlePath: result.location.bundlePath,
        ...(result.location.version === undefined ? {} : { version: result.location.version }),
      };
    }
  }

  return undefined;
}
