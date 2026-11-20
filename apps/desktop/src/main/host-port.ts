/**
 * The desktop host port, implemented against a real Electron main process.
 *
 * The shape is not defined here. `packages/core/src/port/host-port.ts` is the
 * only definition (a test asserts it does not change), and the headless
 * implementation in `headless-host-port.ts` is the reference for semantics. What
 * this file adds is the Electron half of each member and, in every case, the
 * failure path.
 *
 * Three properties hold for every member that returns a promise, because the
 * contract says so and a consumer is allowed to rely on it:
 *
 *   It is `async` even when the answer is already known. A synchronous `return`
 *   would change the timing of every caller's error handling.
 *
 *   Failures are values, not throws. The frozen unions carry a code; throwing
 *   would force every caller to wrap the call and would lose the code.
 *
 *   A resolved success is not a promise that something happened. `notify` with
 *   `canNotify: false` resolves having done nothing, which is the contract.
 *
 * Two members are synchronous on purpose -- `capabilities`, `paths` and the
 * registration half of `onShutdown`. They are read during startup, before any
 * await can run, so making them async would make the port unusable where it is
 * needed first.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { EngineSpawnSpec } from "@haruyuki/core";
import type { HostPort } from "@haruyuki/core";

/** The environment variable the engine reads to isolate its own state. */
export const ENGINE_HOME_ENV = "HARUYUKI_HOME";

/**
 * Where the watchdog sits relative to the engine bundle.
 *
 * It is resolved against `app.getAppPath()` rather than against this module's
 * `__dirname`: the main bundle is built into `dist/main/`, while the watchdog
 * ships beside the engine bundle. Anchoring at `__dirname` would produce a path
 * inside `dist` that only exists in development.
 */
export const WATCHDOG_RELATIVE_PATH = "runtime/watchdog.cjs";

/** What the desktop shell can do. Desktop answers true to the first three. */
export const DESKTOP_CAPABILITIES: HostPort["capabilities"] = Object.freeze({
  // Electron has `Notification`. Whether a toast is *visible* depends on the
  // app having a Start Menu entry, which belongs to packaging (requirement T-3).
  canNotify: true,
  // Drag-drag exposes a path through `webUtils.getPathForFile` in a sandboxed
  // preload. Probed, not assumed: see the probe notes for the exact result,
  // including that a path can legitimately be the empty string.
  canReadDroppedFiles: true,
  // Popping a panel into its own window is a `BrowserWindow`, which exists.
  canPopout: true,
  // A floating/pinned window is a design decision this item does not make: the
  // difference from `canPopout` is not defined yet (requirement T-4), and
  // answering true would claim a capability nobody has specified.
  canFloatingWindow: false,
});

/** Everything the port needs that only the shell can answer. */
export interface DesktopHostPortOptions {
  /**
   * Absolute path of the engine JS bundle, from the runtime layout.
   *
   * Passed in rather than discovered: the runtime layout is `G1`'s decision
   * (`extraResources` vs asar), and a port that guessed would be a second,
   * disagreeing copy of it.
   */
  readonly bundlePath: string;
  /**
   * Absolute real path of the watchdog, from the runtime layout.
   *
   * Optional only for the existing dev callers: when absent, the D2 fallback
   * `watchdogFor(appPath)` is used. The packaged shell passes the layout's
   * `watchdogPath`, which is outside app.asar.
   */
  readonly watchdogPath?: string;
  /**
   * Extra roots the user has authorised for local resource display.
   *
   * The readable set is `cwd` ∪ user-picked ∪ user-dropped; the caller owns the
   * last two because it sees the picker and the drop. This member makes that set
   * injectable instead of having the port infer it.
   */
  readonly readableRoots?: readonly string[];
}

/**
 * The four directory roots, from Electron's own answers.
 *
 * `cache` is the interesting one: `app.getPath` has no `cache` name (electron.d.ts
 * `getPath` union), and calling it throws at runtime. It is therefore composed
 * under `userData`, which keeps it inside the engine's home and disposable
 * alongside it.
 *
 * @param getPath `app.getPath`, injected so a test can answer without Electron
 */
export function desktopPaths(getPath: (name: string) => string): HostPort["paths"] {
  const userData = getPath("userData");

  return {
    userData,
    // The engine's log location. `D1` already decided this resolves through
    // `app.getPath("logs")`; going through the same call keeps one answer.
    logs: getPath("logs"),
    cache: path.join(userData, "cache"),
    temp: getPath("temp"),
  };
}

/**
 * Build the complete environment for the engine child.
 *
 * Two rules, both load-bearing:
 *
 *   The record is complete. The contract says callers must not merge
 *   `process.env` again, so anything missing here is missing in the child. A
 *   forgotten `PATH` shows up as an engine that cannot be found on POSIX.
 *
 *   `NODE_OPTIONS` is replaced, not appended. An inherited value would either
 *   double up the watchdog or carry flags the engine child must not have; the
 *   only preload it should get is ours.
 *
 * @param base the process environment to copy
 * @param watchdogPath absolute path of the watchdog script
 * @param userData the engine home
 */
export function engineEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  watchdogPath: string,
  userData: string,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }

  // Electron would otherwise start normally in the child: the bundle is a plain
  // Node program, and without this flag the child is a second copy of the shell
  // with no window and no server.
  env["ELECTRON_RUN_AS_NODE"] = "1";

  // The engine home, which is also `cwd`, so the engine writes one tree.
  env[ENGINE_HOME_ENV] = userData;

  // PTY children inherit the engine's environment and readline/terminfo key off
  // TERM; under `dumb` a clear-screen does not even clear the viewport.
  if (base.TERM === undefined || base.TERM === "" || base.TERM === "dumb") {
    env["TERM"] = "xterm-256color";
  }

  env["NODE_OPTIONS"] = `--require "${watchdogPath}"`;

  return env;
}

/**
 * Build the spawn spec, or explain why it cannot be built.
 *
 * The refusal is a value rather than a throw for the reason in the contract:
 * the caller classifies it as SPAWN_FAILED and shows the reason verbatim, and a
 * thrown string would arrive without a code.
 *
 * Existence is checked on every call, not at construction: a caller may
 * construct the port before the engine artifact is unpacked, and refusing once
 * at startup would make a bundle that appears moments later unusable.
 *
 * Every shell answer is injected rather than imported: `app.getAppPath()` and
 * the filesystem are the two things a unit test cannot provide, and reaching for
 * them inside this function would make the whole spec untestable outside a real
 * Electron process.
 *
 * @param options the port's options
 * @param paths the four roots
 * @param exists injected so a test can answer without touching the disk
 * @param appPath injected so a test can answer without Electron
 */
export async function buildSpawnSpec(
  options: DesktopHostPortOptions,
  paths: HostPort["paths"],
  exists: (candidate: string) => boolean,
  appPath: string,
): Promise<{ ok: true; spec: EngineSpawnSpec } | { ok: false; reason: string }> {
  const bundlePath = options.bundlePath;

  // An absolute path is required: a relative one resolves against the host's cwd
  // here but against `paths.userData` in the child, so it would look valid and
  // then fail at spawn with an ENOENT nobody can explain.
  if (!path.isAbsolute(bundlePath)) {
    return { ok: false, reason: `engine bundle path must be absolute: ${bundlePath}` };
  }

  if (!exists(bundlePath)) {
    return { ok: false, reason: `engine bundle not found: ${bundlePath}` };
  }

  const watchdogPath = options.watchdogPath ?? watchdogFor(appPath);

  if (!path.isAbsolute(watchdogPath)) {
    return { ok: false, reason: `watchdog path must be absolute: ${watchdogPath}` };
  }

  if (!exists(watchdogPath)) {
    return { ok: false, reason: `watchdog not found: ${watchdogPath}` };
  }

  // `NODE_OPTIONS` is a command line. A Windows backslash in the path is an
  // escape there, which is why the D2 helper already converts the fallback.
  const watchdogForNodeOptions =
    process.platform === "win32" ? watchdogPath.split("\\").join("/") : watchdogPath;

  return {
    ok: true,
    spec: {
      // The Electron binary, run as Node. `process.execPath` is `electron.exe`
      // when this code runs inside Electron, which is exactly what the engine
      // must be started with -- but only if the environment above says so.
      exePath: process.execPath,
      env: engineEnvironment(process.env, watchdogForNodeOptions, paths.userData),
      // `--ws-token-file` is the option NAME; `Engine.start` appends the path.
      argvPrefix: [
        "server",
        "--listen",
        "ws://127.0.0.1:0",
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
      ],
      bundlePath,
      // The engine writes its default tree under cwd, so cwd is the isolated home.
      cwd: paths.userData,
      // stdout carries the "WebSocket:" line; stdin is the watchdog signal.
      stdio: "pipe",
      // No console window on Windows. A black window flashing on every launch is
      // a defect users report, not a cosmetic detail.
      windowsHide: true,
      // POSIX gets its own process group so the stop path can signal the whole
      // group; Windows has no such thing and uses `taskkill /T /F` instead.
      detached: process.platform !== "win32",
    },
  };
}

/**
 * Absolute path of the watchdog script.
 *
 * Forward slashes on Windows: `NODE_OPTIONS` is parsed as a command line, and
 * backslashes are escape characters there. The quotes around the value are what
 * preserve spaces in the path.
 *
 * @param appPath `app.getAppPath()`
 */
export function watchdogFor(appPath: string): string {
  const absolute = path.resolve(appPath, WATCHDOG_RELATIVE_PATH);

  return process.platform === "win32" ? absolute.split("\\").join("/") : absolute;
}

/**
 * Create the four roots before anything uses them.
 *
 * Idempotent, and tolerant of an existing directory with different permissions:
 * the point is that the engine can write, not that this process created them.
 *
 * @param paths the four roots
 */
export async function ensurePaths(paths: HostPort["paths"]): Promise<void> {
  await Promise.all(
    [paths.userData, paths.logs, paths.cache, paths.temp].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
}
