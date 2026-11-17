/**
 * `W8-VERIFY` first script: does one command produce a runtime tree and its lock?
 *
 * This is the `leaked-child-reclaimeda` judge, and it is deliberately narrower than "the
 * pipeline works". Round 1 has a stopping point: four of the eight steps run,
 * and what they leave behind is the runtime tree plus `runtime-lock.json`.
 * An artifact does not exist yet, and saying otherwise would be the whole
 * defect this item exists to remove.
 *
 * Run it from the repository root:
 *
 *   node apps/desktop/scripts/verify-round-one.mjs [--skip-install]
 *
 * Exit codes mirror release.mjs, because a judge that invents its own codes
 * cannot describe the thing it judges:
 *
 *   0  round 1 succeeded and both products are present
 *   1  release.mjs attempted the work and failed
 *   2  release.mjs could not start (bad usage or a failed prerequisite)
 *   3  release.mjs says this machine cannot do the only requested target
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..", "..");

const RELEASE = path.join(DESKTOP_DIR, "scripts", "release.mjs");
const LOCK_FILE = path.join(DESKTOP_DIR, "runtime-lock.json");
const ENGINE_DIR = path.join(DESKTOP_DIR, "runtime", "engine");

/** The lock fields `lock.ts` insists on, checked here so failures name them. */
const REQUIRED_LOCK_FIELDS = [
  "lockVersion",
  "engineVersion",
  "sha256",
  "builtAt",
  "bundle",
  "runtime",
  "tree",
];

/**
 * One named judgement, so a failure says which claim is false.
 *
 * @param {string} label
 * @param {() => string | null} check returns a complaint, or null when it holds
 * @returns {boolean}
 */
function judge(label, check) {
  const complaint = check();
  if (complaint === null) {
    process.stdout.write(`  ok    ${label}\n`);
    return true;
  }
  process.stdout.write(`  FAIL  ${label}: ${complaint}\n`);
  return false;
}

async function main() {
  if (!existsSync(RELEASE)) {
    process.stderr.write(`release.mjs is missing at ${RELEASE}\n`);
    return 2;
  }

  const started = Date.now();
  const result = spawnSync(process.execPath, [RELEASE, "--skip-bundle"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // Inherited `ELECTRON_RUN_AS_NODE` makes the packaged binary behave as
    // plain Node, so the child environment must not carry it. release.mjs
    // strips it for its own children; this is the same reason one level up.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const status = result.status;
  if (status !== 0) {
    process.stderr.write(`\nrelease.mjs exited ${status} after ${seconds}s\n`);
    const noise = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (noise.length > 0) process.stderr.write(`${noise}\n`);
    // Pass the code through unchanged. "It reported failure" is a different
    // finding from "it could not start", and collapsing them would make the
    // judge unable to describe the pipeline it is judging.
    return typeof status === "number" ? status : 1;
  }

  process.stdout.write(`\nrelease.mjs exited 0 in ${seconds}s; checking what it left behind\n`);

  let lock = null;
  const checks = [
    judge("runtime-lock.json exists", () =>
      existsSync(LOCK_FILE) ? null : `missing at ${LOCK_FILE}`,
    ),
    judge("runtime/engine exists", () =>
      existsSync(ENGINE_DIR) ? null : `missing at ${ENGINE_DIR}`,
    ),
    judge("runtime/watchdog.cjs exists", () =>
      existsSync(path.join(DESKTOP_DIR, "runtime", "watchdog.cjs"))
        ? null
        : "the engine preloads it through NODE_OPTIONS; without it the engine dies",
    ),
  ];

  if (existsSync(LOCK_FILE)) {
    try {
      lock = JSON.parse(await readFile(LOCK_FILE, "utf8"));
    } catch (error) {
      checks.push(judge("runtime-lock.json parses", () => String(error)));
    }
  }

  if (lock !== null) {
    for (const field of REQUIRED_LOCK_FIELDS) {
      checks.push(
        judge(`lock has ${field}`, () => (field in lock ? null : `field "${field}" is absent`)),
      );
    }
    checks.push(
      judge("lock engine tree has files", () =>
        typeof lock.tree?.files === "number" && lock.tree.files > 0
          ? null
          : "tree.files is not a positive number, so the tree was not walked",
      ),
    );
  }

  const failed = checks.filter((ok) => !ok).length;
  if (failed > 0) {
    process.stderr.write(`\n${failed} of ${checks.length} assertions failed\n`);
    return 1;
  }

  process.stdout.write(
    `\nall ${checks.length} assertions hold: round 1 produced a runtime tree and its lock\n`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
