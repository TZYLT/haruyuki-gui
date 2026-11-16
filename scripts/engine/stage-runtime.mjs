#!/usr/bin/env node
/**
 * stage-runtime.mjs - assemble the exact tree that electron-builder will ship.
 *
 * `electron-builder` copies `extraResources` from a real directory. Pointing it
 * at `_research/` would make a clean checkout unbuildable and would let the lock
 * describe a different tree from the one in the package. This script is the one
 * place that turns the fetched artifact into `apps/desktop/runtime/`:
 *
 *   runtime/engine/        pruned engine + node_modules
 *   runtime/watchdog.cjs   real file, preloaded through NODE_OPTIONS
 *
 * It is idempotent: the target is removed and rebuilt. The intermediate
 * directory is a sibling so the final rename stays on one volume. A failure
 * removes the intermediate directory and leaves the previous target untouched.
 */

import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pruneEngine } from "./prune.mjs";

/** Script location; repository root derived from it. */
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

/** The one watchdog copy; the engine keeps its own source in packages/core. */
const WATCHDOG_SOURCE = path.join(REPO_ROOT, "packages", "core", "src", "runtime", "watchdog.cjs");

/**
 * Build `runtime/` from a fetched engine.
 *
 * @param {object} options
 * @param {string} [options.sourceDir]
 * @param {string} [options.targetDir]
 * @param {string} [options.watchdogSource]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.arch]
 * @param {boolean} [options.dropDts]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ engineDir: string, watchdogPath: string, targetDir: string }>}
 */
export async function stageRuntime(options = {}) {
  const sourceDir = path.resolve(
    options.sourceDir ?? path.join(REPO_ROOT, "_research", "engine-0.6.0", "package"),
  );
  const targetDir = path.resolve(
    options.targetDir ?? path.join(REPO_ROOT, "apps", "desktop", "runtime"),
  );
  const watchdogSource = path.resolve(options.watchdogSource ?? WATCHDOG_SOURCE);
  const log = options.log ?? (() => undefined);
  const temporary = `${targetDir}.tmp-${process.pid}`;

  await stat(watchdogSource).catch(() => {
    throw new Error(`watchdog source is missing: ${watchdogSource}`);
  });

  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });

  try {
    const pruned = await pruneEngine({
      sourceDir,
      targetDir: path.join(temporary, "engine"),
      platform: options.platform,
      arch: options.arch,
      dropDts: options.dropDts,
      log,
    });

    log(`[stage] pruned ${pruned.plan.files.length} files`);

    const watchdogPath = path.join(temporary, "watchdog.cjs");

    await cp(watchdogSource, watchdogPath);
    await stat(watchdogPath);

    await rm(targetDir, { recursive: true, force: true });
    await rename(temporary, targetDir);
    log(`[stage] ${targetDir}`);

    return {
      engineDir: path.join(targetDir, "engine"),
      watchdogPath: path.join(targetDir, "watchdog.cjs"),
      targetDir,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Parse the CLI; unknown flags fail instead of being ignored. */
function parseArgs(argv) {
  const options = {
    sourceDir: path.join(REPO_ROOT, "_research", "engine-0.6.0", "package"),
    targetDir: path.join(REPO_ROOT, "apps", "desktop", "runtime"),
    platform: process.platform,
    arch: process.arch,
    dropDts: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--source") {
      options.sourceDir = path.resolve(nextValue(argv, (index += 1), "--source"));
    } else if (arg === "--target") {
      options.targetDir = path.resolve(nextValue(argv, (index += 1), "--target"));
    } else if (arg === "--platform") {
      options.platform = nextValue(argv, (index += 1), "--platform");
    } else if (arg === "--arch") {
      options.arch = nextValue(argv, (index += 1), "--arch");
    } else if (arg === "--drop-dts") {
      options.dropDts = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/engine/stage-runtime.mjs [--source <dir>] [--target <dir>] " +
          "[--platform win32] [--arch x64] [--drop-dts]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

/** Read the value after a flag. */
function nextValue(argv, index, flag) {
  const value = argv[index];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const result = await stageRuntime({ ...parseArgs(process.argv.slice(2)), log: console.log });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[stage] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
