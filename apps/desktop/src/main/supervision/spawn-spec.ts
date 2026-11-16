/**
 * Spawn-spec resolution for the desktop engine host.
 *
 * Split from `engine-host.ts` so the process-lifetime seam stays small and this
 * platform detail has one place: where the dev bundle lives, how the watchdog is
 * injected, and what environment the engine child receives.
 *
 * This is temporary scaffolding for D2 (`RD-02`): when the desktop HostPort
 * adapter lands, `getRuntimeSpawnSpec()` replaces the source of these values and
 * the call site in `engine-host.ts` stays the same.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import type { Engine, EngineSpawnSpec } from "@haruyuki/core";

import type { SupervisionLog } from "./boot.js";

/** The dev engine bundle, relative to a repository root. */
const DEV_BUNDLE_RELATIVE = join("_research", "engine-0.6.0", "package", "haruyuki.js");

/** How far up from each search root the dev bundle is looked for. */
const DEV_SEARCH_DEPTH = 8;

/** Engine state directory under userData; the engine writes its own tree there. */
export const ENGINE_HOME_DIR = "engine-home";

/** Token directory under userData, owned by the caller as B1 requires. */
export const TOKEN_DIR_NAME = "engine-token";

/** Where to look for the bundle when the caller did not name one. */
export interface BundleResolutionOptions {
  readonly bundlePath?: string;
  readonly appPath?: string;
  readonly searchFrom?: readonly string[];
}

/**
 * Resolve the engine bundle: explicit option, environment, then the dev path.
 *
 * An explicit path that does not exist is logged and the search continues; a
 * typo in `HARUYUKI_ENGINE_BUNDLE` must not silently turn into "no engine" with
 * no trace. The dev search is upward from cwd/appPath so a checkout is found
 * wherever it lives; there is deliberately no absolute drive letter here.
 */
export function resolveEngineBundle(
  options: BundleResolutionOptions,
  log: SupervisionLog,
): string | null {
  const explicit: string[] = [];

  if (options.bundlePath !== undefined && options.bundlePath.trim() !== "") {
    explicit.push(options.bundlePath);
  }

  const fromEnv = process.env["HARUYUKI_ENGINE_BUNDLE"];

  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    explicit.push(fromEnv);
  }

  for (const candidate of explicit) {
    const absolute = resolve(candidate);

    if (existsSync(absolute)) return absolute;

    log("supervision.engine.bundle", { state: "missing", path: absolute });
  }

  for (const root of options.searchFrom ?? defaultSearchRoots(options)) {
    const found = searchUpForDevBundle(root);

    if (found !== null) return found;
  }

  return null;
}

/** Build the eight-field spawn subset with the shell's environment. */
export function buildEngineSpawnSpec(options: {
  readonly userData: string;
  readonly bundlePath: string;
  readonly watchdogPath: string | null;
}): EngineSpawnSpec {
  const env = environmentWithoutUndefined();

  // The Electron binary doubles as Node for the engine child; setting this on
  // the child only is how the shell launches the engine without turning itself
  // into plain Node.
  env["ELECTRON_RUN_AS_NODE"] = "1";
  env["HARUYUKI_HOME"] = join(options.userData, ENGINE_HOME_DIR);

  if (options.watchdogPath === null) {
    // Do not pass an inherited preload to the engine: the shell cannot justify
    // an arbitrary NODE_OPTIONS it did not write.
    delete env["NODE_OPTIONS"];
  } else {
    env["NODE_OPTIONS"] = `--require "${toNodeOptionsPath(options.watchdogPath)}"`;
  }

  return {
    exePath: process.execPath,
    bundlePath: options.bundlePath,
    // The token file PATH is appended by `Engine.start`; the token value itself
    // never reaches argv. `--ws-auth` is required by the real engine.
    argvPrefix: ["server", "--ws-auth", "capability-token", "--ws-token-file"],
    cwd: options.userData,
    env,
    stdio: "pipe",
    windowsHide: true,
    detached: false,
  };
}

/**
 * Locate `packages/core/src/runtime/watchdog.cjs`.
 *
 * Deriving it from the resolved `@haruyuki/core` package keeps this module free
 * of a second copy of the repository layout and works in the dev tree as well
 * as a bundled shell. A missing file is not fatal: the engine still starts, and
 * the marker records `watchdog: "unknown"` instead of claiming protection the
 * shell cannot prove.
 */
export function resolveWatchdogPath(override?: () => string | null): string | null {
  try {
    if (override !== undefined) {
      const candidate = override();

      return candidate !== null && existsSync(candidate) ? candidate : null;
    }

    const require = createRequire(requireAnchor());
    const entry = require.resolve("@haruyuki/core");
    const besideEntry = join(dirname(entry), "runtime", "watchdog.cjs");

    if (existsSync(besideEntry)) return besideEntry;

    const packageRoot = join(dirname(entry), "..", "runtime", "watchdog.cjs");

    return existsSync(packageRoot) ? packageRoot : null;
  } catch {
    return null;
  }
}

/**
 * What to record for the watchdog.
 *
 * B1 reports a `watchdog` degradation exactly when the injected script never
 * printed `WATCHDOG_OK`. No injection means the shell has no claim at all, so
 * the honest value is `unknown` (requirement section 4.3 item 4).
 */
export function watchdogStatus(
  watchdogPath: string | null,
  engine: Engine,
): "active" | "inactive" | "unknown" {
  if (watchdogPath === null) return "unknown";

  const degraded = (engine.degradations ?? []).some((entry) => entry.kind === "watchdog");

  return degraded ? "inactive" : "active";
}

/** cwd plus the app path when the caller has one. */
function defaultSearchRoots(options: BundleResolutionOptions): string[] {
  const roots = [process.cwd()];

  if (options.appPath !== undefined) roots.push(options.appPath);

  return roots;
}

/** Walk up from `start` looking for the dev engine bundle. */
function searchUpForDevBundle(start: string): string | null {
  let dir = resolve(start);

  for (let depth = 0; depth < DEV_SEARCH_DEPTH; depth += 1) {
    const candidate = join(dir, DEV_BUNDLE_RELATIVE);

    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);

    if (parent === dir) break;

    dir = parent;
  }

  return null;
}

/**
 * Windows paths use forward slashes because Node's `NODE_OPTIONS` parser treats
 * a backslash inside the quotes as an escape; `C:\a\watchdog.cjs` arrives as
 * `C:awatchdog.cjs` and the preload silently fails.
 */
function toNodeOptionsPath(absolute: string): string {
  return process.platform === "win32" ? absolute.replaceAll("\\", "/") : absolute;
}

/**
 * Anchor for `createRequire`.
 *
 * The main process is bundled as CommonJS, so `import.meta` is empty there and
 * `__dirname` is the real location; tests run as ESM, where the reverse holds.
 * `typeof` is safe for the identifier that does not exist on the other side.
 */
function requireAnchor(): string {
  return typeof __dirname === "string" ? join(__dirname, "spawn-spec.cjs") : import.meta.url;
}

/** Copy `process.env` into the string-only record the spawn spec requires. */
function environmentWithoutUndefined(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  return env;
}
