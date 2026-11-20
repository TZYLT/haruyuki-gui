#!/usr/bin/env node
/**
 * check-forbidden-literals.mjs - three rules about strings and file names that
 * must not appear in a public repository, all enforced on every run.
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
 * **Internal document numbers.** A comment that says "see the private notes for
 * this rule" and then carries a number is a reference to a file the reader of
 * this code does not have and cannot resolve. The reason a rule exists survives
 * translation into words; the number does not. The same holds for a file name
 * that carries an internal work-package tag: whoever clones the repository can
 * see the name and cannot follow it anywhere.
 *
 * **Internal file names.** Work is tracked in a private plan with short tags.
 * A source file named after one of those tags is technically a working link
 * between the public tree and the private plan, so the tag has to move to the
 * commit or the change description instead.
 *
 * All three rules are the same mechanism -- a token that should not exist in a
 * public tree -- so they live in one gate with one output format.
 *
 * Scope: the whole repository. New code is written wherever the next change
 * happens, so a gate that looks at one directory protects the only place that
 * already complies. The existing violations are frozen in a baseline instead: a
 * file may keep exactly the amount it had, and the next one is a failure.
 *
 * Usage:
 *   node scripts/check-forbidden-literals.mjs [--root <dir>] [--update-baseline] [--help]
 *
 * Exit codes: 0 pass, 1 violations, 2 the gate itself is broken.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const USAGE = `check-forbidden-literals - wire literals, internal numbers and internal file names

Usage:
  node scripts/check-forbidden-literals.mjs                scan the whole tree
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
 * Where the wire-literal rule applies: the engine, above its transport adapter.
 *
 * This rule is about layering, not about the public boundary, so it keeps the
 * scope it had. Running it over the whole tree would freeze every legitimate
 * naming in the protocol contract, the merge module and the contract fixtures as
 * debt, and the shrunken-only baseline would then reject the next fixture that
 * names a message. The internal-number and internal-path rules below are the ones
 * that had to grow to the whole tree.
 */
const WIRE_SCOPE = ["packages/core/src/engine"];

/** The frozen count of existing violations, per file. */
const BASELINE_PATH = "scripts/forbidden-literals-baseline.json";

/**
 * The gate's own script and its self-test contain one sample per rule, because
 * that is the only way to prove the rules fire. They are the only exemptions: a
 * wider list would quietly turn a rule off wherever it is inconvenient.
 */
const EXEMPT_FILES = new Set([
  "scripts/check-forbidden-literals.mjs",
  "scripts/check-forbidden-literals.test.ts",
]);

/**
 * Internal document numbers: a private reference the reader cannot resolve.
 *
 * Each shape below was found in this tree at the time the gate was widened. A new
 * shape belongs here only once it has been seen, not speculatively.
 */
const INTERNAL_NUMBER = [
  /\bdocs\/\d+/, // docs/47
  /《\d+》/, // 《47》
  /\bINV-\d+\b/, // INV-21
  /\b[ER]-\d{3}\b/, // E-147, R-03
  /\bFZ-\d+\b/, // FZ-2
  /\b[VWD]-\d{1,2}[a-z]?\b/, // V-09, W-06, D-12
  /\bB\d-[A-Z]\d+\b/, // B2-D09
  /\b\d{2}\s*§/, // 47 §3
];

/**
 * Internal work-package tags in a file name.
 *
 * The private plan names work items like `w15` or `f-03`, and a file was named
 * after the item it was written for. The name is visible to every reader of the
 * repository and resolves to nothing for them.
 */
const INTERNAL_PATH = /(^|\/)(w\d{2}|[a-z]-\d{2})-/;

/**
 * Trees the fallback walk must not enter.
 *
 * A git work tree never needs this list: `--exclude-standard` already hides
 * build output, caches and the private material that lives beside the checkout,
 * and `docs` is a separate private repository mounted into this tree. The list
 * matters only where there is no git index to ask (a fixture tree, an exported
 * tarball), and it is deliberately the same set the repository ignores.
 */
const SKIPPED = new Set([
  "node_modules",
  ".git",
  "_research",
  "dist",
  "coverage",
  "_acceptance",
  "docs",
]);

/** Extensions that hold source. `.d.ts` is included: a declaration is source too. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/** @param {string} file */
const isSource = (file) => SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension));

/**
 * Flatten a tree into files whose names pass `keep`.
 *
 * @param {string} root absolute root
 * @param {string} relative repo-relative directory, "." for the root
 * @param {(name: string) => boolean} keep file-name predicate
 * @returns {string[]} repo-relative posix paths
 */
function listFiles(root, relative, keep) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = dir === "." ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(next);
      } else if (keep(entry.name)) {
        out.push(next);
      }
    }
  };
  if (statSync(path.join(root, relative), { throwIfNoEntry: false }) !== undefined) walk(relative);
  return out.sort();
}

/**
 * Every file the repository would publish: tracked files plus untracked files
 * that are not ignored.
 *
 * A work tree answers this exactly: `git ls-files --cached --others
 * --exclude-standard` is the set a clone would receive, plus the local files a
 * contributor is about to add. That second half matters: a gate must catch a new
 * violation in a file that is not staged yet, or it would miss exactly the code
 * being written now. Ignored material (build output, caches, private notes, and
 * a scratch script that happens to sit in the tree) is not published, so it is
 * not scanned and cannot enter the baseline.
 *
 * A temporary fixture or an exported tarball has no git index, and there the walk
 * with the skips below is the best available answer.
 *
 * @param {string} root absolute root
 * @returns {string[]} repo-relative posix paths
 */
function listRepositoryFiles(root) {
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (listed.status === 0 && typeof listed.stdout === "string" && listed.stdout.length > 0) {
    return listed.stdout
      .split("\0")
      .filter((name) => name.length > 0)
      .sort();
  }

  return listFiles(root, ".", () => true);
}

/**
 * Whether a repo-relative path lives inside one of the scope prefixes.
 *
 * @param {string} file repo-relative posix path
 * @param {string[]} scopes repo-relative directories
 * @returns {boolean}
 */
const inScope = (file, scopes) => scopes.some((dir) => file === dir || file.startsWith(`${dir}/`));

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
 * Size of the existing baseline, or null when the tree has none yet.
 *
 * @param {string} root absolute root
 * @returns {{ files: number, entries: number } | null}
 */
function readBaselineSize(root) {
  const target = path.join(root, BASELINE_PATH);
  if (!existsSync(target)) return null;

  const parsed = JSON.parse(readFileSync(target, "utf8"));
  const entries = Object.entries(parsed.files ?? {}).map(([, count]) => Number(count));

  return { files: entries.length, entries: entries.reduce((sum, count) => sum + count, 0) };
}

/**
 * @param {string} root absolute root
 * @param {boolean} frozen whether the baseline is applied
 * @returns {{ violations: Violation[], counts: Map<string, number> }}
 */
function collectViolations(root, frozen = true) {
  /** @type {Violation[]} */
  const violations = [];
  const repositoryFiles = listRepositoryFiles(root);
  const files = repositoryFiles.filter((file) => isSource(file) && !EXEMPT_FILES.has(file));
  const wireFiles = new Set(files.filter((file) => inScope(file, WIRE_SCOPE)));
  const transport = new Set(files.filter((file) => inScope(file, TRANSPORT_SCOPE)));
  const allowed = frozen ? readBaseline(root) : new Map();
  /** @type {Map<string, number>} */
  const seen = new Map();

  /**
   * Count one violation against a file and keep it only when the file has no
   * baseline allowance left.
   *
   * @param {Violation} violation
   */
  const record = (violation) => {
    const before = seen.get(violation.file) ?? 0;
    seen.set(violation.file, before + 1);
    // The baseline excuses exactly as many violations as the file already had.
    // The next one is the failure this gate exists for.
    if (before < (allowed.get(violation.file) ?? 0)) return;
    violations.push(violation);
  };

  // A file's name is visible even when nothing in the file is. The violation is
  // counted against the file so the baseline can freeze it like any other debt.
  for (const file of repositoryFiles) {
    if (!INTERNAL_PATH.test(file)) continue;
    record({
      file,
      line: 1,
      rule: "internal-path",
      message: `the file name carries an internal work-package tag that a public reader cannot resolve; name the behaviour instead`,
    });
  }

  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    const lines = text.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;

      for (const match of INTERNAL_NUMBER) {
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

      if (!wireFiles.has(file) || transport.has(file)) continue;

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
 * @param {{ root: string, updateBaseline: boolean }} args
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
    const entries = [...counts.values()].reduce((sum, count) => sum + count, 0);
    /** @type {{ files: number, entries: number } | null} */
    let previous;
    try {
      previous = readBaselineSize(root);
    } catch (error) {
      console.error(
        `ERROR: cannot read the existing baseline: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 2;
      return;
    }

    // The baseline is a debt list, not a license. Rewriting it from whatever the
    // tree happens to contain would make every new violation disappear from the
    // gate on the next run, which is exactly the failure mode this guard exists
    // to prevent.
    if (previous !== null && (counts.size > previous.files || entries > previous.entries)) {
      const grew = [
        counts.size > previous.files
          ? `files ${String(previous.files)} -> ${String(counts.size)}`
          : "",
        entries > previous.entries
          ? `entries ${String(previous.entries)} -> ${String(entries)}`
          : "",
      ]
        .filter((part) => part.length > 0)
        .join(", ");
      console.error(
        `ERROR: the baseline is a debt list and may only shrink; this update would grow it (${grew}). Fix the new violations, or record the decision to accept them in the change description.`,
      );
      process.exitCode = 2;
      return;
    }

    const next = {
      _comment:
        "Debt list, not a license. Each file may keep exactly the violations it already had and the next one is a failure; this list may only shrink. Growing it requires a separate decision recorded in the change description.",
      files: Object.fromEntries([...counts.entries()].sort()),
    };
    writeFileSync(path.join(root, BASELINE_PATH), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`baseline written: ${String(counts.size)} file(s), ${String(entries)} entr(ies)`);
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

  console.log(`PASS: no forbidden literals or internal file names in the scanned tree`);
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
