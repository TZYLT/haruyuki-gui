#!/usr/bin/env node
/**
 * prune.mjs - copy the engine artifact and remove only files proven safe to remove.
 *
 * The rule this script exists to enforce is the route's red line: **nothing is
 * deleted because it "looks unused"**. Every rule is an explicit path class, and
 * the post-prune smoke has to prove the engine still starts, loads
 * `node-pty`/`sharp`, and completes the handshake. A rule that fails that smoke
 * is reverted, not defended.
 *
 * The source tree is never modified. `stage-runtime.mjs` calls this with a
 * target under `apps/desktop/runtime/`, so `_research/engine-0.6.0/package`
 * remains the untouched B1 artifact.
 *
 * Rules (win32-x64 is the shipping target):
 *
 *   source maps        all `*.map`; stack traces lose source lines, not frames
 *   foreign prebuilds   node-pty prebuilds except `<platform>-<arch>`
 *   foreign sharp       @janhapke/sharp-electron/linux-x64 on non-linux
 *   declarations        only with --drop-dts, and never under typescript/lib or @types
 *
 * Kept deliberately: @letta-ai, typescript, @img/sharp-win32-x64, @janhapke's
 * index + its own node_modules, every LICENSE/NOTICE, and any file no rule names.
 */

import { cp, lstat, readdir, rm, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Script location; repository root derived from it, never from cwd. */
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

/** A file selected for removal. */
/**
 * @typedef {object} PrunedFile
 * @property {string} relative posix path inside the engine
 * @property {number} bytes file size
 * @property {"source-map" | "foreign-prebuild" | "foreign-sharp" | "declaration"} reason
 */

/**
 * A whole pruning plan.
 *
 * @typedef {object} PrunePlan
 * @property {PrunedFile[]} files
 * @property {number} bytes
 * @property {Record<string, { files: number, bytes: number }>} byReason
 */

/**
 * Decide what to remove, without touching the tree.
 *
 * Exported so tests can assert the rules without copying 400 MB.
 *
 * @param {object} options
 * @param {string} options.root engine root to inspect
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.arch]
 * @param {boolean} [options.dropDts]
 * @returns {Promise<PrunePlan>}
 */
export async function planPrune(options) {
  const root = path.resolve(options.root);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const dropDts = options.dropDts === true;
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  /** @type {PrunedFile[]} */
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const parent = entry.parentPath ?? root;
    const absolute = path.join(parent, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const info = await lstat(absolute);
    const reason = reasonFor(relative, platform, arch, dropDts);

    if (reason !== null) {
      files.push({ relative, bytes: info.size, reason });
    }
  }

  files.sort((left, right) => (left.relative < right.relative ? -1 : 1));

  /** @type {Record<string, { files: number, bytes: number }>} */
  const byReason = {};

  for (const file of files) {
    const bucket = (byReason[file.reason] ??= { files: 0, bytes: 0 });

    bucket.files += 1;
    bucket.bytes += file.bytes;
  }

  return {
    files,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    byReason,
  };
}

/**
 * Copy the engine to `targetDir` and remove the files the plan names.
 *
 * The copy comes first because the target is what ships; pruning the source
 * would destroy the artifact the next run needs. Empty directories left by a
 * rule are removed afterwards so the package does not carry an empty
 * `win32-arm64/` shell.
 *
 * @param {object} options
 * @param {string} options.sourceDir
 * @param {string} options.targetDir
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.arch]
 * @param {boolean} [options.dropDts]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ engineDir: string, plan: PrunePlan, keptBytes: number }>}
 */
export async function pruneEngine(options) {
  const sourceDir = path.resolve(options.sourceDir);
  const targetDir = path.resolve(options.targetDir);
  const log = options.log ?? (() => undefined);

  await requireEngine(sourceDir);
  refuseOverlap(sourceDir, targetDir);

  await rm(targetDir, { recursive: true, force: true });
  await cp(sourceDir, targetDir, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });

  const plan = await planPrune({
    root: targetDir,
    platform: options.platform,
    arch: options.arch,
    dropDts: options.dropDts,
  });

  for (const file of plan.files) {
    await unlink(path.join(targetDir, file.relative));
  }

  await removeEmptyDirectories(targetDir);

  const kept = await directorySize(targetDir);

  log(
    `[prune] removed ${plan.files.length} files / ${mib(plan.bytes)} ` +
      `(${Object.entries(plan.byReason)
        .map(([reason, count]) => `${reason}=${count.files}`)
        .join(", ")})`,
  );
  log(`[prune] kept ${mib(kept.bytes)} in ${kept.files} files`);

  return { engineDir: targetDir, plan, keptBytes: kept.bytes };
}

/**
 * The single rule table. A path not named here is kept.
 *
 * @param {string} relative posix path
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 * @param {boolean} dropDts
 * @returns {PrunedFile["reason"] | null}
 */
function reasonFor(relative, platform, arch, dropDts) {
  if (relative.endsWith(".map")) return "source-map";

  const prebuild = /^node_modules\/node-pty\/prebuilds\/([^/]+)\//.exec(relative);

  if (prebuild !== null && prebuild[1] !== `${platform}-${arch}`) {
    return "foreign-prebuild";
  }

  if (
    relative.startsWith("node_modules/@janhapke/sharp-electron/linux-x64/") &&
    !(platform === "linux" && arch === "x64")
  ) {
    return "foreign-sharp";
  }

  if (
    dropDts &&
    relative.endsWith(".d.ts") &&
    !relative.startsWith("node_modules/typescript/lib/") &&
    !relative.startsWith("node_modules/@types/")
  ) {
    return "declaration";
  }

  return null;
}

/** The source must be an installed engine, not an arbitrary directory. */
async function requireEngine(dir) {
  for (const required of ["haruyuki.js", "node_modules", "package.json"]) {
    try {
      await stat(path.join(dir, required));
    } catch {
      throw new Error(`not an engine directory (missing ${required}): ${dir}`);
    }
  }
}

/** Copying into itself would recurse; the check is textual and absolute. */
function refuseOverlap(sourceDir, targetDir) {
  const relative = path.relative(sourceDir, targetDir);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`target must not be inside source: ${targetDir}`);
  }
}

/** Remove now-empty directories bottom-up, never the root. */
async function removeEmptyDirectories(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(entry.parentPath ?? root, entry.name))
    .sort((left, right) => right.length - left.length);

  for (const dir of dirs) {
    const remaining = await readdir(dir);

    if (remaining.length === 0) await rmdir(dir);
  }
}

/** Total bytes/files under a directory, for the log line. */
async function directorySize(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  let files = 0;
  let bytes = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const info = await lstat(path.join(entry.parentPath ?? root, entry.name));

    files += 1;
    bytes += info.size;
  }

  return { files, bytes };
}

/** Human-readable MiB. */
function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Parse the CLI; unknown flags fail instead of being ignored. */
function parseArgs(argv) {
  const options = {
    sourceDir: path.join(REPO_ROOT, "_research", "engine-0.6.0", "package"),
    targetDir: path.join(REPO_ROOT, "_research", "engine-0.6.0-pruned"),
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
        "usage: node scripts/engine/prune.mjs [--source <dir>] [--target <dir>] " +
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
    const options = parseArgs(process.argv.slice(2));
    const result = await pruneEngine({ ...options, log: console.log });
    console.log(JSON.stringify({ engineDir: result.engineDir, plan: result.plan }, null, 2));
  } catch (error) {
    console.error(`[prune] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
