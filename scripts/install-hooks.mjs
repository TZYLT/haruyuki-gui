#!/usr/bin/env node
/**
 * install-hooks.mjs - point git at the versioned .githooks/ directory.
 *
 * Usage:
 *   node scripts/install-hooks.mjs           # install (idempotent)
 *   node scripts/install-hooks.mjs --check   # report only, never writes config
 *
 * What it does
 *   `git config core.hooksPath .githooks` in the current repository (the
 *   default `--local` scope). `.githooks/` is version controlled, so every clone
 *   gets the same hooks by running this one command: `pnpm hooks:install`.
 *   Running it twice is a no-op; it never treats "already installed" as an error.
 *
 * Exit codes
 *   0 = installed, or already installed (with --check: hooks are present)
 *   1 = not inside a git work tree, or (with --check) hooks are not installed
 *   2 = the script or its environment is broken (no git, config write failed);
 *       mapped through the shared `fail()` helper so the exit codes keep the
 *       same meaning as every other gate script in scripts/.
 *
 * Why 1 and not 2 for "not a git work tree": that is a property of the caller's
 * location, not a defect of this script - the user is told to run it from the
 * repository root, and `--check` uses the same code for "not installed" so a CI
 * probe can tell "no hooks" (1) from "broken tooling" (2).
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { fail } from "./lib/gate-cli.mjs";

/** Written to core.hooksPath; git resolves it relative to the work-tree root. */
const HOOKS_PATH = ".githooks";

/** Hook file whose presence and executable bit we report on. */
const HOOK_FILE = "pre-commit";

run();

/**
 * Entry point. Every unexpected condition ends in `fail()` (exit 2); the two
 * expected "repository is not ready" conditions set exit code 1.
 *
 * @returns {void}
 */
function run() {
  try {
    const checkOnly = parseArgs(process.argv.slice(2));

    assertGitAvailable();

    const root = repoRoot();

    if (root === "") {
      console.error("ERROR: this directory is not a git work tree.");
      console.error("ERROR: run this script from inside the haruyuki-gui checkout.");
      process.exitCode = 1;

      return;
    }

    const current = readHooksPath();
    const installed = current === HOOKS_PATH;

    if (checkOnly) {
      if (installed) {
        console.log(`OK: git hooks are installed (core.hooksPath = ${HOOKS_PATH}).`);
        process.exitCode = 0;

        return;
      }

      const state = current === "" ? "core.hooksPath is not set" : `core.hooksPath is "${current}"`;
      console.error(`ERROR: git hooks are not installed: ${state}.`);
      console.error("ERROR: install them with: pnpm hooks:install");

      process.exitCode = 1;

      return;
    }

    if (installed) {
      console.log(`OK: git hooks are already installed (core.hooksPath = ${HOOKS_PATH}).`);
      reportHookFile(root);
      process.exitCode = 0;

      return;
    }

    if (current !== "") {
      console.log(`NOTE: core.hooksPath was "${current}"; replacing it with "${HOOKS_PATH}".`);
    }

    const write = git(["config", "core.hooksPath", HOOKS_PATH]);

    if (write.status !== 0) {
      fail(`git config core.hooksPath ${HOOKS_PATH} failed: ${firstLine(write.stderr)}`);
    }

    const readBack = readHooksPath();

    if (readBack !== HOOKS_PATH) {
      fail(`core.hooksPath reads back as "${readBack}" after install, expected "${HOOKS_PATH}"`);
    }

    console.log(`OK: installed core.hooksPath = ${HOOKS_PATH}.`);
    reportHookFile(root);
    console.log("OK: every commit in this repository now runs the pre-commit hook.");
    console.log("OK: bypass it once with: git commit --no-verify");
  } catch (error) {
    fail(error);
  }
}

/**
 * Parse the command line. Only `--check` exists; anything else is a usage
 * error, which `fail()` reports as exit code 2.
 *
 * @param {string[]} argv Arguments after the node/script prefix.
 * @returns {boolean} True for `--check`.
 */
function parseArgs(argv) {
  let checkOnly = false;

  for (const arg of argv) {
    if (arg === "--check") {
      checkOnly = true;

      continue;
    }

    throw new Error(`unknown argument: ${arg} (usage: node scripts/install-hooks.mjs [--check])`);
  }

  return checkOnly;
}

/**
 * Fail with a clear message when git itself is missing.
 *
 * @returns {void}
 */
function assertGitAvailable() {
  const result = git(["--version"]);

  if (result.status !== 0) {
    fail(`git is not available: ${firstLine(result.stderr ?? "") || "not found on PATH"}`);
  }
}

/**
 * Absolute path of the work-tree root, or "" when this is not a git work tree.
 *
 * @returns {string}
 */
function repoRoot() {
  const inside = git(["rev-parse", "--is-inside-work-tree"]);

  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return "";
  }

  return git(["rev-parse", "--show-toplevel"]).stdout.trim();
}

/**
 * Current core.hooksPath, or "" when unset (and possibly when it is set to an
 * empty string, which git treats the same way here).
 *
 * @returns {string}
 */
function readHooksPath() {
  const result = git(["config", "--get", "core.hooksPath"]);

  // `git config --get` exits 1 both for "unset" and for "set to the empty
  // string"; only an exit code above 1 is a real failure.
  if (result.status > 1) {
    fail(`git config --get core.hooksPath failed: ${firstLine(result.stderr)}`);
  }

  return result.status === 0 ? result.stdout.trim() : "";
}

/**
 * Report whether the configured hooks directory actually contains the hook,
 * and whether it is executable. Warnings only: the git configuration is still
 * valid, and on Windows git runs hooks through sh regardless of the mode bit.
 *
 * @param {string} root Work-tree root.
 * @returns {void}
 */
function reportHookFile(root) {
  const absolute = path.join(root, HOOKS_PATH, HOOK_FILE);

  if (!existsSync(absolute)) {
    console.warn(`WARNING: ${HOOKS_PATH}/${HOOK_FILE} does not exist; commits will not be gated.`);

    return;
  }

  console.log(`OK: hook file found: ${HOOKS_PATH}/${HOOK_FILE}`);

  if (process.platform === "win32") {
    return;
  }

  const mode = statSync(absolute).mode;

  if ((mode & 0o111) === 0) {
    console.warn(`WARNING: ${HOOKS_PATH}/${HOOK_FILE} is not executable.`);
    console.warn("WARNING: git cannot run it. Fix with: chmod +x .githooks/pre-commit");
    console.warn(
      "WARNING: or record the mode bit in the index: " +
        `git update-index --chmod=+x ${HOOKS_PATH}/${HOOK_FILE}`,
    );
  }
}

/**
 * Run one git command without a shell and capture its output.
 *
 * @param {string[]} args Arguments for git.
 * @returns {{ status: number, stdout: string, stderr: string }} Result; `status`
 *   is -1 on a spawn failure, so callers never see a throw.
 */
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", shell: false });

  if (result.error !== undefined && result.error !== null) {
    return { status: -1, stdout: result.stdout ?? "", stderr: String(result.error.message) };
  }

  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * @param {string} text
 * @returns {string} First non-empty line, trimmed.
 */
function firstLine(text) {
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value !== "");

  return line ?? "";
}
