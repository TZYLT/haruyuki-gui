#!/usr/bin/env node
/**
 * gen-command-table.mjs - build the README command tables from package.json.
 *
 * The two READMEs must list every command a reader can run. Keeping that list
 * by hand is how it went stale: the table claimed to hold every release script
 * while ten of them had never been added, and nothing failed when one was
 * renamed. So the table is generated here and checked, never edited in place.
 *
 * The truth sources are split on purpose:
 *
 * - **The commands themselves** come from the `scripts` of the root
 *   `package.json` and of every `apps/*` package. Their names, their order and
 *   their presence are the manifest's, not this file's.
 * - **The prose** (one purpose, one exit-code sentence per command) lives in
 *   `command-notes.json`, because the generator can prove a script exists but
 *   cannot know what it is for. A script with no note, or a note left behind by
 *   a removed script, is an error: that is what makes "someone added a script"
 *   turn red instead of silently widening the gap.
 * - **Repository script files** that are not reached through `package.json`
 *   (the release pipeline's own executables) are listed in the same notes file
 *   under `files`, and the generator checks that each path still exists.
 *
 * Usage:
 *   node scripts/docs/gen-command-table.mjs           write both READMEs
 *   node scripts/docs/gen-command-table.mjs --check   verify only, do not write
 *   node scripts/docs/gen-command-table.mjs --help    print this text
 *
 * Exit codes (the shared gate-cli three-value contract):
 *   0 = the tables are in place (or were written)
 *   1 = --check found the README out of date
 *   2 = the generator cannot judge: bad argument, unreadable JSON, a note
 *       missing for an existing script, a note naming a script that is gone,
 *       a `files` entry whose path does not exist, or a README without exactly
 *       one marker pair
 *
 * The generated region is delimited in each README by one HTML comment pair:
 *
 *   <!-- BEGIN GENERATED:commands -->
 *   ...
 *   <!-- END GENERATED:commands -->
 *
 * Everything outside the pair is hand-written and never touched here.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of this script, used to make the run independent of the cwd. */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Repository root, resolved from this file rather than from `process.cwd()`. */
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
/** The hand-written prose, one entry per command. */
const NOTES_PATH = path.join(SCRIPT_DIR, "command-notes.json");

/** Marker that opens the generated region in every README. */
const MARKER_BEGIN = "<!-- BEGIN GENERATED:commands -->";
/** Marker that closes it. */
const MARKER_END = "<!-- END GENERATED:commands -->";

/** The READMEs this generator owns, with the language their prose comes from. */
const README_TARGETS = [
  { file: "README.md", language: "zh", title: "README" },
  { file: "README.en.md", language: "en", title: "README" },
];

/** Chinese and English captions, kept next to the table shape they describe. */
const CAPTIONS = {
  packages: {
    zh: "**包脚本（根 `package.json` 与 `apps/*/package.json` 的 `scripts`，按声明顺序）**",
    en: "**Package scripts (the `scripts` of the root `package.json` and of every `apps/*/package.json`, in declaration order)**",
  },
  files: {
    zh: "**仓库内脚本文件（不经过 `package.json`，只由 `command-notes.json` 登记）**",
    en: "**Repository script files (not reached through `package.json`; registered in `command-notes.json`)**",
  },
};

/** Column headings per language. */
const HEADINGS = {
  zh: ["命令", "用途", "退出码"],
  en: ["Command", "Purpose", "Exit code"],
};

/**
 * Code points that occupy two terminal cells.
 *
 * Only used to line the Markdown source up for a human reading it in an editor;
 * the rendered table is aligned by the renderer either way. A misclassified
 * character costs whitespace, never correctness.
 *
 * @param {number} codePoint
 * @returns {boolean}
 */
function isWide(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/**
 * Display width of a string in terminal cells.
 *
 * @param {string} text
 * @returns {number}
 */
function displayWidth(text) {
  let width = 0;

  for (const character of text) {
    width += isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
  }

  return width;
}

/**
 * Pad a cell to a display width, so the source table reads as a table.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function pad(text, width) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Render one Markdown table.
 *
 * Cells are assumed not to contain `|`, which the notes contract forbids; the
 * validation below rejects a note that would break the table rather than
 * escaping it and producing a table nobody wrote.
 *
 * @param {string[]} headings
 * @param {string[][]} rows
 * @returns {string}
 */
function renderTable(headings, rows) {
  const [first, second, third] = headings;
  const widths = [
    Math.max(displayWidth(first), ...rows.map((row) => displayWidth(row[0]))),
    Math.max(displayWidth(second), ...rows.map((row) => displayWidth(row[1]))),
    Math.max(displayWidth(third), ...rows.map((row) => displayWidth(row[2]))),
  ];
  const lines = [
    `| ${pad(first, widths[0])} | ${pad(second, widths[1])} | ${pad(third, widths[2])} |`,
    `| ${"-".repeat(widths[0])} | ${"-".repeat(widths[1])} | ${"-".repeat(widths[2])} |`,
  ];

  for (const row of rows) {
    lines.push(
      `| ${pad(row[0], widths[0])} | ${pad(row[1], widths[1])} | ${pad(row[2], widths[2])} |`,
    );
  }

  return lines.join("\n");
}

/**
 * Read and parse one JSON file, turning any failure into an exit-2 message.
 *
 * @param {string} absolute
 * @returns {unknown}
 */
function readJson(absolute) {
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new GeneratorError(`cannot read ${path.relative(ROOT, absolute)}: ${messageOf(error)}`);
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

/** A problem with the generator's own inputs; always exit 2. */
class GeneratorError extends Error {}

/**
 * Read one notes entry and check its shape.
 *
 * @param {string} label where the entry lives, for the error message
 * @param {unknown} entry
 * @returns {{ purpose: { zh: string, en: string }, exit: { zh: string, en: string } }}
 */
function readNote(label, entry) {
  const fail = (detail) => {
    throw new GeneratorError(`${NOTES_NAME}: ${label} ${detail}`);
  };

  if (entry === null || typeof entry !== "object") fail("is not an object");

  const note = /** @type {Record<string, unknown>} */ (entry);
  const keys = Object.keys(note).sort();

  if (keys.join(",") !== "exit,purpose") fail(`must have exactly the keys "purpose" and "exit"`);

  for (const field of ["purpose", "exit"]) {
    const value = /** @type {Record<string, unknown>} */ (note[field]);

    if (value === null || typeof value !== "object") fail(`has no object at "${field}"`);

    for (const language of ["zh", "en"]) {
      const text = /** @type {Record<string, unknown>} */ (value)[language];

      if (typeof text !== "string" || text.trim() === "") {
        fail(`has no non-empty "${field}.${language}"`);
      }

      if (text.includes("|")) fail(`has a "|" in "${field}.${language}"; it would break the table`);
      if (text.includes("\n")) fail(`has a newline in "${field}.${language}"`);
    }
  }

  return /** @type {{ purpose: { zh: string, en: string }, exit: { zh: string, en: string } }} */ (
    note
  );
}

/** The file name used in errors; short, because the directory is implied. */
const NOTES_NAME = path.basename(NOTES_PATH);

/**
 * Collect the package sources, in the order the tables show them.
 *
 * The root comes first, then every `apps/*` directory that has a
 * `package.json`, sorted by directory name so the output never depends on the
 * file system's enumeration order.
 *
 * @returns {{ key: string, label: string, manifestPath: string, name: string, scripts: Record<string, string> }[]}
 */
function readPackages() {
  const folders = ["root"];

  for (const entry of readdirSync(path.join(ROOT, "apps"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(path.join(ROOT, "apps", entry.name, "package.json"))) continue;

    folders.push(`apps/${entry.name}`);
  }

  return folders.map((key) => {
    const manifestPath = key === "root" ? "package.json" : `${key}/package.json`;
    const manifest = readJson(path.join(ROOT, manifestPath));

    if (manifest === null || typeof manifest !== "object") {
      throw new GeneratorError(`${manifestPath} is not a JSON object`);
    }

    const record = /** @type {Record<string, unknown>} */ (manifest);
    const scripts = record.scripts;

    if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
      throw new GeneratorError(`${manifestPath} has no "scripts" object`);
    }

    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== "string" || command.trim() === "") {
        throw new GeneratorError(`${manifestPath}: script "${name}" has no command string`);
      }
    }

    return {
      key,
      label: manifestPath,
      manifestPath,
      name: typeof record.name === "string" ? record.name : key,
      scripts: /** @type {Record<string, string>} */ (scripts),
    };
  });
}

/**
 * Build the rows of both tables for one language.
 *
 * Also enforces the notes contract in both directions: every script needs a
 * note, and every note must name a script that is still there.
 *
 * @param {string} language "zh" or "en"
 * @returns {{ packageRows: string[][], fileRows: string[][] }}
 */
function buildRows(language) {
  const notes = readJson(NOTES_PATH);

  if (notes === null || typeof notes !== "object") {
    throw new GeneratorError(`${NOTES_NAME} is not a JSON object`);
  }

  const noteRecord = /** @type {Record<string, unknown>} */ (notes);
  const packageNotes = noteRecord.packages;
  const fileNotes = noteRecord.files;

  if (packageNotes === null || typeof packageNotes !== "object") {
    throw new GeneratorError(`${NOTES_NAME} has no "packages" object`);
  }

  if (fileNotes === null || typeof fileNotes !== "object") {
    throw new GeneratorError(`${NOTES_NAME} has no "files" object`);
  }

  const packages = readPackages();
  const known = new Set(packages.map((entry) => entry.key));

  for (const key of Object.keys(/** @type {Record<string, unknown>} */ (packageNotes))) {
    if (!known.has(key)) {
      throw new GeneratorError(
        `${NOTES_NAME}: "packages.${key}" names no package; the sources are root and apps/*`,
      );
    }
  }

  const packageRows = [];

  for (const entry of packages) {
    const section = /** @type {Record<string, unknown> | undefined} */ (
      /** @type {Record<string, unknown>} */ (packageNotes)[entry.key]
    );

    if (section === undefined) {
      throw new GeneratorError(`${NOTES_NAME}: no "packages.${entry.key}" section`);
    }

    const scriptNames = Object.keys(entry.scripts);

    for (const name of Object.keys(section)) {
      if (!scriptNames.includes(name)) {
        throw new GeneratorError(
          `${NOTES_NAME}: "packages.${entry.key}.${name}" names no script in ${entry.label}`,
        );
      }
    }

    for (const name of scriptNames) {
      if (!(name in section)) {
        throw new GeneratorError(
          `${NOTES_NAME}: no note for "${name}" in ${entry.label}; add one before the table can be generated`,
        );
      }

      const note = readNote(`packages.${entry.key}.${name}`, section[name]);
      const command =
        entry.key === "root" ? `pnpm ${name}` : `pnpm --filter ${entry.name} ${name}`;

      packageRows.push([`\`${command}\``, note.purpose[language], note.exit[language]]);
    }
  }

  const fileRows = [];

  for (const [relative, rawNote] of Object.entries(/** @type {Record<string, unknown>} */ (fileNotes)).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const absolute = path.join(ROOT, relative);

    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new GeneratorError(`${NOTES_NAME}: "files.${relative}" does not exist`);
    }

    const note = readNote(`files.${relative}`, rawNote);
    const runner = relative.endsWith(".sh") ? "bash" : "node";

    fileRows.push([`\`${runner} ${relative}\``, note.purpose[language], note.exit[language]]);
  }

  return { packageRows, fileRows };
}

/**
 * Render the full text that belongs between the markers.
 *
 * @param {string} language
 * @returns {string}
 */
function renderInner(language) {
  const { packageRows, fileRows } = buildRows(language);
  const headings = HEADINGS[language];

  const sections = [
    `${CAPTIONS.packages[language]}\n\n${renderTable(headings, packageRows)}`,
    `${CAPTIONS.files[language]}\n\n${renderTable(headings, fileRows)}`,
  ];

  return sections.join("\n\n");
}

/**
 * Read one README and return the text around and between its markers.
 *
 * Exactly one marker pair is required: a second pair would mean the file has
 * two generated regions and only one of them would be maintained.
 *
 * @param {string} relative
 * @returns {{ text: string, before: string, inner: string, after: string }}
 */
function readGeneratedRegion(relative) {
  const absolute = path.join(ROOT, relative);
  let text;

  try {
    text = readFileSync(absolute, "utf8").replaceAll("\r\n", "\n");
  } catch (error) {
    throw new GeneratorError(`cannot read ${relative}: ${messageOf(error)}`);
  }

  const begin = text.indexOf(MARKER_BEGIN);
  const end = text.indexOf(MARKER_END);

  if (begin === -1 || end === -1 || end < begin) {
    throw new GeneratorError(`${relative}: missing the ${MARKER_BEGIN} / ${MARKER_END} markers`);
  }

  if (text.indexOf(MARKER_BEGIN, begin + 1) !== -1 || text.indexOf(MARKER_END, end + 1) !== -1) {
    throw new GeneratorError(`${relative}: more than one marker pair`);
  }

  const before = text.slice(0, begin + MARKER_BEGIN.length);
  const inner = text
    .slice(begin + MARKER_BEGIN.length, end)
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  const after = text.slice(end);

  return { text, before, inner, after };
}

/**
 * Rebuild one README with a freshly generated region.
 *
 * A blank line is kept between each marker and the generated content, so the
 * surrounding prose and the generated block stay readable in the Markdown
 * source as well as in the rendered page.
 *
 * @param {{ before: string, after: string }} region
 * @param {string} inner
 * @returns {string}
 */
function withInner(region, inner) {
  return `${region.before}\n\n${inner}\n\n${region.after}`;
}

/**
 * Print usage and exit 0.
 *
 * @returns {void}
 */
function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/docs/gen-command-table.mjs [--check] [--help]",
      "",
      "  (no flag)  regenerate and write the command tables in both READMEs",
      "  --check    compare the READMEs with the generated tables; exit 1 on drift",
      "  --help     print this text and exit 0",
      "",
      "Truth sources: the scripts of the root and apps/* package.json files, plus",
      "scripts/docs/command-notes.json for the purpose and exit-code prose.",
      "A script with no note, or a note naming a removed script, exits 2.",
      "",
      "Exit codes: 0 in place, 1 out of date (--check), 2 broken input.",
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
  const unknown = args.filter((arg) => arg !== "--check" && arg !== "--help" && arg !== "-h");

  if (unknown.length > 0) {
    process.stderr.write(`gen-command-table: unknown argument "${unknown[0]}"\n`);
    process.exitCode = 2;

    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();

    return;
  }

  const check = args.includes("--check");
  let drift = 0;

  for (const target of README_TARGETS) {
    const region = readGeneratedRegion(target.file);
    const inner = renderInner(target.language);

    if (check) {
      if (region.inner === inner) {
        process.stdout.write(`ok    ${target.file}: command tables up to date\n`);
        continue;
      }

      drift += 1;
      const expected = inner.split("\n");
      const actual = region.inner.split("\n");
      let line = 0;

      while (line < expected.length || line < actual.length) {
        if (expected[line] !== actual[line]) break;
        line += 1;
      }

      process.stdout.write(
        `FAIL  ${target.file}: generated block differs at line ${line + 1} of the block\n`,
      );
      continue;
    }

    writeFileSync(path.join(ROOT, target.file), withInner(region, inner), "utf8");
    process.stdout.write(`write ${target.file}: command tables regenerated\n`);
  }

  if (drift > 0) {
    process.stdout.write(
      "\nrun: node scripts/docs/gen-command-table.mjs   (then commit both READMEs)\n",
    );
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  if (error instanceof GeneratorError) {
    process.stderr.write(`gen-command-table: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`gen-command-table: unexpected failure: ${messageOf(error)}\n`);
    process.exitCode = 2;
  }
}
