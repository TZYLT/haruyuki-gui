/**
 * check-file-size.mjs - gate: no source file may exceed the 1000 line limit.
 *
 * Usage:
 *   node scripts/check-file-size.mjs                  # scan packages, apps, scripts
 *   node scripts/check-file-size.mjs --root <dir>     # scan another tree (self-tests only)
 *   node scripts/check-file-size.mjs --write-baseline # re-record the ratchet baseline
 *
 * Scope
 *   Directories: packages, apps, scripts.
 *   Root level:  the source files directly in the repository root, one level deep
 *                (for example eslint.config.mjs, vitest.config.mts). The 1000 line
 *                limit applies to every unregistered file, and a
 *                root-level config is a source file like any other. Generated files
 *                below the root level are not hand-written source and are skipped.
 *   Extensions:  .ts .tsx .mts .cts .js .mjs .cjs .jsx
 *   Skipped dirs (any depth): node_modules, dist, out, build, coverage, fixtures,
 *   _research, docs. `fixtures` is skipped because the gate self-tests there
 *   deliberately create oversized files.
 *
 * Line counting
 *   Lines are separated by "\n". A trailing segment without a newline still
 *   counts as a line, and an empty file counts as 0 lines. So "a\nb\n" is 2
 *   lines, "a\nb" is 2 lines and "" is 0 lines. "\r\n" is not special: the
 *   "\r" stays attached to the line it terminates and does not change the count.
 *
 * Ratchet baseline (scripts/source-file-size-baseline.json)
 *   A JSON object of { "<repo-relative posix path>": <recorded line count> }.
 *
 *   The rule has two tiers:
 *     - NEW files must be at or below 1000 lines. A new file is never
 *       registered: split it, or do not create it.
 *     - LEGACY files that already exceeded 1000 when the rule landed are pinned
 *       in the baseline at their exact line count. The pin is an exact value,
 *       not a ceiling, so the baseline and the file never drift apart:
 *         * grew                  -> violation: the baseline must be raised in
 *                                    the same change (wiring exception, logged)
 *         * shrank but still >1000 -> violation: ratchet the baseline down
 *         * reached <=1000         -> violation: delete the baseline entry
 *     Every accepted change therefore leaves the baseline equal to the real
 *     size, which keeps the ratchet history readable.
 *   - Baseline entry whose file no longer exists: reported as
 *     `file-size-baseline` so the baseline cannot rot into a list of dead paths.
 *   - Missing baseline file is treated as an empty baseline (`{}`).
 *     A malformed one is a configuration failure: exit code 2, never a pass.
 *
 * Exit codes: 0 = pass, 1 = violation, 2 = the script or its configuration is broken.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runGate, toPosix } from "./lib/gate-cli.mjs";

/** Hard per-file limit, in lines. */
const MAX_LINES = 1000;

/** Top-level directories that belong to this gate. */
const SCAN_DIRS = ["packages", "apps", "scripts"];

/** Directory names skipped at any depth. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  "fixtures",
  "_research",
  "docs",
]);

/** File extensions that count as source. Kept identical to the other gates. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"]);

/**
 * Name fragments that mark a root-level source file as generated build output.
 * Generated files are not hand-written, so the 1000 line rule does not apply.
 */
const GENERATED_FILE_MARKERS = [".generated."];

/** Repo-relative path of the ratchet baseline. */
const BASELINE_PATH = "scripts/source-file-size-baseline.json";

await runGate(collectViolations, { flags: ["write-baseline"] });

/**
 * Gate body. Runs the check, or rewrites the baseline when explicitly asked.
 *
 * @param {{ root: string, flags: Record<string, boolean> }} args
 * @returns {import("./lib/gate-cli.mjs").Violation[]}
 */
function collectViolations({ root, flags }) {
  if (flags["write-baseline"]) {
    return writeBaseline(root);
  }

  const baseline = readBaseline(root);
  const files = scanSourceFiles(root);
  /** @type {import("./lib/gate-cli.mjs").Violation[]} */
  const violations = [];

  for (const file of files) {
    const lineCount = countLines(readFileSync(path.posix.join(root, file), "utf8"));
    const recorded = baseline.get(file);

    if (recorded === undefined) {
      if (lineCount > MAX_LINES) {
        violations.push({
          file,
          line: MAX_LINES + 1,
          rule: "file-size",
          message:
            `${lineCount} lines exceeds the ${MAX_LINES} line limit. ` +
            `New files are never registered in ${BASELINE_PATH}: split by responsibility.`,
        });
      }

      continue;
    }

    // The baseline is an exact pin, not a ceiling. Any drift must be resolved in
    // the same change, so the recorded value always equals the real size.
    if (lineCount > recorded) {
      violations.push({
        file,
        line: recorded + 1,
        rule: "file-size",
        message:
          `${lineCount} lines exceeds the recorded baseline of ${recorded} lines. ` +
          `Split the file, or raise the baseline by exactly ${lineCount - recorded} line(s) ` +
          `for a wiring-only change and record it in the work log.`,
      });
      continue;
    }

    if (lineCount < recorded && lineCount > MAX_LINES) {
      violations.push({
        file,
        line: recorded,
        rule: "file-size-baseline",
        message:
          `shrank from the recorded baseline of ${recorded} to ${lineCount} lines; ` +
          `ratchet the baseline down to ${lineCount} in this change`,
      });
      continue;
    }

    if (lineCount <= MAX_LINES) {
      violations.push({
        file,
        line: recorded,
        rule: "file-size-baseline",
        message:
          `now ${lineCount} lines, at or below the ${MAX_LINES} line limit; ` +
          `delete its obsolete baseline entry`,
      });
    }
  }

  // A baseline entry pointing at nothing is dead weight and must be deleted.
  for (const file of baseline.keys()) {
    if (existsSync(path.posix.join(root, file))) {
      continue;
    }

    violations.push({
      file,
      rule: "file-size-baseline",
      message: `stale baseline entry: the file no longer exists, delete it from ${BASELINE_PATH}`,
    });
  }

  return violations;
}

/**
 * List repo-relative posix paths of every in-scope source file.
 *
 * Throws when nothing was found: a gate that inspected zero files must never
 * report PASS, otherwise a broken root or a renamed workspace silently disables
 * the check.
 *
 * @param {string} root
 * @returns {string[]}
 */
function scanSourceFiles(root) {
  /** @type {string[]} */
  const files = [];

  for (const dirName of SCAN_DIRS) {
    const directory = path.posix.join(root, dirName);

    if (!isDirectory(directory)) {
      continue;
    }

    walk(directory, root, files);
  }

  scanRootFiles(root, files);

  files.sort();

  if (files.length === 0) {
    throw new Error(
      `no source files found under ${SCAN_DIRS.join(", ")} or at the root of ${root}; ` +
        "refusing to report PASS without inspecting anything",
    );
  }

  return files;
}

/**
 * Collect the source files that sit directly in the repository root.
 *
 * Only regular files are considered: subdirectories are covered by SCAN_DIRS, and
 * directories outside that set (fixtures, docs, _research, node_modules) stay out
 * of scope. Generated files below the root level are skipped.
 *
 * @param {string} root Absolute posix scan root.
 * @param {string[]} files Accumulator.
 * @returns {void}
 */
function scanRootFiles(root, files) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      continue;
    }

    const lowered = entry.name.toLowerCase();

    if (!SOURCE_EXTENSIONS.has(path.posix.extname(lowered))) {
      continue;
    }

    if (GENERATED_FILE_MARKERS.some((marker) => lowered.includes(marker))) {
      continue;
    }

    files.push(toPosix(entry.name));
  }
}

/**
 * Depth-first walk collecting in-scope files as repo-relative posix paths.
 *
 * @param {string} directory Absolute posix directory.
 * @param {string} root Absolute posix scan root.
 * @param {string[]} files Accumulator.
 * @returns {void}
 */
function walk(directory, root, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.posix.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        walk(absolute, root, files);
      }

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!SOURCE_EXTENSIONS.has(path.posix.extname(entry.name).toLowerCase())) {
      continue;
    }

    files.push(toPosix(path.posix.relative(root, absolute)));
  }
}

/**
 * Count lines the way the gate defines them.
 *
 * @param {string} source File contents.
 * @returns {number}
 */
function countLines(source) {
  if (source === "") {
    return 0;
  }

  const segments = source.split("\n").length;

  return source.endsWith("\n") ? segments - 1 : segments;
}

/**
 * Load the ratchet baseline.
 *
 * Throws on anything that is not a JSON object of path -> non-negative integer,
 * and on read errors other than "the file does not exist yet".
 *
 * @param {string} root
 * @returns {Map<string, number>}
 */
function readBaseline(root) {
  const absolute = path.posix.join(root, BASELINE_PATH);
  /** @type {string} */
  let raw;

  try {
    raw = readFileSync(absolute, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return new Map();
    }

    throw error;
  }

  /** @type {unknown} */
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse ${BASELINE_PATH}: ${errorMessage(error)}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${BASELINE_PATH} must contain a JSON object of { "path": lineCount }`);
  }

  const baseline = new Map();

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${BASELINE_PATH}: entry "${key}" must be a non-negative integer line count`);
    }

    baseline.set(normalizeKey(key), value);
  }

  return baseline;
}

/**
 * Rewrite the baseline from the current tree (explicit `--write-baseline` only).
 *
 * The baseline is an exact pin per oversized file, so this command exists to
 * raise, lower or drop entries that already exist. It refuses to ADD a file:
 * new files must be split, and registering one has to be a deliberate manual
 * edit of the JSON, reviewed like any other rule change.
 *
 * @param {string} root
 * @returns {import("./lib/gate-cli.mjs").Violation[]} Violations; empty means the rewrite happened.
 */
function writeBaseline(root) {
  const files = scanSourceFiles(root);
  const previous = readBaseline(root);
  /** @type {Record<string, number>} */
  const entries = {};
  /** @type {import("./lib/gate-cli.mjs").Violation[]} */
  const violations = [];

  for (const file of files) {
    const lineCount = countLines(readFileSync(path.posix.join(root, file), "utf8"));

    if (lineCount <= MAX_LINES) {
      continue;
    }

    if (!previous.has(file)) {
      violations.push({
        file,
        line: MAX_LINES + 1,
        rule: "file-size",
        message:
          `${lineCount} lines exceeds the ${MAX_LINES} line limit and is not pinned yet. ` +
          `New files are never registered: split it. To pin a legacy file, add the entry ` +
          `to ${BASELINE_PATH} by hand and record the reason in the work log.`,
      });
      continue;
    }

    entries[file] = lineCount;
  }

  if (violations.length > 0) {
    return violations;
  }

  const absolute = path.posix.join(root, BASELINE_PATH);
  mkdirSync(path.posix.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(entries, null, 2)}\n`, "utf8");

  const count = Object.keys(entries).length;

  console.log(`Wrote ${count} baseline ${count === 1 ? "entry" : "entries"} to ${BASELINE_PATH}`);

  return [];
}

/**
 * Normalize a baseline key to the form used elsewhere: repo-relative posix.
 *
 * @param {string} key
 * @returns {string}
 */
function normalizeKey(key) {
  return toPosix(key).replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * @param {string} absolute
 * @returns {boolean}
 */
function isDirectory(absolute) {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingFile(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    /** @type {{ code?: unknown }} */ (error).code === "ENOENT"
  );
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
