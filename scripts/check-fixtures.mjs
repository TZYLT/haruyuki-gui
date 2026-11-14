/**
 * check-fixtures.mjs - gate: the fixture corpus (wire recordings and bridge frames).
 *
 * Usage:
 *   node scripts/check-fixtures.mjs                 # scan fixtures/
 *   node scripts/check-fixtures.mjs --root <dir>    # scan another tree (self-tests only)
 *   node scripts/check-fixtures.mjs --help          # print this text and exit 0
 *
 * Scope
 *   Three jobs over the same files:
 *
 *   1. Shape - one message per line, a header that carries `schemaVersion`, and
 *      a message shape that matches the kind the header claims. The corpus is
 *      empty today, so a green run means "nothing to contradict".
 *
 *   2. Redaction - a corpus fixture never contains real content. The rule is
 *      A3-Q12: "fixture never contains real content; always replace it with
 *      synthetic text and keep only structure and token counts"). That means no
 *      real absolute path, no user name from the local deny-list, no email
 *      address, no bearer token or 64-hex token-like string, and no
 *      `request_id` outside the synthetic vocabulary.
 *
 *   3. Version alignment - a wire header whose
 *      `engine.version` / `engine.commit` differs from the pair pinned in
 *      `packages/protocol/src/contract/snapshot.json` prints a `WARN` line and
 *      does NOT change the exit code: failing would force a full re-record on
 *      every engine bump, which the route doc rejects.
 *
 * Why line-oriented
 *   A fixture that fails has to be locatable: `<file>:<line>` is the whole
 *   diagnostic interface, and it only works if one message is one line
 *   , so the corpus INV-A3-1, section 5.1 rule 2).
 *
 * Rule ids (stable; `scripts/check-fixtures.test.ts` asserts each one fires)
 *   shape:
 *     empty-fixture        the file has no header line
 *     json                 a line is not JSON
 *     json-object          a line is JSON but not an object
 *     schema-version       the header is not `schemaVersion: 1`
 *     header-kind          the header is neither "wire" nor "frames"
 *     wire-direction       a wire line is neither "s2c" nor "c2s"
 *     wire-message         a wire line has no `msg` object
 *     wire-message-type    `msg.type` is not a non-empty string
 *     frame-envelope       a frame misses one of v/ch/seq/t/body
 *     frame-type           a frame `t` is not a non-empty string
 *   redaction:
 *     redaction-state      the header marker is missing (wire) or not "r1"+;
 *                          "r0" is the recorder's not-yet-redacted marker
 *     redaction-path       an absolute path outside SYNTHETIC_PATH_ROOTS
 *     redaction-username   the local user name from the deny-list
 *     redaction-email      an email address
 *     redaction-token      "Bearer <token>" or a 64-hex token-like string
 *     redaction-request-id a `request_id` outside SYNTHETIC_REQUEST_ID
 *     redaction-host       a `connection_name` that is not SYNTHETIC_HOSTNAME
 *   The `version-align` WARN line is not a rule: it is advisory output and
 *   never contributes to the exit code.
 *
 * Redaction vocabulary
 *   `redaction: "r0"` means "not redacted yet" and is what the recorder writes
 *   into its gitignored `_research/` output (the recorder records into
 *   records into `_research`, then redacts into the corpus). This gate never
 *   scans `_research/`, `docs/` or `node_modules/`, so an r0 fixture may live
 *   under `_research/`; anything below CORPUS_DIRS must declare `r1` or later.
 *
 *   "Synthetic" means: a value the recording pass chose, not one the engine
 *   produced. Paths may start with C:/work or /tmp/x; `request_id`s may be
 *   `r-<n>`, `req-<n>` or `synthetic-<slug>` (the frozen header example uses
 *   `"request_id": "r-1"`). Everything else must be replaced.
 *
 *   One field is not a path and not a request id: `device_status.connection_name`,
 *   the only place the engine echoes the machine name back (records measured
 *   2026-11-14 carry it verbatim). A machine name identifies the machine it was
 *   recorded on, so the corpus value is always `synthetic-host`. The rule is an
 *   allow-list rather than a deny-list of local host names on purpose: a deny-list
 *   would make the verdict depend on the machine running the gate, and a short
 *   common word used as a host name would start flagging innocent prose.
 *
 *   The user-name deny-list is built from `os.userInfo().username` plus
 *   `%USERNAME%` / `$USER` when set, and is never echoed in output - a gate log
 *   is public too, so messages describe the rule, not the value that fired it.
 *
 * Determinism
 *   Files and directory entries are sorted, output has no timestamps and no
 *   machine-absolute paths: the same input produces the same bytes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runGate, toPosix } from "./lib/gate-cli.mjs";

/** Directories whose `*.jsonl` files are part of the corpus, relative to the root. */
const CORPUS_DIRS = ["fixtures/engine/recordings", "fixtures/bridge"];

/** Directory names the corpus walk never enters, at any depth. */
const SKIPPED_DIRS = new Set(["_research", "docs", "node_modules"]);

/** The only fixture schema this gate knows how to read. */
const SUPPORTED_SCHEMA_VERSION = 1;

/** Wire fixtures start with this header kind; bridge fixtures with the other. */
const WIRE_KIND = "wire";
const FRAMES_KIND = "frames";

/** The contract snapshot that pins the engine version and commit. */
const PINNED_ENGINE_PATH = "packages/protocol/src/contract/snapshot.json";

/**
 * Roots that synthetic paths may use (the recorder rewrites real locations to
 * rewrites real locations to one of these). A path is synthetic when it equals
 * a root or sits below it; `C:/workstation` is NOT below `C:/work`.
 */
const SYNTHETIC_PATH_ROOTS = ["c:/work", "/tmp/x"];

/**
 * The synthetic `request_id` vocabulary. `r-<n>` is the frozen header example,
 * `req-<n>` covers request/response pairs, `synthetic-<slug>` covers names that
 * must stay readable (for example an approval id that is explained in a note).
 */
const SYNTHETIC_REQUEST_ID = /^(?:r|req)-\d{1,6}$|^synthetic-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The only device name the corpus may carry. `device_status.connection_name` is
 * the engine echoing the machine name, which identifies where a recording came
 * from; the redaction pass replaces it with this value (scripts/redact-fixtures.mjs).
 */
const SYNTHETIC_HOSTNAME = "synthetic-host";

/**
 * Absolute-path detectors, applied to decoded JSON strings - never to raw JSON
 * text, where a Windows path arrives as `C:\\work` and the escaping would hide
 * the root. The lookbehinds keep them out of `https://` URLs and ratios.
 */
const WINDOWS_ABSOLUTE_PATH = /(?<![\w:/\\])[A-Za-z]:[\\/][^\s"'<>|,;]*/g;
const POSIX_ABSOLUTE_PATH = /(?<![\w.:/\\-])\/[\w.-]+(?:\/[\w.-]+)*/g;

/** `alice@example.com`, including the addresses a machine name would produce. */
const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

/**
 * An HTTP bearer credential, a 64-hex string (the recorder's own token shape), and a
 * provider API key (`sk-` plus a long tail). The last one is here because a live
 * recording is made against a real model provider: the key itself must never reach a
 * fixture, and only the pattern can catch it after the fact.
 */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const HEX_TOKEN = /(?<![0-9A-Za-z])[0-9a-fA-F]{64}(?![0-9A-Za-z])/;
const PROVIDER_KEY = /(?<![0-9A-Za-z])sk-[A-Za-z0-9_-]{16,}/;

/** One message per rule id; all ASCII, none echoes the value that fired it. */
const REDACTION_MESSAGES = {
  "redaction-state": 'header redaction must be "r1" or later; "r0" means not redacted yet',
  "redaction-path": "absolute path must use a synthetic root (C:/work or /tmp/x)",
  "redaction-username": "line contains the local user name",
  "redaction-email": "line contains an email address",
  "redaction-token": "line contains a bearer token, a 64-hex token or a provider API key",
  "redaction-request-id": "request_id must be synthetic (r-<n>, req-<n> or synthetic-<slug>)",
  "redaction-host": 'device name must be "synthetic-host"',
};

/** Help text. Kept in one place so `--help` and the header cannot drift. */
const USAGE = `check-fixtures - fixture corpus gate

Usage:
  node scripts/check-fixtures.mjs                 scan the corpus below fixtures/
  node scripts/check-fixtures.mjs --root <dir>    scan another tree (self-tests only)
  node scripts/check-fixtures.mjs --help          print this text and exit 0

Exit codes:
  0 = pass, 1 = violations, 2 = the script or its configuration is broken.
`;

const rawArgs = process.argv.slice(2);

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.log(USAGE);
  process.exitCode = 0;
} else {
  await runGate(collectViolations);
}

/**
 * @typedef {object} GateContext
 * @property {string} root absolute posix tree root
 * @property {{ version: string, commit: string } | undefined} pin lazily read engine pin
 * @property {RegExp[]} namePatterns deny-listed local user names
 */

/**
 * Gate body: walk the corpus, check every file, and print advisory warnings.
 *
 * Warnings are printed here, before `runGate()` prints the summary, so a
 * version drift stays visible on a green run. The exit code comes from the
 * violation list alone.
 *
 * @param {{ root: string }} args
 * @returns {Promise<Array<{ file: string, line: number, rule: string, message: string }>>}
 */
async function collectViolations(args) {
  /** @type {GateContext} */
  const context = {
    root: args.root,
    pin: undefined,
    namePatterns: buildNamePatterns(),
  };
  /** @type {Array<{ file: string, line: number, rule: string, message: string }>} */
  const violations = [];
  /** @type {string[]} */
  const warnings = [];

  for (const relative of listFixtures(args.root)) {
    checkFile(context, relative, violations, warnings);
  }

  for (const warning of warnings) {
    console.log(warning);
  }

  return violations;
}

/**
 * Every fixture file in the corpus, repo-relative posix and sorted.
 *
 * Only CORPUS_DIRS are entered; SKIPPED_DIRS and symlinks are dropped at any
 * depth, so the gate cannot spend its 5 s budget walking `node_modules`,
 * `_research` or a linked checkout.
 *
 * @param {string} root absolute tree root
 * @returns {string[]}
 */
function listFixtures(root) {
  /** @type {string[]} */
  const found = [];

  for (const dir of CORPUS_DIRS) {
    walkCorpus(root, dir, found);
  }

  return found.sort();
}

/**
 * Depth-first walk of one corpus directory, appending `*.jsonl` files.
 *
 * @param {string} root absolute tree root
 * @param {string} relativeDir posix directory below the root
 * @param {string[]} found collected repo-relative fixture paths
 * @returns {void}
 */
function walkCorpus(root, relativeDir, found) {
  const absolute = path.join(root, relativeDir);

  if (!existsSync(absolute)) {
    return;
  }

  let entries;

  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    throw new Error(`cannot list ${relativeDir}`);
  }

  for (const entry of entries.slice().sort(compareNames)) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) {
        continue;
      }

      walkCorpus(root, `${relativeDir}/${entry.name}`, found);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(`${relativeDir}/${entry.name}`);
    }
  }
}

/**
 * @param {{ name: string }} a
 * @param {{ name: string }} b
 * @returns {number}
 */
function compareNames(a, b) {
  if (a.name === b.name) {
    return 0;
  }

  return a.name < b.name ? -1 : 1;
}

/**
 * Validate one fixture file: header first, then one message per line.
 *
 * @param {GateContext} context gate context
 * @param {string} relative repo-relative fixture path
 * @param {Array<{ file: string, line: number, rule: string, message: string }>} violations
 * @param {string[]} warnings advisory version-drift lines
 * @returns {void}
 */
function checkFile(context, relative, violations, warnings) {
  let text;

  try {
    text = readFileSync(path.join(context.root, relative), "utf8");
  } catch (error) {
    const code = errorCode(error);

    throw new Error(`cannot read ${relative}${code === "" ? "" : ` (${code})`}`);
  }

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

  checkRedactionMarker(relative, header, violations);
  checkContent(relative, 1, header, violations, context);
  checkVersionAlignment(context, relative, header, warnings);

  for (let index = 1; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const message = parseLine(relative, lineNumber, lines[index], violations);

    if (message === null) {
      continue;
    }

    if (kind !== null) {
      checkMessage(relative, lineNumber, kind, message, violations);
    }

    checkContent(relative, lineNumber, message, violations, context);
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
        `header must say schemaVersion ${SUPPORTED_SCHEMA_VERSION}, found ${quote(header.schemaVersion)}`,
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
 * Enforce the "r1 or later" marker below the corpus.
 *
 * A wire header must always declare it: the recorder always writes `redaction`
 * (as "r0"), so a wire header without one was edited by hand. The frozen frames
 * header  has no `redaction` field at all - bridge fixtures are
 * hand-written or template-made , so the corpus R-07) - so a missing marker is fine
 * there, while an explicit `r0` is not: it means unredacted content was copied
 * into the corpus.
 *
 * @param {string} relative repo-relative fixture path
 * @param {Record<string, unknown>} header parsed header
 * @param {Array<{ file: string, line: number, rule: string, message: string }>} violations
 * @returns {void}
 */
function checkRedactionMarker(relative, header, violations) {
  const marker = header.redaction;

  if (marker === undefined) {
    if (header.kind === WIRE_KIND) {
      violations.push(
        violation(relative, 1, "redaction-state", REDACTION_MESSAGES["redaction-state"]),
      );
    }

    return;
  }

  if (!isRedactedMarker(marker)) {
    violations.push(
      violation(relative, 1, "redaction-state", REDACTION_MESSAGES["redaction-state"]),
    );
  }
}

/**
 * True when the marker is "r1" or a later revision.
 *
 * @param {unknown} value raw header value
 * @returns {boolean}
 */
function isRedactedMarker(value) {
  if (typeof value !== "string") {
    return false;
  }

  const match = /^r(\d+)$/.exec(value);

  return match !== null && Number(match[1]) >= 1;
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
 * Scan every string in one parsed line for redaction leaks.
 *
 * The walk is over decoded JSON, not raw bytes: it sees `C:\work` where the
 * file has `C:\\work`, so root matching is exact, and it finds values nested in
 * `msg`, arrays and `payload` without a second schema.
 *
 * @param {string} relative repo-relative fixture path
 * @param {number} lineNumber 1-based line number
 * @param {unknown} node parsed header or message
 * @param {Array<{ file: string, line: number, rule: string, message: string }>} violations
 * @param {GateContext} context gate context
 * @returns {void}
 */
function checkContent(relative, lineNumber, node, violations, context) {
  const fired = new Set();

  inspectNode(node, "", (key, text) => {
    if (key === "request_id" && !SYNTHETIC_REQUEST_ID.test(text)) {
      fired.add("redaction-request-id");
    }

    // A key check, not a value check: the device name is the one field whose
    // shape cannot tell a real machine from a synthetic one, so the only safe
    // value is the reserved placeholder.
    if (key === "connection_name" && text !== SYNTHETIC_HOSTNAME) {
      fired.add("redaction-host");
    }

    for (const rule of detectRules(text, context.namePatterns)) {
      fired.add(rule);
    }
  });

  for (const rule of [...fired].sort()) {
    violations.push(violation(relative, lineNumber, rule, REDACTION_MESSAGES[rule]));
  }
}

/**
 * Depth-first walk over a parsed JSON value, handing every string to `probe`
 * together with its key (array items inherit the key of their array).
 *
 * @param {unknown} node current node
 * @param {string} key key the node sits under, or "" at the top
 * @param {(key: string, text: string) => void} probe called once per string
 * @returns {void}
 */
function inspectNode(node, key, probe) {
  if (typeof node === "string") {
    probe(key, node);

    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      inspectNode(item, key, probe);
    }

    return;
  }

  if (!isObject(node)) {
    return;
  }

  for (const [childKey, child] of Object.entries(node)) {
    inspectNode(child, childKey, probe);
  }
}

/**
 * Which redaction rules one decoded string violates.
 *
 * @param {string} text decoded string value
 * @param {RegExp[]} namePatterns deny-listed user names
 * @returns {string[]} rule ids, in a stable order
 */
function detectRules(text, namePatterns) {
  /** @type {string[]} */
  const found = [];

  if (containsAbsolutePath(text)) {
    found.push("redaction-path");
  }

  if (namePatterns.some((pattern) => pattern.test(text))) {
    found.push("redaction-username");
  }

  if (EMAIL_ADDRESS.test(text)) {
    found.push("redaction-email");
  }

  if (BEARER_TOKEN.test(text) || HEX_TOKEN.test(text) || PROVIDER_KEY.test(text)) {
    found.push("redaction-token");
  }

  return found;
}

/**
 * True when at least one absolute path in the string is not synthetic.
 *
 * @param {string} text decoded string value
 * @returns {boolean}
 */
function containsAbsolutePath(text) {
  for (const match of text.matchAll(WINDOWS_ABSOLUTE_PATH)) {
    if (!isSyntheticPath(match[0])) {
      return true;
    }
  }

  for (const match of text.matchAll(POSIX_ABSOLUTE_PATH)) {
    if (!isSyntheticPath(match[0])) {
      return true;
    }
  }

  return false;
}

/**
 * Is the matched path equal to, or below, an allowed synthetic root?
 *
 * @param {string} candidate matched absolute path
 * @returns {boolean}
 */
function isSyntheticPath(candidate) {
  const normalized = candidate.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

  return SYNTHETIC_PATH_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}

/**
 * Build the local-user-name deny-list.
 *
 * `os.userInfo().username` is the platform answer; `%USERNAME%` is what a
 * Windows shell exports; `$USER` covers POSIX. Names shorter than two
 * characters are dropped because a one-letter pattern would match almost any
 * sentence and turn the rule into noise.
 *
 * @returns {RegExp[]}
 */
function buildNamePatterns() {
  const names = new Set();

  considerName(names, readUserName());
  considerName(names, process.env.USERNAME);
  considerName(names, process.env.USER);

  return [...names].sort().map(toNamePattern);
}

/**
 * @returns {string | undefined}
 */
function readUserName() {
  try {
    return os.userInfo().username;
  } catch {
    // A platform without a user database is not a gate failure.
    return undefined;
  }
}

/**
 * @param {Set<string>} names collected names, lower-cased
 * @param {string | undefined} value candidate name
 * @returns {void}
 */
function considerName(names, value) {
  if (typeof value !== "string") {
    return;
  }

  const name = value.trim();

  if (name.length < 2) {
    return;
  }

  names.add(name.toLowerCase());
}

/**
 * Build the boundary-aware pattern for one deny-listed name.
 *
 * `_` counts as part of a word so a schema field such as `bridge.user_message`
 * does not fire on a user called "user"; surrounding punctuation and quotes do
 * not, so `"owner": "alice"` and `alice-workstation` both fire.
 *
 * @param {string} name lower-cased name
 * @returns {RegExp}
 */
function toNamePattern(name) {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "i");
}

/**
 * @param {string} value raw text
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compare a wire header's engine pair with the contract pin, collecting one
 * advisory line per drifting file.
 *
 * The pin is read lazily: frames-only and empty corpora must not depend on the
 * contract snapshot. A wire fixture without a readable pin is a configuration
 * failure (exit 2), because silently skipping the comparison would hide exactly
 * the version drift this check exists to surface.
 *
 * @param {GateContext} context gate context
 * @param {string} relative repo-relative fixture path
 * @param {Record<string, unknown>} header parsed header
 * @param {string[]} warnings advisory lines
 * @returns {void}
 */
function checkVersionAlignment(context, relative, header, warnings) {
  if (header.kind !== WIRE_KIND) {
    return;
  }

  const pin = readEnginePin(context);
  const engine = isObject(header.engine) ? header.engine : {};
  /** @type {string[]} */
  const drifts = [];

  if (engine.version !== pin.version) {
    drifts.push(`engine.version ${quote(engine.version)} != pinned ${quote(pin.version)}`);
  }

  if (engine.commit !== pin.commit) {
    drifts.push(`engine.commit ${quote(engine.commit)} != pinned ${quote(pin.commit)}`);
  }

  if (drifts.length === 0) {
    return;
  }

  warnings.push(`WARN ${relative}:1 version-align ${drifts.join("; ")}`);
}

/**
 * Read (once) the engine pair pinned by the contract snapshot.
 *
 * @param {GateContext} context gate context
 * @returns {{ version: string, commit: string }}
 */
function readEnginePin(context) {
  if (context.pin !== undefined) {
    return context.pin;
  }

  let parsed;

  try {
    parsed = JSON.parse(readFileSync(path.join(context.root, PINNED_ENGINE_PATH), "utf8"));
  } catch (error) {
    const code = errorCode(error);

    throw new Error(
      `cannot read the pinned engine pair from ${PINNED_ENGINE_PATH}${code === "" ? "" : ` (${code})`}`,
    );
  }

  const engine = isObject(parsed) ? parsed.engine : undefined;

  if (
    !isObject(engine) ||
    typeof engine.version !== "string" ||
    typeof engine.commit !== "string"
  ) {
    throw new Error(`${PINNED_ENGINE_PATH} must pin engine.version and engine.commit`);
  }

  context.pin = { version: engine.version, commit: engine.commit };

  return context.pin;
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

  if (!isObject(parsed)) {
    violations.push(violation(relative, lineNumber, "json-object", "line must be a JSON object"));

    return null;
  }

  return parsed;
}

/**
 * @param {unknown} value candidate
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Node error code without the absolute path Node appends to the message.
 *
 * @param {unknown} error caught value
 * @returns {string}
 */
function errorCode(error) {
  if (isObject(error) && typeof error.code === "string") {
    return error.code;
  }

  return "";
}

/**
 * Render an untrusted value as bounded ASCII for a diagnostic.
 *
 * Values never come from a trusted source here, so clipping plus escaping keeps
 * a crafted fixture from breaking the one-line format or the ASCII-only rule.
 *
 * @param {unknown} value raw value
 * @returns {string} quoted, ASCII-only, at most 40 characters inside the quotes
 */
function quote(value) {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const printable = text.replace(/[^\x20-\x7E]/g, "?");
  const clipped = printable.length > 40 ? `${printable.slice(0, 40)}...` : printable;

  return JSON.stringify(clipped);
}

/**
 * @param {string} file repo-relative fixture path
 * @param {number} line 1-based line number
 * @param {string} rule rule id
 * @param {string} message English, one line
 * @returns {{ file: string, line: number, rule: string, message: string }}
 */
function violation(file, line, rule, message) {
  return { file: toPosix(file), line, rule, message };
}
