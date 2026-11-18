/**
 * boundaries-resolve.mjs - specifier resolution and package attribution for
 * scripts/check-boundaries.mjs.
 *
 * This module owns the file-system side of the boundary gate: walking the scan
 * roots, resolving one specifier to a real file, and attributing a real path or
 * a bare package name to one of the five workspace packages. It makes no
 * boundary decision and knows no rule id; scripts/check-boundaries.mjs owns the
 * matrix, the rule ids and the messages.
 *
 * Contract
 *   - Every path entering this module is absolute posix (or repo-relative posix
 *     where a function says so); every path leaving it is absolute posix
 *     without a trailing slash. `toPosix()` from scripts/lib/gate-cli.mjs is
 *     applied at the boundaries.
 *   - Resolution fails closed. "No file inside the root" is `missing` with the
 *     primary guess attached, never an external dependency: an unresolved
 *     specifier would otherwise disable the boundary check without a signal.
 *     Only a path that provably leaves the repository is `outside`, i.e. an
 *     external dependency.
 *   - Symbolic links are neither walked nor trusted. A resolved candidate is
 *     canonicalized with realpath before attribution, so a node_modules symlink
 *     cannot disguise an internal package as a local file (or the reverse).
 *   - tsconfig `paths` aliases are not consulted. An alias that does not
 *     resolve ends up `missing` and therefore visible, never silently external.
 *   - Path comparison and package attribution follow the file system's own
 *     case rules. Windows is case-insensitive: `../../Core/src/index.ts`
 *     resolves against the real `packages/core`, so the segment `Core` must
 *     still be attributed to package `core`. Every resolved path is
 *     canonicalized with `realpathSync.native` (which restores the on-disk
 *     case) and, on Windows only, compared case-insensitively, while the
 *     returned package name is always the normalized lower-case one. On POSIX
 *     the comparison stays case-sensitive, so `packages/Core` is a different
 *     directory from `packages/core` and is attributed to neither.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import { toPosix } from "./gate-cli.mjs";

/** Top-level directories that belong to the gate. */
export const SCAN_DIRS = ["packages", "apps", "scripts"];

/** Top-level directories whose second segment names a workspace package. */
export const WORKSPACE_ROOTS = new Set(["packages", "apps"]);

/** Package names that take part in the boundary matrix. */
export const WORKSPACE_PACKAGES = new Set(["protocol", "core", "ui", "desktop", "vscode"]);

/** Package prefix of the workspace scope. */
const WORKSPACE_SCOPE = "@haruyuki/";

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

/**
 * Repo-relative directories skipped by full path, not by name.
 *
 * Both are produced by the packaging pipeline and both contain a copy of the
 * engine's own sources, so scanning them reports the engine's unresolved imports
 * as ours - and the verdict would then depend on whether somebody happened to
 * package, not on whether this code has a boundary violation.
 *
 * By path rather than by name because the names are ordinary words: the shell
 * keeps its runtime modules under `apps/desktop/src/main/runtime`, and skipping
 * every directory called `runtime` would quietly stop checking seven real source
 * files while still reporting PASS.
 */
const EXCLUDED_PATHS = new Set([
  "apps/desktop/release",
  "apps/desktop/runtime",
  "apps/desktop/runtime-lock.json",
]);

/** File extensions that count as source. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

/** Extensions tried when a specifier carries none, in resolution order. */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".d.ts"];

/**
 * An explicit JS extension addresses the compiled name of a TypeScript module,
 * so try the source it was compiled from as well (`./foo.js` -> `./foo.ts`).
 */
const JS_TO_TS_REWRITES = new Map([
  [".js", [".ts", ".tsx", ".d.ts"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts", ".d.mts"]],
  [".cjs", [".cts", ".d.cts"]],
]);

/** Host APIs, matched as a bare name or as a `<name>/...` deep import. */
const HOST_APIS = ["electron", "vscode"];

/**
 * Whether path segments compare case-insensitively. Windows is
 * case-insensitive by default, so `path.resolve()` and `statSync()` accept a
 * specifier such as `../../Core/src/index.ts` for the real `packages/core`
 * directory. POSIX stays case-sensitive: `Core` and `core` are two different
 * directories there.
 */
const CASE_INSENSITIVE_PATHS = process.platform === "win32";

/** Every Node builtin name, without the `node:` protocol prefix. */
const NODE_BUILTINS = new Set(builtinModules);

/**
 * Canonicalize the scan root through the file system, so every later containment
 * check compares canonical paths.
 *
 * @param {string} root Absolute path of the scan root.
 * @returns {string} Absolute posix path without a trailing slash.
 */
export function canonicalRoot(root) {
  try {
    return stripTrailingSlash(toPosix(realpathSync.native(root)));
  } catch (error) {
    throw new Error(`cannot resolve the repository root ${root}: ${errorMessage(error)}`);
  }
}

/**
 * List repo-relative posix paths of every in-scope source file.
 *
 * Throws when nothing was found, or when no workspace package directory exists:
 * a gate that inspected nothing must never report PASS. The directory check
 * counts only `packages/<name>` / `apps/<name>` entries whose name is one of
 * the five matrix packages, so a tree that merely holds an unrelated directory
 * (for example `packages/tooling`) is still an empty shell and exits 2.
 *
 * @param {string} root Absolute posix scan root.
 * @returns {string[]}
 */
export function scanSourceFiles(root) {
  /** @type {string[]} */
  const files = [];
  let matrixPackageDirs = 0;

  for (const dirName of SCAN_DIRS) {
    const directory = path.posix.join(root, dirName);

    if (!isDirectory(directory)) {
      continue;
    }

    if (WORKSPACE_ROOTS.has(dirName)) {
      matrixPackageDirs += readdirSync(directory, { withFileTypes: true }).filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          normalizedPackageName(entry.name) !== null,
      ).length;
    }

    walk(directory, root, files);
  }

  files.sort();

  if (files.length === 0) {
    throw new Error(
      `no source files found under ${SCAN_DIRS.join(", ")} in ${root}; ` +
        "refusing to report PASS without inspecting anything",
    );
  }

  if (matrixPackageDirs === 0) {
    throw new Error(
      `no workspace package directory (${[...WORKSPACE_PACKAGES].join(", ")}) found under ` +
        `${[...WORKSPACE_ROOTS].join(", ")} in ${root}; directories outside the five-package ` +
        "matrix cannot produce a boundary verdict, so this is not a pass",
    );
  }

  return files;
}

/**
 * Depth-first walk collecting in-scope files as repo-relative posix paths.
 * Symbolic links are never followed.
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

    // Checked before the directory-name rule and against the repo-relative path,
    // so a generated tree is skipped wherever it appears and a real source
    // directory that happens to share its name is still scanned.
    if (EXCLUDED_PATHS.has(toPosix(path.posix.relative(root, absolute)))) {
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
 * Resolve a path specifier to an existing file inside the root.
 *
 * @param {string} root Absolute posix scan root.
 * @param {string} fromDir Absolute posix directory of the importing module.
 * @param {string} specifier
 * @returns {{ status: "file", file: string } | { status: "outside" } | { status: "missing", tried: string }}
 */
export function resolvePathSpecifier(root, fromDir, specifier) {
  const resolved = path.isAbsolute(specifier)
    ? path.resolve(specifier)
    : path.resolve(fromDir, specifier);
  const base = toPosix(resolved);

  if (!isInside(root, base)) {
    return { status: "outside" };
  }

  for (const candidate of candidatePaths(base)) {
    if (!isFile(candidate)) {
      continue;
    }

    // Canonicalize before attributing: a symlink must not make an internal
    // package look like a local file (nor the other way round), and native
    // realpath restores the on-disk case of a case-insensitive file system.
    const real = toPosix(realpathSync.native(candidate));

    if (!isInside(root, real)) {
      return { status: "outside" };
    }

    return { status: "file", file: real };
  }

  return { status: "missing", tried: base };
}

/**
 * File candidates for one resolved base path, in resolution order.
 *
 * @param {string} base Absolute posix path.
 * @returns {string[]}
 */
function candidatePaths(base) {
  const candidates = [base];
  const extension = path.posix.extname(base).toLowerCase();
  const rewrites = JS_TO_TS_REWRITES.get(extension);

  if (rewrites !== undefined) {
    const stem = base.slice(0, base.length - extension.length);

    for (const replacement of rewrites) {
      candidates.push(stem + replacement);
    }
  }

  for (const candidate of RESOLVE_EXTENSIONS) {
    candidates.push(base + candidate);
    candidates.push(`${base}/index${candidate}`);
  }

  return [...new Set(candidates)];
}

/**
 * Package name for one resolved path, or null when the path is inside the root
 * but outside the five matrix packages.
 *
 * The returned name is always the normalized (lower-case) package name, even
 * when the path uses different casing, which Windows accepts for the same
 * directory.
 *
 * @param {string} root Absolute posix scan root.
 * @param {string} absolute Absolute posix path.
 * @returns {string | null}
 */
export function packageOfPath(root, absolute) {
  const segments = splitRepoRelative(root, absolute);

  if (segments === null || segments.length < 2) {
    return null;
  }

  const rootDir = normalizedWorkspaceRoot(segments[0]);

  if (rootDir === null) {
    return null;
  }

  return normalizedPackageName(segments[1]);
}

/**
 * The `packages/<name>` or `apps/<name>` prefix of a path whose package is not
 * in the matrix. Used for the verbose note only.
 *
 * @param {string} root Absolute posix scan root.
 * @param {string} absolute Absolute posix path.
 * @returns {string | null}
 */
export function workspaceRootOfPath(root, absolute) {
  const segments = splitRepoRelative(root, absolute);

  if (segments === null || segments.length < 2) {
    return null;
  }

  const rootDir = normalizedWorkspaceRoot(segments[0]);

  return rootDir === null ? null : `${rootDir}/${segments[1]}`;
}

/**
 * Package named by a bare `@haruyuki/...` specifier.
 *
 * @param {string} specifier
 * @returns {string | null} The package name, "unknown" for an `@haruyuki/...`
 *   name outside the five packages, or null when the specifier is not in scope.
 */
export function packageOfSpecifier(specifier) {
  if (!specifier.startsWith(WORKSPACE_SCOPE)) {
    return null;
  }

  const name = specifier.slice(WORKSPACE_SCOPE.length).split("/")[0];

  return WORKSPACE_PACKAGES.has(name) ? name : "unknown";
}

/**
 * Host API named by a specifier: `electron`, `electron/...` or `vscode`.
 *
 * @param {string} specifier
 * @returns {string | null}
 */
export function hostApiOf(specifier) {
  for (const name of HOST_APIS) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      return name;
    }
  }

  return null;
}

/**
 * Node builtin test: `node:*`, a builtin name, or a builtin subpath
 * (`fs/promises`, `assert/strict`).
 *
 * @param {string} specifier
 * @returns {boolean}
 */
export function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) {
    return true;
  }

  if (NODE_BUILTINS.has(specifier)) {
    return true;
  }

  return NODE_BUILTINS.has(specifier.split("/")[0]);
}

/**
 * @param {string} specifier
 * @returns {boolean}
 */
export function isPathSpecifier(specifier) {
  return specifier.startsWith(".") || path.isAbsolute(specifier);
}

/**
 * Render one path for a message: repo-relative when inside the root.
 *
 * @param {string} root Absolute posix scan root.
 * @param {string} absolute Absolute posix path.
 * @returns {string}
 */
export function describePath(root, absolute) {
  const relative = toPosix(path.relative(root, absolute));

  return relative === "" || relative.startsWith("../") ? absolute : relative;
}

/**
 * @param {string} root Absolute posix root.
 * @param {string} target Absolute posix path.
 * @returns {boolean}
 */
function isInside(root, target) {
  const foldedRoot = foldPath(root);
  const foldedTarget = foldPath(target);

  return foldedTarget === foldedRoot || foldedTarget.startsWith(`${foldedRoot}/`);
}

/**
 * Whether a repo-relative posix path is a test file.
 *
 * This is the repository's test-file convention, and it lives here rather than
 * in a second place because two gates must agree on it: the boundary gate
 * applies the R6 exemption (below), and `vitest` collects tests by the same
 * shape. A path that one calls a test and the other does not is either an
 * unenforced exemption or a test file nobody runs.
 *
 * It is deliberately an extension test on the whole path, not a directory
 * test: a colocated `foo.test.ts` next to `foo.ts` is the shape the renderer
 * already uses.
 *
 * @param {string} repoRelative Repo-relative posix path.
 * @returns {boolean}
 */
export function isTestFilePath(repoRelative) {
  return /\.test\.tsx?$/.test(repoRelative);
}

/**
 * Whether a value-import from `from` to `to` is exempt because the importing
 * file is a test.
 *
 * The exemption exists for exactly one edge. A test in the renderer has to
 * construct the real collaborators it exercises - a double, a fixture loader,
 * a sender - and those live in `core`. Writing them again inside the test
 * package would be a second implementation of the thing under test, and
 * `import type` cannot call anything, so the test could only assert against a
 * mock of itself.
 *
 * Every other restricted edge stays restricted in tests. In particular this
 * never relaxes R7 (renderer -> protocol values): the frame-type table reaches
 * the renderer by injection from the host, so no test needs to import it.
 *
 * @param {string} repoRelativeImporter Repo-relative posix path of the importer.
 * @param {string | null} from Importing package name, or null outside the matrix.
 * @param {string} to Imported package name.
 * @returns {boolean}
 */
export function isTestFileValueImportExempt(repoRelativeImporter, from, to) {
  return from === "ui" && to === "core" && isTestFilePath(repoRelativeImporter);
}

/**
 * Fold one path for comparison when the file system is case-insensitive.
 * On POSIX the value is returned unchanged, so `Core` and `core` stay distinct.
 *
 * @param {string} value Absolute posix path.
 * @returns {string}
 */
function foldPath(value) {
  return CASE_INSENSITIVE_PATHS ? value.toLowerCase() : value;
}

/**
 * Canonical workspace package name for one directory segment.
 *
 * @param {string} segment One repo-relative path segment.
 * @returns {string | null} The normalized package name, or null when the
 *   segment names no matrix package.
 */
function normalizedPackageName(segment) {
  return normalizedName(WORKSPACE_PACKAGES, segment);
}

/**
 * Canonical workspace root name (`packages` or `apps`) for one directory
 * segment.
 *
 * @param {string} segment One repo-relative path segment.
 * @returns {string | null}
 */
function normalizedWorkspaceRoot(segment) {
  return normalizedName(WORKSPACE_ROOTS, segment);
}

/**
 * Match one directory segment against a set of canonical names. Exact match
 * first; on a case-insensitive file system a case-insensitive match is accepted
 * and the canonical name is returned, never the caller's spelling.
 *
 * @param {Set<string>} names Canonical names.
 * @param {string} segment One directory segment.
 * @returns {string | null}
 */
function normalizedName(names, segment) {
  if (names.has(segment)) {
    return segment;
  }

  if (!CASE_INSENSITIVE_PATHS) {
    return null;
  }

  const folded = segment.toLowerCase();

  for (const name of names) {
    if (name.toLowerCase() === folded) {
      return name;
    }
  }

  return null;
}

/**
 * Repo-relative segments of an absolute path, or null when it is outside.
 *
 * @param {string} root Absolute posix scan root.
 * @param {string} absolute Absolute posix path.
 * @returns {string[] | null}
 */
function splitRepoRelative(root, absolute) {
  const relative = toPosix(path.relative(root, absolute));

  if (relative === "" || relative.startsWith("../")) {
    return null;
  }

  return relative.split("/");
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
 * @param {string} absolute
 * @returns {boolean}
 */
function isFile(absolute) {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
