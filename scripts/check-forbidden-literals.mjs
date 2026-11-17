#!/usr/bin/env node
/**
 * check-forbidden-literals.mjs - two rules about strings that must not appear in
 * business code, both enforced on every run.
 *
 * **Wire literals.** The engine speaks a wire protocol whose message names are
 * not part of this repository's vocabulary: they are somebody else's API, and
 * stating one inside a feature module couples that feature to a protocol that can
 * change without asking. The transport adapter is where those names belong,
 * because it is the one place that has to know them; everything above it reaches
 * the same capability through a named port or a discriminated contract.
 *
 * The rule targets names that come from somewhere else and drag this code along
 * when they change. `agent_list` is such a name: the engine renames it and this
 * code breaks. `sync` is not -- this layer has a recovery step called sync, and
 * the only thing a shared word costs is that a reader must look at the context. So
 * the two colliding words are exempt for a reason of substance, not because the
 * collision is inconvenient.
 *
 * **Internal document numbers.** A comment that says "see docs/47 §5.1" is a
 * reference to a file the reader of this code does not have and cannot resolve.
 * The reason a rule exists survives translation into words; the number does not.
 *
 * Both rules are the same mechanism -- a string that should not exist in this
 * layer -- so they live in one gate with one output format.
 *
 * Usage:
 *   node scripts/check-forbidden-literals.mjs [--root <dir>] [--help]
 *
 * Exit codes: 0 pass, 1 violations, 2 the gate itself is broken.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const USAGE = `check-forbidden-literals - wire literals and internal document numbers

Usage:
  node scripts/check-forbidden-literals.mjs                scan the default scope
  node scripts/check-forbidden-literals.mjs --root <dir>   scan another tree
  node scripts/check-forbidden-literals.mjs --update-baseline   rewrite the frozen baseline
  node scripts/check-forbidden-literals.mjs --help         print this text and exit 0

Exit codes:
  0 = pass, 1 = violations, 2 = the gate or its configuration is broken.
`;

/**
 * Wire message names that must not appear as string literals above the transport.
 *
 * Deliberately not exhaustive, and deliberately missing the two names that this
 * layer legitimately uses for its own concepts: a recovery has a `sync` step and
 * the controller has an `input` port. A check that fired on those would be
 * "fixed" by renaming a domain word, which makes the code worse and the rule no
 * stronger.
 */
const WIRE_LITERALS = new Set([
  "app_server_info",
  "runtime_start",
  "agent_list",
  "conversation_messages_list",
  "conversation_list",
  "update_device_status",
  "update_loop_status",
  "update_queue",
  "update_subagent_state",
  "control_request",
  "control_response",
  "approval_response",
  "sync_response",
  "input_accepted",
  "stream_delta",
  "turn_finished",
  "runtime_start_response",
  "app_server_info_response",
]);

/** Directories whose files may name wire types, because naming them is their job. */
const TRANSPORT_SCOPE = ["packages/core/src/engine/client"];

/**
 * Where these rules are enforced.
 *
 * The whole engine, not just the layer that already complies. The rule is about
 * new code, and new code is written wherever the next change happens -- scoping to
 * one directory would protect the only place that needs no protection and leave
 * every future file unguarded.
 *
 * The existing violations are frozen in a baseline instead: a file may keep
 * exactly the number it had, and the next one is a failure. That is the difference
 * between a narrow rule (never checked elsewhere) and a frozen one (checked
 * everywhere, with the past excused), and only the second survives contact with
 * new code.
 */
const SCOPE = ["packages/core/src/engine"];

/** The transport adapter may name wire types; naming them is its job. */
const BASELINE_PATH = "scripts/forbidden-literals-baseline.json";

const DOC_NUMBER = [
  /\bdocs\/\d+/, // docs/47
  /《\d+》/, // 《47》
  /\bINV-\d+\b/, // INV-21
  /\b[ER]-\d{3}\b/, // E-147, R-03
  /\bFZ-\d+\b/, // FZ-2
];

const SKIPPED = new Set(["node_modules", ".git", "_research", "dist"]);

/** @param {string} file */
const isSource = (file) => file.endsWith(".ts") && !file.endsWith(".d.ts");

/**
 * Flatten a tree into source files.
 *
 * @param {string} root absolute root
 * @param {string} relative repo-relative directory
 * @returns {string[]} repo-relative posix paths
 */
function listSources(root, relative) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(next);
      } else if (isSource(entry.name)) {
        out.push(next);
      }
    }
  };
  if (statSync(path.join(root, relative), { throwIfNoEntry: false }) !== undefined) walk(relative);
  return out.sort();
}

/**
 * String literals in a line, with their column, ignoring obvious non-literals.
 *
 * This is a scanner, not a parser: it reports what a reader would see, which is
 * exactly what these rules are about. A false positive is fixed by rewording the
 * line; a false negative would be a silently missing rule.
 *
 * @param {string} line source line
 * @returns {Array<{ value: string, column: number }>}
 */
function stringLiterals(line) {
  const found = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    found.push({ value: match[1] ?? match[2] ?? match[3] ?? "", column: match.index + 1 });
  }
  return found;
}

/**
 * @typedef {{ file: string, line: number, rule: string, message: string }} Violation
 */

/**
 * Read the frozen baseline.
 *
 * @param {string} root absolute root
 * @returns {Map<string, number>}
 */
function readBaseline(root) {
  const text = readFileSync(path.join(root, BASELINE_PATH), "utf8");
  const parsed = JSON.parse(text);
  /** @type {Map<string, number>} */
  const allowed = new Map();

  for (const [file, count] of Object.entries(parsed.files ?? {})) {
    allowed.set(file, Number(count));
  }

  return allowed;
}

/**
 * @param {string} root absolute root
 * @param {boolean} frozen whether the baseline is applied
 * @returns {{ violations: Violation[], counts: Map<string, number> }}
 */
function collectViolations(root, frozen = true) {
  /** @type {Violation[]} */
  const violations = [];
  const files = SCOPE.flatMap((dir) => listSources(root, dir));
  const transport = new Set(TRANSPORT_SCOPE.flatMap((dir) => listSources(root, dir)));
  const allowed = frozen ? readBaseline(root) : new Map();
  /** @type {Map<string, number>} */
  const seen = new Map();

  for (const file of files) {
    const record = (violation) => {
      const before = seen.get(file) ?? 0;
      seen.set(file, before + 1);
      // The baseline excuses exactly as many lines as the file already had. The
      // next one is the failure this gate exists for.
      if (before < (allowed.get(file) ?? 0)) return;
      violations.push(violation);
    };
    const text = readFileSync(path.join(root, file), "utf8");
    const lines = text.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;

      for (const match of DOC_NUMBER) {
        if (match.test(line)) {
          record({
            file,
            line: lineNumber,
            rule: "internal-number",
            message: `an internal document number is unreadable outside this repository; say the reason in words instead`,
          });
          break;
        }
      }

      if (transport.has(file)) continue;

      for (const { value } of stringLiterals(line)) {
        if (WIRE_LITERALS.has(value)) {
          record({
            file,
            line: lineNumber,
            rule: "wire-literal",
            message: `"${value}" is a wire message name; reach it through a capability or a port instead of naming it here`,
          });
          break;
        }
      }
    }
  }

  for (const [file, count] of [...seen.entries()].sort()) {
    const granted = allowed.get(file) ?? 0;

    if (count < granted) {
      console.log(
        `note ${file}: ${String(count)} violation(s), baseline allows ${String(granted)}; shrink the baseline`,
      );
    }
  }

  return { violations, counts: seen };
}

/**
 * @param {{ root: string }} args
 * @returns {void}
 */
function runGate({ root, updateBaseline }) {
  let violations;
  let counts;
  try {
    ({ violations, counts } = collectViolations(root, !updateBaseline));
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  if (updateBaseline) {
    const next = {
      _comment:
        "Frozen count of existing violations per file, from before this gate existed. A file may keep exactly this many; the next one is a failure. Shrink this file when a file is cleaned up; never grow it without a decision recorded in the change.",
      files: Object.fromEntries([...counts.entries()].sort()),
    };
    writeFileSync(path.join(root, BASELINE_PATH), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(
      `baseline written: ${String(counts.size)} file(s), ${String([...counts.values()].reduce((sum, n) => sum + n, 0))} entr(ies)`,
    );
    return;
  }

  for (const { file, line, rule, message } of violations) {
    console.error(`${file}:${line} ${rule} ${message}`);
  }

  if (violations.length > 0) {
    console.error(`FAIL: ${violations.length} violation(s)`);
    process.exitCode = 1;
    return;
  }

  console.log(`PASS: no forbidden literals in ${SCOPE.join(", ")}`);
}

const argv = process.argv.slice(2);
const rootIndex = argv.indexOf("--root");
const updateBaseline = argv.includes("--update-baseline");

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
} else {
  runGate({
    root: rootIndex === -1 ? process.cwd() : path.resolve(argv[rootIndex + 1] ?? "."),
    updateBaseline,
  });
}
