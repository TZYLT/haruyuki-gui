/**
 * check-i18n.mjs - gate: the catalogues are complete, valid and consistent.
 *
 * Usage:
 *   node scripts/i18n/check.mjs                 # scan this repository
 *   node scripts/i18n/check.mjs --root <dir>    # scan another tree (self-tests)
 *
 * Three checks, each with its own rule id:
 *
 *   I1 key-set        the two catalogues declare exactly the same keys
 *   I2 valid-icu      every message parses as ICU MessageFormat
 *   I3 placeholder    a key's interpolation argument set is identical in both
 *                     catalogues -- the failure mode that turns "Hello {name}"
 *                     into a silently missing name
 *   I4 key-format     keys match the frozen pattern and use a frozen namespace
 *   I5 no-key-value   no value equals its own key, the classic untranslated stub
 *   I6 reference      every key a component asks `t()` for exists in the
 *                     catalogue, and every catalogue key is used by something.
 *                     A dangling reference renders as an error at runtime; an
 *                     unused key rots silently and the next translator copies it.
 *
 * The catalogue sources are read, not imported. Importing would tie the gate to
 * the package compiling, so a tree with a type error could not be linted -- and a
 * translation key set is exactly the kind of thing worth checking while the code
 * is half-finished. Reading also lets the gate run before any build exists.
 *
 * The reader understands the literal object shape the catalogues use. That is a
 * real constraint, and I1's "no keys found" error is what makes it safe: a shapes
 * change makes the gate fail loudly instead of reporting an empty, passing set.
 *
 * Exit codes follow scripts/lib/gate-cli.mjs: 0 clean, 1 violations, 2 broken.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { TYPE, parse } from "@formatjs/icu-messageformat-parser";

import { runGate } from "../lib/gate-cli.mjs";

/** Where the catalogues live, repo-relative. */
const LOCALES_DIR = "packages/ui/src/i18n/locales";

/** Where the code that consumes keys lives. */
const COMPONENT_DIRS = [
  "packages/ui/src/components",
  "packages/ui/src/examples",
  "packages/ui/src/icons",
  // The desktop shell renders catalogue keys too, and was outside this scan
  // until the review found it. `apps/desktop/src/renderer/error-page.tsx` calls
  // `t()` for real; a renamed key there would have been a runtime hole that this
  // gate reported as clean. The I6 rule is only as good as its consumer list.
  "apps/desktop/src/renderer",
  "apps/desktop/src/shared",
];

/** The catalogues under comparison. English is the reference. */
const REFERENCE_LOCALE = "en";
const OTHER_LOCALES = ["zh-CN"];

/** Frozen key format: a namespace, then two to four lowerCamelCase segments. */
const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){0,2}$/;

/** Frozen namespace set. */
const NAMESPACES = new Set(["common", "component", "page", "error", "a11y"]);

/**
 * The one main-process file whose `t()` literals count as references.
 *
 * I6 scans the renderer and the shared layer. The Help menu's labels are the
 * first user-visible strings in the main process, and they are still `t()`
 * literals, so without this the menu's keys would all report as dead weight.
 *
 * Narrow on purpose: scanning `apps/desktop/src/main` whole would treat log
 * event identifiers and IPC channel strings as key references, which is exactly
 * the "any string that looks like a key" hole this rule avoids. One file is
 * enough -- the Help menu's labels and both cleanup dialogs' copy are resolved
 * in `menu.ts`, so that is where their keys appear.
 */
const MENU_REFERENCES = "apps/desktop/src/main/menu.ts";

/**
 * The shell's code-to-key table, which counts as a reference for I6.
 *
 * Named here rather than discovered, so moving the table breaks this gate loudly
 * instead of silently turning five live keys into five "unused" reports.
 */
const SHELL_ERROR_TABLE = "apps/desktop/src/shared/shell-error.ts";

/**
 * Read a file as UTF-8.
 *
 * @param {string} absolute absolute path
 * @returns {string}
 */
function read(absolute) {
  return readFileSync(absolute, "utf8");
}

/**
 * List source files below a directory.
 *
 * Only `.ts` and `.tsx` are considered, and test files are filtered by the caller
 * because a test legitimately references keys the app does not.
 *
 * @param {string} root absolute posix repo root
 * @param {string} relative repo-relative directory
 * @returns {string[]} repo-relative posix paths
 */
function listSourceFiles(root, relative) {
  const absolute = path.join(root, relative);

  if (!existsSync(absolute)) return [];

  const found = [];

  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;

    if (entry.isDirectory()) {
      found.push(...listSourceFiles(root, child));
    } else if (/[.]tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      found.push(child);
    }
  }

  return found;
}

/**
 * Extract the `"key": "value"` pairs from a catalogue module.
 *
 * Values are matched with a string literal that may contain escaped quotes, which
 * is what ICU needs (`{count, plural, one {# item} other {# items}}` contains no
 * quotes today, but a message about quoting would).
 *
 * @param {string} source catalogue source
 * @returns {Map<string, string>} key to raw message text
 */
function parseCatalogue(source) {
  const entries = new Map();

  for (const match of source.matchAll(/"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const [, key, value] = match;

    if (key !== undefined && value !== undefined) {
      entries.set(key, value.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
    }
  }

  return entries;
}

/**
 * Extract the argument names a message uses.
 *
 * Walks braces rather than using a regex over `{name}`: ICU nests, so a naive
 * pattern would report `plural` branch labels as arguments.
 *
 * @param {string} message ICU message
 * @returns {Set<string>} argument names
 */
function argumentsIn(message) {
  const names = new Set();
  let depth = 0;

  for (let index = 0; index < message.length; index += 1) {
    const char = message[index];

    if (char === "{") {
      // At depth 0 the brace opens an argument and the identifier follows it.
      if (depth === 0) {
        const rest = message.slice(index + 1);
        const name = /^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*[,}]/.exec(rest)?.[1];

        if (name !== undefined) names.add(name);
      }

      depth += 1;
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
    }
  }

  return names;
}

/**
 * Decide whether a message is well-formed ICU.
 *
 * This is a structural check, not a full parser: balanced braces, no empty
 * argument, and every `plural`/`select` carrying an `other` branch (which ICU
 * requires for both). A real parser would be better and would mean importing the
 * package -- the trade documented at the top of this file.
 *
 * @param {string} message ICU message
 * @returns {string | null} a reason when invalid, null when it looks valid
 */
function icuProblem(message) {
  if (message.trim() === "") return "message is empty";

  // Parsed with the real ICU grammar rather than counted in braces.
  //
  // Brace counting cannot tell an argument from an escaped literal: ICU allows
  // `'{'` and `'}'` to mean the literal characters, so `Use '{' to open a block`
  // is a valid message that a counter reads as an unbalanced opening brace. It
  // also cannot see that `{a, plural, one {x}} {b, plural, other {y}}` is broken
  // -- a scan for `\bother\s*\{` anywhere in the message is satisfied by the
  // second argument's branch, so the first argument's missing `other` goes
  // unreported until runtime, when `IntlMessageFormat` throws in the user's face.
  // The parser is already a devDependency for the runtime format path, so using
  // it here costs nothing and is exact.
  let ast;

  try {
    ast = parse(message);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    // The parser already rejects a missing `other` clause by name. Translated
    // into the vocabulary the rest of this gate uses, so the message reads like
    // the rule it belongs to instead of like a parser stack.
    if (reason.includes("MISSING_OTHER_CLAUSE")) {
      return "plural has no other branch";
    }

    return `invalid ICU: ${reason}`;
  }

  // `plural` / `select` / `selectordinal` must carry an `other` branch. The
  // parser accepts their absence; the formatter throws without it.
  const checkBranches = (nodes) => {
    for (const node of nodes) {
      if (
        node.type === TYPE.plural ||
        node.type === TYPE.select ||
        node.type === TYPE.selectordinal
      ) {
        const hasOther = node.options !== undefined && node.options.other !== undefined;

        if (!hasOther) {
          return `${node.value} has no other branch`;
        }

        for (const option of Object.values(node.options)) {
          const problem = checkBranches(option.value);

          if (problem !== null) return problem;
        }
      }
    }

    return null;
  };

  return checkBranches(ast);
}

/**
 * Collect every violation.
 *
 * @param {{ root: string }} args parsed arguments
 * @returns {object[]} violations
 */
function collectViolations(args) {
  const violations = [];
  const referenceFile = `${LOCALES_DIR}/${REFERENCE_LOCALE}.ts`;
  const referencePath = path.join(args.root, referenceFile);

  if (!existsSync(referencePath)) {
    throw new Error(`cannot find ${referenceFile}; is --root a haruyuki-gui checkout?`);
  }

  const reference = parseCatalogue(read(referencePath));

  if (reference.size === 0) {
    throw new Error(`no keys found in ${referenceFile}; the parser and the file disagree`);
  }

  /** @type {Map<string, Map<string, string>>} */
  const catalogues = new Map([[REFERENCE_LOCALE, reference]]);

  for (const locale of OTHER_LOCALES) {
    const file = `${LOCALES_DIR}/${locale}.ts`;
    const absolute = path.join(args.root, file);

    if (!existsSync(absolute)) {
      violations.push({ file, rule: "I1", message: `catalogue for ${locale} is missing` });
      continue;
    }

    const entries = parseCatalogue(read(absolute));

    if (entries.size === 0) {
      throw new Error(`no keys found in ${file}; the parser and the file disagree`);
    }

    catalogues.set(locale, entries);
  }

  // ---- I1: identical key sets.
  for (const [locale, entries] of catalogues) {
    if (locale === REFERENCE_LOCALE) continue;

    const file = `${LOCALES_DIR}/${locale}.ts`;

    for (const key of reference.keys()) {
      if (!entries.has(key)) {
        violations.push({ file, rule: "I1", message: `${key} is missing` });
      }
    }

    for (const key of entries.keys()) {
      if (!reference.has(key)) {
        violations.push({
          file,
          rule: "I1",
          message: `${key} does not exist in ${REFERENCE_LOCALE}`,
        });
      }
    }
  }

  // ---- I2 / I4 / I5 / I3.
  const referenceArguments = new Map();

  for (const [locale, entries] of catalogues) {
    const file = `${LOCALES_DIR}/${locale}.ts`;

    for (const [key, message] of entries) {
      // I4: the key format is frozen, in every catalogue.
      if (!KEY_PATTERN.test(key)) {
        violations.push({
          file,
          rule: "I4",
          message: `${key} does not match namespace.seg[.seg] with lowerCamelCase segments`,
        });
      } else {
        const namespace = key.split(".")[0] ?? "";

        if (!NAMESPACES.has(namespace)) {
          violations.push({
            file,
            rule: "I4",
            message: `${key} uses unknown namespace ${namespace}`,
          });
        }
      }

      // I5: a value equal to its key is an untranslated stub that reads like an id.
      if (message === key) {
        violations.push({ file, rule: "I5", message: `${key} has the key as its value` });
      }

      // I2: the message must be valid ICU.
      const problem = icuProblem(message);

      if (problem !== null) {
        violations.push({ file, rule: "I2", message: `${key}: ${problem}` });
        continue;
      }

      const names = argumentsIn(message);

      if (locale === REFERENCE_LOCALE) {
        referenceArguments.set(key, names);
      } else {
        // I3: the argument set must match the reference exactly. A message that
        // dropped {name} renders a sentence with a hole in it, and nothing else
        // in the pipeline notices.
        const expected = referenceArguments.get(key);

        if (expected !== undefined) {
          const missing = [...expected].filter((name) => !names.has(name));
          const extra = [...names].filter((name) => !expected.has(name));

          if (missing.length > 0) {
            violations.push({
              file,
              rule: "I3",
              message: `${key} is missing placeholder(s) ${missing.join(", ")}`,
            });
          }

          if (extra.length > 0) {
            violations.push({
              file,
              rule: "I3",
              message: `${key} has unknown placeholder(s) ${extra.join(", ")}`,
            });
          }
        }
      }
    }
  }

  // ---- I6: references resolve, and every key is used.
  //
  // Both directions matter and for different reasons. A key the code asks for but
  // the catalogue lacks is a runtime error in one locale only -- the English may
  // exist while the Chinese is missing, which is exactly what I1 already catches,
  // but a key missing from *both* is a typo nobody notices until it renders.
  // An unused key is dead weight that the next translator dutifully translates.
  const sources = [];

  for (const directory of COMPONENT_DIRS) {
    for (const relative of listSourceFiles(args.root, directory)) {
      // Tests count as references. A key that only a test names is genuinely in
      // use -- the plural keys are referenced by the plural test precisely to
      // prove the catalogue honours each language's rule -- and excluding them
      // would push those keys into an allowlist for no reason.
      sources.push({ file: relative, text: read(path.join(args.root, relative)) });
    }
  }

  // The menu's labels are catalogue keys used from the main process; the
  // comment on MENU_REFERENCES says why only that file is read.
  const menuReferences = path.join(args.root, MENU_REFERENCES);

  if (existsSync(menuReferences)) {
    sources.push({ file: MENU_REFERENCES, text: read(menuReferences) });
  }

  // An empty consumer set must not read as "nothing is unused".
  //
  // The guard used to be `if (sources.length > 0)`, so a tree with no consumer
  // directory at all skipped I6 entirely and reported PASS. That made the green
  // fixture's green meaningless -- it has no `components/`, so the half of I6
  // that checks "declared but never referenced" never ran -- and it meant a
  // renamed directory silently disabled the rule. Exit 2 says "the gate could
  // not judge", which is the truth.
  if (sources.length === 0) {
    violations.push({
      file: LOCALES_DIR,
      rule: "I6",
      message: `no source files found in ${COMPONENT_DIRS.join(", ")}; cannot tell which keys are unused`,
    });
  } else {
    const referenced = new Map();

    for (const source of sources) {
      // `t("ns.key")` and `labelKey="ns.key"` are the two ways this package names
      // a key in source. Prop-drilled keys are typed, so a typo there would not
      // compile; these string literals are the untyped route.
      for (const match of source.text.matchAll(
        /(?:t\(|labelKey=|key:)\s*["']([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*){1,3})["']/g,
      )) {
        const key = match[1];

        if (key === undefined) continue;
        if (!referenced.has(key)) referenced.set(key, source.file);
      }
    }

    // The shell's error-code table is a reference mechanism the requirement names
    // explicitly ("this table is the only source for the i18n mapping"), so the
    // gate reads it. Without this, five keys that exist solely to be looked up by
    // code are reported as dead weight -- and the obvious "fix" would be to
    // duplicate them as literals at the call site, which is exactly the second
    // spelling the requirement forbids.
    //
    // Narrow on purpose: one file, one table, one namespace. A general "any string
    // that looks like a key counts as used" rule would let a key in a comment or a
    // docstring keep a dead entry alive forever.
    const shellErrorTable = path.join(args.root, SHELL_ERROR_TABLE);

    if (existsSync(shellErrorTable)) {
      for (const match of read(shellErrorTable).matchAll(/["'](error\.shell\.[a-zA-Z0-9]+)["']/g)) {
        const key = match[1];

        if (key === undefined) continue;
        if (!referenced.has(key)) referenced.set(key, SHELL_ERROR_TABLE);
      }
    }

    for (const [key, file] of referenced) {
      if (!reference.has(key)) {
        violations.push({
          file,
          rule: "I6",
          message: `${key} is referenced but not declared in ${REFERENCE_LOCALE}`,
        });
      }
    }

    for (const key of reference.keys()) {
      if (!referenced.has(key)) {
        violations.push({
          file: referenceFile,
          rule: "I6",
          message: `${key} is declared but never referenced`,
        });
      }
    }
  }

  return violations;
}

await runGate(collectViolations, {});
