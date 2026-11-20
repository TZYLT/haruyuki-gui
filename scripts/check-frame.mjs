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
 *   FrameTypeSpec>` already proves every existing row has the four fields, and
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

/**
 * Directories that hold workspace source.
 *
 * Narrower than `check-boundaries`' scan set on purpose: that gate also reads
 * `scripts/`, while this one reads only the packages whose code can emit a
 * frame. A gate scripts/ file writing a frame type is rare enough that the
 * difference is not worth a second dialect, but the two sets are NOT the same
 * and this comment says so rather than claiming a mirror.
 */
const SCAN_DIRS = ["packages", "apps"];

/** File extensions the scan reads. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * Test files are skipped, and the reason is not "tests are less important".
 *
 * A test deliberately constructs values production code must never emit: an
 * empty frame type, a single letter standing in for "some type", a type the
 * test itself asserts must be REJECTED. Those literals are the test's input,
 * not a claim about the wire, so registering them in `FRAME_TYPES` would put
 * invented types into the contract -- and there is nowhere sensible to put a
 * type whose whole purpose is to be invalid.
 *
 * The production half is still fully covered: every non-test source file is
 * scanned, and the renderer's own consumers are production code.
 *
 * The same convention as `isTestFilePath` in boundaries-resolve.mjs: the
 * suffix decides, so a file merely containing "test" is still production.
 */
const TEST_FILE_PATTERN = /\.test\.tsx?$/;

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
  unresolvedSummary: "frame-summary-unresolved",
  unresolvedLiteral: "frame-type-unresolved",
};

/**
 * The three channel names of the frozen envelope.
 *
 * Used to tell a frame-shaped object from an unrelated one that happens to have
 * a `t` key: the channel set is closed - `control`, `stream` and `bulk`.
 */
const CHANNEL_VALUES = new Set(["control", "stream", "bulk"]);

/**
 * @typedef {object} FrameTypeRow
 * @property {string} type the literal key, e.g. "bridge.ready"
 * @property {{ kind: "literal", value: string } |
 *   { kind: "unresolved", text: string } |
 *   { kind: "missing" }} summary the `summary` property's readability
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
  const kind = scriptKindOf(fileName);
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, kind);

  // A file the parser could not read is not a file with nothing to report. TSX
  // in a `.ts` parse is the concrete case: JSX is a syntax error there, the
  // recovered tree drops the elements, and every literal inside a JSX attribute
  // becomes invisible. Reporting that as PASS is the one failure mode this gate
  // must never have, so it is a hard error instead.
  if (source.parseDiagnostics.length > 0) {
    const first = source.parseDiagnostics[0];

    throw new Error(
      `cannot parse ${fileName}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")} ` +
        "at line " +
        String(source.getLineAndCharacterOfPosition(first.start).line + 1) +
        "; the frame gate cannot certify a file it could not read",
    );
  }

  return source;
}

/**
 * The parser dialect for one file, by extension.
 *
 * `.tsx` must be parsed as TSX or JSX becomes a syntax error; everything else
 * stays TS. `.js`/`.mjs`/`.cjs` are not scanned at all (see SOURCE_EXTENSIONS),
 * so no dialect has to be chosen for them.
 *
 * @param {string} fileName absolute or repo-relative path
 * @returns {ts.ScriptKind}
 */
function scriptKindOf(fileName) {
  return fileName.toLowerCase().endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
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
      throw new Error(
        `FRAME_TYPES is not an object literal in ${FRAME_TYPES_FILE}; the gate reads the table ` +
          "statically and cannot resolve a reference or a call, so a table assembled some other " +
          "way would be reported as empty",
      );
    }

    for (const property of node.properties) {
      // A spread would smuggle rows past the reader: the object would look
      // populated while the gate saw none of them, which is the "clean table
      // with no rows" failure the empty-table rule exists to prevent.
      if (ts.isSpreadAssignment(property)) {
        throw new Error(
          `FRAME_TYPES spreads another object in ${FRAME_TYPES_FILE}; the gate resolves rows ` +
            "statically and cannot follow a spread, so those rows would be silently unregistered",
        );
      }

      const name = propertyName(property);

      if (name === null || !ts.isPropertyAssignment(property)) {
        continue;
      }

      const line = source.getLineAndCharacterOfPosition(property.name.getStart(source)).line + 1;

      rows.push({ type: name, line, summary: summaryOf(property.initializer) });
    }
  }

  /**
   * Read one row's `summary`, distinguishing "absent" from "not a literal".
   *
   * The distinction matters because the two need different answers. A row with
   * no `summary` is a real violation: the field is printed in diagnostics. A row
   * whose `summary` is a shared constant or an interpolated template is correct
   * code the gate simply cannot read, and reporting that as "has no summary"
   * would fail a merge over a legal refactor.
   *
   * @param {ts.Expression} initializer
   * @returns {{ kind: "literal", value: string } |
   *   { kind: "unresolved", text: string } |
   *   { kind: "missing" }}
   */
  function summaryOf(initializer) {
    if (!ts.isObjectLiteralExpression(initializer)) {
      return { kind: "unresolved", text: "the row is not an object literal" };
    }

    for (const property of initializer.properties) {
      if (propertyName(property) !== "summary" || !ts.isPropertyAssignment(property)) {
        continue;
      }

      const value = literalText(property.initializer);

      return value === null
        ? { kind: "unresolved", text: property.initializer.getText(source) }
        : { kind: "literal", value };
    }

    return { kind: "missing" };
  }

  visit(source);

  for (const row of rows) {
    if (row.summary.kind === "missing") {
      problems.push({
        line: row.line,
        rule: RULES.badSummary,
        message:
          `frame type "${row.type}" has no summary; every row carries a one-line English ` +
          "summary because it is printed in diagnostics",
      });

      continue;
    }

    if (row.summary.kind === "unresolved") {
      problems.push({
        line: row.line,
        rule: RULES.unresolvedSummary,
        message:
          `frame type "${row.type}" has a summary this gate cannot read statically ` +
          `(saw ${row.summary.text}); write it as a plain string literal, or move the value ` +
          "into the row, so the diagnostic text stays reviewable here",
      });

      continue;
    }

    if (row.summary.value.trim() === "") {
      problems.push({
        line: row.line,
        rule: RULES.badSummary,
        message:
          `frame type "${row.type}" has an empty summary; every row carries a one-line English ` +
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
        const relative = toPosix(path.relative(root, absolute));

        if (!TEST_FILE_PATTERN.test(relative)) {
          files.push(relative);
        }
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
 *   { ch: "control", t: "bridge.ready" }   an object literal naming a channel
 *   { ch: "control", type: "bridge.ready" } the same, spelled out
 *
 * Computed values (`t: name`, `` t: `x.${y}` ``) are skipped: they cannot be
 * resolved without running the program, and reporting them would punish every
 * parameterised construction.
 *
 * A literal whose object forwards a spread instead of naming a channel is
 * reported as unresolved rather than skipped: `{ t: "typo", ...envelope }` is a
 * real frame and the gate cannot read its channel, so silence would let the
 * typo through.
 *
 * @param {string} fileName absolute path, for diagnostics only
 * @param {string} text file contents
 * @returns {{ value: string, line: number, unresolved: boolean }[]}
 */
function findFrameTypeLiterals(fileName, text) {
  const source = parseSource(fileName, text);
  /** @type {{ value: string, line: number, unresolved: boolean }[]} */
  const literals = [];

  /**
   * @param {ts.Node} node
   */
  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);

      // `t` is a common short key and `type` is everywhere, so a literal alone
      // says nothing. What makes an object a frame envelope is the channel: the
      // frozen `Frame` shape has `ch` and the three channel names are a closed
      // set, so requiring one of them is both precise and cheap. The older
      // "any of ch/v/seq/body" test matched unrelated objects such as a version
      // stamp `{ v: 2, t: "dark.high-contrast" }`.
      if (name === "t" || name === "type") {
        const value = literalText(node.initializer);

        if (value !== null && ts.isObjectLiteralExpression(node.parent)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const channel = channelOf(node.parent);

          if (channel !== null) {
            literals.push({ value, line, unresolved: false });
          } else if (hasSpread(node.parent)) {
            // `{ t: "typo", ...envelope }` carries the channel in the spread.
            // The gate cannot follow it, so it must say so rather than treat the
            // object as unrelated: silence here is exactly how a transposed
            // letter would reach the wire.
            literals.push({ value, line, unresolved: true });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  /**
   * The channel an object literal declares, when it names one directly.
   *
   * @param {ts.ObjectLiteralExpression} node
   * @returns {string | null}
   */
  function channelOf(node) {
    for (const property of node.properties) {
      if (propertyName(property) !== "ch" || !ts.isPropertyAssignment(property)) {
        continue;
      }

      const value = literalText(property.initializer);

      return value !== null && CHANNEL_VALUES.has(value) ? value : null;
    }

    return null;
  }

  /**
   * Whether an object literal forwards part of itself from somewhere else.
   *
   * @param {ts.ObjectLiteralExpression} node
   * @returns {boolean}
   */
  function hasSpread(node) {
    return node.properties.some((property) => ts.isSpreadAssignment(property));
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
      if (literal.unresolved) {
        violations.push({
          file,
          line: literal.line,
          rule: RULES.unresolvedLiteral,
          message:
            `frame type "${literal.value}" is built from a spread, so this gate cannot see ` +
            "which channel or whether the type is registered; name `ch` directly in the " +
            "object literal or register the type",
        });

        continue;
      }

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
