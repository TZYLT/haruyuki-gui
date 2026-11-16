#!/usr/bin/env node
/**
 * verify-media.mjs - the media channel's assertions that need a real renderer.
 *
 * Three questions cannot be answered from Node, because they are about what the
 * browser does with the main process's decision:
 *
 *   - does a `.txt` served as `text/plain` arrive as plain text?
 *   - does an `.html` served as `text/plain` refuse to execute its script?
 *   - does a 27 MB image stream without stalling the main process?
 *
 * Everything else in this item is unit-tested; this script exists so those three
 * are measured rather than argued from the type table.
 *
 * Two launch details are not incidental:
 *
 *   `ELECTRON_RUN_AS_NODE` is stripped. It is set in this session's environment,
 *   and leaving it would turn the Electron binary into plain Node -- no window ever
 *   opens and the failure presents as a hang.
 *
 *   The report is read from a file, not from stdout. `app.exit` does not drain
 *   piped stdout on Windows, and a probe that exits before its report is written is
 *   a probe that reported nothing.
 *
 * Exit codes: 0 all assertions passed, 1 one failed, 2 an artifact is missing.
 *
 * Usage:
 *   node apps/desktop/scripts/verify-media.mjs
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

/** The built probe, the preload it needs, and where it writes its report. */
const PROBE = path.join(REPO_ROOT, "apps", "desktop", "dist", "probe", "media-probe.cjs");
const PRELOAD = path.join(REPO_ROOT, "apps", "desktop", "dist", "main", "preload.cjs");
const OUT_FILE = path.join(REPO_ROOT, "apps", "desktop", "dist", "probe", "media-result.json");
const TRACE_FILE = path.join(REPO_ROOT, "apps", "desktop", "dist", "probe", "media-trace.log");

/** Per-stage ceiling. A stage that hangs is a failure, not a slow pass. */
const TIMEOUT_MS = 120_000;

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
    // Left in place these two would change what the child *is*: the first turns
    // Electron into plain Node, the second is inherited from whatever shell
    // launched us and can carry flags Electron rejects.
    if (key === "ELECTRON_RUN_AS_NODE") continue;
    if (key === "NODE_OPTIONS") continue;
    env[key] = value;
  }

  env["HARUYUKI_D2_PRELOAD"] = PRELOAD;
  env["HARUYUKI_D2_MEDIA_OUT"] = OUT_FILE;
  env["HARUYUKI_D2_TRACE"] = TRACE_FILE;

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

    /** @param {{ code: number | null, stdout: string, stderr: string }} run */
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
 * Read the probe's one machine-readable line from a file or from stdout.
 *
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function parseResult(text) {
  const match = /^MEDIARESULT (.+)$/m.exec(text);
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

/** Print and exit. */
function fail(message, code = 1) {
  process.stderr.write(`\n${message}\n`);
  process.exit(code);
}

/** Drive the probe and grade its report. */
async function main() {
  process.stdout.write("verify-media\n");
  process.stdout.write(`electron: ${ELECTRON_BIN}\n\n`);

  for (const [label, file, hint] of [
    ["the electron binary", ELECTRON_BIN, "pnpm --filter @haruyuki/desktop run setup:electron"],
    ["the probe bundle", PROBE, "pnpm --filter @haruyuki/desktop run build:probe"],
    ["the shell preload", PRELOAD, "pnpm --filter @haruyuki/desktop run build:main"],
  ]) {
    if (!existsSync(file)) fail(`${label} is missing: ${file}\nrun: ${hint}`, 2);
  }

  rmSync(OUT_FILE, { force: true });
  rmSync(TRACE_FILE, { force: true });

  const started = Date.now();
  const run = await runProbe();
  const elapsed = Date.now() - started;

  const fromFile = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : "";
  const result = parseResult(fromFile) ?? parseResult(run.stdout);

  if (result === null) {
    if (existsSync(TRACE_FILE)) {
      process.stderr.write("--- trace ---\n");
      process.stderr.write(readFileSync(TRACE_FILE, "utf8").trim() + "\n");
    }
    if (run.stderr.trim() !== "") {
      process.stderr.write("--- stderr ---\n");
      process.stderr.write(run.stderr.trim() + "\n");
    }
    fail(`the probe did not report; exit ${String(run.code)}`);
  }

  if (typeof result["fatal"] === "string") {
    fail(`the probe reported a fatal error: ${result["fatal"]}`);
  }

  // A text file arrives as a plain-text document, not a rendered one.
  const textType = result["textContentType"];
  report(
    "text arrives as text",
    textType === "text/plain",
    `document.contentType=${String(textType)}`,
  );

  // The security claim the channel rests on.
  const htmlType = result["htmlContentType"];
  const htmlExecuted = result["htmlExecuted"];
  report(
    "html does not execute",
    htmlType === "text/plain" && htmlExecuted === false,
    `contentType=${String(htmlType)} executed=${String(htmlExecuted)}`,
  );

  //  a large image streams without stalling the main process. The budget is
  // the requirement's 200 ms, but the measurement is "no gap above the sampler's
  // resolution", so the message reports what was actually observed rather than
  // claiming a zero.
  const gap = typeof result["imageWorstGapMs"] === "number" ? result["imageWorstGapMs"] : null;
  const loaded = result["imageOutcome"] === "loaded";
  report(
    "27 MB streams without stalling",
    loaded && gap !== null && gap <= 200,
    `outcome=${String(result["imageOutcome"])} bytes=${String(result["imageBytes"])} worstGap=${
      gap === null ? "unmeasured" : `${gap}ms (sampler tick 10ms)`
    }`,
  );

  // The two refusals: a refused type and a refused path. These are cheap to check
  // and they are the two ways the channel is supposed to say no.
  report("refuses .exe with 415", result["exeRefused"] === true, String(result["exeRefused"]));
  report(
    "refuses a path outside the set with 403",
    result["outsideRefused"] === true,
    String(result["outsideRefused"]),
  );

  const allPassed =
    textType === "text/plain" &&
    htmlType === "text/plain" &&
    htmlExecuted === false &&
    loaded &&
    gap !== null &&
    gap <= 200 &&
    result["exeRefused"] === true &&
    result["outsideRefused"] === true;

  process.stdout.write(
    `\n${allPassed ? "ALL MEDIA ASSERTIONS PASSED" : "SOME MEDIA ASSERTIONS FAILED"} on ${
      process.platform
    } (${String(elapsed)} ms)\n`,
  );

  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
