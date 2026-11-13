/**
 * Headless host port: the `HostPortStartup` startup subset for a plain `node` process.
 *
 * `host-port.ts` owns the shape: `HostPortStartup` for the three startup items
 * file), 3.3(a) (HostPortStartup), 3.4 (watchdog injection), 4.2 (work package)
 * and 5.1 (isolation rules). This is the second implementation of the host port
 * contract: the desktop shell (D2) will answer `true` to some capabilities,
 * while this one answers `false` to all four and roots every path in a
 * disposable directory. That makes it the evidence for INIME safety ("every port
 * method must be implementable headlessly").
 *
 * Deliberately out of scope: no state machine, no WebSocket, no stdout parsing
 * and no token content. Those belong to the log / snapshot assembly / `transport.ts` / . This module
 * only answers "where may the engine write" (paths) and "how is it started"
 * (the spawn spec). One thing it does own is the watchdog INJECTION string
 * (decision D-02): `runtime/watchdog.cjs` itself is the watchdog file, but composing
 * `NODE_OPTIONS` is part of building the spawn spec, so it lives here.
 *
 * The watchdog path is derived from `import.meta.url` and never imported. Two
 * reasons: the script is CommonJS meant to be preloaded into a different
 * process, and the bridge writes it concurrently, so a static import would couple our
 * build (and our test collection) to a file this package does not own.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EngineSpawnSpec } from "../engine/types";
import type { HostPortStartup } from "./host-port";

/**
 * The four capabilities a headless host cannot provide.
 *
 * Frozen and shared: all four are constants of the implementation, and freezing
 * keeps a caller from mutating one instance's answer into another's. The
 * contract is `HostPortStartup["capabilities"]`, so this object is checked
 * against the frozen shape instead of being a second definition of it.
 */
const HEADLESS_CAPABILITIES: HostPortStartup["capabilities"] = Object.freeze({
  canNotify: false,
  canReadDroppedFiles: false,
  canPopout: false,
  canFloatingWindow: false,
});

/**
 * Engine argv before the bundle path: engine knowledge, not a host preference.
 *
 * `--ws-token-file` is the option NAME only: the token file path is appended by
 * `Engine.start` (it owns `tokenDir`), and the token value itself must never
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

/** Where the watchdog script sits relative to this source file. */
const WATCHDOG_RELATIVE_PATH = "../runtime/watchdog.cjs";

/** Environment variable the engine reads to isolate its own state. */
const ENGINE_HOME_ENV = "HARUYUKI_HOME";

/** Subdirectory names created under `engineHome`. */
const USER_DATA_DIR = "userData";
const LOGS_DIR = "logs";
const CACHE_DIR = "cache";
const TEMP_DIR = "temp";

/** Prefix of the disposable engine home created when the caller omits one. */
const TEMP_ENGINE_HOME_PREFIX = "haruyuki-headless-";

/**
 * Options for {@link createHeadlessHostPort}.
 *
 * - `bundlePath`: engine entry point, and it must be absolute. It is stored
 *   verbatim and checked at spawn-spec time, because the bundle may be unpacked
 *   after the host is constructed.
 * - `engineHome`: root of all four directories. Omitted means a fresh
 *   `mkdtemp` directory, which is what tests and short-lived probes want.
 * - `tokenDir`: directory for the capability token file. The contract has no
 *   token field, and `paths.temp` is defined as "where short-lived isolates
 *   (token files, scratch state) must be created" (host-port.ts), so an explicit
 *   `tokenDir` becomes `paths.temp`. A relative value resolves against
 *   `engineHome`; a value outside `engineHome` is rejected instead of silently
 *   escaping the isolated root.
 */
export type HeadlessHostPortOptions = {
  bundlePath: string;
  engineHome?: string;
  tokenDir?: string;
};

/**
 * Build a headless {@link HostPortStartup}.
 *
 * Asynchronous on purpose: the factory performs real I/O (it creates four
 * directories, and may create the engine home itself), so it is a promise
 * rather than a synchronous constructor. A failure to create a directory
 * rejects here, where a bootstrap can classify it once, instead of surfacing
 * much later as a confusing ENOENT from the engine. Keeping the factory async
 * also matches the desktop shell, which resolves the same roots from
 * `app.whenReady()`.
 *
 * `paths` and `capabilities` are resolved once and returned as data, and the
 * watchdog location is fixed at construction; only the bundle existence check is
 * deferred to `getRuntimeSpawnSpec`, because the artifact may be unpacked after
 * the host is built.
 */
export async function createHeadlessHostPort(
  options: HeadlessHostPortOptions,
): Promise<HostPortStartup> {
  const engineHome = await resolveEngineHome(options.engineHome);
  const tempDir = resolveTokenDir(engineHome, options.tokenDir);

  const paths: HostPortStartup["paths"] = {
    userData: join(engineHome, USER_DATA_DIR),
    logs: join(engineHome, LOGS_DIR),
    cache: join(engineHome, CACHE_DIR),
    temp: tempDir,
  };

  await Promise.all(
    [paths.userData, paths.logs, paths.cache, paths.temp].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );

  const watchdogPath = watchdogPathForNodeOptions();

  return {
    capabilities: HEADLESS_CAPABILITIES,
    paths,

    async getRuntimeSpawnSpec() {
      // Existence is re-checked on every call: callers construct the port
      // before the engine artifact is unpacked, so a construction-time check
      // would refuse a bundle that appears moments later.
      if (!existsSync(options.bundlePath)) {
        return { ok: false, reason: `engine bundle not found: ${options.bundlePath}` };
      }

      const spec: EngineSpawnSpec = {
        // In the headless the interpreter is the current Node binary; the
        // Electron shell will pass electron.exe plus ELECTRON_RUN_AS_NODE.
        exePath: process.execPath,
        // A complete environment: callers must not merge process.env again.
        // An inherited NODE_OPTIONS is intentionally replaced, not appended,
        // so the engine child is preloaded with the watchdog and nothing else.
        env: {
          ...environmentWithoutUndefined(),
          [ENGINE_HOME_ENV]: engineHome,
          NODE_OPTIONS: `--require "${watchdogPath}"`,
        },
        argvPrefix: [...ENGINE_ARGV_PREFIX],
        bundlePath: options.bundlePath,
        // The engine writes its default file tree and state under cwd, so cwd
        // must be the isolated userData directory.
        cwd: paths.userData,
        // stdout carries the "WebSocket:" line and stdin is the watchdog
        // signal, so both must be piped.
        stdio: "pipe",
        windowsHide: true,
        // No process group: the parent owns graceful stop and kill in B1.
        detached: false,
      };

      return { ok: true, spec };
    },
  };
}

/**
 * Resolve the engine home, creating a disposable one when omitted.
 */
async function resolveEngineHome(engineHome: string | undefined): Promise<string> {
  if (engineHome !== undefined) {
    return resolve(engineHome);
  }

  return mkdtemp(join(tmpdir(), TEMP_ENGINE_HOME_PREFIX));
}

/**
 * Resolve `paths.temp` and keep it inside `engineHome`.
 *
 * Isolation is a hard rule, not a preference: a token directory outside the
 * engine home would write a secret next to unrelated data and would let the
 * engine's default file tree escape too. Rejecting the input is louder than
 * quietly falling back, so the caller learns its configuration is wrong.
 */
function resolveTokenDir(engineHome: string, tokenDir: string | undefined): string {
  if (tokenDir === undefined) {
    return join(engineHome, TEMP_DIR);
  }

  const absolute = resolve(engineHome, tokenDir);
  const fromHome = relative(engineHome, absolute);

  if (fromHome.startsWith("..") || isAbsolute(fromHome)) {
    throw new Error(`tokenDir must stay inside engineHome: ${absolute} is outside ${engineHome}`);
  }

  return absolute;
}

/**
 * Absolute `NODE_OPTIONS` path of the watchdog, in the form Node can parse.
 *
 * Windows paths use forward slashes here because Node's NODE_OPTIONS parser
 * (measured on Node 24.22.3, Windows 10.0.19045) treats a backslash inside the
 * double quotes as an escape and strips it: `"C:\Users\..."` arrives as
 * `C:Users...` and the preload fails with MODULE_NOT_FOUND. A quoted path with
 * forward slashes - or with every backslash doubled - loads correctly, and both
 * forms keep the space-containing path as one argument. Forward slashes are
 * used because they are also valid absolute paths on Windows and need no
 * doubling, and because POSIX paths are already in that form.
 *
 * The result is absolute on both platforms. The quotes are what preserve
 * spaces; Node strips them from the parsed argument.
 */
function watchdogPathForNodeOptions(): string {
  const absolute = fileURLToPath(new URL(WATCHDOG_RELATIVE_PATH, import.meta.url));

  return process.platform === "win32" ? absolute.split("\\").join("/") : absolute;
}

/**
 * Copy `process.env` into the string-valued record the spawn spec requires.
 *
 * Spreading `process.env` directly would type each value as `string |
 * undefined`, which `Record<string, string>` does not accept; the entries Node
 * cannot represent are dropped. This mirrors what `spawn` does internally.
 */
function environmentWithoutUndefined(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}
