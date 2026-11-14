#!/usr/bin/env node
/**
 * fetch-engine.mjs - unpack the pinned `haruyuki` npm artifact for research and
 * local acceptance runs.
 *
 * Why this exists: the published package is the only runnable engine build
 * but the unpacked tarball is missing its runtime
 * dependencies (F-2), so a plain `npm pack` + extract is not enough. This
 * script performs the three steps the probe needs, in order, and nothing else:
 *
 *   [1] pack     `npm pack haruyuki@<version>` into a throwaway temp directory
 *   [2] extract  system `tar -xzf <tgz>` into <out> (the tarball has a
 *                `package/` prefix, so <out>/package is the engine root)
 *   [3] install  `npm install --omit=dev --legacy-peer-deps --ignore-scripts`
 *                inside <out>/package
 *
 * The peer-dependency and lifecycle-script flags are not optional: react and
 * react-dom disagree (F-3) and the husky postinstall refers to a file that does
 * not ship in the tarball, so either one aborts the install.
 *
 * Usage:
 *   node scripts/engine/fetch-engine.mjs            # -> <repo>/_research/engine-0.6.0
 *   node scripts/engine/fetch-engine.mjs --out <dir>
 *
 * Idempotency: if <out>/package/haruyuki.js already exists the script reports
 * the paths it would have produced and exits 0 without touching the network.
 * The artifact directory is treated as read-only output; re-running with a
 * different version means pointing --out somewhere else.
 *
 * No third-party dependencies: node:child_process, node:fs, node:os, node:path
 * and node:url only. `ws` and friends are installed inside the artifact, never
 * imported from here.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned engine version. Must stay equal to the version the contract snapshot pins. */
const ENGINE_VERSION = "0.6.0";

/** npm package name of the engine build. */
const ENGINE_PACKAGE = "haruyuki";

/** Script location: <repo>/scripts/engine/fetch-engine.mjs. */
const SCRIPT_PATH = fileURLToPath(import.meta.url);

/** Repository root, derived from the script location (never from cwd). */
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..", "..");

/** Windows cannot execFile a .cmd shim without a shell (CVE-2024-27980 fix). */
const IS_WINDOWS = process.platform === "win32";

/** Per-step wall clock, printed at the end so slow steps are visible. */
const timings = [];

/**
 * Print one line of progress. Kept on stdout because the operator reads the
 * whole run as a log; real failures go to stderr.
 *
 * @param {string} message
 */
function log(message) {
  console.log(`[fetch-engine] ${message}`);
}

/**
 * Run one step and record how long it took.
 *
 * @template T
 * @param {string} label short human name used in the timing table
 * @param {() => T} step
 * @returns {T}
 */
function timed(label, step) {
  const startedAt = performance.now();
  const result = step();
  const elapsedMs = Math.round(performance.now() - startedAt);
  timings.push({ label, elapsedMs });
  log(`${label} done in ${elapsedMs} ms`);
  return result;
}

/**
 * Parse `--out <dir>` / `--out=<dir>`. Unknown arguments fail loudly instead of
 * being ignored, so a typo cannot silently write to the default location.
 *
 * @param {string[]} argv
 * @returns {string} directory that will receive the artifact
 */
function parseOutDir(argv) {
  let out = path.join(REPO_ROOT, "_research", `engine-${ENGINE_VERSION}`);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--out requires a directory argument");
      }
      out = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length);
      if (value === "") {
        throw new Error("--out requires a directory argument");
      }
      out = path.resolve(value);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return out;
}

/**
 * Render one command line for the shell. npm on Windows is `npm.cmd`, which
 * Node refuses to spawn without a shell (CVE-2024-27980 fix), so the command is
 * built as a single string and every argument is quoted for that shell. Passing
 * an unquoted temp or repository path through cmd.exe would break on a machine
 * whose profile path contains a space.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function renderCommand(command, args) {
  if (IS_WINDOWS) {
    const quoted = args.map((arg) => {
      if (arg === "" || /[\s"&|<>^()]/.test(arg)) {
        return `"${arg.replaceAll('"', '""')}"`;
      }
      return arg;
    });
    return [command, ...quoted].join(" ");
  }

  const quoted = args.map((arg) =>
    /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`,
  );
  return [command, ...quoted].join(" ");
}

/**
 * Run npm/tar with captured output. Output is returned rather than streamed so
 * a failure can be reported as one readable block.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs: number }} options
 * @returns {string} stdout
 */
function run(command, args, options) {
  try {
    return execSync(renderCommand(command, args), {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const detail = [stderr, stdout].filter((part) => part !== "").join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed (${error.status ?? "spawn error"})` +
        (detail === "" ? "" : `\n${detail}`),
    );
  }
}

/**
 * Locate the tarball npm just wrote. `npm pack --json` is authoritative, but
 * the fallback keeps the script working on npm versions that print plain text.
 *
 * @param {string} stagingDir
 * @param {string} stdout
 * @returns {string} absolute path to the .tgz
 */
function findTarball(stagingDir, stdout) {
  try {
    const jsonStart = stdout.indexOf("[");
    if (jsonStart !== -1) {
      const parsed = JSON.parse(stdout.slice(jsonStart));
      const filename = parsed?.[0]?.filename;
      if (typeof filename === "string" && filename.endsWith(".tgz")) {
        const candidate = path.join(stagingDir, filename);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // Fall through to the directory scan below.
  }

  const tarballs = readdirSync(stagingDir).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `expected exactly one .tgz in ${stagingDir}, found ${tarballs.length}: ` +
        (tarballs.join(", ") || "(none)"),
    );
  }
  return path.join(stagingDir, tarballs[0]);
}

/**
 * Read the version recorded inside the extracted package, so a registry-side
 * surprise (or a stale artifact directory) is visible in the log.
 *
 * @param {string} packageDir
 * @returns {string}
 */
function readExtractedVersion(packageDir) {
  const manifest = path.join(packageDir, "package.json");
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  return typeof parsed.version === "string" ? parsed.version : "(missing)";
}

/**
 * Entry point.
 *
 * @returns {number} process exit code
 */
function main() {
  const outDir = parseOutDir(process.argv.slice(2));
  const packageDir = path.join(outDir, "package");
  const entryPoint = path.join(packageDir, "haruyuki.js");

  log(`engine ${ENGINE_PACKAGE}@${ENGINE_VERSION}`);
  log(`repo root  ${REPO_ROOT}`);
  log(`output dir ${outDir}`);

  // Skip only when the artifact is both unpacked AND installed. The tarball
  // ships no dependencies (F-2), so an extract that was interrupted before
  // `npm install` finished would otherwise look "done" forever. Re-running the
  // pack+extract over the existing tree is safe: tar overwrites, and the install
  // then completes the tree.
  const entryExists = existsSync(entryPoint);
  const installComplete = existsSync(path.join(packageDir, "node_modules", "ws"));

  if (entryExists && installComplete) {
    log(`already present, skipping network work: ${entryPoint}`);
    log(`package dir ${packageDir}`);
    log("result: ok (idempotent skip)");
    return 0;
  }

  if (entryExists) {
    log("artifact present but node_modules/ws is missing; completing the install");
  }

  mkdirSync(outDir, { recursive: true });

  // The staging directory lives in os.tmpdir() so a failed download never
  // leaves a partial tarball next to the artifact.
  const stagingDir = mkdtempSync(path.join(tmpdir(), "haruyuki-pack-"));
  let tarballPath = null;

  try {
    const packOutput = timed("pack", () =>
      run("npm", ["pack", `${ENGINE_PACKAGE}@${ENGINE_VERSION}`, "--json"], {
        cwd: stagingDir,
        timeoutMs: 300_000,
      }),
    );
    tarballPath = findTarball(stagingDir, packOutput);
    log(`tarball ${tarballPath}`);

    timed("extract", () =>
      run("tar", ["-xzf", tarballPath, "-C", outDir], {
        cwd: stagingDir,
        timeoutMs: 120_000,
      }),
    );

    if (!existsSync(entryPoint)) {
      throw new Error(`extract produced no ${entryPoint}; unexpected tarball layout`);
    }

    const extractedVersion = readExtractedVersion(packageDir);
    log(`package version ${extractedVersion}`);
    if (extractedVersion !== ENGINE_VERSION) {
      throw new Error(
        `version mismatch: wanted ${ENGINE_VERSION}, tarball contains ${extractedVersion}`,
      );
    }

    timed("install", () =>
      run(
        "npm",
        [
          "install",
          "--omit=dev",
          "--legacy-peer-deps",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: packageDir, timeoutMs: 600_000 },
      ),
    );

    if (!existsSync(path.join(packageDir, "node_modules", "ws"))) {
      throw new Error("install finished but node_modules/ws is missing; the probe cannot connect");
    }
  } finally {
    // Single-point cleanup: drop the tarball, then remove the now-empty staging
    // directory. No recursive delete.
    if (tarballPath !== null && existsSync(tarballPath)) {
      unlinkSync(tarballPath);
    }
    try {
      rmdirSync(stagingDir);
    } catch {
      log(`staging dir left in place (not empty): ${stagingDir}`);
    }
  }

  log(`entry point ${entryPoint}`);
  log(`package dir ${packageDir}`);
  for (const { label, elapsedMs } of timings) {
    log(`timing ${label}=${elapsedMs}ms`);
  }
  log(`timing total=${timings.reduce((sum, item) => sum + item.elapsedMs, 0)}ms`);
  log("result: ok");
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[fetch-engine] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
