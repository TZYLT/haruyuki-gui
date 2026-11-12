/**
 * verify-hooks.mjs - read `core.hooksPath` without ever running git.
 *
 * `scripts/verify.mjs` ends with a one-line hint when the repository hooks are
 * not installed. The obvious probe, `git config --get core.hooksPath`, is a git
 * command, and the project keeps git out of the gate scripts: a gate that
 * shells out to git fails for reasons unrelated to the tree it inspects (no
 * git on PATH, a hardened CI image, a split index lock). Reading `.git/config`
 * as plain text gives the same answer from the file system alone.
 *
 * Covered layouts:
 *   - an ordinary checkout: `<root>/.git/config`;
 *   - a worktree or submodule: `<root>/.git` is a `gitdir: <path>` file, and
 *     the shared settings live in the directory named by its `commondir`.
 *
 * Anything unreadable or unparsable counts as "not installed", which is the
 * safe direction: the only consequence is one extra hint line, never a false
 * green.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { toPosix } from "./gate-cli.mjs";

/** The hooks directory this repository ships (`pnpm hooks:install`). */
const HOOKS_DIRECTORY = ".githooks";

/**
 * True when `core.hooksPath` resolves to this repository's `.githooks`.
 *
 * @param {string} root Absolute posix repository root.
 * @returns {boolean}
 */
export function hooksInstalled(root) {
  const configPath = findGitConfig(root);

  if (configPath === null) {
    return false;
  }

  const hooksPath = readHooksPath(configPath);

  if (hooksPath === null) {
    return false;
  }

  const normalized = toPosix(hooksPath).replace(/\/+$/, "");

  return normalized === HOOKS_DIRECTORY || normalized.endsWith(`/${HOOKS_DIRECTORY}`);
}

/**
 * Locate the git config file that applies to `root`.
 *
 * @param {string} root Absolute posix repository root.
 * @returns {string | null} Absolute posix path, or null when there is no git
 *   metadata to read.
 */
function findGitConfig(root) {
  const dotGit = path.join(root, ".git");

  if (!existsSync(dotGit)) {
    return null;
  }

  let gitDirectory = dotGit;

  if (!statSync(dotGit).isDirectory()) {
    // A worktree or submodule: `.git` is a pointer file, not a directory.
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));

    if (match === null) {
      return null;
    }

    gitDirectory = path.resolve(root, match[1].trim());
  }

  const candidates = [path.join(gitDirectory, "config")];
  const commonDirFile = path.join(gitDirectory, "commondir");

  if (existsSync(commonDirFile)) {
    const commonDirectory = path.resolve(gitDirectory, readFileSync(commonDirFile, "utf8").trim());

    candidates.push(path.join(commonDirectory, "config"));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return toPosix(candidate);
    }
  }

  return null;
}

/**
 * Read `core.hooksPath` out of one git config file.
 *
 * Only what the hint needs is parsed: section headers, and the last
 * `hooksPath = ...` line inside `[core]` (git itself lets the last value win).
 *
 * @param {string} configPath Absolute posix path to a git config file.
 * @returns {string | null} The configured value, unquoted, or null.
 */
function readHooksPath(configPath) {
  const lines = readFileSync(configPath, "utf8").split("\n");
  let section = "";
  let hooksPath = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      // `[core]` and `[core "name"]` both name the core section.
      section = line.slice(1, -1).split(/\s+/)[0].toLowerCase();
      continue;
    }

    if (section !== "core") {
      continue;
    }

    const match = /^hooksPath\s*=\s*(.*)$/i.exec(line);

    if (match !== null) {
      hooksPath = stripGitValue(match[1]);
    }
  }

  return hooksPath;
}

/**
 * @param {string} value Raw right-hand side of a git config line.
 * @returns {string}
 */
function stripGitValue(value) {
  const trimmed = value.trim();

  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}
