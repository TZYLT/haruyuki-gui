#!/usr/bin/env node
/**
 * smoke-engine.mjs - does the real engine start and answer over the shell's own code?
 *
 * Scope: three of the five assertions:
 *
 *   - the engine reaches `ready` through `@haruyuki/core`, in a real Electron main
 *     process, not through the acceptance script's own copy of the logic
 *   - the handshake reports `protocol_version = 1` and an engine version
 *   - the process stops gracefully and the child is gone afterwards
 *
 * Note on what is NOT asserted: the requirement's wording mentions a "capability set",
 * and `AppServerInfo` has no such field -- it carries `protocolVersion`, `engineVersion`,
 * `backend` and `raw`. The assertion follows the type rather than the prose. If a
 * capability set is genuinely part of the contract, it belongs in `AppServerInfo` and
 * that is a change to `@haruyuki/core`, not to this script.
 *
 * Exit codes: 0 pass, 1 fail, 2 engine artifact missing (the same split the acceptance
 * script uses, so CI can tell "broken" from "not fetched").
 *
 * Why this is not part of `pnpm verify` (D1-Q33): it needs a 358 MB Electron binary,
 * a downloaded engine package and a real window server session. `verify` has to run in
 * 60 s on a machine with none of those.
 *
 * The environment trap this script exists to survive: this machine sets
 * `ELECTRON_RUN_AS_NODE=1` globally. With that inherited, `electron` silently runs as
 * plain Node, `app.whenReady()` is never reached, and the failure presents as a hang
 * rather than as an error. The variable is removed here before spawning.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This script, and the repository root derived from it -- never from cwd.
 *
 * Three levels up, not two: this file lives in `apps/desktop/scripts/`, so `..` is the
 * desktop package, `../..` is `apps`, and `../../..` is the repository. Getting this
 * wrong is silent -- the paths simply do not resolve, and the failure reads as "the
 * artifact is missing" rather than "the root is wrong".
 */
const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..", "..", "..");

/** The unpacked engine produced by scripts/engine/fetch-engine.mjs. */
const BUNDLE_PATH = path.join(REPO_ROOT, "_research", "engine-0.6.0", "package", "haruyuki.js");

/** The Electron binary the shell is launched with. */
const ELECTRON_BIN = path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe");

/** The probe that actually runs inside Electron's main process. */
const PROBE_PATH = path.join(REPO_ROOT, "apps", "desktop", "dist", "probe", "engine-probe.cjs");

/** Total budget. `start` allows 10 s for the port and 5 s for the handshake, plus the
 * engine's own boot; 60 s is generous without hiding a hang. */
const TIMEOUT_MS = 60_000;

/** Human-readable hint for the missing-artifact exit code. */
const FETCH_HINT = "node scripts/engine/fetch-engine.mjs";

/**
 * Print a failure and exit 1.
 *
 * @param {string} message what went wrong
 */
function fail(message) {
  process.stderr.write(`FAIL ${message}\n`);
  process.exit(1);
}

/**
 * Print one passing assertion.
 *
 * @param {string} label the assertion's identifier
 * @param {string} detail measured evidence
 */
function pass(label, detail) {
  process.stdout.write(`PASS ${label} ${detail}\n`);
}

/**
 * Check the artifacts this script needs, and exit 2 if one is absent.
 */
function requireArtifacts() {
  if (!existsSync(BUNDLE_PATH)) {
    process.stderr.write(`the engine artifact is missing: ${BUNDLE_PATH}\n`);
    process.stderr.write(`run: ${FETCH_HINT}\n`);
    process.exit(2);
  }

  if (!existsSync(ELECTRON_BIN)) {
    process.stderr.write(`the electron binary is missing: ${ELECTRON_BIN}\n`);
    process.stderr.write("run: pnpm --filter @haruyuki/desktop run setup:electron\n");
    process.exit(2);
  }

  // The probe is a build product. Checking it here turns "the bundle is stale or was
  // never built" into a named exit code instead of a confusing "no RESULT line".
  if (!existsSync(PROBE_PATH)) {
    process.stderr.write(`the probe bundle is missing: ${PROBE_PATH}\n`);
    process.stderr.write("run: pnpm --filter @haruyuki/desktop run build:probe\n");
    process.exit(2);
  }
}

/**
 * Remove the two variables that would change what the child does.
 *
 * `ELECTRON_RUN_AS_NODE` turns the binary into plain Node. `NODE_OPTIONS` is inherited
 * from whatever shell started us and can inject a `--require` the probe did not ask
 * for. Neither is a legitimate part of this test's environment.
 *
 * @returns {Record<string, string>} the environment to spawn with
 */
function childEnv() {
  /** @type {Record<string, string>} */
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "ELECTRON_RUN_AS_NODE") continue;
    if (key === "NODE_OPTIONS") continue;
    env[key] = value;
  }

  env["HARUYUKI_SMOKE_BUNDLE"] = BUNDLE_PATH;
  env["HARUYUKI_SMOKE_ROOT"] = REPO_ROOT;

  return env;
}

/**
 * The probe's output. Collected rather than streamed because every assertion needs the
 * whole run, and a partially interleaved stdout/stderr is harder to read than two
 * coherent blocks.
 *
 * @typedef {{ code: number | null, stdout: string, stderr: string }} ProbeRun
 */

/** How a `protocol.handle` style load failure announces itself on stderr. */
const MODULE_LOAD_FAILURE = /^App threw an error during load$/m;

/** Appended when the wait is cut short rather than allowed to time out. */
const FAILED_DURING_LOAD =
  "\nThe probe crashed while loading. This is a build or dependency problem, not a " +
  "timeout: read the stack above instead of waiting for one.\n";

/**
 * Run the Electron-hosted probe and collect its output.
 *
 * Two ways out: the child exits, or its stderr shows a load-time crash. The second
 * exists because Electron prints a module-load error and then keeps its message loop
 * alive, so waiting for `close` would spend the whole timeout to report something that
 * was already known after 200 ms.
 *
 * @returns {Promise<ProbeRun>}
 */
function runProbe() {
  return new Promise((resolve) => {
    const child = spawn(ELECTRON_BIN, [PROBE_PATH], {
      cwd: REPO_ROOT,
      env: childEnv(),
      // `windowsHide` so a CI run does not flash a window; the probe opens none, but
      // Chromium still creates a hidden message window.
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    /**
     * Resolve once, whichever signal arrives first.
     *
     * @param {ProbeRun} run
     */
    function settle(run) {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      resolve(run);
    }

    const timer = setTimeout(() => {
      // A hang is the expected shape of an `ELECTRON_RUN_AS_NODE` regression, so the
      // timeout message names that possibility rather than only reporting a timeout.
      child.kill("SIGKILL");
      settle({
        code: null,
        stdout,
        stderr:
          stderr +
          `\nprobe did not finish within ${TIMEOUT_MS} ms. ` +
          "If it produced no output at all, check that ELECTRON_RUN_AS_NODE is not set.\n",
      });
    }, TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;

      if (MODULE_LOAD_FAILURE.test(stderr)) {
        child.kill("SIGKILL");
        settle({ code: null, stdout, stderr: stderr + FAILED_DURING_LOAD });
      }
    });

    child.on("error", (error) => {
      settle({ code: null, stdout, stderr: stderr + String(error) });
    });

    child.on("close", (code) => {
      settle({ code, stdout, stderr });
    });
  });
}

/**
 * Parse the probe's one machine-readable line.
 *
 * The probe prints a single `RESULT <json>` line. Anything else it printed is passed
 * through to this script's stderr so a failure is debuggable without rerunning.
 *
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
function parseResult(stdout) {
  const match = /^RESULT (.+)$/m.exec(stdout);

  if (match === null) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * The entry point.
 */
async function main() {
  requireArtifacts();

  const run = await runProbe();

  if (run.stderr.trim() !== "") process.stderr.write(run.stderr);

  const result = parseResult(run.stdout);

  if (result === null) {
    fail(`the probe produced no RESULT line (exit ${String(run.code)})`);
  }

  // The engine reached ready through the product's own facade.
  if (result.ready !== true) {
    fail(`the engine did not reach ready: ${JSON.stringify(result.error ?? result.state)}`);
  }

  // The facade exposes no `url` accessor -- discovery happens internally and the URL
  // goes straight to the socket. So the timing is what this assertion can cover: it
  // measures `start()` returning, which is the definition of ready (socket open AND
  // `app_server_info` answered, per engine.ts).
  if (typeof result.portMs !== "number" || result.portMs <= 0) {
    fail(`the ready timing was not measured: ${JSON.stringify(result.portMs)}`);
  }

  if (result.socketState !== "open") {
    fail(`the socket state is ${JSON.stringify(result.socketState)}, expected open`);
  }

  pass("engine reaches ready", `ready in ${result.portMs} ms, socketState=open`);

  // The handshake facts.
  if (result.protocolVersion !== 1) {
    fail(`protocol_version is ${JSON.stringify(result.protocolVersion)}, expected 1`);
  }

  if (typeof result.engineVersion !== "string" || result.engineVersion === "") {
    fail(`engineVersion is ${JSON.stringify(result.engineVersion)}`);
  }

  pass(
    "handshake facts",
    `protocol_version=1 engine=${result.engineVersion} backend=${String(result.backend)} degradations=${String(
      result.degradationCount,
    )}`,
  );

  // The process stopped and the child is gone.
  if (result.stopped !== true) {
    fail(`the engine did not stop cleanly: state=${JSON.stringify(result.state)}`);
  }

  pass("graceful stop", `stopped gracefully in ${String(result.stopMs)} ms`);

  process.stdout.write("smoke-engine: 3 of 3 assertions passed\n");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
