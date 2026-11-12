/**
 * check-cycles.mjs - gate: the source tree must not contain circular imports.
 *
 * Usage:
 *   node scripts/check-cycles.mjs                  # scan packages, apps, scripts
 *   node scripts/check-cycles.mjs --root <dir>     # scan another tree (self-tests only)
 *
 * Implementation notes
 *   Detection is delegated to the pinned `madge` dependency (a CommonJS package,
 *   which ESM imports through its default export). madge walks the scan roots and
 *   runs dependency-tree / filing-cabinet over them.
 *
 *   - Scan roots: the `packages`, `apps` and `scripts` directories that exist
 *     under the root. They are passed in one madge call so a cycle spanning two
 *     of them is found too, with `baseDir` pinned to the root so every reported
 *     path is already repo-relative.
 *   - Extensions: ts, mts, cts, js, mjs, cjs. Declaration files are excluded so
 *     `.d.ts` never takes part in the graph.
 *   - Excluded at any depth, through `excludeRegExp`: node_modules, fixtures,
 *     _research, docs, dist, out, build, coverage. The pattern accepts both "/"
 *     and "\" because madge filters on strings produced from OS paths.
 *
 * Failure policy
 *   If madge throws, returns an unusable object, or analysed zero modules, the
 *   script exits 2. "Nothing analysed" must never be reported as "no cycles".
 *
 * Output
 *   One violation per cycle: `file` is the repo-relative posix path of the first
 *   module in the cycle, `message` chains the whole cycle with " -> ".
 *
 * Exit codes: 0 = pass, 1 = violation, 2 = the script or its configuration is broken.
 */

import { statSync } from "node:fs";
import path from "node:path";

import madge from "madge";

import { runGate, toPosix } from "./lib/gate-cli.mjs";

/** Top-level directories that belong to this gate. */
const SCAN_DIRS = ["packages", "apps", "scripts"];

/** File extensions handed to madge. */
const FILE_EXTENSIONS = ["ts", "mts", "cts", "js", "mjs", "cjs"];

/** Directories pruned from the graph, matched at any depth. */
const EXCLUDED_DIRS = [
  "node_modules",
  "fixtures",
  "_research",
  "docs",
  "dist",
  "out",
  "build",
  "coverage",
];

/**
 * madge filters tree keys (relative paths) with these regular expressions.
 * `excludeRegExp` must be an array; madge calls `.map()` on it.
 */
const EXCLUDE_PATTERNS = [
  `(^|[\\\\/])(${EXCLUDED_DIRS.join("|")})([\\\\/]|$)`,
  // Declaration files must not be analysed (or resolved) at all.
  "\\.d\\.ts$",
];

await runGate(collectViolations);

/**
 * Gate body: analyse the tree and turn every cycle into one violation.
 *
 * @param {{ root: string }} args
 * @returns {Promise<import("./lib/gate-cli.mjs").Violation[]>}
 */
async function collectViolations({ root }) {
  const srcPaths = SCAN_DIRS.map((dirName) => path.posix.join(root, dirName)).filter(isDirectory);

  if (srcPaths.length === 0) {
    throw new Error(
      `none of ${SCAN_DIRS.join(", ")} exists under ${root}; ` +
        "refusing to report PASS without inspecting anything",
    );
  }

  /** @type {any} */
  let result;

  try {
    result = await madge(srcPaths, {
      baseDir: root,
      fileExtensions: FILE_EXTENSIONS,
      excludeRegExp: EXCLUDE_PATTERNS,
      includeNpm: false,
      // Mixed `import`/`require` forms inside TS files are still imports; do not
      // drop them from the graph, or a cycle could slip through.
      detectiveOptions: {
        ts: { mixedImports: true },
        tsx: { mixedImports: true },
      },
    });
  } catch (error) {
    throw new Error(`circular import analysis failed for ${root}: ${errorMessage(error)}`);
  }

  if (result === undefined || result === null || typeof result.circular !== "function") {
    throw new Error("madge returned an unusable result; refusing to report PASS");
  }

  const analysed = typeof result.obj === "function" ? result.obj() : undefined;

  if (analysed === undefined || analysed === null || Object.keys(analysed).length === 0) {
    throw new Error(
      `madge analysed no modules under ${root}; refusing to report PASS without inspecting anything`,
    );
  }

  /** @type {unknown} */
  const cycles = result.circular();

  if (!Array.isArray(cycles)) {
    throw new Error("madge returned a non-array cycle list; refusing to report PASS");
  }

  /** @type {import("./lib/gate-cli.mjs").Violation[]} */
  const violations = [];

  for (const cycle of cycles) {
    if (!Array.isArray(cycle) || cycle.length === 0) {
      throw new Error("madge returned a malformed cycle; refusing to report PASS");
    }

    const chain = cycle.map((file) => toPosix(String(file)));
    // madge lists each module once; close the loop for the reader.
    const printed = [...chain, chain[0]].join(" -> ");

    violations.push({
      file: chain[0],
      rule: "circular",
      message: `circular import: ${printed}`,
    });
  }

  return violations;
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
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
