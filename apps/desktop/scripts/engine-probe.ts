/**
 * The engine smoke probe: the part of `smoke-engine.mjs` that runs inside Electron.
 *
 * `smoke-engine.mjs` launches the bundle this file produces with the Electron binary;
 * this file starts the real engine through `@haruyuki/core` and prints one
 * `RESULT <json>` line.
 *
 * Why the probe runs inside Electron rather than under plain Node: the assertion is
 * "the engine starts from the shell's own code, in the shell's own process". Running it
 * under Node would test the engine and skip the shell, which is the half that breaks.
 *
 * Two facts about this environment that the code has to survive:
 *
 *   `ELECTRON_RUN_AS_NODE=1` is set globally on this machine. Inherited, it turns the
 *   binary into plain Node and `app.whenReady()` never resolves -- the failure looks
 *   like a hang, not an error. `smoke-engine.mjs` removes it before spawning.
 *
 *   The Electron binary doubles as the Node binary for the engine child. Setting the
 *   variable on the child only is how the real host launches the engine, so the smoke
 *   test needs no second runtime installed.
 */

import { app } from "electron";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Engine } from "@haruyuki/core";
import type { EngineSpawnSpec } from "@haruyuki/core";

/**
 * A `require` anchored at `packages/core`, injected by the build.
 *
 * `@haruyuki/core` loads `ws` through `createRequire(import.meta.url)` relative to its
 * own module -- which works when core is bundled, because the bundle inherits core's
 * inline copy and its own `import.meta.url` points at the bundle. pnpm's strict layout
 * still puts `ws` under `packages/core/node_modules`, so the bundle's location cannot
 * resolve it by name. Anchoring a require at the package that declares `ws` makes the
 * bundle location-independent.
 *
 * Declared here because the build replaces it with a literal string.
 */
declare const __WS_REQUIRE_FROM__: string;

/**
 * Warm `ws` through the anchored require before core's lazy loader runs.
 *
 * Core resolves `ws` at module load, so this has to happen before the import above is
 * evaluated -- which the bundler's hoisting makes impossible to guarantee from inside a
 * function. The workaround is that core's `createRequire` falls back to Node's own
 * resolution from the bundle, and Node's resolution walks up from
 * `apps/desktop/dist/probe/` to `apps/desktop/node_modules`, then the workspace root,
 * where the pnpm store link for `ws` exists. That is enough on this layout; the anchored
 * require below is the assertion that it worked.
 */
const coreRequire = createRequire(__WS_REQUIRE_FROM__);

/** Where the caller said the engine bundle and repository root are. */
const BUNDLE_PATH = process.env["HARUYUKI_SMOKE_BUNDLE"];
const REPO_ROOT = process.env["HARUYUKI_SMOKE_ROOT"];

/** What the probe reports back. */
interface ProbeResult {
  ready: boolean;
  port?: number;
  portMs?: number;
  protocolVersion?: number;
  engineVersion?: string;
  capabilities?: string[];
  stopped?: boolean;
  stopMs?: number;
  state?: string;
  error?: string;
}

/**
 * Print the result line and quit.
 *
 * `app.exit` rather than `app.quit`: `quit` runs the full teardown and can be delayed
 * by a window or a protocol handler, and this process has neither.
 *
 * @param result what to report
 * @param code process exit code
 */
function report(result: ProbeResult, code: number): never {
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  app.exit(code);

  // `app.exit` does not return; TypeScript cannot know that.
  throw new Error("unreachable");
}

/**
 * The spawn spec for the engine, matching what the host uses.
 *
 * @param root repository root
 * @param bundle the engine's entry file
 */
function spawnSpec(root: string, bundle: string): EngineSpawnSpec {
  return {
    exePath: process.execPath,
    bundlePath: bundle,
    argvPrefix: ["server"],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: "pipe",
    windowsHide: true,
    detached: false,
  };
}

/**
 * Run the probe.
 */
async function main(): Promise<void> {
  if (BUNDLE_PATH === undefined || REPO_ROOT === undefined) {
    report({ ready: false, error: "HARUYUKI_SMOKE_BUNDLE and HARUYUKI_SMOKE_ROOT must be set" }, 1);
  }

  // `ws` must be resolvable before anything tries to start an engine, because core
  // resolves it eagerly at module load. Asserting it here turns the otherwise invisible
  // "the bundle cannot see a dependency of the package it bundled" into a named failure.
  try {
    coreRequire("ws");
  } catch (error) {
    report(
      {
        ready: false,
        error: `cannot resolve ws from packages/core: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      1,
    );
  }

  // A fresh token directory per run. A shared one would let a stale token from an
  // earlier run satisfy a later handshake, which is the failure the token file exists to
  // prevent.
  const tokenDir = await mkdtemp(path.join(tmpdir(), "haruyuki-smoke-"));
  const engine = new Engine();

  try {
    const startedAt = Date.now();
    const info = await engine.start({
      spawnSpec: spawnSpec(REPO_ROOT, BUNDLE_PATH),
      tokenDir,
      expectedEngineVersion: "0.6.0",
    });
    const portMs = Date.now() - startedAt;

    const url = engine.url;

    if (typeof url !== "string" || url === "") {
      report({ ready: true, error: "the facade reported ready with no url" }, 1);
    }

    const port = Number(new URL(url).port);
    const capabilities = Object.keys(info.capabilities ?? {});

    const stopAt = Date.now();

    await engine.stop();

    const stopMs = Date.now() - stopAt;

    // `stopped` is about the state transition, not the signal: a child that ignored
    // SIGTERM and was killed still reached the terminal state, and that is what the
    // assertion is for.
    const stopped = engine.state === "stopped" || engine.state === "idle";

    report(
      {
        ready: true,
        port,
        portMs,
        protocolVersion: info.protocolVersion,
        engineVersion: info.engineVersion,
        capabilities,
        stopped,
        stopMs,
        state: engine.state,
      },
      0,
    );
  } catch (error) {
    report(
      {
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        state: engine.state,
      },
      1,
    );
  } finally {
    // Pointwise: the directory this run made, by exact path.
    await rm(tokenDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

void app.whenReady().then(main);
