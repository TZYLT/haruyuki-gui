#!/usr/bin/env node
/**
 * coldstart.mjs - measure how long the shell takes to become usable.
 *
 * Cold start is process start to *both* of:
 *
 *   `ready-to-show` fired  -- the window is painted and about to appear
 *   `readyState === "complete"` -- the renderer document finished loading
 *
 * because either one alone is a misleading number: a window that appears before the page
 * can paint is not usable, and a page that finishes loading behind a hidden window is not
 * visible. The budget is P50 and P95 over 20 runs.
 *
 * Exit codes: 0 pass, 1 fail, 2 artifact missing.
 *
 * Why this is not part of `pnpm verify` (`D1-Q33`): it needs an Electron binary and a
 * window server, and `verify` has to run in a minute on a machine with neither.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This script, and the repository root derived from it -- never from cwd. */
const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..", "..", "..");

/** The Electron binary the shell is launched with. */
const ELECTRON_BIN = path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe");

/** The built main process. */
const MAIN_ENTRY = path.join(REPO_ROOT, "apps", "desktop", "dist", "main", "main.cjs");

/** The probe that reports the two timestamps. */
const PROBE_PATH = path.join(REPO_ROOT, "apps", "desktop", "dist", "probe", "coldstart-probe.cjs");

/** Runs per the acceptance criterion. */
const RUNS = 20;

/** Per-run ceiling. A run that exceeds this is a failure, not a slow sample. */
const RUN_TIMEOUT_MS = 30_000;

/** The budgets a run is judged against. */
const BUDGET_P50_MS = 3_000;
const BUDGET_P95_MS = 5_000;

/**
 * Print a failure and exit.
 *
 * @param {string} message
 * @param {number} code
 */
function fail(message, code = 1) {
  process.stderr.write(`FAIL ${message}\n`);
  process.exit(code);
}

/**
 * Check the artifacts this script needs.
 */
function requireArtifacts() {
  for (const [label, file, build] of [
    ["the electron binary", ELECTRON_BIN, "pnpm --filter @haruyuki/desktop run setup:electron"],
    ["the main process bundle", MAIN_ENTRY, "pnpm --filter @haruyuki/desktop run build"],
    ["the cold start probe", PROBE_PATH, "pnpm --filter @haruyuki/desktop run build:probe"],
  ]) {
    if (!existsSync(file)) {
      process.stderr.write(`${label} is missing: ${file}\nrun: ${build}\n`);
      process.exit(2);
    }
  }
}

/**
 * The environment to spawn with.
 *
 * `ELECTRON_RUN_AS_NODE` would turn the binary into plain Node, so the window never
 * appears and the measurement never starts. `NODE_OPTIONS` is inherited from whatever
 * shell launched us and can inject a `--require` the probe did not ask for.
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

  env["HARUYUKI_COLDSTART_ENTRY"] = MAIN_ENTRY;

  return env;
}

/**
 * Run the probe once and read its measurement.
 *
 * @returns {Promise<{ elapsedMs: number } | { error: string }>}
 */
function runOnce() {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(ELECTRON_BIN, [PROBE_PATH], {
      cwd: REPO_ROOT,
      env: childEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    /**
     * @param {{ elapsedMs: number } | { error: string }} value
     */
    function settle(value) {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ error: `the run exceeded ${RUN_TIMEOUT_MS} ms` });
    }, RUN_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => settle({ error: String(error) }));

    child.on("close", () => {
      const match = /^COLDSTART (\{.+)$/m.exec(stdout);
      const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      if (match === null) {
        settle({ error: `no COLDSTART line (${stderr.trim().slice(0, 400)})` });

        return;
      }

      try {
        const parsed = JSON.parse(match[1]);

        if (typeof parsed.elapsedMs !== "number") {
          settle({ error: "the measurement was not a number" });

          return;
        }

        // The probe's own figure is the one that counts: it starts at process start and
        // stops at the later of the two readiness signals. The wall clock here includes
        // Node's spawn overhead on the measuring side, so it is only a sanity bound.
        settle({ elapsedMs: parsed.elapsedMs });
      } catch {
        settle({ error: "the COLDSTART line was not valid JSON" });
      }
    });
  });
}

/**
 * The percentile of a sorted numeric sample, by nearest rank.
 *
 * Nearest rank rather than interpolation: with 20 runs a reviewer can count to the
 * reported sample, and an interpolated value that sits between two measurements is a
 * number nobody can reproduce.
 *
 * @param {number[]} sorted ascending
 * @param {number} fraction 0..1
 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return Number.NaN;

  const rank = Math.ceil(fraction * sorted.length);

  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Run the measurement.
 */
async function main() {
  requireArtifacts();

  const samples = [];

  for (let run = 1; run <= RUNS; run++) {
    const result = await runOnce();

    if ("error" in result) fail(`run ${run}/${RUNS}: ${result.error}`);

    samples.push(result.elapsedMs);
    process.stdout.write(`run ${String(run).padStart(2)} ${result.elapsedMs.toFixed(1)} ms\n`);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);

  process.stdout.write(
    `\nP50 ${p50.toFixed(1)} ms (budget ${BUDGET_P50_MS}) ` +
      `P95 ${p95.toFixed(1)} ms (budget ${BUDGET_P95_MS}) ` +
      `min ${sorted[0].toFixed(1)} max ${sorted[sorted.length - 1].toFixed(1)}\n`,
  );

  const overP50 = p50 > BUDGET_P50_MS;
  const overP95 = p95 > BUDGET_P95_MS;

  if (overP50 || overP95) {
    fail(
      `cold start is over budget: P50 ${p50.toFixed(1)}/${BUDGET_P50_MS} ` +
        `P95 ${p95.toFixed(1)}/${BUDGET_P95_MS}`,
    );
  }

  process.stdout.write(`coldstart: ${RUNS} runs within budget\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
