#!/usr/bin/env node
/**
 * lock.mjs - generate `runtime-lock.json` from the staged engine.
 *
 * The lock is generated, never hand-edited: its entry hash and tree digest must
 * describe the exact bytes electron-builder puts in `resources/engine`. A hand
 * edit would pass review and fail at start, which is the worst place to learn
 * the lock is wrong.
 *
 * The tree algorithm is the same frozen one the main process verifies:
 * sort relative posix paths, one line per file (`sha256 + "  " + relative`),
 * join with `\n`, no trailing newline. The generator lives in `.mjs` because it
 * runs before the app is built; the verifier lives in TypeScript. The packaged
 * packaged smoke is the cross-check that the two copies agree.
 *
 * The runtime block records the Electron ABI that native modules were built
 * for, not the system Node used to run this script. A system Node has a
 * different ABI (137 here vs 150 in Electron 45); recording it would make the
 * lock look like it described a runtime the engine never runs on.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Script location; repository root derived from it. */
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

/** The lock's only supported version. */
export const LOCK_VERSION = 1;

/**
 * Generate the lock for a staged runtime.
 *
 * @param {object} options
 * @param {string} options.stageDir `apps/desktop/runtime` (contains engine/ and watchdog.cjs)
 * @param {string} options.outFile destination `runtime-lock.json`
 * @param {string} [options.sourceSpec] e.g. `haruyuki@0.6.0`
 * @param {string} [options.sourceIntegrity] optional npm integrity string
 * @param {{ electron: string, node: string, modules: string }} [options.runtime]
 * @param {string} [options.builtAt]
 * @returns {Promise<object>} the lock that was written
 */
export async function generateLock(options) {
  const stageDir = path.resolve(options.stageDir);
  const engineDir = path.join(stageDir, "engine");
  const bundlePath = path.join(engineDir, "haruyuki.js");
  const packageJson = JSON.parse(await readFile(path.join(engineDir, "package.json"), "utf8"));

  if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
    throw new Error(`engine package.json lacks name/version: ${engineDir}`);
  }

  const entry = await hashFile(bundlePath);
  const tree = await hashTree(engineDir);
  const runtime = options.runtime ?? detectRuntime();
  const lock = {
    lockVersion: LOCK_VERSION,
    engineVersion: packageJson.version,
    bundle: {
      name: packageJson.name,
      entry: "haruyuki.js",
      bytes: entry.bytes,
    },
    sha256: entry.sha256,
    source: {
      kind: "npm",
      spec: options.sourceSpec ?? `${packageJson.name}@${packageJson.version}`,
      ...(options.sourceIntegrity === undefined ? {} : { integrity: options.sourceIntegrity }),
    },
    builtAt: options.builtAt ?? new Date().toISOString(),
    runtime,
    tree,
  };

  await mkdir(path.dirname(path.resolve(options.outFile)), { recursive: true });
  const temporary = `${path.resolve(options.outFile)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await rename(temporary, path.resolve(options.outFile));

  return lock;
}

/**
 * Hash one file. Kept byte-for-byte equivalent to the main-process implementation.
 *
 * @param {string} file
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
export async function hashFile(file) {
  const hash = createHash("sha256");
  let bytes = 0;

  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);

    stream.on("data", (chunk) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;

      bytes += buffer.byteLength;
      hash.update(buffer);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });

  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Hash the whole engine tree with the frozen manifest.
 *
 * @param {string} engineDir
 * @returns {Promise<{ sha256: string, files: number, bytes: number }>}
 */
export async function hashTree(engineDir) {
  const root = path.resolve(engineDir);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  let bytes = 0;

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink in engine tree: ${entry.name}`);
    }

    if (!entry.isFile()) continue;

    const absolute = path.join(entry.parentPath ?? root, entry.name);
    const info = await lstat(absolute);

    files.push({
      absolute,
      relative: path.relative(root, absolute).split(path.sep).join("/"),
      bytes: info.size,
    });
    bytes += info.size;
  }

  files.sort((left, right) =>
    left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0,
  );

  const lines = [];

  for (const file of files) {
    const digest = await hashFile(file.absolute);

    lines.push(`${digest.sha256}  ${file.relative}`);
  }

  return {
    sha256: createHash("sha256").update(lines.join("\n")).digest("hex"),
    files: files.length,
    bytes,
  };
}

/**
 * Read the Electron ABI from the real Electron binary, not from the shell's Node.
 *
 * @returns {{ electron: string, node: string, modules: string }}
 */
function detectRuntime() {
  const electronPackagePath = path.join(REPO_ROOT, "node_modules", "electron", "package.json");
  const electronPackage = JSON.parse(readFileSync(electronPackagePath, "utf8"));
  const electronExe = path.join(
    REPO_ROOT,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron",
  );
  const result = spawnSync(electronExe, ["-p", "JSON.stringify(process.versions)"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });

  if (result.status !== 0) {
    throw new Error(
      `cannot read Electron runtime from ${electronExe}: ${result.stderr || result.stdout}`,
    );
  }

  const versions = JSON.parse(result.stdout);

  return {
    electron: String(electronPackage.version),
    node: String(versions.node),
    modules: String(versions.modules),
  };
}

/** Parse the CLI; unknown flags fail instead of being ignored. */
function parseArgs(argv) {
  const options = {
    stageDir: path.join(REPO_ROOT, "apps", "desktop", "runtime"),
    outFile: path.join(REPO_ROOT, "apps", "desktop", "runtime-lock.json"),
    sourceSpec: undefined,
    sourceIntegrity: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--stage") {
      options.stageDir = path.resolve(nextValue(argv, (index += 1), "--stage"));
    } else if (arg === "--out") {
      options.outFile = path.resolve(nextValue(argv, (index += 1), "--out"));
    } else if (arg === "--source-spec") {
      options.sourceSpec = nextValue(argv, (index += 1), "--source-spec");
    } else if (arg === "--source-integrity") {
      options.sourceIntegrity = nextValue(argv, (index += 1), "--source-integrity");
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/engine/lock.mjs [--stage <dir>] [--out <file>] " +
          "[--source-spec <spec>] [--source-integrity <sri>]",
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
    const lock = await generateLock(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(lock, null, 2));
  } catch (error) {
    console.error(`[lock] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
