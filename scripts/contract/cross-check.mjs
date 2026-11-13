#!/usr/bin/env node
/**
 * cross-check.mjs - type-layer cross-check for the contract snapshot.
 *
 * Scope
 *   `pnpm contract:check --dts <dir>` compares the committed snapshot with a
 *   directory of TypeScript declarations. In this repo the directory is a
 *   self-made fixture (route doc 08 section 9): the real `@letta-ai/letta-client`
 *   package is not installed and must not be installed (A2 hard constraint 1).
 *
 *   Only `.d.ts` files below `dtsDir` are read, recursively, in sorted posix
 *   path order. Each file is parsed with
 *
 *     ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
 *
 *   and walked with `forEachChild`. There is no Program, no type checker and no
 *   module resolution, exactly like `scripts/contract/lib/scan.mjs`; field types
 *   stay opaque text on purpose.
 *
 * Command-class interface rule (used by `missing-in-snapshot`)
 *   A declaration in the `.d.ts` tree is treated as a command interface only
 *   when it is an `interface` declaration whose name ends with `Command`
 *   (case-sensitive). Type aliases, class declarations and every other
 *   interface are ignored. This keeps unrelated helper declarations from being
 *   reported as commands the snapshot failed to record. Every command in the
 *   committed snapshot follows the same suffix rule (124/124), so a renamed
 *   command still shows up as `missing-in-dts` on the snapshot side and as
 *   `missing-in-snapshot` on the declaration side. Declarations nested in
 *   `namespace` / `declare module` bodies are indexed by their simple name,
 *   which is how the snapshot records `type`.
 *
 * Differences (all three are printed, none changes the exit code)
 *   missing-in-dts       snapshot has the interface, the `.d.ts` tree does not
 *   missing-in-snapshot  a `*Command` interface exists only in the `.d.ts` tree
 *   field-diff           for snapshot entries with `fieldLevel: true` only:
 *                        a field is `added` (in `.d.ts`, not snapshot),
 *                        `removed` (in snapshot, not `.d.ts`) or `type-changed`
 *                        (same name, different normalized type text). Entries
 *                        with `fieldLevel: false` are compared by existence only
 *                        (field-level facts are registered, not inferred).
 *   Field comparison uses top-level property names and type text only; optional
 *   and readonly markers are not part of the snapshot comparison. Every
 *   `field-diff` record also carries the declaring `file` and `line`, so a gate
 *   wrapper can turn it into a `<file>:<line> <rule> <message>` line.
 *
 * gitHead
 *   `dtsDir/package.json` may carry `gitHead`. It is compared with
 *   `snapshot.engine.commit`; a mismatch adds one warning line and never fails
 *   the run. The comparison tolerates an abbreviated form on either side: the
 *   (P6-F3): the snapshot stores the short commit from `git rev-parse --short
 *   HEAD` while a published package pins the full 40-character SHA, so the two
 *   only warn when neither value is a prefix of the other. Both sides must be at
 *   least 7 hex characters for the prefix rule to apply. A missing or unreadable
 *   `package.json`, or a file without a usable `gitHead`, is not broken input:
 *   the result is simply `gitHead: null`.
 *
 * Result and exit codes
 *   crossCheck({ dtsDir, snapshot }) -> { ok, differences, gitHead, warnings }
 *     ok: true   the comparison ran; `differences` may still be non-empty
 *     ok: false  broken input; `code` names the reason and `message` explains it
 *   Exit 0 for a completed comparison (diffs included), exit 2 for broken input.
 *   No code path turns a difference into exit 1.
 *
 * Determinism
 *   Files, interfaces, differences and warnings have a fixed order (code-unit
 *   comparison, never localeCompare), and no time or filesystem iteration order
 *   leaks into the result. Two runs over the same inputs produce the same
 *   object and the same ASCII, one-entry-per-line report.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import ts from "typescript";

/** Snapshot used when this module runs as its own CLI. */
export const DEFAULT_SNAPSHOT_PATH = "packages/protocol/src/contract/snapshot.json";

/** Suffix that marks a `.d.ts` interface as a command class. */
export const COMMAND_INTERFACE_SUFFIX = "Command";

/** One-line rule id printed in every report header. */
export const RULE_ID = "command-interfaces-are-interfaces-named-*-Command";

/** Structured failure codes for broken input (exit 2). */
export const FAILURE_CODES = Object.freeze({
  INVALID_ARGUMENTS: "invalid-arguments",
  INVALID_SNAPSHOT: "invalid-snapshot",
  DTS_DIR_MISSING: "dts-dir-missing",
  DTS_DIR_NOT_DIRECTORY: "dts-dir-not-directory",
  DTS_DIR_EMPTY: "dts-dir-empty",
  DTS_DIR_UNREADABLE: "dts-dir-unreadable",
});

/** Exit code for a completed comparison, differences included. */
export const EXIT_SUCCESS = 0;

/** Exit code for broken input. Never used for differences. */
export const EXIT_INPUT_ERROR = 2;

/** Usage text for the standalone entry point. */
const USAGE = `Usage:
  node scripts/contract/cross-check.mjs --dts <dir> [--snapshot <file>]

Exit codes: 0 comparison completed (differences included), 2 broken input.`;

/**
 * Convert backslashes to posix separators so reports are stable across hosts.
 *
 * @param {string} value
 * @returns {string}
 */
function toPosix(value) {
  return value.replaceAll("\\", "/");
}

/**
 * Code-unit comparison. This is the ordering rule of the whole module; using
 * `localeCompare` would make the output depend on the host locale.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Collapse all whitespace runs to one space and trim. Used for report values so
 * every entry stays on one line.
 *
 * @param {unknown} value
 * @returns {string}
 */
function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * Normalize type text before comparing it. Whitespace layout and spacing
 * around union/intersection/comma separators are not semantic, so the
 * comparison ignores them; everything else (for example `Foo[]` vs
 * `Array<Foo>`) stays a difference.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeTypeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*([|&,])\s*/g, "$1");
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Internal failure value for helpers.
 *
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function failure(code, message) {
  return { ok: false, code, message };
}

/**
 * Full broken-input result. `crossCheck` never throws for bad input, so every
 * caller gets the same shape and the exit code stays computable.
 *
 * @param {string} code
 * @param {string} message
 * @returns {object}
 */
function inputFailure(code, message) {
  return {
    ok: false,
    code,
    message,
    differences: [],
    gitHead: null,
    warnings: [],
  };
}

/**
 * Recursively collect `.d.ts` files below `dir`.
 *
 * @param {string} dir absolute directory
 * @param {string[]} out accumulator of absolute file paths
 */
function walkDtsDirectory(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkDtsDirectory(absolute, out);
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      out.push(absolute);
    }
  }
}

/**
 * Validate the declaration directory and list its `.d.ts` files.
 *
 * @param {string} dtsDir
 * @returns {object} `{ok: true, files: {absolute, relative}[]}` or a failure
 */
function listDtsFiles(dtsDir) {
  const root = path.resolve(dtsDir);

  let stats;

  try {
    stats = statSync(root);
  } catch {
    return failure(FAILURE_CODES.DTS_DIR_MISSING, `dts directory not found: ${toPosix(root)}`);
  }

  if (!stats.isDirectory()) {
    return failure(
      FAILURE_CODES.DTS_DIR_NOT_DIRECTORY,
      `dts path is not a directory: ${toPosix(root)}`,
    );
  }

  /** @type {string[]} */
  const absoluteFiles = [];

  try {
    walkDtsDirectory(root, absoluteFiles);
  } catch (error) {
    return failure(
      FAILURE_CODES.DTS_DIR_UNREADABLE,
      `cannot read dts directory ${toPosix(root)}: ${errorMessage(error)}`,
    );
  }

  const files = absoluteFiles
    .map((absolute) => ({
      absolute,
      relative: toPosix(path.relative(root, absolute)),
    }))
    .sort((left, right) => compareStrings(left.relative, right.relative));

  if (files.length === 0) {
    return failure(FAILURE_CODES.DTS_DIR_EMPTY, `no .d.ts files below: ${toPosix(root)}`);
  }

  return { ok: true, files };
}

/**
 * Read the top-level properties of one interface. Methods, call signatures and
 * index signatures are skipped; nested object literals are not expanded, their
 * type text is kept as-is.
 *
 * @param {import("typescript").InterfaceDeclaration} node
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {{name: string, type: string}[]}
 */
function extractFields(node, sourceFile) {
  /** @type {{name: string, type: string}[]} */
  const fields = [];

  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || !member.name) {
      continue;
    }

    const name =
      ts.isIdentifier(member.name) ||
      ts.isStringLiteral(member.name) ||
      ts.isNumericLiteral(member.name)
        ? member.name.text
        : null;

    if (name === null) {
      continue;
    }

    fields.push({
      name,
      type: member.type ? member.type.getText(sourceFile) : "",
    });
  }

  return fields;
}

/**
 * Walk one parsed file and collect every interface declaration, including
 * declarations nested in `namespace` / `declare module` bodies.
 *
 * @param {import("typescript").Node} node
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} file posix path relative to `dtsDir`
 * @param {object[]} out accumulator
 */
function collectInterfaces(node, sourceFile, file, out) {
  if (ts.isInterfaceDeclaration(node)) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

    out.push({
      name: node.name.text,
      file,
      line,
      fields: extractFields(node, sourceFile),
    });
  }

  node.forEachChild((child) => collectInterfaces(child, sourceFile, file, out));
}

/**
 * Parse every listed file and collect interface entries. Read errors are
 * broken input, not a partial result; a TS syntax error does not throw (it
 * stays a parse diagnostic in the source file), matching the syntax-only scope.
 *
 * @param {{absolute: string, relative: string}[]} files
 * @returns {object} `{ok: true, interfaces}` or a failure
 */
function readInterfaces(files) {
  /** @type {object[]} */
  const interfaces = [];

  for (const file of files) {
    let text;

    try {
      text = readFileSync(file.absolute, "utf8");
    } catch (error) {
      return failure(
        FAILURE_CODES.DTS_DIR_UNREADABLE,
        `cannot read ${file.relative}: ${errorMessage(error)}`,
      );
    }

    const sourceFile = ts.createSourceFile(
      file.relative,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    collectInterfaces(sourceFile, sourceFile, file.relative, interfaces);
  }

  return { ok: true, interfaces };
}

/**
 * Index interfaces by simple name. Files are visited in sorted order and
 * declarations in source order, so a duplicate name always resolves to the
 * same entry; the first declaration wins.
 *
 * @param {object[]} interfaces
 * @returns {Map<string, object>}
 */
function indexInterfaces(interfaces) {
  const byName = new Map();

  for (const entry of interfaces) {
    if (!byName.has(entry.name)) {
      byName.set(entry.name, entry);
    }
  }

  return byName;
}

/**
 * Return a problem description when the snapshot argument cannot be compared,
 * or null when it is usable. This mirrors the frozen snapshot shape enough for
 * cross-checking without becoming a second schema validator.
 *
 * @param {unknown} snapshot
 * @returns {string | null}
 */
function snapshotProblem(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.commands)) {
    return "snapshot must be an object with a commands array";
  }

  for (let index = 0; index < snapshot.commands.length; index += 1) {
    const command = snapshot.commands[index];

    if (!command || typeof command !== "object" || typeof command.type !== "string") {
      return `snapshot command at index ${index} has no string type`;
    }

    if (command.fieldLevel === true) {
      if (!Array.isArray(command.fields)) {
        return `snapshot command ${command.type} is fieldLevel but has no fields array`;
      }

      for (const field of command.fields) {
        if (!field || typeof field.name !== "string" || typeof field.type !== "string") {
          return `snapshot command ${command.type} has a malformed field`;
        }
      }
    }
  }

  return null;
}

/**
 * Compare the fields of one snapshot command with the matching `.d.ts`
 * interface. Only called for `fieldLevel: true` entries.
 *
 * @param {object} command snapshot command record
 * @param {object} entry `.d.ts` interface entry
 * @param {object[]} out difference accumulator
 */
function compareFields(command, entry, out) {
  /** @type {Map<string, string>} */
  const snapshotFields = new Map();

  for (const field of command.fields) {
    snapshotFields.set(field.name, field.type);
  }

  /** @type {Map<string, string>} */
  const dtsFields = new Map();

  for (const field of entry.fields) {
    dtsFields.set(field.name, field.type);
  }

  for (const [name, type] of dtsFields) {
    if (!snapshotFields.has(name)) {
      out.push({
        kind: "field-diff",
        type: command.type,
        wire: typeof command.wire === "string" ? command.wire : null,
        file: entry.file,
        line: entry.line,
        field: name,
        change: "added",
        snapshotType: null,
        dtsType: type,
      });
    }
  }

  for (const [name, type] of snapshotFields) {
    if (!dtsFields.has(name)) {
      out.push({
        kind: "field-diff",
        type: command.type,
        wire: typeof command.wire === "string" ? command.wire : null,
        file: entry.file,
        line: entry.line,
        field: name,
        change: "removed",
        snapshotType: type,
        dtsType: null,
      });

      continue;
    }

    const dtsType = dtsFields.get(name) ?? "";

    if (normalizeTypeText(type) !== normalizeTypeText(dtsType)) {
      out.push({
        kind: "field-diff",
        type: command.type,
        wire: typeof command.wire === "string" ? command.wire : null,
        file: entry.file,
        line: entry.line,
        field: name,
        change: "type-changed",
        snapshotType: type,
        dtsType,
      });
    }
  }
}

/**
 * Fixed difference order: kind, type, field, change, file, line. All components
 * are compared as code units, so the report is independent of insertion order.
 *
 * @param {object} left
 * @param {object} right
 * @returns {number}
 */
function compareDifferences(left, right) {
  return (
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.type ?? "", right.type ?? "") ||
    compareStrings(left.field ?? "", right.field ?? "") ||
    compareStrings(left.change ?? "", right.change ?? "") ||
    compareStrings(left.file ?? "", right.file ?? "") ||
    (left.line ?? 0) - (right.line ?? 0)
  );
}

/**
 * Read `gitHead` from `<dtsDir>/package.json`. Any failure means "metadata not
 * available" and returns null; it never makes the input broken.
 *
 * @param {string} dtsDir
 * @returns {string | null}
 */
function readGitHead(dtsDir) {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(path.resolve(dtsDir), "package.json"), "utf8"),
    );

    if (parsed && typeof parsed.gitHead === "string" && parsed.gitHead.trim() !== "") {
      return parsed.gitHead.trim();
    }
  } catch {
    // Optional metadata: absent, unreadable or malformed all mean null.
  }

  return null;
}

/**
 * Whether two commit strings denote the same revision.
 *
 * `snapshot.engine.commit` is the short SHA printed by `git rev-parse --short
 * HEAD` (7 characters); `gitHead` in a published package is the full 40
 * character SHA. Comparing them with `!==` therefore warned on every real
 * package (P6-F3). Equal strings match; otherwise both sides must be hex and at
 * least 7 characters long and the shorter one must be a prefix of the longer
 * one. Anything else (a branch name, a tag, a dirty marker) stays a mismatch.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function sameCommit(left, right) {
  if (left === right) {
    return true;
  }

  const first = left.toLowerCase();
  const second = right.toLowerCase();

  if (first.length < 7 || second.length < 7) {
    return false;
  }

  if (!/^[0-9a-f]+$/.test(first) || !/^[0-9a-f]+$/.test(second)) {
    return false;
  }

  return first.length <= second.length ? second.startsWith(first) : first.startsWith(second);
}

/**
 * Cross-check a snapshot against a tree of TypeScript declarations.
 *
 * @param {{dtsDir: string, snapshot: object}} options
 * @returns {object} `{ok, differences, gitHead, warnings}`; broken input adds
 *   `code` and `message` and sets `ok` to false
 */
export function crossCheck(options) {
  const { dtsDir, snapshot } = options ?? {};

  if (typeof dtsDir !== "string" || dtsDir.trim() === "") {
    return inputFailure(FAILURE_CODES.INVALID_ARGUMENTS, "dtsDir must be a non-empty string");
  }

  const problem = snapshotProblem(snapshot);

  if (problem !== null) {
    return inputFailure(FAILURE_CODES.INVALID_SNAPSHOT, problem);
  }

  const listed = listDtsFiles(dtsDir);

  if (!listed.ok) {
    return inputFailure(listed.code, listed.message);
  }

  const parsed = readInterfaces(listed.files);

  if (!parsed.ok) {
    return inputFailure(parsed.code, parsed.message);
  }

  const interfacesByName = indexInterfaces(parsed.interfaces);
  const snapshotTypes = new Set();
  /** @type {object[]} */
  const differences = [];

  for (const command of snapshot.commands) {
    snapshotTypes.add(command.type);

    const entry = interfacesByName.get(command.type);

    if (!entry) {
      differences.push({
        kind: "missing-in-dts",
        type: command.type,
        wire: typeof command.wire === "string" ? command.wire : null,
      });

      continue;
    }

    if (command.fieldLevel === true) {
      compareFields(command, entry, differences);
    }
  }

  const reportedMissingInSnapshot = new Set();

  for (const entry of parsed.interfaces) {
    if (!entry.name.endsWith(COMMAND_INTERFACE_SUFFIX)) {
      continue;
    }

    if (snapshotTypes.has(entry.name) || reportedMissingInSnapshot.has(entry.name)) {
      continue;
    }

    reportedMissingInSnapshot.add(entry.name);
    differences.push({
      kind: "missing-in-snapshot",
      type: entry.name,
      file: entry.file,
      line: entry.line,
    });
  }

  differences.sort(compareDifferences);

  const gitHead = readGitHead(dtsDir);
  const snapshotHead =
    snapshot.engine && typeof snapshot.engine.commit === "string"
      ? snapshot.engine.commit.trim()
      : "";
  /** @type {string[]} */
  const warnings = [];

  if (gitHead !== null && snapshotHead !== "" && !sameCommit(gitHead, snapshotHead)) {
    warnings.push(`gitHead mismatch: dts=${gitHead} snapshot=${snapshotHead}`);
  }

  return { ok: true, differences, gitHead, warnings };
}

/**
 * Render one difference as a single ASCII line.
 *
 * @param {object} difference
 * @returns {string}
 */
function formatDifference(difference) {
  if (difference.kind === "missing-in-dts") {
    return `difference: missing-in-dts type=${oneLine(difference.type)} wire=${oneLine(
      difference.wire ?? "none",
    )}`;
  }

  if (difference.kind === "missing-in-snapshot") {
    return `difference: missing-in-snapshot type=${oneLine(difference.type)} file=${oneLine(
      difference.file,
    )}:${difference.line}`;
  }

  if (difference.kind === "field-diff") {
    return (
      `difference: field-diff type=${oneLine(difference.type)} ` +
      `wire=${oneLine(difference.wire ?? "none")} field=${oneLine(difference.field)} ` +
      `change=${oneLine(difference.change)} ` +
      `snapshot-type=${oneLine(difference.snapshotType ?? "none")} ` +
      `dts-type=${oneLine(difference.dtsType ?? "none")} ` +
      `file=${oneLine(difference.file ?? "none")}:${difference.line ?? "none"}`
    );
  }

  return `difference: ${oneLine(difference.kind)} type=${oneLine(difference.type ?? "none")}`;
}

/**
 * Render a result as an ASCII, one-entry-per-line report. The same result
 * always renders to the same string.
 *
 * @param {object} result value returned by `crossCheck`
 * @returns {string} newline-terminated report
 */
export function formatCrossCheck(result) {
  const lines = [];

  if (!result || result.ok !== true) {
    const code = result && typeof result.code === "string" ? result.code : "invalid-result";
    const message = result && typeof result.message === "string" ? result.message : "no message";

    lines.push(
      `cross-check: rule=${RULE_ID} result=input-error code=${oneLine(code)} ` +
        `message=${oneLine(message)}`,
    );

    return `${lines.join("\n")}\n`;
  }

  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const differences = Array.isArray(result.differences) ? result.differences : [];

  lines.push(
    `cross-check: rule=${RULE_ID} result=ok differences=${differences.length} ` +
      `warnings=${warnings.length} gitHead=${oneLine(result.gitHead ?? "none")}`,
  );

  for (const warning of warnings) {
    lines.push(`warning: ${oneLine(warning)}`);
  }

  for (const difference of differences) {
    lines.push(formatDifference(difference));
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Map a result to the frozen exit code: 0 for a completed comparison (even
 * with differences), 2 for broken input.
 *
 * @param {object} result value returned by `crossCheck`
 * @returns {0 | 2}
 */
export function exitCodeFor(result) {
  return result && result.ok === true ? EXIT_SUCCESS : EXIT_INPUT_ERROR;
}

/**
 * Standalone entry point, used for manual checks and by gate self-tests. The
 * canonical command remains `contract:check --dts <dir>`; this entry point only
 * exposes the same function without the CLI dispatcher.
 *
 * @param {string[]} argv arguments after the script name
 * @returns {0 | 2}
 */
export function main(argv = process.argv.slice(2)) {
  let values;

  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dts: { type: "string" },
        snapshot: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`cross-check: ${errorMessage(error)}\n${USAGE}\n`);

    return EXIT_INPUT_ERROR;
  }

  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);

    return EXIT_SUCCESS;
  }

  if (values.dts === undefined) {
    process.stderr.write(`cross-check: --dts is required\n${USAGE}\n`);

    return EXIT_INPUT_ERROR;
  }

  const snapshotPath = values.snapshot ?? DEFAULT_SNAPSHOT_PATH;
  let snapshot;

  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch (error) {
    process.stderr.write(
      `cross-check: cannot read snapshot ${toPosix(path.resolve(snapshotPath))}: ` +
        `${errorMessage(error)}\n`,
    );

    return EXIT_INPUT_ERROR;
  }

  const result = crossCheck({ dtsDir: values.dts, snapshot });
  const report = formatCrossCheck(result);

  if (result.ok === true) {
    process.stdout.write(report);
  } else {
    process.stderr.write(report);
  }

  return exitCodeFor(result);
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`cross-check: internal error: ${errorMessage(error)}\n`);
    process.exitCode = EXIT_INPUT_ERROR;
  }
}
