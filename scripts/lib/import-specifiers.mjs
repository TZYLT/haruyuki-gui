/**
 * Import specifier collection: the AST layer of the package boundary gate.
 *
 * Kept out of `check-boundaries.mjs` so the gate itself stays under the
 * 1000-line limit; this module only parses and enumerates, it makes no
 * boundary verdict.
 */
import path from "node:path";

import ts from "typescript";

export function parseModule(file, text) {
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
export function collectSpecifiers(sourceFile) {
  /** @type {Array<{ text: string, position: number, typeOnly: boolean, names: string[] | null }>} */
  const found = [];

  /**
   * @param {import("typescript").Node} node A string-literal-like node.
   * @param {boolean} typeOnly
   * @returns {void}
   */
  const record = (node, typeOnly, names = null) => {
    const literal = /** @type {import("typescript").StringLiteralLike} */ (node);

    found.push({
      text: literal.text,
      position: literal.getStart(sourceFile),
      typeOnly,
      names,
    });
  };

  /**
   * Value binding names of a named import/export clause; null when the form
   * cannot be enumerated (namespace, default, side-effect, call forms).
   *
   * @param {import("typescript").NamedImports | import("typescript").NamedExports | undefined} clause
   * @returns {string[] | null}
   */
  const namesOf = (clause) => {
    // A namespace import has no enumerable bindings: it can reach every
    // export, so it is treated as an unbounded value import and stays red.
    if (
      clause === undefined ||
      (!ts.isNamedImports(clause) && !ts.isNamedExports(clause)) ||
      clause.elements.length === 0
    ) {
      return null;
    }

    /** @type {string[]} */
    const names = [];

    for (const element of clause.elements) {
      if (ts.isNamedImports(clause)) {
        if (element.isTypeOnly || element.name.text === "type") {
          continue;
        }

        names.push((element.propertyName ?? element.name).text);
      } else {
        if (element.isTypeOnly) {
          continue;
        }

        names.push((element.propertyName ?? element.name).text);
      }
    }

    return names.length === 0 ? null : names;
  };

  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      record(
        node.moduleSpecifier,
        isTypeOnlyImportClause(node.importClause),
        namesOf(node.importClause?.namedBindings),
      );
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier, isTypeOnlyExportDeclaration(node), namesOf(node.exportClause));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression, node.isTypeOnly === true);
    } else if (ts.isCallExpression(node) && isRequireCall(node)) {
      record(node.arguments[0], false);
    } else if (ts.isCallExpression(node) && isModuleRequireCall(node)) {
      record(node.arguments[0], false);
    } else if (ts.isCallExpression(node) && isCreateRequireResultCall(node)) {
      record(node.arguments[0], false);
    } else if (ts.isCallExpression(node) && isDynamicImportCall(node)) {
      record(node.arguments[0], false);
    } else if (ts.isImportTypeNode(node) && isLiteralImportTypeNode(node)) {
      // A type position exists only in type space, so every ImportTypeNode is
      // type-only: accepted on the type-allowed edges, rejected on R1/R8-R11.
      record(/** @type {import("typescript").LiteralTypeNode} */ (node.argument).literal, true);
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
 * `module.require("m")` with a static string argument. A non-literal argument
 * cannot be decided statically and is not collected (documented blind spot, the
 * same one `require(variable)` has).
 *
 * @param {import("typescript").CallExpression} node
 * @returns {boolean}
 */
function isModuleRequireCall(node) {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "require" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "module" &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

/**
 * `createRequire(<anything>)("<literal>")` with a static string argument.
 *
 * The `createRequire(...)` call itself is not a dependency (its argument is
 * usually `import.meta.url`); the module load is the *returned* function call,
 * which this test recognizes. Both the bare `createRequire` and a
 * `<namespace>.createRequire` callee are accepted.
 *
 * @param {import("typescript").CallExpression} node
 * @returns {boolean}
 */
function isCreateRequireResultCall(node) {
  if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
    return false;
  }

  if (!ts.isCallExpression(node.expression)) {
    return false;
  }

  const factory = node.expression.expression;

  if (ts.isIdentifier(factory)) {
    return factory.text === "createRequire";
  }

  return ts.isPropertyAccessExpression(factory) && factory.name.text === "createRequire";
}

/**
 * `import("<literal>")` in a type position, including `typeof import("...")`.
 *
 * @param {import("typescript").ImportTypeNode} node
 * @returns {boolean}
 */
function isLiteralImportTypeNode(node) {
  return ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal);
}

/**
 * The path form of one specifier: a path specifier as written, a `file:` URL
 * converted with `fileURLToPath`, or none for a bare/external specifier.
 *
 * @param {string} specifier
 * @returns {{ kind: "path", value: string } | { kind: "none" } | { kind: "file-url-error", message: string }}
 */
