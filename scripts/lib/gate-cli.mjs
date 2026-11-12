/**
 * gate-cli.mjs - shared command-line contract for every self-written gate script
 * (scripts/verify.mjs today, scripts/check-*.mjs later).
 *
 * This module only provides plumbing. It must never contain a concrete check.
 *
 * Contract (frozen; changing it means changing every gate script at once):
 *
 *   1. Root
 *      - All gate scripts scan the repository rooted at `parseArgs(argv).root`.
 *      - The default root is `process.cwd()`.
 *      - `--root <dir>` exists for self-tests only; normal runs pass no root.
 *      - Every path is posix ("/"). This project runs on Windows and
 *        `path.normalize` yields backslashes, which silently break anchors such
 *        as `^apps/([^/]+)/` and make a check pass without inspecting anything.
 *        Run `toPosix()` before matching, comparing or printing any path.
 *
 *   2. Output
 *      - English only, one violation per line:
 *            <file>:<line> <rule> <message>
 *      - `report()` prints the violation lines, `finish()` prints the summary.
 *
 *   3. Exit codes (exactly three values)
 *      - 0 = all checks passed
 *      - 1 = at least one violation
 *      - 2 = the script itself is broken (bad argument, bad config, I/O error),
 *            never to be confused with a violation.
 *
 *   4. Usage
 *      import { runGate } from "./lib/gate-cli.mjs";
 *      await runGate(async ({ root, flags }) => collectViolations(root, flags), {
 *        flags: ["full"],
 *      });
 *      // or, manually:
 *      //   const args = parseArgs(process.argv.slice(2), { flags: ["full"] });
 *      //   finish(await collectViolations(args.root, args.flags));
 *      // Errors thrown above are the script's own failure and must reach
 *      // `fail()` (exit 2), not the violation path (exit 1).
 */

import { statSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {object} Violation
 * @property {string} file Repo-relative path; backslashes are tolerated and normalized.
 * @property {number} [line] 1-based line number when the violation is line-scoped.
 * @property {string} rule Short rule id, for example "R3" or "no-value-import".
 * @property {string} message English, single line, action-oriented.
 */

/**
 * @typedef {object} GateArgs
 * @property {string} root Absolute posix path of the scanned repository.
 * @property {Record<string, boolean>} flags Declared boolean switches that were present.
 */

/**
 * Convert a path to posix separators.
 *
 * @param {string} value
 * @returns {string}
 */
export function toPosix(value) {
  if (typeof value !== "string") {
    throw new TypeError(`toPosix expects a string, received ${typeof value}`);
  }

  return value.replaceAll("\\", "/");
}

/**
 * Resolve a directory to an absolute posix path.
 *
 * Throws when the path does not exist or is not a directory, so a typo in
 * `--root` cannot turn into a silent "0 files, PASS" run.
 *
 * @param {string} [dir] Defaults to `process.cwd()`.
 * @returns {string}
 */
export function resolveRoot(dir = process.cwd()) {
  if (typeof dir !== "string" || dir === "") {
    throw new TypeError("resolveRoot expects a non-empty directory path");
  }

  const absolute = toPosix(path.resolve(dir));
  let stats;

  try {
    stats = statSync(absolute);
  } catch {
    throw new Error(`--root path does not exist: ${absolute}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`--root path is not a directory: ${absolute}`);
  }

  return absolute;
}

/**
 * Parse the shared gate-script arguments.
 *
 * Known options: `--root <dir>` / `--root=<dir>`, plus the boolean switches the
 * caller declares in `options.flags` (for example `--full`). Anything else is a
 * usage error and throws; `runGate()` maps that throw to exit code 2.
 *
 * @param {string[]} argv Arguments without the node/script prefix.
 * @param {{ flags?: string[] }} [options]
 * @returns {GateArgs}
 */
export function parseArgs(argv, options = {}) {
  if (!Array.isArray(argv)) {
    throw new TypeError("parseArgs expects an array of strings");
  }

  const declaredFlags = new Set(options.flags ?? []);
  /** @type {Record<string, boolean>} */
  const flags = {};
  let root = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (typeof arg !== "string") {
      throw new TypeError(`parseArgs expects strings, received ${typeof arg}`);
    }

    if (arg === "--root") {
      const value = argv[index + 1];

      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new Error("Missing value for --root <dir>");
      }

      root = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--root=")) {
      const value = arg.slice("--root=".length);

      if (value === "") {
        throw new Error("Missing value for --root <dir>");
      }

      root = value;
      continue;
    }

    if (arg.startsWith("--")) {
      const name = arg.slice(2);

      if (!declaredFlags.has(name)) {
        throw new Error(`Unknown argument: ${arg}`);
      }

      flags[name] = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { root: resolveRoot(root), flags };
}

/**
 * Print violations to stdout in the shared format, sorted for stable output.
 *
 * @param {Violation[]} violations
 * @returns {boolean} True when there are no violations.
 */
export function report(violations) {
  if (!Array.isArray(violations)) {
    throw new TypeError("report expects an array of violations");
  }

  const sorted = violations.map(assertViolation).sort(compareViolations);

  for (const violation of sorted) {
    console.log(formatViolation(violation));
  }

  return sorted.length === 0;
}

/**
 * Print the summary, set the exit code and hand the verdict back to the caller.
 *
 * This sets `process.exitCode` instead of calling `process.exit()` so piped
 * stdout is fully flushed before the process ends. Call it as the last step.
 *
 * @param {Violation[]} violations
 * @returns {boolean} True when the gate passed.
 */
export function finish(violations) {
  const passed = report(violations);

  if (passed) {
    console.log("PASS");
  } else {
    console.log(`FAIL: ${violations.length} violation(s)`);
  }

  process.exitCode = passed ? 0 : 1;

  return passed;
}

/**
 * Report a script-level failure (exit 2) and terminate.
 *
 * @param {unknown} message
 * @returns {never}
 */
export function fail(message) {
  const text = message instanceof Error ? message.message : String(message);

  console.error(`ERROR: ${text}`);
  process.exit(2);
}

/**
 * Run a gate script body under the shared contract.
 *
 * Convenience wrapper: parses the arguments, runs the check, prints the summary.
 * A thrown usage error or a thrown check error becomes exit code 2, so script
 * defects can never be mistaken for violations (exit 1).
 *
 * @param {(args: GateArgs) => Violation[] | Promise<Violation[]>} check
 * @param {{ flags?: string[], argv?: string[] }} [options]
 * @returns {Promise<void>}
 */
export async function runGate(check, options = {}) {
  try {
    const args = parseArgs(options.argv ?? process.argv.slice(2), {
      flags: options.flags ?? [],
    });
    const violations = await check(args);

    finish(violations);
  } catch (error) {
    fail(error);
  }
}

/**
 * @param {Violation} violation
 * @param {number} index
 * @returns {Violation}
 */
function assertViolation(violation, index) {
  if (violation === null || typeof violation !== "object") {
    throw new TypeError(`violation at index ${index} is not an object`);
  }

  if (typeof violation.file !== "string" || violation.file === "") {
    throw new TypeError(`violation at index ${index} has no "file"`);
  }

  if (typeof violation.rule !== "string" || violation.rule === "") {
    throw new TypeError(`violation at index ${index} has no "rule"`);
  }

  if (typeof violation.message !== "string") {
    throw new TypeError(`violation at index ${index} has no "message"`);
  }

  if (violation.line !== undefined && !Number.isInteger(violation.line)) {
    throw new TypeError(`violation at index ${index} has a non-integer "line"`);
  }

  return violation;
}

/**
 * @param {Violation} a
 * @param {Violation} b
 * @returns {number}
 */
function compareViolations(a, b) {
  const fileA = toPosix(a.file);
  const fileB = toPosix(b.file);

  if (fileA !== fileB) {
    return fileA < fileB ? -1 : 1;
  }

  const lineA = a.line ?? Number.MAX_SAFE_INTEGER;
  const lineB = b.line ?? Number.MAX_SAFE_INTEGER;

  if (lineA !== lineB) {
    return lineA - lineB;
  }

  return a.rule.localeCompare(b.rule);
}

/**
 * @param {Violation} violation
 * @returns {string}
 */
function formatViolation(violation) {
  const file = toPosix(violation.file);
  const where = violation.line === undefined ? file : `${file}:${violation.line}`;

  return `${where} ${violation.rule} ${violation.message}`;
}
