/**
 * check-frame.mjs - the `frame` gate.
 *
 * What this gate is for
 *   The frame type table (FRAME_TYPES) is a data table
 *   that other items append to: C1, E*, D3 each add rows for their own frame
 *   types. Two things about it are invisible to the type checker:
 *
 *     1. Whether a frame type used in source is REGISTERED at all.
 *        `Frame["t"]` is a plain `string` by design, because a host may inject
 *        its own table (C5-Q24). So `send({ t: "term.ouput", ... })` -- one
 *        transposed letter -- compiles, and then fails in the renderer far
 *        from the typo.
 *     2. Whether the table stays APPEND-ONLY. `t` values become part of the
 *        wire contract the moment they land: downstream items write them into
 *        fixtures and hosts branch on them.
 *
 *   Row shape is deliberately NOT checked here. `satisfies Record<string,
 *   FrameTypeSpec>` already proves every existing row has the five fields, and
 *   a hand-rolled copy of that check would be a weaker second opinion. What
 *   the compiler cannot see is the set of rows against the set of uses.
 *
 * Why a source scan rather than narrowing the type
 *   Narrowing `Frame["t"]` to `KnownFrameType` would forbid exactly what the
 *   contract allows: a host injecting a table the shared package does not know
 *   about. A scan keeps the types open and the repository's own literals
 *   checked.
 *
 * How source is read
 *   Through the TypeScript parser, not regular expressions. `t:` is also an
 *   ordinary object key and a common short name, so a text match would report
 *   violations on unrelated code; the AST sees an object-literal property and
 *   can tell a quoted initializer from a computed one. `typescript` is already
 *   a devDependency; this gate adds none.
 *
 * Exit codes follow scripts/lib/gate-cli.mjs: 0 pass, 1 violation, 2 broken.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { toPosix, runGate } from "./lib/gate-cli.mjs";

/** Directories that hold workspace source. Mirrors check-boundaries' scan set. */
const SCAN_DIRS = ["packages", "apps"];

/** File extensions the scan reads. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** Directories never descended into. */
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
 * Where the frame type table lives, repo-relative.
 *
 * Read as text and parsed, not imported: `scripts/` cannot resolve the
 * workspace packages, and reading the file keeps this gate
 * runnable before the package is built.
 */
const FRAME_TYPES_FILE = "packages/protocol/src/frame/frame-types.ts";

/** Rule ids, one per failure mode. */
const RULES = {
  missingTable: "frame-table-missing",
  emptyTable: "frame-table-empty",
  unregistered: "frame-type-unregistered",
  badSummary: "frame-summary",
};

/**
 * @typedef {object} FrameTypeRow
 * @property {string} type the literal key, e.g. "bridge.ready"
 * @property {string | null} summary the `summary` property, or null when absent
 * @property {number} line 1-based line of the key
 */

/**
 * @typedef {object} FrameTable
 * @property {FrameTypeRow[]} rows
 * @property {{ line: number, rule: string, message: string }[]} problems
 */

/**
 * Parse one source file into a TypeScript source file node.
 *
 * @param {string} fileName absolute path
 * @param {string} text file contents
 * @returns {ts.SourceFile}
 */
function parseSource(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

/**
 * The literal text of a node, when it is a plain string literal.
 *
 * Template literals with no substitutions count: `` t: `bulk.page` `` is a
 * literal value written with backticks. A template with substitutions is not,
 * and returns null so the caller skips it rather than guessing.
 *
 * @param {ts.Node} node
 * @returns {string | null}
 */
function literalText(node) {
  if (ts.isStringLiteral(node)) {
    return node.text;
  }

  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return null;
}

/**
 * The static name of a property assignment, when it has one.
 *
 * @param {ts.Node} node
 * @returns {string | null}
 */
function propertyName(node) {
  if (!ts.isPropertyAssignment(node)) {
    return null;
  }

  const name = node.name;

  if (ts.isIdentifier(name)) {
    return name.text;
  }

  return literalText(name);
}

/**
 * Find the `FRAME_TYPES` declaration and read its rows.
 *
 * Returns null when the file does not exist, which is a real state of this
 * branch before the table's package is written. The caller turns that into one
 * violation rather than a crash, because "the table is missing" is something
 * the reader can act on.
 *
 * @param {string} root absolute repository root
 * @returns {FrameTable | null}
 */
function readFrameTypes(root) {
  const absolute = path.join(root, FRAME_TYPES_FILE);

  let text;

  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const source = parseSource(absolute, text);

  /** @type {FrameTypeRow[]} */
  const rows = [];
  /** @type {{ line: number, rule: string, message: string }[]} */
  const problems = [];

  /**
   * @param {ts.Node} node
   */
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === "FRAME_TYPES" && node.initializer !== undefined) {
        collectRows(node.initializer);
      }
    }

    ts.forEachChild(node, visit);
  }

  /**
   * @param {ts.Expression} initializer
   */
  function collectRows(initializer) {
    // `as const satisfies Record<string, FrameTypeSpec>` wraps the object, so
    // peel the outer expressions until the object literal is reached.
    let node = initializer;

    while (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      node = node.expression;
    }

    if (!ts.isObjectLiteralExpression(node)) {
      return;
    }

    for (const property of node.properties) {
      const name = propertyName(property);

      if (name === null || !ts.isPropertyAssignment(property)) {
        continue;
      }

      const line = source.getLineAndCharacterOfPosition(property.name.getStart(source)).line + 1;

      rows.push({ type: name, line, summary: summaryOf(property.initializer) });
    }
  }

  /**
   * @param {ts.Expression} initializer
   * @returns {string | null}
   */
  function summaryOf(initializer) {
    if (!ts.isObjectLiteralExpression(initializer)) {
      return null;
    }

    for (const property of initializer.properties) {
      if (propertyName(property) !== "summary" || !ts.isPropertyAssignment(property)) {
        continue;
      }

      return literalText(property.initializer);
    }

    return null;
  }

  visit(source);

  for (const row of rows) {
    if (row.summary === null || row.summary.trim() === "") {
      problems.push({
        line: row.line,
        rule: RULES.badSummary,
        message:
          `frame type "${row.type}" has no summary; every row carries a one-line English ` +
          "summary because it is printed in diagnostics",
      });
    }
  }

  return { rows, problems };
}

/**
 * Walk the workspace source and return repo-relative posix paths.
 *
 * @param {string} root absolute repository root
 * @returns {string[]}
 */
function scanSourceFiles(root) {
  /** @type {string[]} */
  const files = [];

  /**
   * @param {string} dirAbsolute absolute posix directory
   */
  function walk(dirAbsolute) {
    const entries = readdirSync(dirAbsolute, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.posix.join(dirAbsolute, entry.name);

      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          walk(absolute);
        }

        continue;
      }

      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.posix.extname(entry.name))) {
        files.push(toPosix(path.relative(root, absolute)));
      }
    }
  }

  for (const dirName of SCAN_DIRS) {
    const absolute = path.posix.join(root, dirName);

    if (!isDirectory(absolute)) {
      // Scanning nothing must never look like passing: the gate would report a
      // clean repository on a wrong `--root`.
      throw new Error(`expected workspace directory ${dirName}/, but it does not exist`);
    }

    walk(absolute);
  }

  return files;
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
 * Find every frame-type literal written in one source file.
 *
 * Two shapes are collected:
 *   { t: "bridge.ready" }             an object-literal property named `t`
 *   { type: "bridge.ready" }          the same, spelled out
 *
 * Computed values (`t: name`, `` t: `x.${y}` ``) are skipped: they cannot be
 * resolved without running the program, and reporting them would punish every
 * parameterised construction.
 *
 * @param {string} fileName absolute path, for diagnostics only
 * @param {string} text file contents
 * @returns {{ value: string, line: number }[]}
 */
function findFrameTypeLiterals(fileName, text) {
  const source = parseSource(fileName, text);
  /** @type {{ value: string, line: number }[]} */
  const literals = [];

  /**
   * @param {ts.Node} node
   */
  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);

      // `type` is a common identifier, so it is only trusted inside an object
      // literal that already looks like a frame: the other keys `ch`/`seq`/`v`
      // are what make `type` a frame type here. `t` alone is unambiguous
      // enough for the frame contract, but the same guard keeps a stray
      // `{ t: "..." }` in unrelated code from matching.
      if (name === "t" || name === "type") {
        const value = literalText(node.initializer);

        if (value !== null && ts.isObjectLiteralExpression(node.parent)) {
          const frameLike = node.parent.properties.some((property) => {
            const key = propertyName(property);

            return key === "ch" || key === "v" || key === "seq" || key === "body";
          });

          if (frameLike) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

            literals.push({ value, line });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);

  return literals;
}

/**
 * Collect every violation.
 *
 * @param {string} root absolute repository root
 * @returns {import("./lib/gate-cli.mjs").Violation[]}
 */
export function collectViolations(root) {
  const table = readFrameTypes(root);

  if (table === null) {
    return [
      {
        file: FRAME_TYPES_FILE,
        rule: RULES.missingTable,
        message:
          "the frame type table is missing; FRAME_TYPES is defined here and every frame " +
          "type in the repository must be registered in it",
      },
    ];
  }

  /** @type {import("./lib/gate-cli.mjs").Violation[]} */
  const violations = table.problems.map((problem) => ({
    file: FRAME_TYPES_FILE,
    line: problem.line,
    rule: problem.rule,
    message: problem.message,
  }));

  if (table.rows.length === 0) {
    violations.push({
      file: FRAME_TYPES_FILE,
      rule: RULES.emptyTable,
      message:
        "FRAME_TYPES has no rows; an empty table makes the registration check below pass " +
        "without inspecting anything",
    });

    return violations;
  }

  const registered = new Set(table.rows.map((row) => row.type));

  for (const file of scanSourceFiles(root)) {
    if (file === FRAME_TYPES_FILE) {
      continue;
    }

    const text = readFileSync(path.join(root, file), "utf8");

    for (const literal of findFrameTypeLiterals(path.join(root, file), text)) {
      if (registered.has(literal.value)) {
        continue;
      }

      violations.push({
        file,
        line: literal.line,
        rule: RULES.unregistered,
        message:
          `frame type "${literal.value}" is not registered in FRAME_TYPES; add the row to ` +
          `${FRAME_TYPES_FILE} or fix the spelling`,
      });
    }
  }

  return violations;
}

/**
 * Entry-point guard.
 *
 * The self-test imports `collectViolations` directly, so the CLI half must not
 * run on import. Both paths are canonicalized first, so a symlinked checkout or
 * a relative `argv[1]` still identifies the entry point; wrongly answering
 * "false" would silently skip the gate.
 */
const ENTRY_POINT = isEntryPoint(process.argv[1]);

if (ENTRY_POINT) {
  await runGate(({ root }) => collectViolations(root));
}

/**
 * @param {string | undefined} argv1
 * @returns {boolean}
 */
function isEntryPoint(argv1) {
  if (argv1 === undefined) {
    return false;
  }

  try {
    return (
      realpathSync.native(path.resolve(argv1)) ===
      realpathSync.native(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
