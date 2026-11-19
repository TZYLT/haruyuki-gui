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
 *   - Extensions: ts, tsx, mts, cts, js, mjs, cjs, jsx. This matches the source
 *     extension set of the other gates, so a cycle made of .tsx/.jsx modules is
 *     found, and a tree that only contains them is not mistaken for "nothing
 *     analysed" (which used to fail with exit 2).
 *   - Declaration files (.d.ts / .d.mts / .d.cts) are excluded so they never take
 *     part in the graph.
 *   - Excluded at any depth, through `excludeRegExp`: node_modules, fixtures,
 *     _research, docs, dist, out, build, coverage. The pattern accepts both "/"
 *     and "\" because madge filters on strings produced from OS paths.
 *
 *   Syntax pre-check
 *     Before madge runs, every scanned file is parsed with `ts.createSourceFile`
 *     and its `parseDiagnostics` inspected (the same technique the ownership gate
 *     uses). A file that does not parse contributes no edges to the graph, so it
 *     would silently hide a cycle; instead the gate exits 2 and prints
 *     `file:line` plus the parser message.
 *
 *   Unresolved edges
 *     dependency-tree returns every specifier it could not resolve in
 *     `result.warnings().skipped`. A relative one is an in-repo import that
 *     vanished from the graph, so the gate exits 2 instead of passing. Bare
 *     package names are external (includeNpm is off) and are ignored.
 *
 * Failure policy
 *   If madge throws, returns an unusable object, analysed zero modules, dropped a
 *   relative specifier, or any scanned file has a syntax error, the script exits
 *   2. "Nothing analysed" must never be reported as "no cycles".
 *
 * Output
 *   One violation per cycle: `file` is the repo-relative posix path of the first
 *   module in the cycle, `message` chains the whole cycle with " -> ".
 *
 * Exit codes: 0 = pass, 1 = violation, 2 = the script or its configuration is broken.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import madge from "madge";
import ts from "typescript";

import { runGate, toPosix } from "./lib/gate-cli.mjs";

/** Top-level directories that belong to this gate. */
const SCAN_DIRS = ["packages", "apps", "scripts"];

/** File extensions handed to madge. */
const FILE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs", "jsx"];

/** Extensions that count as source during the syntax pre-check walk. */
const SOURCE_EXTENSIONS = new Set(FILE_EXTENSIONS.map((extension) => `.${extension}`));

/** Suffixes that mark a declaration file: never analysed. */
const DECLARATION_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"];

/** Directories pruned from the graph, matched at any depth. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "fixtures",
  "_research",
  "docs",
  "dist",
  "out",
  "build",
  "coverage",
]);

/**
 * madge filters tree keys (relative paths) with these regular expressions.
 * `excludeRegExp` must be an array; madge calls `.map()` on it.
 */
const EXCLUDE_PATTERNS = [
  `(^|[\\\\/])(${[...EXCLUDED_DIRS].join("|")})([\\\\/]|$)`,
  // Declaration files must not be analysed (or resolved) at all.
  "\\.d\\.(ts|mts|cts)$",
];

await runGate(collectViolations);

/**
 * Gate body: validate the graph, analyse the tree and turn every cycle into one
 * violation.
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

  const files = listSourceFiles(root);

  assertParsable(root, files);

  // madge is handed the files this gate decided are source, not the three
  // directories. Handing it `apps` makes it walk the tree on its own, and it
  // collects `skipped` specifiers from what it walked even when `excludeRegExp`
  // keeps those files out of the graph - so a bundled engine's relative imports
  // were reported as "unresolved in-repo imports" while zero artifact modules
  // appeared in the analysis. Same walk, two answers.
  //
  // With an explicit list, `skipped` can only describe a file that is actually
  // being judged. An in-scope file that imports into an excluded directory is
  // still reported, which is the case this assertion exists for.
  const absoluteFiles = files.map((file) => path.posix.join(root, file));

  /** @type {any} */
  let result;

  try {
    result = await madge(absoluteFiles, {
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

  assertNoSkippedRelativeImports(result);

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
 * Drop the files git ignores, leaving the ones a reviewer would call source.
 *
 * The gate has to judge the repository, not whatever happens to be on disk. Two
 * directories under `apps/` are written by the packaging pipeline and are
 * gitignored: a walk that trusts the filesystem reads the bundled engine output as
 * source, and then reports forty-six unresolved imports and cycles that exist only
 * inside a bundle. A correct tree goes red for anyone who ran `package` before
 * `verify --full`, and the report names specifiers nobody wrote.
 *
 * Ignore rules are asked for, rather than inferring "tracked is source": a file a
 * developer has just written is not tracked yet and still deserves judging, while
 * a build artifact is both untracked and ignored. `git check-ignore` draws exactly
 * that line.
 *
 * Every candidate goes in one call - the list is hundreds long and per-file
 * processes would dominate the gate's runtime. Exit code 1 means "none of these is
 * ignored", which is a normal answer; any other failure means git could not speak,
 * and then nothing is dropped: scanning too much is a noisy gate, dropping files
 * blindly is a blind one.
 *
 * @param {string} root absolute scan root
 * @param {string[]} files root-relative posix paths
 * @returns {string[]}
 */
function dropIgnoredFiles(root, files) {
  if (files.length === 0) {
    return files;
  }

  try {
    const listed = execFileSync("git", ["check-ignore", "-z", "--stdin"], {
      cwd: root,
      input: files.join("\0"),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    });

    const ignored = new Set(
      listed
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => toPosix(entry)),
    );

    return files.filter((file) => !ignored.has(toPosix(file)));
  } catch (error) {
    if (error !== null && typeof error === "object" && "status" in error && error.status === 1) {
      return files;
    }

    return files;
  }
}

/**
 * List repo-relative posix paths of every in-scope, non-declaration source file.
 *
 * Throws when nothing was found: the syntax pre-check must never silently inspect
 * zero files.
 *
 * @param {string} root
 * @returns {string[]}
 */
function listSourceFiles(root) {
  /** @type {string[]} */
  const collected = [];

  for (const dirName of SCAN_DIRS) {
    const directory = path.posix.join(root, dirName);

    if (isDirectory(directory)) {
      walk(directory, root, collected);
    }
  }

  const files = dropIgnoredFiles(root, collected).sort();

  if (files.length === 0) {
    throw new Error(
      `no source files found under ${SCAN_DIRS.join(", ")} in ${root}; ` +
        "refusing to report PASS without inspecting anything",
    );
  }

  return files;
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

    const lowered = entry.name.toLowerCase();

    if (DECLARATION_SUFFIXES.some((suffix) => lowered.endsWith(suffix))) {
      continue;
    }

    if (!SOURCE_EXTENSIONS.has(path.posix.extname(lowered))) {
      continue;
    }

    files.push(toPosix(path.posix.relative(root, absolute)));
  }
}

/**
 * Fail when a scanned file cannot be parsed.
 *
 * @param {string} root Absolute posix scan root.
 * @param {string[]} files Repo-relative posix paths.
 * @returns {void}
 */
function assertParsable(root, files) {
  for (const file of files) {
    const text = readFileSync(path.posix.join(root, file), "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      false,
      scriptKindOf(file),
    );
    const diagnostics = sourceFile.parseDiagnostics ?? [];

    if (diagnostics.length === 0) {
      continue;
    }

    const first = diagnostics[0];
    const start = typeof first.start === "number" ? first.start : 0;
    const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;

    throw new Error(
      `cannot parse ${file}:${line}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}; ` +
        "a file that does not parse hides its imports, so the cycle check cannot report PASS",
    );
  }
}

/**
 * Fail when dependency-tree dropped a relative import from the graph.
 *
 * `result.warnings().skipped` also lists bare (external) specifiers that cannot be
 * resolved without node modules; only relative specifiers are in-repo edges.
 *
 * @param {any} result madge result.
 * @returns {void}
 */
function assertNoSkippedRelativeImports(result) {
  if (typeof result.warnings !== "function") {
    throw new Error(
      "madge returned no warnings API; refusing to report PASS without checking unresolved imports",
    );
  }

  const warnings = result.warnings();
  const skipped = warnings !== null && typeof warnings === "object" ? warnings.skipped : undefined;

  if (!Array.isArray(skipped)) {
    throw new Error("madge returned malformed warnings; refusing to report PASS");
  }

  const relative = [...new Set(skipped)]
    .filter((item) => typeof item === "string" && isRelativeSpecifier(item))
    .sort();

  if (relative.length === 0) {
    return;
  }

  throw new Error(
    `unresolved in-repo import(s) were dropped from the graph: ` +
      `${relative.map((item) => `"${item}"`).join(", ")}; ` +
      "an unresolved edge makes the cycle check blind, so fix the specifier",
  );
}

/**
 * @param {string} specifier
 * @returns {boolean}
 */
function isRelativeSpecifier(specifier) {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

/**
 * @param {string} file
 * @returns {import("typescript").ScriptKind}
 */
function scriptKindOf(file) {
  const lowered = file.toLowerCase();

  if (lowered.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }

  if (lowered.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }

  if (lowered.endsWith(".ts") || lowered.endsWith(".mts") || lowered.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }

  return ts.ScriptKind.JS;
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
