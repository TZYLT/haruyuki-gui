/**
 * module-ownership-sources.mjs - source parsing and path resolution for
 * scripts/check-module-ownership.mjs.
 *
 * Split out only to keep both files inside the repo's 1000 line limit. This
 * module holds no policy: it turns a file into dependency edges and turns a
 * specifier into the repo-relative file it denotes.
 *
 * Dependency forms recognised: static import (value and type-only), `export ... from`,
 * `export * from`, `import x = require("y")`, `require("y")`, `import("y")` and the
 * type-level `import("y").T`.
 *
 * Resolution boundary
 *   in-repo   Relative specifiers ("./x", "../x") resolved against the importing
 *             file, and workspace package specifiers resolved through
 *             packages/<name>/package.json and apps/<name>/package.json. These must
 *             resolve; the entry script turns a failure into an "unresolved"
 *             violation instead of skipping it.
 *   external  Node builtins ("node:fs" and the bare names in NODE_BUILTINS) and bare
 *             package names present in a node_modules directory of the root or of a
 *             workspace package. They are not edges of this repository.
 *   anything else (an in-repo specifier matching nothing, a path escaping the root,
 *             a bare name that is neither workspace, builtin nor installed) is
 *             unresolved.
 *   Probing order for a relative specifier: the exact path, the path plus
 *   .ts/.tsx/.mts/.cts/.js/.mjs/.cjs/.jsx, then the same extensions on <path>/index.
 *   A ".js"/".mjs"/".cjs" specifier also probes its TypeScript counterpart because
 *   ESM TypeScript writes "./x.js" for "./x.ts". An existing file with any other
 *   extension (an asset import) counts as resolved.
 *   A resolved path is CANONICAL: it is run through `realpathSync.native` and made
 *   relative to the canonical root, so a Windows case variant or a junction cannot
 *   smuggle an edge past the ownership policy. Ownership matching therefore stays
 *   on a single spelling of each path.
 *   Not modelled: path aliases other than workspace package names (a tsconfig "@/*"
 *   alias) and subpath imports ("#internal"). Such a bare name becomes unresolved
 *   rather than ignored, so introducing one later fails loudly.
 *
 * Barrel predicate (the fixtures under `fixtures/ownership/` are built against this)
 *   isBarrel is true when the file has at least one forwarding export and every
 *   statement is a forwarding export, an import or an empty statement. So any local
 *   declaration, any executable statement, `export {a}` without `from`, `export
 *   default`, `export =` and `export {}` all disqualify the file, and
 *   `export * from "./a"; export const own = 1;` is not a barrel. An
 *   `import x = require("y")` declaration is an import form, not a local
 *   declaration, so it does not by itself make a forwarding module a barrel.
 *   Declaration files (*.d.ts / *.d.mts / *.d.cts) are excluded by
 *   isDeclarationFile().
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { toPosix } from "./gate-cli.mjs";

/** Extensions that count as source. Kept identical to the other gates. */
export const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);

/** Extensions probed when a specifier omits one, in resolution order. */
export const PROBE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

/**
 * Cache of scan root -> canonical (realpath) posix form. A repository can be
 * reached through more than one absolute spelling (drive letter case, junction),
 * so the root is canonicalized once per run and reused for every resolved edge.
 *
 * @type {Map<string, string>}
 */
const canonicalRoots = new Map();

/** Suffixes that mark a declaration file. */
const DECLARATION_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"];

/** Names Node resolves without node_modules. */
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/**
 * @typedef {{ specifier: string, form: string, line: number }} Dependency
 * @typedef {{ dir: string, manifest: Record<string, unknown> }} WorkspacePackage
 * @typedef {{ kind: "resolved", file: string } | { kind: "external" } | { kind: "unresolved" }} Resolution
 */

/**
 * Parse one source file with the TypeScript scanner.
 *
 * @param {string} file Repo-relative posix path.
 * @param {string} text
 * @returns {import("typescript").SourceFile}
 */
export function parseSource(file, text) {
  const lowered = file.toLowerCase();
  let scriptKind = ts.ScriptKind.JS;

  if (lowered.endsWith(".tsx")) {
    scriptKind = ts.ScriptKind.TSX;
  } else if (lowered.endsWith(".jsx")) {
    scriptKind = ts.ScriptKind.JSX;
  } else if (lowered.endsWith(".ts") || lowered.endsWith(".mts") || lowered.endsWith(".cts")) {
    scriptKind = ts.ScriptKind.TS;
  }

  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind);
}

/**
 * Collect dependency edges and decide whether the file is a pure forwarding module.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {{ dependencies: Dependency[], forwarding: number, firstForwardingLine: number, isBarrel: boolean }}
 */
export function analyzeSource(sourceFile) {
  /** @type {Dependency[]} */
  const dependencies = [];
  let forwarding = 0;
  let firstForwardingLine = 0;
  let hasLocalDeclaration = false;

  for (const statement of sourceFile.statements) {
    if (ts.isEmptyStatement(statement)) {
      continue;
    }

    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      // `import x = require("y")` is an import form, not a local declaration:
      // treating it as one would let `import x = require("./b"); export * from
      // "./a";` pass the barrel check while still hiding ownership.
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier === undefined) {
        // `export {a}` / `export {}` re-exports a local name; that is not forwarding.
        hasLocalDeclaration = true;
        continue;
      }

      forwarding += 1;

      if (firstForwardingLine === 0) {
        firstForwardingLine = lineOf(sourceFile, statement);
      }

      continue;
    }

    // Everything else (declarations, `export =`, `export default`, executable
    // statements) proves the module has a body.
    hasLocalDeclaration = true;
  }

  visitDependencies(sourceFile, dependencies);

  return {
    dependencies,
    forwarding,
    firstForwardingLine,
    isBarrel: forwarding > 0 && !hasLocalDeclaration,
  };
}

/**
 * Walk the AST and record every dependency specifier.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {Dependency[]} dependencies
 * @returns {void}
 */
function visitDependencies(sourceFile, dependencies) {
  /**
   * @param {import("typescript").Node} node
   * @returns {void}
   */
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const typeOnly = node.importClause !== undefined && node.importClause.isTypeOnly === true;

      dependencies.push({
        specifier: node.moduleSpecifier.text,
        form: typeOnly ? "import type" : "import",
        line: lineOf(sourceFile, node),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const form = node.isTypeOnly
        ? "export type from"
        : node.exportClause === undefined
          ? "export * from"
          : "export from";

      dependencies.push({
        specifier: node.moduleSpecifier.text,
        form,
        line: lineOf(sourceFile, node),
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      dependencies.push({
        specifier: node.moduleReference.expression.text,
        form: "import = require()",
        line: lineOf(sourceFile, node),
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      dependencies.push({
        specifier: node.argument.literal.text,
        form: "import() type",
        line: lineOf(sourceFile, node),
      });
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";

      if (isDynamicImport || isRequire) {
        dependencies.push({
          specifier: node.arguments[0].text,
          form: isDynamicImport ? "import()" : "require()",
          line: lineOf(sourceFile, node),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/**
 * Resolve one specifier to the in-repo file it denotes.
 *
 * @param {string} root Absolute posix scan root.
 * @param {string} importer Repo-relative posix path of the importing file.
 * @param {string} specifier
 * @param {Map<string, WorkspacePackage>} workspace
 * @returns {Resolution}
 */
export function resolveDependency(root, importer, specifier, workspace) {
  if (isRelativeSpecifier(specifier)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));

    if (base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) {
      // Outside the scanned repository: nothing to compare ownership against.
      return { kind: "unresolved" };
    }

    const file = probeFile(root, base);

    return file === undefined ? { kind: "unresolved" } : { kind: "resolved", file };
  }

  const packageName = packageNameOf(specifier);
  const workspacePackage = workspace.get(packageName);

  if (workspacePackage !== undefined) {
    const subpath = specifier.slice(packageName.length).replace(/^\//, "");
    const bases =
      subpath === ""
        ? packageEntryBases(workspacePackage)
        : packageSubpathBases(workspacePackage, subpath);

    for (const candidate of bases) {
      const file = probeFile(root, candidate);

      if (file !== undefined) {
        return { kind: "resolved", file };
      }
    }

    return { kind: "unresolved" };
  }

  if (isNodeBuiltin(specifier)) {
    return { kind: "external" };
  }

  if (isInstalledPackage(root, packageName, workspace)) {
    return { kind: "external" };
  }

  return { kind: "unresolved" };
}

/**
 * True when the file is a TypeScript declaration file.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isDeclarationFile(file) {
  const lowered = file.toLowerCase();
  return DECLARATION_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
}

/**
 * Probe a repo-relative base path for the file it denotes.
 *
 * A hit is returned in canonical form (real path relative to the canonical root),
 * never in the spelling derived from the specifier. That is what closes the
 * Windows case-variant and junction bypasses: matching always sees the one real
 * location of the file.
 *
 * @param {string} root Absolute posix scan root.
 * @param {string} base Repo-relative posix path, already normalized.
 * @returns {string | undefined}
 */
function probeFile(root, base) {
  if (base === "" || base === "." || base.startsWith("../")) {
    return undefined;
  }

  // Exact match first: it covers explicit extensions and non-source assets.
  const exact = canonicalFile(root, base);

  if (exact !== undefined) {
    return exact;
  }

  const extension = path.posix.extname(base).toLowerCase();

  if (SOURCE_EXTENSIONS.has(extension)) {
    // ESM TypeScript writes "./x.js" for the "./x.ts" it compiles from.
    const stem = base.slice(0, -extension.length);
    const counterparts =
      extension === ".js"
        ? [".ts", ".tsx"]
        : extension === ".mjs"
          ? [".mts"]
          : extension === ".cjs"
            ? [".cts"]
            : [];

    for (const counterpart of counterparts) {
      const match = canonicalFile(root, `${stem}${counterpart}`);

      if (match !== undefined) {
        return match;
      }
    }

    return undefined;
  }

  for (const candidateExtension of PROBE_EXTENSIONS) {
    const match = canonicalFile(root, `${base}${candidateExtension}`);

    if (match !== undefined) {
      return match;
    }
  }

  for (const candidateExtension of PROBE_EXTENSIONS) {
    const match = canonicalFile(root, `${base}/index${candidateExtension}`);

    if (match !== undefined) {
      return match;
    }
  }

  return undefined;
}

/**
 * Canonical repo-relative posix path of an existing file below the root.
 *
 * @param {string} root Absolute posix scan root.
 * @param {string} base Repo-relative posix path.
 * @returns {string | undefined} Undefined when there is no file, or when its real
 *   location escapes the scanned root.
 */
function canonicalFile(root, base) {
  const absolute = path.posix.join(root, base);

  if (!isFile(absolute)) {
    return undefined;
  }

  let real;

  try {
    real = toPosix(realpathSync.native(absolute));
  } catch {
    // The file exists (checked above) but cannot be canonicalized: refuse to
    // guess a path, so the caller reports the edge as unresolved (exit 2 path).
    return undefined;
  }

  const relative = toPosix(path.posix.relative(canonicalRoot(root), real));

  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative)
  ) {
    return undefined;
  }

  return relative;
}

/**
 * Real (canonical) posix form of a scan root, computed once per run.
 *
 * @param {string} root Absolute posix scan root.
 * @returns {string}
 */
function canonicalRoot(root) {
  let canonical = canonicalRoots.get(root);

  if (canonical === undefined) {
    try {
      canonical = toPosix(realpathSync.native(root));
    } catch {
      canonical = toPosix(root);
    }

    canonicalRoots.set(root, canonical);
  }

  return canonical;
}

/**
 * Candidate entry paths of a workspace package imported by its bare name.
 *
 * @param {WorkspacePackage} workspacePackage
 * @returns {string[]}
 */
function packageEntryBases(workspacePackage) {
  const bases = [];
  const exportsField = workspacePackage.manifest.exports;
  let exported;

  if (typeof exportsField === "string") {
    exported = exportsField;
  } else if (isRecord(exportsField) && typeof exportsField["."] === "string") {
    exported = exportsField["."];
  }

  if (typeof exported === "string") {
    bases.push(path.posix.join(workspacePackage.dir, exported));
  }

  if (typeof workspacePackage.manifest.main === "string") {
    bases.push(path.posix.join(workspacePackage.dir, workspacePackage.manifest.main));
  }

  bases.push(path.posix.join(workspacePackage.dir, "src/index"));
  bases.push(path.posix.join(workspacePackage.dir, "index"));

  return bases.map((base) => path.posix.normalize(base));
}

/**
 * Candidate targets for a subpath import, e.g. `@haruyuki/ui/i18n/core`.
 *
 * The `exports` map is consulted first, because it is the package's own statement of
 * where a subpath lives. Joining the subpath onto the package directory was the original
 * behaviour and it is wrong for any package whose layout does not mirror its subpaths:
 * `./i18n/core` maps to `./src/i18n/core.ts`, and the join produced `ui/i18n/core`.
 *
 * That failure was not silent -- the gate reported the import as unresolved and refused
 * to run blind -- but it reported it against the source file that used the subpath,
 * which is the one place the problem was not.
 *
 * @param {WorkspacePackage} workspacePackage
 * @param {string} subpath specifier with the package name removed, no leading slash
 * @returns {string[]} repo-relative posix candidates, in priority order
 */
function packageSubpathBases(workspacePackage, subpath) {
  const bases = [];
  const exportsField = workspacePackage.manifest.exports;
  const key = `./${subpath}`;

  if (isRecord(exportsField)) {
    const target = exportsField[key];

    if (typeof target === "string") {
      bases.push(path.posix.join(workspacePackage.dir, target));
    } else if (isRecord(target)) {
      // Conditions are opaque here; any declared target is a better guess than the
      // subpath join, and `probeFile` rejects the ones that do not exist.
      for (const value of Object.values(target)) {
        if (typeof value === "string") {
          bases.push(path.posix.join(workspacePackage.dir, value));
        }
      }
    }
  }

  // The join, kept as a fallback: a package that mirrors its layout still resolves, and
  // a subpath that is only reachable by joining still gets a chance.
  bases.push(path.posix.join(workspacePackage.dir, subpath));

  return bases.map((base) => path.posix.normalize(base));
}

/**
 * Map workspace package names to their directories.
 *
 * A manifest that is not valid JSON, or has no name, is a script failure: the
 * caller maps a throw to exit code 2 instead of guessing ownership.
 *
 * @param {string} root
 * @returns {Map<string, WorkspacePackage>}
 */
export function loadWorkspacePackages(root) {
  /** @type {Map<string, WorkspacePackage>} */
  const workspace = new Map();

  for (const dirName of ["packages", "apps"]) {
    const base = path.posix.join(root, dirName);

    if (!isDirectory(base)) {
      continue;
    }

    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        continue;
      }

      const dir = `${dirName}/${entry.name}`;
      const manifestPath = path.posix.join(root, dir, "package.json");

      if (!isFile(manifestPath)) {
        continue;
      }

      let manifest;

      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        throw new Error(`${dir}/package.json is not valid JSON: ${detail}`);
      }

      if (!isRecord(manifest) || typeof manifest.name !== "string" || manifest.name === "") {
        throw new Error(
          `${dir}/package.json has no "name"; refusing to guess a workspace package name`,
        );
      }

      if (workspace.has(manifest.name)) {
        throw new Error(`workspace package name "${manifest.name}" is declared more than once`);
      }

      workspace.set(manifest.name, { dir, manifest });
    }
  }

  return workspace;
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
 * @param {string} specifier
 * @returns {boolean}
 */
function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) {
    return true;
  }

  return NODE_BUILTINS.has(packageNameOf(specifier));
}

/**
 * First package name of a bare specifier ("@scope/name/sub" or "name/sub").
 *
 * @param {string} specifier
 * @returns {string}
 */
function packageNameOf(specifier) {
  const segments = specifier.split("/");

  if (specifier.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }

  return segments[0];
}

/**
 * True when a bare package name exists in an installed node_modules directory.
 *
 * @param {string} root
 * @param {string} packageName
 * @param {Map<string, WorkspacePackage>} workspace
 * @returns {boolean}
 */
function isInstalledPackage(root, packageName, workspace) {
  if (existsSync(path.posix.join(root, "node_modules", packageName))) {
    return true;
  }

  for (const workspacePackage of workspace.values()) {
    if (existsSync(path.posix.join(root, workspacePackage.dir, "node_modules", packageName))) {
      return true;
    }
  }

  return false;
}

/**
 * @param {import("typescript").SourceFile} sourceFile
 * @param {import("typescript").Node} node
 * @returns {number} 1-based line of the node start.
 */
function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} absolute
 * @returns {boolean}
 */
export function isFile(absolute) {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} absolute
 * @returns {boolean}
 */
export function isDirectory(absolute) {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}
