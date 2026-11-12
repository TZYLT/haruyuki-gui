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
    return stripTrailingSlash(toPosix(realpathSync(root)));
  } catch (error) {
    throw new Error(`cannot resolve the repository root ${root}: ${errorMessage(error)}`);
  }
}

/**
 * List repo-relative posix paths of every in-scope source file.
 *
 * Throws when nothing was found, or when no workspace package directory exists:
 * a gate that inspected nothing must never report PASS.
 *
 * @param {string} root Absolute posix scan root.
 * @returns {string[]}
 */
export function scanSourceFiles(root) {
  /** @type {string[]} */
  const files = [];
  let packageDirs = 0;

  for (const dirName of SCAN_DIRS) {
    const directory = path.posix.join(root, dirName);

    if (!isDirectory(directory)) {
      continue;
    }

    if (WORKSPACE_ROOTS.has(dirName)) {
      packageDirs += readdirSync(directory, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && !entry.isSymbolicLink(),
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

  if (packageDirs === 0) {
    throw new Error(
      `no package directory found under ${[...WORKSPACE_ROOTS].join(", ")} in ${root}; ` +
        "the boundary matrix would have nothing to judge, so this is not a pass",
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
    // package look like a local file (nor the other way round).
    const real = toPosix(realpathSync(candidate));

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
 * @param {string} root Absolute posix scan root.
 * @param {string} absolute Absolute posix path.
 * @returns {string | null}
 */
export function packageOfPath(root, absolute) {
  const segments = splitRepoRelative(root, absolute);

  if (segments === null || segments.length < 2 || !WORKSPACE_ROOTS.has(segments[0])) {
    return null;
  }

  return WORKSPACE_PACKAGES.has(segments[1]) ? segments[1] : null;
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

  if (segments === null || segments.length < 2 || !WORKSPACE_ROOTS.has(segments[0])) {
    return null;
  }

  return `${segments[0]}/${segments[1]}`;
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
  return target === root || target.startsWith(`${root}/`);
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
