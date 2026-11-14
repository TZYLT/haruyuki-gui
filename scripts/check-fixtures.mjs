/**
 * check.mjs - gate: the fixture corpus (wire recordings and bridge frames).
 *
 * Usage:
 *   node scripts/fixtures/check.mjs                 # scan fixtures/
 *   node scripts/fixtures/check.mjs --root <dir>    # scan another tree (self-tests only)
 *
 * Scope
 *   Owns the corpus *shape*: one message per line, a header line that carries a
 *   `schemaVersion`, and the inventory a reader can trust. It deliberately does
 *   not own replay semantics - whether a recording actually replays is a test,
 *   not a lint - and it does not yet own redaction, which is the next pass over
 *   the same files.
 *
 *   The corpus is empty today, so a green run means "nothing to contradict".
 *   The exit contract and the segment slot exist now so that `pnpm verify` has
 *   a stable position for this check before the first recording lands.
 *
 * Why line-oriented
 *   A fixture that fails has to be locatable: `<file>:<line>` is the whole
 *   diagnostic interface, and it only works if one message is one line.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { runGate, toPosix } from "./lib/gate-cli.mjs";

/** Directories whose `*.jsonl` files are part of the corpus, relative to the root. */
const CORPUS_DIRS = ["fixtures/engine/recordings", "fixtures/bridge"];

/** The only fixture schema this gate knows how to read. */
const SUPPORTED_SCHEMA_VERSION = 1;

/** Wire fixtures start with this header kind; bridge fixtures with the other. */
const WIRE_KIND = "wire";
const FRAMES_KIND = "frames";

await runGate(collectViolations);

/**
 * Gate body: walk the corpus, check every file, and report one violation per
 * broken line.
 *
 * @param {{ root: string }} args
 * @returns {Promise<Array<{ file: string, line: number, rule: string, message: string }>>}
 */
async function collectViolations(args) {
  const violations = [];

  for (const relative of listFixtures(args.root)) {
    checkFile(args.root, relative, violations);
  }

  return violations;
}

/**
 * Every fixture file in the corpus, repo-relative and sorted.
 *
 * @param {string} root absolute tree root
 * @returns {string[]}
 */
function listFixtures(root) {
  const found = [];

  for (const dir of CORPUS_DIRS) {
    const absolute = path.join(root, dir);

    if (!existsSync(absolute)) {
      continue;
    }

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push(toPosix(path.join(dir, entry.name)));
      }
    }
  }

  return found.sort();
}

/**
 * Validate one fixture file: header first, then one message per line.
 *
 * @param {string} root absolute tree root
 * @param {string} relative repo-relative fixture path
 * @param {Array<{ file: string, line: number, rule: string, message: string }>} violations
 * @returns {void}
 */
function checkFile(root, relative, violations) {
  const text = readFileSync(path.join(root, relative), "utf8");
  const lines = text.split(/\r?\n/);

  // A trailing newline is not an empty message.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  if (lines.length === 0) {
    violations.push(violation(relative, 1, "empty-fixture", "a fixture needs a header line"));

    return;
  }

  const header = parseLine(relative, 1, lines[0], violations);

  if (header === null) {
    return;
  }

  const kind = checkHeader(relative, header, violations);

  for (let index = 1; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const message = parseLine(relative, lineNumber, lines[index], violations);

    if (message !== null) {
      checkMessage(relative, lineNumber, kind, message, violations);
    }
  }
}

/**
 * Check the header line and return which corpus kind the file claims to be.
 *
 * @param {string} relative repo-relative fixture path
 * @param {Record<string, unknown>} header parsed header
 * @param {Array<{ file: string, line: number, rule: string, message: string }>} violations
 * @returns {string | null}
 */
function checkHeader(relative, header, violations) {
  if (header.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    violations.push(
      violation(
        relative,
        1,
        "schema-version",
        `header must say schemaVersion ${SUPPORTED_SCHEMA_VERSION}, found ${String(header.schemaVersion)}`,
      ),
    );

    return null;
  }

  if (header.kind !== WIRE_KIND && header.kind !== FRAMES_KIND) {
    violations.push(
      violation(
        relative,
        1,
        "header-kind",
        `header kind must be "${WIRE_KIND}" or "${FRAMES_KIND}"`,
      ),
    );

    return null;
  }

  return header.kind;
}

/**
 * Check one message line against the shape its header promised.
 *
 * @param {string} relative repo-relative fixture path
 * @param {number} lineNumber 1-based line number
 * @param {string | null} kind corpus kind from the header
 * @param {Record<string, unknown>} message parsed message
 * @param {Array<{ file: string, line: number, rule: string, message: string }>} violations
 * @returns {void}
 */
function checkMessage(relative, lineNumber, kind, message, violations) {
  if (kind === WIRE_KIND) {
    // Both directions are kept: a fixture without its c2s lines cannot show what
    // the client did, and replay only ever re-emits s2c.
    if (message.dir !== "s2c" && message.dir !== "c2s") {
      violations.push(
        violation(
          relative,
          lineNumber,
          "wire-direction",
          'every wire line needs dir "s2c" or "c2s"',
        ),
      );
    }

    if (typeof message.msg !== "object" || message.msg === null) {
      violations.push(
        violation(relative, lineNumber, "wire-message", "every wire line needs an msg object"),
      );

      return;
    }

    if (typeof message.msg.type !== "string" || message.msg.type === "") {
      violations.push(
        violation(relative, lineNumber, "wire-message-type", "msg.type must be a non-empty string"),
      );
    }

    return;
  }

  if (kind === FRAMES_KIND) {
    for (const key of ["v", "ch", "seq", "t", "body"]) {
      if (!(key in message)) {
        violations.push(
          violation(relative, lineNumber, "frame-envelope", `frame envelope is missing "${key}"`),
        );
      }
    }

    if (typeof message.t !== "string" || message.t === "") {
      violations.push(
        violation(relative, lineNumber, "frame-type", "frame t must be a non-empty string"),
      );
    }
  }
}

/**
 * Parse one line, recording a violation when it is not a JSON object.
 *
 * @param {string} relative repo-relative fixture path
 * @param {number} lineNumber 1-based line number
 * @param {string} text raw line
 * @param {Array<{ file: string, line: number, rule: string, message: string }>} violations
 * @returns {Record<string, unknown> | null}
 */
function parseLine(relative, lineNumber, text, violations) {
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    violations.push(violation(relative, lineNumber, "json", "line is not JSON"));

    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    violations.push(violation(relative, lineNumber, "json-object", "line must be a JSON object"));

    return null;
  }

  return parsed;
}

/**
 * @param {string} file repo-relative fixture path
 * @param {number} line 1-based line number
 * @param {string} rule rule id
 * @param {string} message English, one line
 * @returns {{ file: string, line: number, rule: string, message: string }}
 */
function violation(file, line, rule, message) {
  return { file, line, rule, message };
}
