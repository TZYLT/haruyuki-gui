#!/usr/bin/env node
/**
 * check-public-docs.mjs - the gate behind "the public documents are current".
 *
 * The repository's only reader-facing documents are the two READMEs, the three
 * licence files, and the maintainer documents they link to. Prose cannot be
 * tested, but four claims about it can:
 *
 *   1. **The command table is generated.** It is regenerated here and compared
 *      with what the READMEs actually contain. The generator also refuses a
 *      script with no note and a note naming a script that is gone, so adding a
 *      command without describing it turns this gate red.
 *   2. **The two READMEs have the same shape.** Both must carry numbered
 *      sections 1 through 9 and the same number of command rows. A row added to
 *      one language only is exactly the drift the pair is supposed to prevent.
 *   3. **No internal identifiers leak.** The public documents are scanned for
 *      the internal document, work-item and finding identifiers the project
 *      uses privately. Those identifiers point at documents a reader cannot
 *      open, so they are noise at best and a broken promise at worst.
 *   4. **The status section is pinned.** It must name the commit it describes as
 *      `main@<sha>`, the sha must resolve, and it must be an ancestor of HEAD -
 *      a status paragraph that describes some other branch's future is a lie
 *      with a timestamp.
 *
 * Usage:
 *   node scripts/docs/check-public-docs.mjs
 *   node scripts/docs/check-public-docs.mjs --help
 *
 * Exit codes (the shared gate-cli three-value contract):
 *   0 = every check passed
 *   1 = at least one violation
 *   2 = this script cannot judge: a file is unreadable, the generator's own
 *       inputs are broken, or `git` is unavailable
 *
 * Output is one line per check, English and ASCII, so the verifier's replay
 * stays readable.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of this script. */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Repository root, resolved from this file rather than from `process.cwd()`. */
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/** The two READMEs, in the order the checks report them. */
const READMES = ["README.md", "README.en.md"];

/** The generator this gate delegates the table comparison to. */
const GENERATOR = path.join("scripts", "docs", "gen-command-table.mjs");

/** Markers the generator owns; duplicated here only to locate the table. */
const MARKER_BEGIN = "<!-- BEGIN GENERATED:commands -->";
const MARKER_END = "<!-- END GENERATED:commands -->";

/**
 * Identifiers the project uses in its private notes and must not print in a
 * public document.
 *
 * Written out here rather than imported from the source gate: this file is a
 * standalone `node` script with no imports from `scripts/`, and a shared
 * pattern module would let one edit silently widen both gates at once.
 */
const INTERNAL_IDENTIFIER =
  /docs\/\d{2}|《\d+》|\b\d{2}\s*§|\b[VWD]-\d{1,2}[a-z]?\b|\bFZ-\d+\b|\bINV-\d+\b|\b[ER]-\d{3}\b|\bB\d-[A-Z]\d+\b/;

/** Basenames that are reader-facing, wherever they live. */
const PUBLIC_DOCUMENT_PATTERN = /^(README.*|NOTICE|THIRD-PARTY.*)$/;

/**
 * Tracked directories whose README files are not reader-facing documents.
 *
 * `fixtures/` holds deliberately broken trees for the gate self-tests: a
 * fixture may have to contain an identifier to prove a gate catches one, so
 * scanning it here would make the two gates contradict each other. `_research/`
 * and `docs/` are the project's private notes and are not part of the public
 * tree at all; the exclusion is stated so that a later contributor does not
 * read their absence as a gap.
 */
const NOT_PUBLIC_PREFIXES = ["fixtures/", "_research/", "docs/"];

/** A checked claim that failed; printed as one `FAIL` line. */
class Violation {
  /**
   * @param {string} check the check this violation belongs to
   * @param {string} message ASCII, single line, says what to change
   */
  constructor(check, message) {
    this.check = check;
    this.message = message;
  }
}

/** This script cannot judge; always exit 2. */
class BrokenGate extends Error {}

/**
 * Read one text file with the repository's line endings normalised.
 *
 * @param {string} relative
 * @returns {string}
 */
function readText(relative) {
  try {
    return readFileSync(path.join(ROOT, relative), "utf8").replaceAll("\r\n", "\n");
  } catch (error) {
    throw new BrokenGate(`cannot read ${relative}: ${messageOf(error)}`);
  }
}

/**
 * The message of an unknown thrown value.
 *
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the generated block between the markers.
 *
 * @param {string} text
 * @param {string} relative for the error message
 * @returns {string}
 */
function generatedBlock(text, relative) {
  const begin = text.indexOf(MARKER_BEGIN);
  const end = text.indexOf(MARKER_END);

  if (begin === -1 || end === -1 || end < begin) {
    throw new BrokenGate(`${relative}: missing the generated-block markers`);
  }

  return text
    .slice(begin + MARKER_BEGIN.length, end)
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * Count the data rows of the Markdown tables inside the generated block.
 *
 * The header row and the `---` separator are not commands; every other row is
 * one. Counting inside the markers rather than the whole file keeps a
 * hand-written example table elsewhere in the README from being mistaken for a
 * command.
 *
 * @param {string} block
 * @returns {number}
 */
function commandRowCount(block) {
  let rows = 0;

  for (const line of block.split("\n")) {
    if (!/^\|\s/.test(line)) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) continue;
    if (/^\|\s*(Command|命令)\s*\|/.test(line)) continue;
    rows += 1;
  }

  return rows;
}

/**
 * Collect the numbered sections (`## 1.` through `## 9.`) of one README.
 *
 * @param {string} text
 * @returns {number[]}
 */
function numberedSections(text) {
  const numbers = [];

  for (const line of text.split("\n")) {
    const match = /^##\s+(\d+)\.\s/.exec(line);

    if (match !== null) numbers.push(Number(match[1]));
  }

  return numbers;
}

/**
 * Extract the text of one numbered section, without its heading.
 *
 * @param {string} text
 * @param {number} number
 * @returns {string | null}
 */
function sectionText(text, number) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${number}\\.\\s`).test(line));

  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s+\d+\.\s/.test(line));
  const body = end === -1 ? rest : rest.slice(0, end);

  return body.join("\n");
}

/**
 * Run the command-table generator in check mode.
 *
 * @returns {{ code: number, output: string }}
 */
function runGeneratorCheck() {
  const result = spawnSync(process.execPath, [GENERATOR, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  if (result.error !== undefined && result.error !== null) {
    throw new BrokenGate(`cannot run ${GENERATOR}: ${messageOf(result.error)}`);
  }

  return {
    code: typeof result.status === "number" ? result.status : 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

/**
 * Run one git command in the repository.
 *
 * @param {string[]} args
 * @returns {{ code: number, stdout: string }}
 */
function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });

  if (result.error !== undefined && result.error !== null) {
    throw new BrokenGate(`cannot run git: ${messageOf(result.error)}`);
  }

  return {
    code: typeof result.status === "number" ? result.status : 1,
    stdout: `${result.stdout ?? ""}`.trim(),
  };
}

/**
 * Check 1: the generated command tables match both READMEs.
 *
 * @param {Violation[]} violations
 * @returns {string} the summary line for a green run
 */
function checkCommands(violations) {
  const result = runGeneratorCheck();

  if (result.code === 2) {
    throw new BrokenGate(
      `the command-table generator cannot judge its inputs:\n${indent(result.output)}`,
    );
  }

  if (result.code !== 0) {
    for (const line of result.output.split("\n")) {
      if (line.startsWith("FAIL")) violations.push(new Violation("commands", line.trim()));
    }

    if (violations.length === 0) {
      violations.push(new Violation("commands", "the generated command tables are out of date"));
    }

    return "";
  }

  const counts = READMES.map((relative) => commandRowCount(generatedBlock(readText(relative), relative)));

  return `both READMEs match the generator (${counts.join(" and ")} command rows)`;
}

/**
 * Check 2: both READMEs carry sections 1 through 9 and the same command rows.
 *
 * @param {Violation[]} violations
 * @returns {string}
 */
function checkStructure(violations) {
  const shapes = READMES.map((relative) => {
    const text = readText(relative);

    return {
      relative,
      sections: numberedSections(text),
      rows: commandRowCount(generatedBlock(text, relative)),
    };
  });

  let ok = true;

  for (const shape of shapes) {
    const missing = [];

    for (let number = 1; number <= 9; number += 1) {
      if (!shape.sections.includes(number)) missing.push(number);
    }

    if (missing.length > 0) {
      ok = false;
      violations.push(
        new Violation("structure", `${shape.relative}: missing sections ${missing.join(", ")}`),
      );
    }

    const duplicated = shape.sections.filter(
      (number, index) => shape.sections.indexOf(number) !== index,
    );

    if (duplicated.length > 0) {
      ok = false;
      violations.push(
        new Violation(
          "structure",
          `${shape.relative}: section numbers repeated: ${[...new Set(duplicated)].join(", ")}`,
        ),
      );
    }
  }

  const [first, second] = shapes;

  if (first.rows !== second.rows) {
    ok = false;
    violations.push(
      new Violation(
        "structure",
        `command rows differ: ${first.relative} has ${first.rows}, ${second.relative} has ${second.rows}`,
      ),
    );
  }

  if (!ok) return "";

  return `9 numbered sections on both sides; ${first.rows} command rows each`;
}

/**
 * List the tracked reader-facing documents.
 *
 * Tracked rather than discovered on disk: a build directory contains a
 * `README.md` for every dependency, and this gate is about what the repository
 * publishes. `-z` keeps a path with a space intact.
 *
 * @returns {string[]} repo-relative posix paths, sorted
 */
function publicDocuments() {
  const listed = git(["ls-files", "-z"]);

  if (listed.code !== 0) {
    throw new BrokenGate("git ls-files failed");
  }

  return listed.stdout
    .split("\u0000")
    .filter((entry) => entry !== "")
    .filter((entry) => PUBLIC_DOCUMENT_PATTERN.test(path.posix.basename(entry)))
    .filter((entry) => !NOT_PUBLIC_PREFIXES.some((prefix) => entry.startsWith(prefix)))
    .filter((entry) => existsSync(path.join(ROOT, entry)))
    .sort();
}

/**
 * Check 3: no internal identifier appears in a reader-facing document.
 *
 * @param {Violation[]} violations
 * @returns {string}
 */
function checkIdentifiers(violations) {
  const documents = publicDocuments();

  if (documents.length === 0) {
    throw new BrokenGate("no reader-facing document is tracked");
  }

  for (const entry of documents) {
    const lines = readText(entry).split("\n");

    for (const [index, line] of lines.entries()) {
      if (INTERNAL_IDENTIFIER.test(line)) {
        violations.push(
          new Violation(
            "identifiers",
            `${entry}:${index + 1} internal identifier; describe the rule in words instead`,
          ),
        );
      }
    }
  }

  if (violations.length > 0) return "";

  return `no internal identifier in ${documents.length} public documents`;
}

/**
 * Check 4: the status section is pinned to a real ancestor of HEAD.
 *
 * @param {Violation[]} violations
 * @returns {string}
 */
function checkAnchor(violations) {
  const resolved = [];
  let ok = true;

  for (const relative of READMES) {
    const status = sectionText(readText(relative), 2);

    if (status === null) {
      ok = false;
      violations.push(new Violation("anchor", `${relative}: there is no section 2 to pin`));
      continue;
    }

    const match = /main@([0-9a-f]{7,40})\b/.exec(status);

    if (match === null) {
      ok = false;
      violations.push(
        new Violation(
          "anchor",
          `${relative}: section 2 has no main@<sha> anchor; say which commit it describes`,
        ),
      );
      continue;
    }

    const sha = match[1];
    const commit = git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);

    if (commit.code !== 0 || commit.stdout === "") {
      ok = false;
      violations.push(new Violation("anchor", `${relative}: main@${sha} does not resolve to a commit`));
      continue;
    }

    const ancestor = git(["merge-base", "--is-ancestor", commit.stdout, "HEAD"]);

    if (ancestor.code === 1) {
      ok = false;
      violations.push(
        new Violation("anchor", `${relative}: main@${sha} is not an ancestor of HEAD`),
      );
      continue;
    }

    if (ancestor.code !== 0) {
      throw new BrokenGate(`git merge-base failed for main@${sha}`);
    }

    resolved.push({ relative, sha: commit.stdout });
  }

  if (!ok) return "";

  const [first, second] = resolved;

  if (first.sha !== second.sha) {
    violations.push(
      new Violation(
        "anchor",
        `the two READMEs pin different commits: ${first.relative} main@${first.sha.slice(0, 7)}, ${second.relative} main@${second.sha.slice(0, 7)}`,
      ),
    );

    return "";
  }

  return `main@${first.sha.slice(0, 7)} resolves and is an ancestor of HEAD`;
}

/**
 * Indent a captured block so a multi-line message stays readable.
 *
 * @param {string} text
 * @returns {string}
 */
function indent(text) {
  return text
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

/**
 * Print usage and exit 0.
 *
 * @returns {void}
 */
function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/docs/check-public-docs.mjs",
      "",
      "Checks, in order:",
      "  1. both READMEs match the generated command tables",
      "  2. both READMEs have sections 1-9 and the same number of command rows",
      "  3. README*/NOTICE/THIRD-PARTY carry no internal identifier",
      "  4. the status section pins main@<sha>, a real ancestor of HEAD",
      "",
      "Exit codes: 0 all passed, 1 a violation, 2 the gate cannot judge.",
      "",
    ].join("\n"),
  );
}

/**
 * Entry point.
 *
 * @returns {void}
 */
function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--help" && arg !== "-h");

  if (unknown.length > 0) {
    process.stderr.write(`check-public-docs: unknown argument "${unknown[0]}"\n`);
    process.exitCode = 2;

    return;
  }

  if (args.length > 0) {
    printHelp();

    return;
  }

  for (const relative of [...READMES, GENERATOR]) {
    if (!existsSync(path.join(ROOT, relative))) {
      throw new BrokenGate(`missing ${relative}`);
    }
  }

  const checks = [
    { name: "commands", run: checkCommands },
    { name: "structure", run: checkStructure },
    { name: "identifiers", run: checkIdentifiers },
    { name: "anchor", run: checkAnchor },
  ];
  let failed = 0;

  for (const check of checks) {
    const violations = [];
    let summary = "";

    try {
      summary = check.run(violations);
    } catch (error) {
      if (error instanceof BrokenGate) throw error;

      throw new BrokenGate(`${check.name}: ${messageOf(error)}`);
    }

    if (violations.length === 0) {
      process.stdout.write(`ok    ${check.name.padEnd(12)} ${summary}\n`);
      continue;
    }

    failed += 1;

    for (const violation of violations) {
      process.stdout.write(`FAIL  ${check.name.padEnd(12)} ${violation.message}\n`);
    }
  }

  if (failed > 0) {
    process.stdout.write(
      `\n${failed} of ${checks.length} checks failed; fix the lines above, then rerun.\n`,
    );
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  if (error instanceof BrokenGate) {
    process.stderr.write(`check-public-docs: ${error.message}\n`);
  } else {
    process.stderr.write(`check-public-docs: unexpected failure: ${messageOf(error)}\n`);
  }

  process.exitCode = 2;
}
