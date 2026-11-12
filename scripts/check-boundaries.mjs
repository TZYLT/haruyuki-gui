/**
 * check-boundaries.mjs - gate: the authoritative package-boundary matrix check.
 *
 * Usage:
 *   node scripts/check-boundaries.mjs               # scan packages, apps, scripts
 *   node scripts/check-boundaries.mjs --root <dir>  # scan another tree (self-tests only)
 *   node scripts/check-boundaries.mjs --verbose     # print scan statistics
 *
 * Why this gate exists
 *   The ESLint rules in eslint.config.mjs match the *raw* import string. A
 *   cross-package dependency written as a relative path, a require() call, a
 *   dynamic import() or an `export ... from` re-export therefore never matches
 *   them. This script parses every module with `ts.createSourceFile`, resolves
 *   each specifier against the real file system, and decides the boundary from
 *   the resolved location. It is the final word; ESLint stays the fast,
 *   editor-facing first pass.
 *
 * The matrix (authoritative: this gate is the final word)
 *
 *   import side \ imported side | protocol | core |    ui    | desktop | vscode
 *   ---------------------------|----------|------|----------|---------|-------
 *   protocol                   |    -     |  X   |    X     |    X    |   X
 *   core                       |    +     |  -   |    X     |    X    |   X
 *   ui                         |    T     |  T   |    -     |    X    |   X
 *   desktop                    |    +     |  +   |    +     |    -    |   X
 *   vscode                     |    +     |  +   |    +     |    X    |   -
 *
 *   "+" value and type imports are allowed, "T" only type-only imports are
 *   allowed, "X" no import at all, "-" the package itself. MATRIX below is the
 *   authority; RULE_BY_EDGE only attaches a rule id, and the two are
 *   cross-checked at startup so they cannot drift apart silently.
 *
 * What counts as a dependency
 *   - ImportDeclaration (value, side-effect and `import type`)
 *   - ExportDeclaration (`export { x } from`, `export * from`, `export * as ns`)
 *   - ImportEqualsDeclaration (`import x = require("...")`)
 *   - CallExpression `require("...")` with one string-literal-like argument
 *   - dynamic `import("...")`
 *
 * Type-only detection
 *   The import clause is type-only (`import type X from`, phaseModifier
 *   TypeKeyword), or every named specifier is type-only (`import { type X }`).
 *   A mixed clause (`import { type X, y }`) is a value import. `export ... from`
 *   uses `isTypeOnly` plus, for named re-exports, "every specifier is
 *   type-only". A side-effect import (`import "..."`) and an empty named clause
 *   (`import {} from "..."`) are value imports: they execute the module.
 *
 * Resolution and attribution
 *   See scripts/lib/boundaries-resolve.mjs for the full contract. In short: a
 *   path specifier is resolved against the importing file's directory (exact
 *   path, path plus each source extension, path plus `/index.<ext>`, and a
 *   TypeScript rewrite of an explicit JS extension), canonicalized with
 *   realpath, and attributed to `packages/<name>` or `apps/<name>`. Bare
 *   `@haruyuki/<name>` specifiers map by name, deep paths included. `electron`,
 *   `vscode`, `node:*`, bare Node builtins and every other bare name are
 *   external dependencies: never matrix edges, only inputs for R2-R5 and R12.
 *   R12 is the shell-to-shell host-API rule: apps/desktop must not import the
 *   VSCode host API `vscode`, and apps/vscode must not import the Electron host
 *   API `electron` or `electron/*`. Internal packages stay matrix edges, so
 *   `@haruyuki/vscode` is R8/R9 material, never R12 material.
 *
 * Unresolved specifiers
 *   A path specifier that resolves to no file inside the root is a violation
 *   with rule `unresolved`: a typo would otherwise disable the boundary check
 *   for that import without any signal. A bare `@haruyuki/<name>` that names no
 *   workspace package is also `unresolved`, because it would otherwise be
 *   silently filed as an external dependency. A path that points outside the
 *   root is an external dependency and is not reported. tsconfig `paths`
 *   aliases are not consulted, so an alias fails visibly instead of silently.
 *
 * Declaration files
 *   `*.d.ts` files are scanned like any other module: a type-only import there
 *   is legal on the type-allowed edges, and a value-form import is still
 *   judged. The syntax form decides, not the file extension, so moving a
 *   forbidden value import into a `.d.ts` does not launder it.
 *
 * Fail-closed policy
 *   - Zero scanned modules: exit 2, never PASS.
 *   - No package directory under `packages`/`apps`: exit 2.
 *   - A source file that does not parse: exit 2. TypeScript would recover most
 *     imports, but "could not inspect the file" must never look like "clean".
 *   - A restricted matrix edge without a rule id (or the reverse): exit 2.
 *   - A bad `--root`: exit 2 (resolveRoot in scripts/lib/gate-cli.mjs).
 *   - Any other internal error: exit 2 (runGate maps throws to exit 2).
 *
 * Scope
 *   Directories: packages, apps, scripts.
 *   Extensions:  .ts .tsx .mts .cts .js .mjs .cjs
 *   Skipped dirs (any depth): node_modules, dist, out, build, coverage,
 *   fixtures, _research, docs. Symbolic links are never followed.
 *
 * Output
 *   English only, one violation per line, posix paths:
 *       <file>:<line> <rule> <message>
 *   `file` is the importing module, `line` is the line of the specifier.
 *   `--verbose` adds scan statistics and any directory that is not part of the
 *   matrix. Default output stays one violation per line plus the summary.
 *
 * Exit codes: 0 = pass, 1 = violation, 2 = the script or its configuration is broken.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import {
  WORKSPACE_PACKAGES,
  canonicalRoot,
  describePath,
  hostApiOf,
  isNodeBuiltin,
  isPathSpecifier,
  packageOfPath,
  packageOfSpecifier,
  resolvePathSpecifier,
  scanSourceFiles,
  workspaceRootOfPath,
} from "./lib/boundaries-resolve.mjs";
import { runGate } from "./lib/gate-cli.mjs";

/**
 * The authoritative permission matrix.
 *
 *   allow  - value and type-only imports are permitted
 *   type   - only type-only imports are permitted
 *   forbid - no import at all
 *
 * The diagonal (a package importing itself) is intentionally absent: it is
 * always allowed.
 */
const MATRIX = {
  protocol: { core: "forbid", ui: "forbid", desktop: "forbid", vscode: "forbid" },
  core: { protocol: "allow", ui: "forbid", desktop: "forbid", vscode: "forbid" },
  ui: { protocol: "type", core: "type", desktop: "forbid", vscode: "forbid" },
  desktop: { protocol: "allow", core: "allow", ui: "allow", vscode: "forbid" },
  vscode: { protocol: "allow", core: "allow", ui: "allow", desktop: "forbid" },
};

/**
 * Rule id per restricted matrix edge. Exactly one entry per `forbid`/`type`
 * cell of MATRIX; `assertMatrixIsConsistent()` enforces both directions.
 */
const RULE_BY_EDGE = new Map([
  ["protocol->core", { rule: "R1", permission: "forbid" }],
  ["protocol->ui", { rule: "R1", permission: "forbid" }],
  ["protocol->desktop", { rule: "R1", permission: "forbid" }],
  ["protocol->vscode", { rule: "R1", permission: "forbid" }],
  ["core->ui", { rule: "R10", permission: "forbid" }],
  ["core->desktop", { rule: "R10", permission: "forbid" }],
  ["core->vscode", { rule: "R10", permission: "forbid" }],
  ["ui->core", { rule: "R6", permission: "type" }],
  ["ui->protocol", { rule: "R7", permission: "type" }],
  ["ui->desktop", { rule: "R11", permission: "forbid" }],
  ["ui->vscode", { rule: "R11", permission: "forbid" }],
  ["desktop->vscode", { rule: "R8", permission: "forbid" }],
  ["vscode->desktop", { rule: "R9", permission: "forbid" }],
]);

/**
 * Violation message per rule id. The wording mirrors eslint.config.mjs so the
 * fast pass and the authoritative pass read the same to a developer.
 */
const RULE_MESSAGES = new Map([
  [
    "R1",
    (from, to) =>
      `R1: @haruyuki/${from} is the leaf package and must not import @haruyuki/${to} ` +
      "(deep paths and type-only imports included); move the shared code into @haruyuki/protocol instead",
  ],
  [
    "R6",
    (from, to) =>
      `R6: @haruyuki/${from} must not value-import @haruyuki/${to}; use 'import type' instead`,
  ],
  [
    "R7",
    (from, to) =>
      `R7: @haruyuki/${from} may only type-import @haruyuki/${to}; ` +
      "add 'import type' or move the shared runtime value out of @haruyuki/protocol",
  ],
  [
    "R8",
    (from, to) =>
      `R8: @haruyuki/${from} (apps/${from}) must not import the sibling app shell ` +
      `@haruyuki/${to} (type-only imports included)`,
  ],
  [
    "R9",
    (from, to) =>
      `R9: @haruyuki/${from} (apps/${from}) must not import the sibling app shell ` +
      `@haruyuki/${to} (type-only imports included)`,
  ],
  [
    "R10",
    (from, to) =>
      `R10: @haruyuki/${from} must not import @haruyuki/${to} (type-only imports included); ` +
      "the dependency edge points the other way",
  ],
  [
    "R11",
    (from, to) =>
      `R11: @haruyuki/${from} must not import the app shell @haruyuki/${to} ` +
      "(type-only imports included); the dependency edge points the other way",
  ],
]);

/**
 * R12: the host API each app shell must never import, keyed by the shell's
 * workspace package name. A shell binds its own host API (desktop -> electron,
 * vscode -> vscode); the other one only arrives by accident, for example when
 * an import is copied from one shell to the other.
 *
 * This table is keyed by *host API module name*, not by workspace package. The
 * internal packages `@haruyuki/desktop` / `@haruyuki/vscode` are ordinary
 * matrix edges (R8/R9): `packageOfSpecifier()` claims them before the external
 * branch runs, so a bare `vscode` here can never be mistaken for
 * `@haruyuki/vscode`.
 */
const FOREIGN_HOST_API_BY_SHELL = new Map([
  ["desktop", "vscode"],
  ["vscode", "electron"],
]);

await runGate(collectViolations, { flags: ["verbose"] });

/**
 * Gate body.
 *
 * @param {{ root: string, flags: Record<string, boolean> }} args
 * @returns {import("./lib/gate-cli.mjs").Violation[]}
 */
function collectViolations({ root, flags }) {
  assertMatrixIsConsistent();

  const scanRoot = canonicalRoot(root);
  const files = scanSourceFiles(scanRoot);
  /** @type {ScanStats} */
  const stats = {
    files: 0,
    specifiers: 0,
    internalEdges: 0,
    typeOnlyInternalEdges: 0,
    local: 0,
    external: 0,
    unresolved: 0,
    unknownPackageDirs: new Set(),
  };
  /** @type {import("./lib/gate-cli.mjs").Violation[]} */
  const violations = [];

  for (const file of files) {
    stats.files += 1;

    const absolute = path.resolve(scanRoot, file);
    const sourcePackage = packageOfPath(scanRoot, absolute);

    if (sourcePackage === null) {
      const unknownDir = workspaceRootOfPath(scanRoot, absolute);

      if (unknownDir !== null) {
        stats.unknownPackageDirs.add(unknownDir);
      }
    }

    const sourceFile = parseModule(file, readFileSync(absolute, "utf8"));

    if (sourceFile.parseDiagnostics.length > 0) {
      const diagnostic = sourceFile.parseDiagnostics[0];

      throw new Error(
        `cannot parse ${file} at line ${lineOf(sourceFile, diagnostic.start ?? 0)}: ` +
          `${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}; ` +
          "the boundary graph would silently miss imports in this file, so no verdict is reported",
      );
    }

    for (const specifier of collectSpecifiers(sourceFile)) {
      stats.specifiers += 1;

      violations.push(
        ...checkSpecifier({
          scanRoot,
          file,
          sourcePackage,
          stats,
          sourceLine: lineOf(sourceFile, specifier.position),
          specifier: specifier.text,
          typeOnly: specifier.typeOnly,
        }),
      );
    }
  }

  if (flags.verbose === true) {
    printStatistics(stats);
  }

  return violations;
}

/**
 * Decide one specifier: resolve it, classify it, apply the matrix and the
 * orthogonal host-API / Node-builtin constraints.
 *
 * @param {{
 *   scanRoot: string,
 *   file: string,
 *   sourcePackage: string | null,
 *   stats: ScanStats,
 *   sourceLine: number,
 *   specifier: string,
 *   typeOnly: boolean,
 * }} input
 * @returns {import("./lib/gate-cli.mjs").Violation[]}
 */
function checkSpecifier({ scanRoot, file, sourcePackage, stats, sourceLine, specifier, typeOnly }) {
  const violation = (rule, message) => [{ file, line: sourceLine, rule, message }];

  // 1. Path specifiers: resolved against the importing file's directory.
  if (isPathSpecifier(specifier)) {
    const resolution = resolvePathSpecifier(
      scanRoot,
      path.dirname(path.resolve(scanRoot, file)),
      specifier,
    );

    if (resolution.status === "outside") {
      stats.external += 1;
      return [];
    }

    if (resolution.status === "missing") {
      stats.unresolved += 1;
      return violation(
        "unresolved",
        `specifier "${specifier}" does not resolve to an existing file (tried ` +
          `"${describePath(scanRoot, resolution.tried)}"); an unresolved specifier silently ` +
          "disables the boundary check, so fix the path or delete the import",
      );
    }

    const targetPackage = packageOfPath(scanRoot, resolution.file);

    if (targetPackage === null) {
      stats.local += 1;
      return [];
    }

    countInternalEdge(stats, typeOnly);

    const edge = evaluateEdge(sourcePackage, targetPackage, typeOnly);

    return edge === null ? [] : violation(edge.rule, edge.message);
  }

  // 2. Internal package names, deep paths included.
  const namedPackage = packageOfSpecifier(specifier);

  if (namedPackage !== null) {
    if (namedPackage === "unknown") {
      stats.unresolved += 1;
      return violation(
        "unresolved",
        `specifier "${specifier}" names no workspace package (known: ` +
          `${[...WORKSPACE_PACKAGES].join(", ")}); a name outside the matrix would be ` +
          "silently treated as an external dependency",
      );
    }

    countInternalEdge(stats, typeOnly);

    const edge = evaluateEdge(sourcePackage, namedPackage, typeOnly);

    return edge === null ? [] : violation(edge.rule, edge.message);
  }

  // 3. External dependencies: never matrix edges, only R2-R5 and R12.
  stats.external += 1;

  const hostApi = hostApiOf(specifier);

  if (hostApi !== null) {
    const hostViolation = hostApiViolation(sourcePackage, hostApi);

    return hostViolation === null ? [] : violation(hostViolation.rule, hostViolation.message);
  }

  if (isNodeBuiltin(specifier)) {
    const builtinViolation = nodeBuiltinViolation(sourcePackage, specifier);

    return builtinViolation === null
      ? []
      : violation(builtinViolation.rule, builtinViolation.message);
  }

  return [];
}

/**
 * @param {ScanStats} stats
 * @param {boolean} typeOnly
 * @returns {void}
 */
function countInternalEdge(stats, typeOnly) {
  stats.internalEdges += 1;

  if (typeOnly) {
    stats.typeOnlyInternalEdges += 1;
  }
}

/**
 * Apply the matrix to one resolved edge.
 *
 * @param {string | null} from Importing package, or null when the importer is
 *   outside the five matrix packages (for example a file under `scripts`).
 * @param {string} to Imported package.
 * @param {boolean} typeOnly Whether the import is type-only.
 * @returns {{ rule: string, message: string } | null} Null when allowed.
 */
function evaluateEdge(from, to, typeOnly) {
  if (from === null || from === to) {
    return null;
  }

  const row = MATRIX[from];

  if (row === undefined) {
    throw new Error(`no matrix row for package "${from}"`);
  }

  const permission = row[to];

  if (permission === undefined) {
    // The package names are fixed, so a missing cell means a defect here.
    throw new Error(`no matrix cell for ${from} -> ${to}`);
  }

  if (permission === "allow" || (permission === "type" && typeOnly)) {
    return null;
  }

  const edge = RULE_BY_EDGE.get(`${from}->${to}`);
  const message = edge === undefined ? undefined : RULE_MESSAGES.get(edge.rule);

  if (edge === undefined || message === undefined) {
    throw new Error(`no rule id for the restricted matrix edge ${from} -> ${to}`);
  }

  return { rule: edge.rule, message: message(from, to) };
}

/**
 * R2/R3/R5/R12: the host-API constraints, which sit outside the matrix.
 *
 * The shared packages must not touch any host API at all. Each app shell owns
 * one host API and must not import the other one (R12), which is a separate
 * question from the matrix: `vscode` is a host API module name, while
 * `@haruyuki/vscode` is an internal package handled by R8/R9.
 *
 * @param {string | null} sourcePackage
 * @param {string} hostApi
 * @returns {{ rule: string, message: string } | null}
 */
function hostApiViolation(sourcePackage, hostApi) {
  if (sourcePackage === "core") {
    return {
      rule: "R2",
      message:
        `R2: @haruyuki/core must not import the host API "${hostApi}"; ` +
        "keep host wiring in apps/*",
    };
  }

  if (sourcePackage === "protocol") {
    return {
      rule: "R3",
      message:
        `R3: @haruyuki/protocol must not import the host API "${hostApi}"; ` +
        "keep host wiring in apps/*",
    };
  }

  if (sourcePackage === "ui") {
    return {
      rule: "R5",
      message:
        `R5: @haruyuki/ui is the renderer and must not import the host API "${hostApi}"; ` +
        "talk to the host through @haruyuki/protocol instead",
    };
  }

  if (sourcePackage !== null && FOREIGN_HOST_API_BY_SHELL.get(sourcePackage) === hostApi) {
    return {
      rule: "R12",
      message:
        `R12: @haruyuki/${sourcePackage} (apps/${sourcePackage}) binds its own host API and ` +
        `must not import the other shell's host API "${hostApi}" (type-only imports included); ` +
        "keep each shell bound to its own host",
    };
  }

  return null;
}

/**
 * R4: the renderer must stay free of Node builtins.
 *
 * @param {string | null} sourcePackage
 * @param {string} specifier
 * @returns {{ rule: string, message: string } | null}
 */
function nodeBuiltinViolation(sourcePackage, specifier) {
  if (sourcePackage !== "ui") {
    return null;
  }

  return {
    rule: "R4",
    message:
      `R4: @haruyuki/ui is the renderer and must not import the Node builtin "${specifier}"; ` +
      "keep I/O in @haruyuki/core",
  };
}

/**
 * Cross-check the matrix against the rule table, so a matrix edit that forgets
 * a rule id (or a rule for a cell that no longer exists) fails loudly instead
 * of leaving the edge silently unchecked.
 *
 * @returns {void}
 */
function assertMatrixIsConsistent() {
  /** @type {Array<{ key: string, permission: string }>} */
  const restricted = [];

  for (const [from, row] of Object.entries(MATRIX)) {
    for (const [to, permission] of Object.entries(row)) {
      if (from === to || permission === "allow") {
        continue;
      }

      restricted.push({ key: `${from}->${to}`, permission });
    }
  }

  if (restricted.length !== RULE_BY_EDGE.size) {
    throw new Error(
      `matrix has ${restricted.length} restricted edge(s) but RULE_BY_EDGE has ` +
        `${RULE_BY_EDGE.size}; the matrix and the rule table must describe the same cells`,
    );
  }

  for (const cell of restricted) {
    const edge = RULE_BY_EDGE.get(cell.key);

    if (edge === undefined) {
      throw new Error(`matrix edge ${cell.key} is "${cell.permission}" but has no rule id`);
    }

    if (edge.permission !== cell.permission) {
      throw new Error(
        `matrix edge ${cell.key} is "${cell.permission}" but its rule is registered as ` +
          `"${edge.permission}"`,
      );
    }

    if (!RULE_MESSAGES.has(edge.rule)) {
      throw new Error(`rule ${edge.rule} for matrix edge ${cell.key} has no message`);
    }
  }

  for (const key of RULE_BY_EDGE.keys()) {
    if (!restricted.some((cell) => cell.key === key)) {
      throw new Error(`rule table entry ${key} has no restricted matrix cell`);
    }
  }
}

/**
 * Parse one module. No ts.Program is created: a boundary decision needs syntax
 * only, and a program over the whole tree would be far slower.
 *
 * @param {string} file Repo-relative posix path, used for the line map only.
 * @param {string} text File contents.
 * @returns {import("typescript").SourceFile}
 */
function parseModule(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
}

/**
 * @param {string} file
 * @returns {import("typescript").ScriptKind}
 */
function scriptKindOf(file) {
  const extension = path.posix.extname(file).toLowerCase();

  if (extension === ".tsx") {
    return ts.ScriptKind.TSX;
  }

  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return ts.ScriptKind.TS;
  }

  return ts.ScriptKind.JS;
}

/**
 * Collect every dependency-bearing node of one module.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {Array<{ text: string, position: number, typeOnly: boolean }>}
 */
function collectSpecifiers(sourceFile) {
  /** @type {Array<{ text: string, position: number, typeOnly: boolean }>} */
  const found = [];

  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier;

      found.push({
        text: specifier.text,
        position: specifier.getStart(sourceFile),
        typeOnly: isTypeOnlyImportClause(node.importClause),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier;

      found.push({
        text: specifier.text,
        position: specifier.getStart(sourceFile),
        typeOnly: isTypeOnlyExportDeclaration(node),
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      const specifier = node.moduleReference.expression;

      found.push({
        text: specifier.text,
        position: specifier.getStart(sourceFile),
        typeOnly: node.isTypeOnly === true,
      });
    } else if (ts.isCallExpression(node) && isRequireCall(node)) {
      const argument = /** @type {import("typescript").StringLiteralLike} */ (node.arguments[0]);

      found.push({
        text: argument.text,
        position: argument.getStart(sourceFile),
        typeOnly: false,
      });
    } else if (ts.isCallExpression(node) && isDynamicImportCall(node)) {
      const argument = /** @type {import("typescript").StringLiteralLike} */ (node.arguments[0]);

      found.push({
        text: argument.text,
        position: argument.getStart(sourceFile),
        typeOnly: false,
      });
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);

  return found;
}

/**
 * Type-only test for an import clause.
 *
 * `import type X from "m"` and `import type * as ns from "m"` are type-only.
 * `import { type X } from "m"` is type-only; `import { type X, y } from "m"` and
 * an empty clause both mean the module is executed, so they are value imports.
 *
 * @param {import("typescript").ImportClause | undefined} clause
 * @returns {boolean}
 */
function isTypeOnlyImportClause(clause) {
  if (clause === undefined) {
    // Side-effect import: `import "m"` runs the module.
    return false;
  }

  if (clause.isTypeOnly === true || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
    return true;
  }

  const bindings = clause.namedBindings;

  if (bindings === undefined || !ts.isNamedImports(bindings)) {
    return false;
  }

  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

/**
 * Type-only test for `export ... from`.
 *
 * @param {import("typescript").ExportDeclaration} node
 * @returns {boolean}
 */
function isTypeOnlyExportDeclaration(node) {
  if (node.isTypeOnly === true) {
    return true;
  }

  const clause = node.exportClause;

  if (clause === undefined || !ts.isNamedExports(clause)) {
    // `export * from` and `export * as ns from` re-export values.
    return false;
  }

  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

/**
 * `require("m")`, with exactly one string-literal-like argument.
 *
 * @param {import("typescript").CallExpression} node
 * @returns {boolean}
 */
function isRequireCall(node) {
  return (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

/**
 * `import("m")` in expression position, with a static string argument.
 *
 * @param {import("typescript").CallExpression} node
 * @returns {boolean}
 */
function isDynamicImportCall(node) {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

/**
 * @param {import("typescript").SourceFile} sourceFile
 * @param {number} position
 * @returns {number} 1-based line number.
 */
function lineOf(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

/**
 * Print the scan statistics. Explicit `--verbose` only: the default output of a
 * gate stays one violation per line plus the summary.
 *
 * @param {ScanStats} stats
 * @returns {void}
 */
function printStatistics(stats) {
  console.log(
    `Scanned ${stats.files} module(s) and ${stats.specifiers} specifier(s): ` +
      `${stats.internalEdges} internal package edge(s) (${stats.typeOnlyInternalEdges} type-only), ` +
      `${stats.local} local, ${stats.external} external, ${stats.unresolved} unresolved.`,
  );

  if (stats.unknownPackageDirs.size > 0) {
    console.log(
      "Note: skipped as import sources because they are not in the five-package matrix: " +
        [...stats.unknownPackageDirs].sort().join(", "),
    );
  }

  if (stats.unresolved > 0) {
    console.log(
      "Note: unresolved specifiers are violations; tsconfig 'paths' aliases are not consulted.",
    );
  }
}

/**
 * @typedef {object} ScanStats
 * @property {number} files
 * @property {number} specifiers
 * @property {number} internalEdges
 * @property {number} typeOnlyInternalEdges
 * @property {number} local
 * @property {number} external
 * @property {number} unresolved
 * @property {Set<string>} unknownPackageDirs
 */
