#!/usr/bin/env node
/**
 * verify-host-port.mjs - the host-port assertions that need a real main process.
 *
 * The unit tests cover every failure path with the shell injected, which is the right
 * way to cover them. What they cannot cover is whether the *real* dependencies behave
 * as the injected ones claim, and this item's risk is exactly there: a path composed
 * correctly that the engine still cannot write into, a notification that throws on
 * construction, a dialog that is wired to the wrong call.
 *
 * What this script deliberately does not check, and why:
 *
 *   Notification *visibility* needs an installed Start Menu entry, which belongs to
 *   packaging (requirement T-3). Constructing one is all a machine can answer here.
 *
 *   The file dialog is never shown: waiting for a human to dismiss it is how a probe
 *   hangs. Reachability is the half that can be checked.
 *
 * Two launch details are load-bearing. `ELECTRON_RUN_AS_NODE` is stripped because it is
 * set in this session's environment, and leaving it makes the Electron binary behave as
 * plain Node -- `app` is then `undefined`, and the failure reads as a crash rather than
 * as a wrong environment. The report is read from a file because `app.exit` does not
 * drain piped stdout on Windows.
 *
 * Exit codes: 0 all assertions passed, 1 one failed, 2 an artifact is missing.
 *
 * Usage:
 *   node apps/desktop/scripts/verify-host-port.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This script, and the repository root derived from it. */
const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..", "..", "..");

/** The Electron binary for this platform. */
const ELECTRON_BIN =
  process.platform === "win32"
    ? path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");

/** The built probe and where it writes its report. */
const PROBE = path.join(REPO_ROOT, "apps", "desktop", "dist", "probe", "host-port-probe.cjs");
const OUT_FILE = path.join(REPO_ROOT, "apps", "desktop", "dist", "probe", "host-port-result.json");

/** Ceiling for the whole run. A hang is a failure, not a slow pass. */
const TIMEOUT_MS = 60_000;

/**
 * The environment to spawn with.
 *
 * @returns {Record<string, string>}
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

  env["HARUYUKI_D2_HOST_OUT"] = OUT_FILE;

  return env;
}

/**
 * Run the probe once.
 *
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runProbe() {
  return new Promise((resolve) => {
    const child = spawn(ELECTRON_BIN, [PROBE], {
      cwd: REPO_ROOT,
      env: childEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    /**
     * @param {{ code: number | null, stdout: string, stderr: string }} run
     */
    function settle(run) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ code: null, stdout, stderr: `${stderr}\nthe probe exceeded ${TIMEOUT_MS} ms` });
    }, TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => settle({ code: null, stdout, stderr: stderr + String(error) }));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

/**
 * Read the probe's machine-readable line.
 *
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function parseResult(text) {
  const match = /^HOSTRESULT (.+)$/m.exec(text);
  if (match === null) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Print a stage result.
 *
 * @param {string} label
 * @param {boolean} passed
 * @param {string} detail
 */
function report(label, passed, detail) {
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${label} ${detail}\n`);
}

/**
 * Print and exit.
 *
 * @param {string} message
 * @param {number} code
 */
function fail(message, code = 1) {
  process.stderr.write(`\n${message}\n`);
  process.exit(code);
}

/** Drive the probe and grade its report. */
async function main() {
  process.stdout.write("verify-host-port\n");
  process.stdout.write(`electron: ${ELECTRON_BIN}\n\n`);

  for (const [label, file, hint] of [
    ["the electron binary", ELECTRON_BIN, "pnpm --filter @haruyuki/desktop run setup:electron"],
    ["the probe bundle", PROBE, "pnpm --filter @haruyuki/desktop run build:probe"],
  ]) {
    if (!existsSync(file)) fail(`${label} is missing: ${file}\nrun: ${hint}`, 2);
  }

  rmSync(OUT_FILE, { force: true });

  const started = Date.now();
  const run = await runProbe();
  const elapsed = Date.now() - started;

  const fromFile = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : "";
  const result = parseResult(fromFile) ?? parseResult(run.stdout);

  if (result === null) {
    if (run.stderr.trim() !== "") {
      process.stderr.write("--- stderr ---\n");
      process.stderr.write(run.stderr.trim() + "\n");
    }
    fail(`the probe did not report; exit ${String(run.code)}`);
  }

  if (typeof result["fatal"] === "string") {
    fail(`the probe reported a fatal error: ${result["fatal"]}`);
  }

  /** @type {boolean[]} */
  const checks = [];

  /**
   * Record one graded check.
   *
   * @param {string} label
   * @param {boolean} passed
   * @param {string} detail
   */
  function check(label, passed, detail) {
    checks.push(passed);
    report(label, passed, detail);
  }

  // The application's own name, and the consequence that made it a security
  // question rather than a cosmetic one. Asserted as an exact tail rather than "not
  // Electron": another app's name would pass a negative check while still colliding.
  const appName = result["appName"];
  check("app name is the brand name", appName === "Haruyuki", String(appName));

  const userDataPath =
    typeof result["pathsResolved"] === "object" && result["pathsResolved"] !== null
      ? result["pathsResolved"]["userData"]
      : undefined;
  check(
    "userData ends in Haruyuki, not Electron",
    typeof userDataPath === "string" && /[\\/]Haruyuki$/.test(userDataPath),
    String(userDataPath),
  );

  // The switch that made this a security question: `media-access.json` must live in a
  // directory only this application uses, or another Electron app can flip it.
  const accessPath = result["mediaAccessPath"];
  check(
    "media-access.json is inside that directory",
    typeof accessPath === "string" &&
      typeof userDataPath === "string" &&
      accessPath.startsWith(userDataPath) &&
      !accessPath.includes("Electron"),
    String(accessPath),
  );

  // The four roots resolve, and the engine's home accepts a write.
  const resolved = result["pathsResolved"];
  check(
    "four roots resolve",
    typeof resolved === "object" && resolved !== null && Object.keys(resolved).length === 4,
    JSON.stringify(resolved),
  );
  // The real question is not "is the string right" but "can the engine write here".
  check(
    "userData accepts a write",
    result["pathsWritable"] === true,
    result["pathsWritable"] === true
      ? "wrote and removed a probe file"
      : String(result["pathsProblem"]),
  );

  // The capability constant, as the shell reports it.
  const capabilities = result["capabilities"];
  check(
    "capabilities match the constant",
    typeof capabilities === "object" &&
      capabilities !== null &&
      capabilities["canNotify"] === true &&
      capabilities["canReadDroppedFiles"] === true &&
      capabilities["canPopout"] === true &&
      capabilities["canFloatingWindow"] === false,
    JSON.stringify(capabilities),
  );

  // The spawn spec refuses a missing bundle and names it.
  check(
    "spawn spec refuses a missing bundle",
    result["spawnSpecOk"] === false && typeof result["spawnSpecReason"] === "string",
    String(result["spawnSpecReason"]),
  );

  // The positive half: cwd, exePath and the run-as-node flag, against a file that
  // really exists. A spec whose shape is right but whose env is wrong starts a second
  // Electron app instead of the engine.
  const cwd = result["spawnSpecCwd"];
  check(
    "cwd is userData, so the engine writes one tree",
    typeof cwd === "string" && cwd === resolved?.["userData"],
    `${String(cwd)} vs ${String(resolved?.["userData"])}`,
  );
  check(
    "exePath is this Electron binary",
    result["spawnSpecExeIsElectron"] === true,
    String(result["spawnSpecExeIsElectron"]),
  );
  check(
    "env carries ELECTRON_RUN_AS_NODE",
    result["spawnSpecEnvHasRunAsNode"] === true,
    String(result["spawnSpecEnvHasRunAsNode"]),
  );

  // A notification constructs without throwing. Visibility is packaging's job.
  check(
    "notification constructs",
    result["notifyConstructed"] === true,
    result["notifyConstructed"] === true ? "constructed, not shown" : String(result["notifyError"]),
  );

  // The scheme allow-list holds against the real platform, and an accepted URL
  // hands off.
  check(
    "openExternal refuses file:",
    result["openExternalRefused"] === true,
    String(result["openExternalRefused"]),
  );
  check(
    "openExternal accepts https:",
    result["openExternalAccepted"] === true,
    result["openExternalAccepted"] === true
      ? "handed to the OS"
      : String(result["openExternalError"]),
  );

  // The dialog is reachable but never shown.
  check(
    "pickPaths (dialog reachable)",
    result["dialogReachable"] === true,
    result["dialogReachable"] === true
      ? "not shown (would need a human)"
      : String(result["dialogError"]),
  );

  // Registration runs once, and a second quit runs nothing.
  check("shutdown ran once", result["shutdownRan"] === 1, String(result["shutdownRan"]));
  check(
    "second quit runs nothing",
    result["shutdownSecondRunIgnored"] === true,
    String(result["shutdownSecondRunIgnored"]),
  );

  const allPassed = checks.every(Boolean);

  process.stdout.write(
    `\n${allPassed ? "ALL HOST-PORT ASSERTIONS PASSED" : "SOME HOST-PORT ASSERTIONS FAILED"} on ${
      process.platform
    } (${String(elapsed)} ms)\n`,
  );

  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
