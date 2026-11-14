/**
 * The bootstrap error surface, driven for real.
 *
 * The requirement says the main-process error page must be visible when `app://`
 * serve. It was marked accepted, but `bootstrapErrorHtml` had no call site at
 * all: a failed launch printed to stderr and called `app.exit(1)`. A unit test of
 * the HTML string could not catch that, because the missing piece was the wiring,
 * not the string.
 *
 * The reproduction is the honest one: move the renderer bundle away, which is
 * exactly the accident (a broken build, a lost `dist/`) this surface exists for.
 * The shell then loads `app://haruyuki/index.html`, the protocol handler answers
 * 404, `loadURL` resolves -- and the window shows the failure page or nothing.
 *
 * What is asserted is what a user would care about: a window appeared, its body
 * has text, and the text names the failure. The exact markup is deliberately not
 * pinned; every wording change would otherwise be a test failure.
 *
 * The bundle is always put back, including on failure -- a probe that leaves a
 * broken build behind makes the next command fail for a reason nobody would guess.
 *
 * Exit codes: 0 the surface held, 1 it did not, 2 a build artifact is missing.
 */

import { spawn } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This script, and the repository root derived from it. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The Electron binary. */
const ELECTRON_BIN =
  process.platform === "win32"
    ? path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");

/** The built main process. */
const MAIN_ENTRY = path.join(REPO_ROOT, "apps", "desktop", "dist", "main", "main.cjs");

/** The probe this script drives. */
const PROBE = path.join(REPO_ROOT, "apps", "desktop", "dist", "probe", "bootstrap-probe.cjs");

/** The allow root's directory, moved away while the probe runs. */
const RENDERER = path.join(REPO_ROOT, "apps", "desktop", "dist", "renderer");

/** Where it is parked. */
const PARKED = path.join(REPO_ROOT, "apps", "desktop", "dist", "renderer.parked");

/** Ceiling for the whole run. The shell is meant to stay open, so it is ended. */
const TIMEOUT_MS = 45_000;

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
 * The environment to spawn with.
 *
 * `ELECTRON_RUN_AS_NODE` turns the binary into plain Node, so no window would
 * ever open and the failure would look like a hang. `NODE_OPTIONS` is inherited
 * from whatever shell launched us. Both change what the child does rather than
 * what it can do.
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

  return env;
}

/**
 * Run the probe and collect what it reported.
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
      settle({
        code: null,
        stdout,
        stderr: `${stderr}\nthe probe exceeded ${String(TIMEOUT_MS)} ms`,
      });
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
 * Read the probe's one machine-readable line.
 *
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
function parseResult(stdout) {
  const match = /^BOOTRESULT (.+)$/m.exec(stdout);

  if (match === null) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Drive the shell with its renderer moved away.
 *
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
async function runBroken() {
  return runProbe();
}

async function main() {
  process.stdout.write("verify-bootstrap-error\n");
  process.stdout.write(`electron: ${ELECTRON_BIN}\n\n`);

  for (const [label, file, build] of [
    ["the electron binary", ELECTRON_BIN, "pnpm --filter @haruyuki/desktop run setup:electron"],
    ["the main process bundle", MAIN_ENTRY, "pnpm --filter @haruyuki/desktop run build:main"],
    ["the bootstrap probe", PROBE, "pnpm --filter @haruyuki/desktop run build:probe"],
  ]) {
    if (!existsSync(file)) {
      process.stderr.write(`${label} is missing: ${file}\nrun: ${build}\n`);
      process.exit(2);
    }
  }

  if (!existsSync(RENDERER)) {
    process.stderr.write(`the renderer bundle is missing: ${RENDERER}\n`);
    process.exit(2);
  }

  let moved = false;

  try {
    renameSync(RENDERER, PARKED);
    moved = true;

    const run = await runBroken();
    const result = parseResult(run.stdout);

    if (result === null) {
      report("the failure page", false, `no BOOTRESULT line, exit ${String(run.code)}`);
      process.stderr.write(run.stderr.slice(0, 4000) + "\n");

      return 2;
    }

    report(
      "a window still appears",
      result.windowAppeared === true,
      result.windowAppeared === true ? "shown" : String(result.error ?? "no window"),
    );

    const text = typeof result.documentText === "string" ? result.documentText : "";

    report(
      "the document is the failure page, not a blank one",
      text.trim().length > 0,
      text.trim().length > 0 ? text.trim().split("\n")[0] : "the body is empty",
    );

    report(
      "the page names the failure",
      result.hasEvent === true,
      result.hasEvent === true ? "names an event code" : "no event code in the page",
    );

    const passed =
      result.windowAppeared === true && text.trim().length > 0 && result.hasEvent === true;

    return passed ? 0 : 1;
  } finally {
    if (moved && existsSync(PARKED)) renameSync(PARKED, RENDERER);
  }
}

const code = await main();

process.stdout.write(
  code === 0 ? "\nALL SURFACES PASSED\n" : "\nTHE FAILURE SURFACE DID NOT HOLD\n",
);
process.exit(code);
