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
  portMs?: number;
  protocolVersion?: number;
  engineVersion?: string;
  backend?: string;
  socketState?: string;
  degradationCount?: number;
  stopped?: boolean;
  stopMs?: number;
  state?: string;
  error?: string;
}

/**
 * Thrown by {@link report} to stop the calling code.
 *
 * A sentinel rather than a control-flow trick: `report` must not return, because every
 * call site has more work after it that must not run (starting an engine with no bundle
 * path, for instance). Throwing is how the function stays total while letting the exit
 * happen on the next tick, after stdout has flushed.
 */
class Reported extends Error {
  constructor() {
    super("reported");
    this.name = "Reported";
  }
}

/**
 * Print the result line and quit.
 *
 * The write is flushed before `app.exit`. `app.exit` terminates the process immediately --
 * it does not run the event loop's exit handlers -- so a `process.stdout.write` that has
 * not reached the pipe is simply lost. That produced a probe which did all its work,
 * exited 0 and printed nothing, which reads exactly like a crash.
 *
 * `app.quit()` is not the alternative: it runs full teardown, which this process has none
 * of and which a message loop it does not need can delay.
 *
 * @param result what to report
 * @param code process exit code
 * @throws {Reported} always, so the caller's remaining work does not run
 */
function report(result: ProbeResult, code: number): never {
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`, () => {
    // The callback runs once the chunk is handed to the OS, which is the point at which
    // exiting stops losing it.
    app.exit(code);
  });

  throw new Reported();
}

/**
 * The spawn spec for the engine, matching what the host uses.
 *
 * The `argvPrefix` contract (from `packages/core/src/engine/engine.ts`): it carries
 * `server` plus the engine options, and it **ends with the `--ws-token-file` option name**
 * -- `Engine.start` appends the token file's PATH as the next element, so the secret never
 * reaches argv.
 *
 * `--ws-auth capability-token` is required, not optional: with only `--ws-token-file` the
 * engine exits with "websocket auth flags require `--ws-auth capability-token`". The first
 * version of this probe omitted it, which is why the engine produced no stdout at all.
 *
 * @param root repository root
 * @param bundle the engine's entry file
 */
function spawnSpec(root: string, bundle: string): EngineSpawnSpec {
  return {
    exePath: process.execPath,
    bundlePath: bundle,
    argvPrefix: ["server", "--ws-auth", "capability-token", "--ws-token-file"],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      // The Electron binary doubles as Node when this is set. It is set on the child only,
      // which is how the real host launches the engine -- this process must NOT have it,
      // or the shell would be running as plain Node.
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: "pipe",
    windowsHide: true,
    detached: false,
  };
}

/**
 * Run the probe.
 *
 * The `Reported` sentinel unwinds out of here; anything else reaching the top is a real
 * failure that has not been reported yet, so it is turned into one.
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

    // The facade exposes no `url` accessor: the URL is discovered internally and handed to
    // the socket. What it does expose is `appServerInfo`, which is what the handshake
    // reported. So the assertions are built from that plus the state, not from a URL this
    // process would have to re-derive.
    const socketState = engine.socketState;
    const degradations = engine.degradations;

    const stopAt = Date.now();

    // `stopGraceful`, not `stop`: the facade's name for the orderly path, and the one that
    // returns a promise. `kill` is the terminal alternative and is not what is being
    // for -- the assertion is that a graceful stop works.
    await engine.stopGraceful();

    const stopMs = Date.now() - stopAt;

    // `closed` is the terminal state after a graceful stop -- the state list is
    // `idle | spawning | handshaking | ready | closing | closed | failed`, and there is no
    // `stopped`. Asserting `stopped` was asserting a state the facade never had.
    const stopped = engine.state === "closed";

    report(
      {
        ready: true,
        portMs,
        protocolVersion: info.protocolVersion,
        engineVersion: info.engineVersion,
        backend: info.backend,
        socketState,
        degradationCount: degradations.length,
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

void app
  .whenReady()
  .then(main)
  .catch((error: unknown) => {
    // `Reported` means a result was already written; the exit is scheduled and this catch
    // has nothing to add. Anything else is an unreported failure, which still has to produce
    // a RESULT line or the caller sees a silent exit.
    if (error instanceof Reported) return;

    process.stdout.write(
      `RESULT ${JSON.stringify({
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
      () => app.exit(1),
    );
  });
