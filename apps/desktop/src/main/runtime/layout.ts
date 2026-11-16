/**
 * Where the packaged runtime lives, in one place.
 *
 * Three callers need the same answer -- the D2 host port (bundle and watchdog),
 * the lock/state modules, and the renderer's eventual error surface -- and each
 * of them would otherwise re-derive it with its own `path.join`. That is the
 * second-guess failure this module exists to prevent: a port that guesses
 * `app.getAppPath()/engine` and a lock that guesses
 * `process.resourcesPath/engine` disagree only in packaged builds, where the
 * first is inside `app.asar` and cannot be spawned.
 *
 * The module is deliberately free of Electron imports. `main.ts` reads
 * `app.isPackaged`, `app.getAppPath()`, `process.resourcesPath` and
 * `app.getPath("userData")` and passes them in; tests call the same pure
 * function with fixture paths.
 */

import path from "node:path";

/** Which side of the packaging boundary the shell is running on. */
export type RuntimeMode = "packaged" | "dev";

/** The runtime facts `main.ts` has to read from Electron. */
export interface RuntimeFacts {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** `app.getAppPath()`; in a packaged build this is `.../resources/app.asar`. */
  readonly appPath: string;
  /** `process.resourcesPath`; the directory that may hold `engine/` and `runtime/`. */
  readonly resourcesPath: string;
  /** `__dirname` of the built main bundle; used only to derive the dev app root. */
  readonly here: string;
  /** `app.getPath("userData")`. */
  readonly userData: string;
  /** `app.getPath("logs")`; the one log root, also shown by the runtime error page. */
  readonly logsDir: string;
}

/** Every path the runtime layer needs, with the mode that produced it. */
export interface RuntimeLayout {
  readonly mode: RuntimeMode;
  /** Packaged: the `app.asar` path. Dev: the `apps/desktop` package directory. */
  readonly appRoot: string;
  /** Packaged: `process.resourcesPath`. Dev: the package directory. */
  readonly resourcesRoot: string;
  readonly engineDir: string;
  readonly bundlePath: string;
  /** Real file, never inside `app.asar`; `NODE_OPTIONS` preloads it. */
  readonly watchdogPath: string;
  /** Packaged: inside `app.asar`. Dev: generated next to the package. */
  readonly lockPath: string;
  readonly statePath: string;
  readonly logsDir: string;
}

/** Fixed file names; exported so callers do not repeat literal strings. */
export const RUNTIME_ENGINE_DIR = "engine" as const;
export const RUNTIME_BUNDLE_FILE = "haruyuki.js" as const;
export const RUNTIME_WATCHDOG_RELATIVE = path.join("runtime", "watchdog.cjs");
export const RUNTIME_LOCK_FILE = "runtime-lock.json" as const;
export const RUNTIME_STATE_FILE = "runtime-state.json" as const;

/**
 * Derive the runtime layout from facts already read from Electron.
 *
 * Packaged builds put the engine and watchdog under `resources/` (real files,
 * spawnable) and the lock inside `app.asar` (tamper-evident by being part of the
 * app). Dev builds use the repository's `_research` engine and source watchdog,
 * so `pnpm start` needs no packaging step.
 *
 * @param facts the four Electron answers plus the main bundle's `__dirname`
 * @returns the frozen layout for this run
 * @throws {TypeError} when a required fact is missing
 */
export function computeRuntimeLayout(facts: RuntimeFacts): RuntimeLayout {
  requirePath(facts.appPath, "appPath");
  requirePath(facts.resourcesPath, "resourcesPath");
  requirePath(facts.here, "here");
  requirePath(facts.userData, "userData");
  requirePath(facts.logsDir, "logsDir");

  if (facts.isPackaged) {
    const resourcesRoot = path.resolve(facts.resourcesPath);
    const appRoot = path.resolve(facts.appPath);
    const engineDir = path.join(resourcesRoot, RUNTIME_ENGINE_DIR);

    return Object.freeze({
      mode: "packaged",
      appRoot,
      resourcesRoot,
      engineDir,
      bundlePath: path.join(engineDir, RUNTIME_BUNDLE_FILE),
      watchdogPath: path.join(resourcesRoot, RUNTIME_WATCHDOG_RELATIVE),
      lockPath: path.join(appRoot, RUNTIME_LOCK_FILE),
      statePath: path.join(path.resolve(facts.userData), RUNTIME_STATE_FILE),
      logsDir: path.resolve(facts.logsDir),
    });
  }

  const appRoot = path.resolve(facts.here, "..", "..");
  const repoRoot = path.resolve(appRoot, "..", "..");

  return Object.freeze({
    mode: "dev",
    appRoot,
    resourcesRoot: appRoot,
    engineDir: path.join(repoRoot, "_research", "engine-0.6.0", "package"),
    bundlePath: path.join(repoRoot, "_research", "engine-0.6.0", "package", RUNTIME_BUNDLE_FILE),
    watchdogPath: path.join(repoRoot, "packages", "core", "src", "runtime", "watchdog.cjs"),
    lockPath: path.join(appRoot, RUNTIME_LOCK_FILE),
    statePath: path.join(path.resolve(facts.userData), RUNTIME_STATE_FILE),
    logsDir: path.resolve(facts.logsDir),
  });
}

/**
 * Reject an empty path before `path.resolve` turns it into the process cwd.
 *
 * `path.resolve("")` returns cwd, so an unset `app.getPath` would silently
 * point the engine at the shell's working directory -- a failure that looks like
 * "the engine is missing" rather than "a fact was not read".
 *
 * @param value the candidate path
 * @param name the fact name, for the error
 */
function requirePath(value: string, name: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty path`);
  }
}
