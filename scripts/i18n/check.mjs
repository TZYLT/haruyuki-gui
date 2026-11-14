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

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { runGate } from "../lib/gate-cli.mjs";

/** Where the catalogues live, repo-relative. */
const LOCALES_DIR = "packages/ui/src/i18n/locales";

/** The catalogues under comparison. English is the reference. */
const REFERENCE_LOCALE = "en";
const OTHER_LOCALES = ["zh-CN"];

/** Frozen key format: a namespace, then two to four lowerCamelCase segments. */
const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){0,2}$/;

/** Frozen namespace set. */
const NAMESPACES = new Set(["common", "component", "page", "error", "a11y"]);

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

  let depth = 0;

  for (const char of message) {
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth < 0) return "unbalanced closing brace";
    }
  }

  if (depth !== 0) return "unbalanced opening brace";

  // `plural` and `select` require an `other` branch; ICU throws without it.
  for (const match of message.matchAll(
    /\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*,\s*(plural|select|selectordinal)\s*,/g,
  )) {
    const kind = match[1] ?? "";
    const tail = message.slice(match.index ?? 0);

    if (!/\bother\s*\{/.test(tail)) {
      return `${kind} has no other branch`;
    }
  }

  // An empty argument such as `{}` or `{ }` is not valid ICU.
  if (/\{\s*\}/.test(message)) return "empty argument";

  return null;
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

  return violations;
}

await runGate(collectViolations, {});
