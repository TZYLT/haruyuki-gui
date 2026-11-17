#!/usr/bin/env node
/**
 * release.mjs - one command that turns a clean checkout into something shippable.
 *
 * Today the sequence lives in people's heads: `pnpm install`, then
 * `fetch-engine`, then `stage-runtime`, then `lock`, then `electron-builder`.
 * A person who skips or reorders a step gets a package that looks fine and
 * fails at start - and the honest description of that state is that a human
 * decided "keep going" on the pipeline's behalf.
 *
 * Two rounds, because the middle of the pipeline and the end of it can be
 * judged separately:
 *
 *   round 1  install -> fetch -> deref -> stage -> lock        (this file, now)
 *   round 2  ... -> build -> package -> manifest               (W2/W3, wave 2)
 *
 * Round 1 produces the runtime tree and its lock, and that is what makes an
 * engine start. Round 2 wraps it into an artifact. `--skip-bundle` is what
 * separates them, and its name is deliberately not "skip checks": nothing is
 * verified less, round 1 simply ends earlier.
 *
 * Exit codes:
 *   0  every requested target succeeded, or was skipped for lack of a capability
 *   1  a target was attempted and failed
 *   2  a prerequisite failed: no manifest, nothing half-written left behind
 *   3  the only requested target cannot be done on this machine
 * 1 and 2 are failures; 3 is also a failure, it just reads differently.
 */

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..", "..");

/** Where the engine artifact lands before `stage-runtime` copies it. */
const ENGINE_ARTIFACT = path.join(REPO_ROOT, "_research", "engine-0.6.0");

/** Files that are not part of the shipped engine and must not reach the lock. */
const NOT_SHIPPED = new Set([".bin"]);

const USAGE = `usage: node apps/desktop/scripts/release.mjs [options]

  --win-only       package Windows only (zip + win-unpacked)
  --linux-only     package Linux only (AppImage)
                   (neither) both
  --skip-install   assume node_modules is already in place
  --skip-fetch     reuse ${path.relative(REPO_ROOT, ENGINE_ARTIFACT)}
  --skip-bundle    stop after the runtime tree and its lock (round 1)
  -h, --help       this text

exit codes
  0  every requested target succeeded, or was skipped for lack of a capability
  1  a target was attempted and failed
  2  a prerequisite failed (nothing half-written is left behind)
  3  the only requested target cannot be done on this machine`;

/**
 * Parse the command line.
 *
 * `--win-only` and `--linux-only` together are refused instead of guessed: the
 * natural reading of "both given" is "do both", which is exactly what giving
 * neither means, so the flag pair would only exist to look like control.
 *
 * @param {string[]} argv
 * @returns {{ targets: ("win32"|"linux")[], skipInstall: boolean, skipFetch: boolean, skipBundle: boolean }}
 */
export function parseArgs(argv) {
  const options = {
    targets: ["win32", "linux"],
    skipInstall: false,
    skipFetch: false,
    skipBundle: false,
  };
  let sawWin = false;
  let sawLinux = false;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--win-only") {
      sawWin = true;
    } else if (arg === "--linux-only") {
      sawLinux = true;
    } else if (arg === "--skip-install") {
      options.skipInstall = true;
    } else if (arg === "--skip-fetch") {
      options.skipFetch = true;
    } else if (arg === "--skip-bundle") {
      options.skipBundle = true;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  if (sawWin && sawLinux) {
    throw new UsageError("--win-only and --linux-only are mutually exclusive");
  }
  if (sawWin) options.targets = ["win32"];
  if (sawLinux) options.targets = ["linux"];

  return options;
}

/** A bad command line, as opposed to a failed step. */
export class UsageError extends Error {}

/**
 * Run a step, printing what it is and how long it took.
 *
 * Every step is reported whether it passes or fails: a log that only shows the
 * steps that worked cannot be used to find out where they stopped.
 *
 * @param {string} label
 * @param {() => { status: number|null, stdout?: string, stderr?: string }} body
 * @returns {boolean} true when the step succeeded
 */
function step(label, body) {
  const started = Date.now();
  process.stdout.write(`\n==> ${label}\n`);
  const result = body();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    process.stdout.write(`<== ${label} ok (${seconds}s)\n`);
    return true;
  }
  process.stdout.write(`<== ${label} FAILED (${seconds}s, exit ${result.status})\n`);
  const noise = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (noise.length > 0) process.stdout.write(`${noise}\n`);
  return false;
}

/**
 * @param {string[]} command
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, cwd, env) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    // `ELECTRON_RUN_AS_NODE` is set globally on the verification machine and
    // would make the Electron binary behave as plain Node for every child
    // process, including the packaged app. Strip it rather than inherit it.
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: undefined },
  });
}

/**
 * Replace symlinks in the engine tree with the files they point at.
 *
 * npm creates `node_modules/.bin/*` as symlinks on POSIX and as `.cmd`/`.ps1`
 * shims on Windows, so a tree installed on one platform has entries the other
 * never sees. The lock hashes content, and a symlink is another way of reaching
 * that content - so the content is what gets hashed, and the link is replaced
 * instead of being skipped (skipping would leave the lock describing a tree
 * with fewer files than the one on disk).
 *
 * @param {string} root
 * @returns {Promise<{ replaced: number, links: string[] }>}
 */
export async function dereferenceTree(root) {
  const { lstat, readlink, unlink, copyFile, stat } = await import("node:fs/promises");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const links = [];

  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    links.push(path.join(entry.parentPath ?? root, entry.name));
  }

  for (const link of links) {
    const target = await readlink(link);
    const absolute = path.resolve(path.dirname(link), target);
    const info = await stat(absolute).catch(() => null);
    if (info === null) {
      throw new Error(`dangling symlink in engine tree: ${link} -> ${target}`);
    }
    if (!info.isFile()) {
      throw new Error(`symlink in engine tree points at a non-file: ${link} -> ${target}`);
    }
    await unlink(link);
    await copyFile(absolute, link);
  }

  return { replaced: links.length, links };
}

/** Keep node_modules/.bin from being walked into the lock. */
async function pruneBinDirectories(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  /** @type {string[]} */
  const remnants = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NOT_SHIPPED.has(entry.name)) continue;
    remnants.push(path.join(entry.parentPath ?? root, entry.name));
  }
  for (const directory of remnants) await rm(directory, { recursive: true, force: true });
  return remnants.length;
}

/**
 * Round 1: everything up to and including the runtime lock.
 *
 * @param {{ skipInstall: boolean, skipFetch: boolean }} options
 * @returns {Promise<number>} exit code
 */
async function roundOne(options) {
  if (!options.skipInstall) {
    const ok = step("install", () => run("pnpm", ["install", "--frozen-lockfile"], REPO_ROOT));
    if (!ok) return 2;
  }

  const lockFile = path.join(DESKTOP_DIR, "runtime-lock.json");
  const engineDir = path.join(DESKTOP_DIR, "runtime", "engine");

  if (!options.skipFetch) {
    const ok = step("fetch engine", () =>
      run(
        process.execPath,
        ["scripts/engine/fetch-engine.mjs", "--out", ENGINE_ARTIFACT],
        REPO_ROOT,
      ),
    );
    if (!ok) return 2;
  } else if (!existsSync(path.join(ENGINE_ARTIFACT, "package", "haruyuki.js"))) {
    process.stderr.write(`--skip-fetch given but ${ENGINE_ARTIFACT} has no package\n`);
    return 2;
  }

  const deref = await dereferenceTree(path.join(ENGINE_ARTIFACT, "package"));
  process.stdout.write(`\n==> dereference\n<== dereference ok (${deref.replaced} symlinks)\n`);

  const ok = step("stage runtime", () =>
    run(process.execPath, ["scripts/engine/stage-runtime.mjs"], REPO_ROOT),
  );
  if (!ok) return 1;

  const okLock = step("lock", () => run(process.execPath, ["scripts/engine/lock.mjs"], REPO_ROOT));
  if (!okLock) return 1;

  if (!existsSync(lockFile)) {
    process.stderr.write(`lock reported success but ${lockFile} is missing\n`);
    return 1;
  }

  process.stdout.write(`\nruntime tree  ${engineDir}\nruntime lock  ${lockFile}\n`);
  process.stdout.write("\nround 1 complete: the runtime tree and its lock are in place.\n");
  return 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }

  const code = await roundOne(options);
  if (code !== 0) return code;

  if (!options.skipBundle) {
    // Round 2 (W2-WIN, W3-LINUX) appends the build/package/manifest steps here.
    process.stdout.write(
      "\nround 2 (build / package / manifest) is not wired yet: pass --skip-bundle,\n" +
        "or run round 1 alone until those work packages land.\n",
    );
    return 2;
  }

  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
