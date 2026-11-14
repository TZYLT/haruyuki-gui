#!/usr/bin/env node
/**
 * verify-gui-host.mjs - one command that answers "can this machine run the shell at all".
 *
 * Written for a host other than the development machine, where Electron may or may not
 * start. It answers three questions in order and stops at the first "no", because each
 * later answer depends on the earlier one:
 *
 *   1. Does a bare Electron window open, and can it read its own DOM?
 *   2. Does *our* built shell open over `app://` under the real CSP?
 *   3. Does the preload bridge arrive in the renderer, and is the sandbox actually on?
 *
 * It deliberately does not need the engine artifact (510 MB) or the network. If stage 1
 * fails, nothing after it can pass, so a machine that cannot run Electron is identified
 * in about ten seconds.
 *
 * Exit codes: 0 all stages passed, 1 a stage failed, 2 an artifact is missing.
 *
 * Usage:
 *   node apps/desktop/scripts/verify-gui-host.mjs
 *   node apps/desktop/scripts/verify-gui-host.mjs --no-sandbox   (diagnostic only)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This script, and the repository root derived from it. */
const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..", "..", "..");

/** The Electron binary. */
const ELECTRON_BIN =
  process.platform === "win32"
    ? path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");

/** The built main process. */
const MAIN_ENTRY = path.join(REPO_ROOT, "apps", "desktop", "dist", "main", "main.cjs");

/** The probe this script drives, built alongside the shell. */
const PROBE = path.join(REPO_ROOT, "apps", "desktop", "dist", "probe", "gui-host-probe.cjs");

/** Per-stage ceiling. A stage that hangs is a failure, not a slow pass. */
const STAGE_TIMEOUT_MS = 45_000;

/** Extra flags passed through from the command line. */
const EXTRA_FLAGS = process.argv.slice(2).filter((arg) => arg.startsWith("--"));

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

/**
 * The environment to spawn with.
 *
 * Both variables would change what the child does rather than what it can do:
 * `ELECTRON_RUN_AS_NODE` turns the binary into plain Node (so no window ever opens and
 * the failure looks like a hang), and `NODE_OPTIONS` is inherited from whatever shell
 * launched us.
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

  env["HARUYUKI_GUI_MAIN"] = MAIN_ENTRY;

  return env;
}

/**
 * Run the probe once and collect what it managed to report.
 *
 * @param {string[]} args extra Electron flags
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runProbe(args) {
  return new Promise((resolve) => {
    const child = spawn(ELECTRON_BIN, [...args, PROBE], {
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
      settle({
        code: null,
        stdout,
        stderr: `${stderr}\nthe probe exceeded ${STAGE_TIMEOUT_MS} ms`,
      });
    }, STAGE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;

      // A load-time crash keeps Electron's message loop alive after printing, so waiting
      // for `close` would spend the whole timeout to learn something already known.
      if (/^App threw an error during load$/m.test(stderr) || /EXCEPTION_BREAKPOINT/.test(stderr)) {
        child.kill("SIGKILL");
        settle({ code: null, stdout, stderr });
      }
    });

    child.on("error", (error) => settle({ code: null, stdout, stderr: stderr + String(error) }));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

/**
 * Read the probe's one machine-readable line.
 *
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
function parseResult(stdout) {
  const match = /^GUIRESULT (.+)$/m.exec(stdout);

  if (match === null) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Drive the three stages.
 */
async function main() {
  process.stdout.write("verify-gui-host\n");
  process.stdout.write(`electron: ${ELECTRON_BIN}\n`);
  process.stdout.write(
    `flags:    ${EXTRA_FLAGS.length > 0 ? EXTRA_FLAGS.join(" ") : "(none)"}\n\n`,
  );

  for (const [label, file, build] of [
    ["the electron binary", ELECTRON_BIN, "pnpm --filter @haruyuki/desktop run setup:electron"],
    ["the main process bundle", MAIN_ENTRY, "pnpm --filter @haruyuki/desktop run build:main"],
    ["the gui host probe", PROBE, "pnpm --filter @haruyuki/desktop run build:probe"],
  ]) {
    if (!existsSync(file)) {
      process.stderr.write(`${label} is missing: ${file}\nrun: ${build}\n`);
      process.exit(2);
    }
  }

  const run = await runProbe(EXTRA_FLAGS);
  const result = parseResult(run.stdout);

  if (run.stderr.trim() !== "") {
    process.stdout.write("--- stderr ---\n");
    process.stdout.write(run.stderr.trim() + "\n\n");
  }

  if (result === null) {
    report("stage 1 (bare window)", false, `no GUIRESULT line, exit ${String(run.code)}`);

    fail(
      "The probe did not report anything. If the stderr above contains " +
        "EXCEPTION_BREAKPOINT or the exit code was 0x80000003, this machine cannot start " +
        "Electron's GPU process -- the same failure the development machine has.",
    );
  }

  // Stage 1: a window opened and its DOM was readable.
  report(
    "stage 1 (bare window)",
    result.bareWindow === true,
    result.bareWindow === true
      ? "opened and read its own DOM"
      : String(result.bareError ?? "failed"),
  );

  if (result.bareWindow !== true) {
    fail("Stage 1 failed, so the rest cannot be measured. The host cannot run Electron.");
  }

  // Stage 2: our built shell loaded over app:// under the real CSP.
  report(
    "stage 2 (app:// shell)",
    result.shellLoaded === true,
    result.shellLoaded === true
      ? `readyState=${String(result.readyState)} origin=${String(result.origin)}`
      : String(result.shellError ?? "failed"),
  );

  // Stage 3: the preload bridge arrived, and the renderer is actually sandboxed.
  report(
    "stage 3 (bridge + sandbox)",
    result.bridgePresent === true,
    result.bridgePresent === true
      ? `global=${String(result.bridgeGlobal)} members=${JSON.stringify(result.bridgeMembers)}`
      : String(result.bridgeError ?? "failed"),
  );

  report(
    "stage 3 (node absent)",
    result.nodeAbsent === true,
    result.nodeAbsent === true
      ? "window.require/process/module/Buffer are all undefined"
      : `leaked: ${JSON.stringify(result.nodeLeaks)}`,
  );

  // The title the shell set, which proves the main process reached its own startup path
  // rather than only creating a window.
  if (typeof result.title === "string") {
    report("stage 3 (window title)", result.title === "Haruyuki", `"${result.title}"`);
  }

  const allPassed =
    result.bareWindow === true &&
    result.shellLoaded === true &&
    result.bridgePresent === true &&
    result.nodeAbsent === true;

  process.stdout.write(
    `\n${allPassed ? "ALL STAGES PASSED" : "SOME STAGES FAILED"} on ${process.platform}\n`,
  );

  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
