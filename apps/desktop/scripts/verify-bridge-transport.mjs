#!/usr/bin/env node
/**
 * verify-bridge-transport.mjs - run D3's real-Electron bridge probe.
 *
 * The unit tests run in Node; this script answers the one question they cannot:
 * does the frame string survive `ipcRenderer`/`ipcMain` with the real preload,
 * and does 1 MiB of terminal bytes move through the bounded ingress without
 * losing or duplicating a slice?
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 2 an artifact is missing.
 *
 * Usage:
 *   node apps/desktop/scripts/verify-bridge-transport.mjs
 *   node apps/desktop/scripts/verify-bridge-transport.mjs --no-sandbox
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..", "..", "..");

const ELECTRON_BIN =
  process.platform === "win32"
    ? path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");

const PROBE = path.join(REPO_ROOT, "apps", "desktop", "dist", "probe", "bridge-probe.cjs");
const PRELOAD = path.join(REPO_ROOT, "apps", "desktop", "dist", "main", "preload.cjs");

const TIMEOUT_MS = 60_000;

const EXTRA_FLAGS = process.argv.slice(2).filter((arg) => arg.startsWith("--"));

function childEnv() {
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "ELECTRON_RUN_AS_NODE") continue;
    if (key === "NODE_OPTIONS") continue;
    env[key] = value;
  }

  return env;
}

function runProbe() {
  return new Promise((resolve) => {
    const child = spawn(ELECTRON_BIN, [...EXTRA_FLAGS, PROBE], {
      cwd: REPO_ROOT,
      env: childEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

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

      if (/^App threw an error during load$/m.test(stderr) || /EXCEPTION_BREAKPOINT/.test(stderr)) {
        child.kill("SIGKILL");
        settle({ code: null, stdout, stderr });
      }
    });

    child.on("error", (error) => settle({ code: null, stdout, stderr: stderr + String(error) }));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

function parseResult(stdout) {
  const match = /^BRIDGERESULT (.+)$/m.exec(stdout);

  if (match === null) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function report(label, passed, detail) {
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${label} ${detail}\n`);
}

async function main() {
  process.stdout.write("verify-bridge-transport\n");
  process.stdout.write(`electron: ${ELECTRON_BIN}\n\n`);

  for (const [label, file, build] of [
    ["the electron binary", ELECTRON_BIN, "pnpm --filter @haruyuki/desktop run setup:electron"],
    ["the preload bundle", PRELOAD, "pnpm --filter @haruyuki/desktop run build:main"],
    ["the bridge probe", PROBE, "pnpm --filter @haruyuki/desktop run build:probe"],
  ]) {
    if (!existsSync(file)) {
      process.stderr.write(`${label} is missing: ${file}\nrun: ${build}\n`);
      process.exit(2);
    }
  }

  const run = await runProbe();
  const result = parseResult(run.stdout);

  if (run.stderr.trim() !== "") {
    process.stdout.write("--- stderr ---\n");
    process.stdout.write(run.stderr.trim() + "\n\n");
  }

  if (result === null) {
    report("probe", false, `no BRIDGERESULT line, exit ${String(run.code)}`);
    process.exit(1);
  }

  report("preload bridge", result.bridgePresent === true, String(result.bridgePresent));
  report("handshake accept", (result.accepts ?? 0) > 0, `accepts=${String(result.accepts)}`);
  report(
    "1 MiB terminal bytes",
    result.termBytes === 128 * 8192,
    `termBytes=${String(result.termBytes)}`,
  );
  report("terminal acks", (result.acks ?? 0) >= 128, `acks=${String(result.acks)}`);
  report("bulk delivery", (result.bulkFrames ?? 0) > 0, `bulkFrames=${String(result.bulkFrames)}`);
  report("no notices", (result.notices ?? 0) === 0, `notices=${String(result.notices)}`);
  report(
    "reload replay",
    result.replayTextOk === true,
    `replayBytes=${String(result.replayBytes)}`,
  );
  report(
    "bounded terminal entry",
    result.boundedPending <= 1024 * 1024,
    `boundedPending=${String(result.boundedPending)}`,
  );
  report(
    "unbounded variant exceeds cap",
    result.unboundedPending > 1024 * 1024,
    `unboundedPending=${String(result.unboundedPending)}`,
  );

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    process.stdout.write(`errors: ${result.errors.join(" | ")}\n`);
  }

  process.stdout.write(`rss=${String(result.rss)} elapsedMs=${String(result.elapsedMs)}\n`);

  process.exit(
    result.bridgePresent === true &&
      (result.accepts ?? 0) > 0 &&
      result.termBytes === 128 * 8192 &&
      (result.acks ?? 0) >= 128 &&
      (result.bulkFrames ?? 0) > 0 &&
      (result.notices ?? 0) === 0 &&
      result.replayTextOk === true &&
      result.boundedPending <= 1024 * 1024 &&
      result.unboundedPending > 1024 * 1024
      ? 0
      : 1,
  );
}

await main();
