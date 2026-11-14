#!/usr/bin/env node
/**
 * redact.mjs - deterministic redaction pass for wire recordings (A3; docs/18
 * section 1.2 R-06, section 3.2 step 1, section 5.1 and section 8 INV-A3-2).
 *
 * Usage:
 *   node scripts/redact-fixtures.mjs <input.jsonl> <output.jsonl>
 *     [--redaction r1] [--report] [--help]
 *
 * The recorder (`scripts/engine/record.mjs`) writes a `kind: "wire"` recording
 * with `redaction: "r0"` under `_research/`. This pass rewrites that header to
 * `redaction: "r1"` (or a later marker) and replaces every sensitive value so
 * the result can be published below `fixtures/`. It is the producer side of
 * `scripts/check-fixtures.mjs`: the gate's rule ids and regexes are copied here
 * verbatim, because a value the gate can see but this pass cannot rewrite would
 * make the corpus unpublishable.
 *
 * Determinism: the same input produces byte-identical output. There is no
 * timestamp, no randomness, no locale-sensitive comparison and no machine
 * path in the JSONL. Every line is re-serialized as compact JSON and every
 * non-ASCII code unit is escaped, so the corpus file itself stays ASCII while
 * its decoded strings are unchanged.
 *
 * Mapping (all replacements are pure functions of the matched text, so an
 * identical value always produces an identical replacement):
 *   - absolute Windows path -> C:/work/<last segment>
 *   - absolute POSIX path   -> /tmp/x/<last segment>
 *     An already-synthetic path is left exactly as it is, which also makes the
 *     pass idempotent (`/tmp/x/a/b` is not collapsed to `/tmp/x/b`).
 *   - local user name (os.userInfo().username, %USERNAME%, $USER) -> user
 *   - email address -> <redacted-email>
 *     The gate rejects every email address, including alice@example.com, so a
 *     literal address cannot survive publication; see fixtures/README.md.
 *   - "Bearer ...", a 64-hex token, "sk-..." -> <redacted-token>
 *   - the machine name (os.hostname(), %COMPUTERNAME%) -> synthetic-host
 *     The engine echoes it as `device_status.connection_name`, and it also shows
 *     up inside tool output; a machine name identifies where a session ran, so
 *     both the field and any stray mention become the reserved placeholder the
 *     gate accepts. The `connection_name` field is rewritten whole, so a name
 *     like `TZYLT-PC` cannot survive as a partially replaced value.
 *   - non-synthetic `request_id` -> synthetic-<slug>; a `perm-<toolCallId>`
 *     approval id becomes synthetic-perm-<slugified toolCallId>.
 *     One map per file keeps request/response linkage: the same original id
 *     always gets the same synthetic id. Synthetic ids already present are
 *     reserved, collisions get a -2/-3 suffix, and an id that would itself look
 *     like a token falls back to synthetic-request-<n>.
 *
 * Report: one summary line on stderr always (input, output, line count, marker
 * and counts per gate rule). `--report` adds per-line counts and the number of
 * remapped request ids. Values that fired a rule are never echoed: the log is
 * public too.
 *
 * Exit codes: 0 redacted, 2 usage or input/output failure. Nothing is written
 * except the output path named on the command line; the pass never copies a
 * file into `fixtures/` by itself.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Marker the pass writes when `--redaction` is omitted.
 *
 * "r2" is the current revision: it adds the device-name rule to "r1" (the first
 * pass). Re-running the pass with no flag therefore reproduces the committed
 * corpus; a "r1" file is valid but predates the device-name rule.
 */
const DEFAULT_REDACTION = "r2";

/** The only device name the corpus may carry; `check-fixtures.mjs` enforces it. */
const SYNTHETIC_HOSTNAME = "synthetic-host";

/** Synthetic roots the gate accepts. */
const SYNTHETIC_WINDOWS_ROOT = "C:/work";
const SYNTHETIC_POSIX_ROOT = "/tmp/x";
const SYNTHETIC_PATH_ROOTS = ["c:/work", "/tmp/x"];

/** Replacement text for the three token-shaped rules. */
const TOKEN_PLACEHOLDER = "<redacted-token>";

/** Replacement text for an address. The gate forbids every email. */
const EMAIL_PLACEHOLDER = "<redacted-email>";

/** Replacement text for a local user name. */
const USER_PLACEHOLDER = "user";

/** Synthetic `request_id` vocabulary, copied from the gate. */
const SYNTHETIC_REQUEST_ID = /^(?:r|req)-\d{1,6}$|^synthetic-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Path and token detectors, copied from `scripts/check-fixtures.mjs` so the
 * producer cannot drift from the gate it must satisfy. The gate applies them
 * to decoded JSON strings, which is exactly what these do.
 */
const WINDOWS_ABSOLUTE_PATH = /(?<![\w:/\\])[A-Za-z]:[\\/][^\s"'<>|,;]*/g;
const POSIX_ABSOLUTE_PATH = /(?<![\w.:/\\-])\/[\w.-]+(?:\/[\w.-]+)*/g;
const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const EMAIL_ADDRESS_GLOBAL = new RegExp(EMAIL_ADDRESS.source, "g");
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const HEX_TOKEN = /(?<![0-9A-Za-z])[0-9a-fA-F]{64}(?![0-9A-Za-z])/g;
const PROVIDER_KEY = /(?<![0-9A-Za-z])sk-[A-Za-z0-9_-]{16,}/g;

/** Longest readable slug kept from a request id; the rest is dropped. */
const MAX_SLUG_LENGTH = 48;

/** The prefix a `perm-<toolCallId>` approval id carries. */
const PERM_PREFIX = "perm-";

/** Counter key -> gate rule id, for the per-line `--report` output. */
const COUNT_LABELS = [
  ["redaction-state", "redactionState"],
  ["redaction-path", "path"],
  ["redaction-username", "username"],
  ["redaction-email", "email"],
  ["redaction-token", "token"],
  ["redaction-host", "host"],
  ["redaction-request-id", "requestId"],
  ["redaction-request-id-kept", "requestIdKept"],
];

/** Help text; `--help` prints it and exits 0. */
const USAGE = `redact.mjs - deterministic redaction pass for wire recordings (A3)

Usage:
  node scripts/redact-fixtures.mjs <input.jsonl> <output.jsonl>
    [--redaction r1] [--report] [--help]

  <input.jsonl>   a kind "wire" recording with redaction "r0"
  <output.jsonl>  where to write the redacted r1 (or later) copy
  --redaction     header marker to write (default r1; must be r1 or later)
  --report        print per-line counts and the request-id map size to stderr

Exit codes:
  0 = redacted, 2 = usage, unreadable input or unwritable output.
`;

/**
 * Entry point. Errors leave exit code 2; the output file is written only after
 * every line parsed successfully, so a broken input cannot leave a half file.
 *
 * @returns {void}
 */
function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE);

    return;
  }

  const inputText = readInput(options.input);
  const lines = splitLines(inputText);

  if (lines.length === 0) {
    throw new Error("input is empty; a wire recording needs a header line");
  }

  const documents = lines.map((line, index) => parseLine(line, index + 1));
  const header = documents[0];

  if (!isObject(header)) {
    throw new Error("line 1 is not a JSON object header");
  }

  if (header.kind !== "wire") {
    throw new Error(
      `line 1 must be a "wire" header, found ${JSON.stringify(header.kind)}; ` +
        "frames fixtures are hand-written and are not produced by this pass",
    );
  }

  const requestIds = planRequestIds(documents);
  const namePatterns = buildNamePatterns();
  const hostPatterns = buildHostPatterns();
  const counts = createCounts();
  const perLine = [];
  const context = { requestIds, namePatterns, hostPatterns };

  const redactedDocuments = documents.map((document, index) => {
    const lineCounts = createCounts();
    const redacted = redactDocument(document, "", context, lineCounts);

    addCounts(counts, lineCounts);
    perLine.push({ line: index + 1, counts: lineCounts });

    return redacted;
  });

  const first = redactedDocuments[0];

  if (isObject(first) && first.redaction !== options.redaction) {
    first.redaction = options.redaction;
    counts.redactionState = 1;
  }

  const outputText = `${redactedDocuments.map(toAsciiJson).join("\n")}\n`;

  writeOutput(options.output, outputText);
  reportSummary(options, redactedDocuments.length, counts, perLine, requestIds.size);
}

/**
 * Parse the command line. Positional arguments are input then output; unknown
 * options and a missing or non-positive marker are usage errors (exit 2).
 *
 * @param {string[]} argv args without the node/script prefix
 * @returns {{ input: string, output: string, redaction: string, report: boolean, help: boolean }}
 */
function parseArgs(argv) {
  const options = {
    input: "",
    output: "",
    redaction: DEFAULT_REDACTION,
    report: false,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--report") {
      options.report = true;
      continue;
    }

    if (arg === "--redaction") {
      const value = argv[index + 1];

      if (value === undefined || value === "") {
        throw new Error("--redaction needs a value (r1 or later)");
      }

      options.redaction = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--redaction=")) {
      const value = arg.slice("--redaction=".length);

      if (value === "") {
        throw new Error("--redaction needs a value (r1 or later)");
      }

      options.redaction = value;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (options.help) {
    return options;
  }

  if (positional.length !== 2) {
    throw new Error("usage: redact.mjs <input.jsonl> <output.jsonl> [--redaction r1] [--report]");
  }

  if (!/^r[1-9][0-9]*$/.test(options.redaction)) {
    throw new Error("--redaction must be r1 or a later r<N> marker");
  }

  options.input = positional[0];
  options.output = positional[1];

  return options;
}

/**
 * Read the raw recording as UTF-8 text.
 *
 * @param {string} input input path
 * @returns {string}
 */
function readInput(input) {
  if (!existsSync(input) || !statSync(input).isFile()) {
    throw new Error(`input is not a file: ${input}`);
  }

  try {
    return readFileSync(input, "utf8");
  } catch (error) {
    throw new Error(`cannot read input ${input}: ${errorCode(error)}`);
  }
}

/**
 * Split a JSONL file into lines, dropping the empty tail a trailing newline
 * leaves behind. A blank line in the middle is still a line and will fail to
 * parse, which is the locatable diagnostic the corpus format asks for.
 *
 * @param {string} text file contents
 * @returns {string[]}
 */
function splitLines(text) {
  const lines = text.split(/\r?\n/);

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

/**
 * Parse one JSONL line, naming the line number on failure.
 *
 * @param {string} line raw line
 * @param {number} lineNumber 1-based line number
 * @returns {unknown}
 */
function parseLine(line, lineNumber) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`line ${lineNumber} is not valid JSON`);
  }
}

/**
 * Write the redacted file; the parent directory must already exist so the pass
 * cannot silently create a new tree (in particular not below `fixtures/`).
 *
 * @param {string} output output path
 * @param {string} text complete file contents
 * @returns {void}
 */
function writeOutput(output, text) {
  const directory = path.dirname(path.resolve(output));

  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`output directory does not exist: ${directory}`);
  }

  try {
    writeFileSync(output, text, "utf8");
  } catch (error) {
    throw new Error(`cannot write output ${output}: ${errorCode(error)}`);
  }
}

/**
 * Build the request-id map for the whole file before any line is rewritten.
 *
 * The pre-scan runs over parsed values in line order and visits objects the
 * same way the gate does (array items inherit the key of their array), so an
 * array of `request_id` strings is covered too. Two properties matter:
 *
 *   1. the same original id always maps to the same synthetic id (a response
 *      still answers its request, across any number of lines);
 *   2. a safe synthetic id already present in the file is reserved, so an
 *      original that slugifies to it cannot steal it. A value that only looks
 *      synthetic (for example `synthetic-` plus a 64-hex run) is treated as
 *      non-synthetic, because keeping it would still fire a token rule.
 *
 * @param {unknown[]} documents parsed JSONL documents, header first
 * @returns {Map<string, string>} original id -> synthetic id
 */
function planRequestIds(documents) {
  /** @type {Set<string>} */
  const originals = new Set();
  /** @type {Set<string>} */
  const synthetic = new Set();

  for (const document of documents) {
    walkStrings(document, "", (key, value) => {
      if (key !== "request_id") {
        return;
      }

      originals.add(value);

      if (isSafeSyntheticId(value)) {
        synthetic.add(value);
      }
    });
  }

  /** @type {Map<string, string>} */
  const mapping = new Map();
  /** @type {Set<string>} */
  const used = new Set(synthetic);
  let fallback = 0;

  for (const original of originals) {
    if (isSafeSyntheticId(original)) {
      continue;
    }

    const base = original.startsWith(PERM_PREFIX)
      ? `synthetic-perm-${slugify(original.slice(PERM_PREFIX.length))}`
      : `synthetic-${slugify(original)}`;
    let candidate = base;

    if (!isSafeSyntheticId(candidate)) {
      candidate = `synthetic-request-${fallback}`;
      fallback += 1;
    }

    let suffix = 2;
    let unique = candidate;

    while (used.has(unique)) {
      unique = `${candidate}-${suffix}`;
      suffix += 1;
    }

    used.add(unique);
    mapping.set(original, unique);
  }

  return mapping;
}

/**
 * Is a candidate a synthetic id the gate accepts and free of token/email
 * shapes? A 64-hex request id would otherwise reappear inside its own
 * `synthetic-` wrapper and still fire `redaction-token`.
 *
 * @param {string} candidate proposed id
 * @returns {boolean}
 */
function isSafeSyntheticId(candidate) {
  return (
    SYNTHETIC_REQUEST_ID.test(candidate) &&
    !EMAIL_ADDRESS.test(candidate) &&
    candidate.match(HEX_TOKEN) === null &&
    candidate.match(PROVIDER_KEY) === null &&
    candidate.match(BEARER_TOKEN) === null
  );
}

/**
 * Turn one request id into a lowercase slug segment.
 *
 * @param {string} value original id fragment
 * @returns {string}
 */
function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

  return slug === "" ? "id" : slug;
}

/**
 * Redact one parsed line. Strings under `request_id` are replaced from the map;
 * every other string goes through the text rules.
 *
 * @param {unknown} node current value
 * @param {string} key key the value sits under, "" at the top
 * @param {{ requestIds: Map<string, string>, namePatterns: RegExp[], hostPatterns: RegExp[] }} context shared context
 * @param {ReturnType<typeof createCounts>} counts per-line counters
 * @returns {unknown}
 */
function redactDocument(node, key, context, counts) {
  if (typeof node === "string") {
    if (key === "request_id") {
      const mapped = context.requestIds.get(node);

      if (mapped === undefined) {
        counts.requestIdKept += 1;

        return node;
      }

      counts.requestId += 1;

      return mapped;
    }

    // The field the engine fills with the machine name. Replaced whole rather
    // than by substring, so a compound name cannot survive half-redacted.
    if (key === "connection_name") {
      counts.host += 1;

      return SYNTHETIC_HOSTNAME;
    }

    return redactString(node, context, counts);
  }

  if (Array.isArray(node)) {
    return node.map((item) => redactDocument(item, key, context, counts));
  }

  if (isObject(node)) {
    /** @type {Record<string, unknown>} */
    const result = {};

    for (const [childKey, child] of Object.entries(node)) {
      result[childKey] = redactDocument(child, childKey, context, counts);
    }

    return result;
  }

  return node;
}

/**
 * Apply every text rule to one decoded string.
 *
 * Paths run first (a whole path is replaced before its segments can be mistaken
 * for prose), then tokens, addresses and names, then paths again: an email or
 * token placeholder ends in `>`, which can expose a following `/segment` as a
 * fresh absolute path. The second sweep replaces those leftovers; it changes
 * nothing else, so running the pass on its own output is a no-op.
 *
 * @param {string} value decoded string
 * @param {{ namePatterns: RegExp[], hostPatterns: RegExp[] }} context shared context
 * @param {ReturnType<typeof createCounts>} counts per-line counters
 * @returns {string}
 */
function redactString(value, context, counts) {
  let text = redactAbsolutePaths(value, counts);

  text = redactTokens(text, counts);
  text = redactEmails(text, counts);
  // Before the user name: a machine name often contains it (`ADMINI-PC`), and
  // the longer value has to win the race or it would be left as `user-PC`.
  text = redactHostNames(text, context.hostPatterns, counts);
  text = redactUserNames(text, context.namePatterns, counts);

  return redactAbsolutePaths(text, counts);
}

/**
 * Replace every mention of this machine's name with the reserved placeholder.
 *
 * @param {string} text candidate string
 * @param {RegExp[]} hostPatterns case-insensitive, word-bounded matchers
 * @param {{ host: number }} counts per-rule counters
 * @returns {string} redacted string
 */
function redactHostNames(text, hostPatterns, counts) {
  let result = text;

  for (const pattern of hostPatterns) {
    result = result.replace(pattern, () => {
      counts.host += 1;

      return SYNTHETIC_HOSTNAME;
    });
  }

  return result;
}

/**
 * @returns {RegExp[]} word-bounded, case-insensitive matchers for this machine
 */
function buildHostPatterns() {
  /** @type {Set<string>} */
  const names = new Set();

  considerName(names, readHostName());
  considerName(names, process.env.COMPUTERNAME);

  return [...names]
    .filter((name) => name.length >= 4)
    .sort()
    .map((name) => new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "gi"));
}

/** @returns {string | undefined} */
function readHostName() {
  try {
    return os.hostname();
  } catch {
    return undefined;
  }
}

/**
 * Replace absolute paths outside the synthetic roots, preserving the last path
 * segment where possible. A synthetic path is returned untouched.
 *
 * @param {string} text decoded string
 * @param {ReturnType<typeof createCounts>} counts per-line counters
 * @returns {string}
 */
function redactAbsolutePaths(text, counts) {
  const windows = text.replace(WINDOWS_ABSOLUTE_PATH, (match) => {
    if (isSyntheticPath(match)) {
      return match;
    }

    counts.path += 1;

    return syntheticPath(SYNTHETIC_WINDOWS_ROOT, match);
  });

  return windows.replace(POSIX_ABSOLUTE_PATH, (match) => {
    if (isSyntheticPath(match)) {
      return match;
    }

    counts.path += 1;

    return syntheticPath(SYNTHETIC_POSIX_ROOT, match);
  });
}

/**
 * Is the matched path equal to, or below, an accepted synthetic root? Mirrors
 * the gate: separator- and case-insensitive, trailing slashes stripped, and
 * `C:/workstation` is not below `C:/work`.
 *
 * @param {string} candidate matched path
 * @returns {boolean}
 */
function isSyntheticPath(candidate) {
  const normalized = candidate.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

  return SYNTHETIC_PATH_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}

/**
 * The last non-empty path segment, or "" for a drive/root.
 *
 * @param {string} match matched absolute path
 * @returns {string}
 */
function lastSegment(match) {
  const trimmed = match.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]+/).filter((part) => part !== "");
  const last = parts[parts.length - 1] ?? "";

  return /^[A-Za-z]:$/.test(last) ? "" : last;
}

/**
 * Compose a synthetic path from a root and the preserved segment.
 *
 * @param {string} root synthetic root
 * @param {string} match matched absolute path
 * @returns {string}
 */
function syntheticPath(root, match) {
  const segment = lastSegment(match);

  return segment === "" ? root : `${root}/${segment}`;
}

/**
 * Replace bearer credentials, 64-hex strings and provider keys. Bearer runs
 * first so a credential containing a hex run is replaced as one unit.
 *
 * @param {string} text decoded string
 * @param {ReturnType<typeof createCounts>} counts per-line counters
 * @returns {string}
 */
function redactTokens(text, counts) {
  let result = text;

  for (const pattern of [BEARER_TOKEN, PROVIDER_KEY, HEX_TOKEN]) {
    result = result.replace(pattern, () => {
      counts.token += 1;

      return TOKEN_PLACEHOLDER;
    });
  }

  return result;
}

/**
 * Replace every address with the non-email placeholder.
 *
 * @param {string} text decoded string
 * @param {ReturnType<typeof createCounts>} counts per-line counters
 * @returns {string}
 */
function redactEmails(text, counts) {
  return text.replace(EMAIL_ADDRESS_GLOBAL, () => {
    counts.email += 1;

    return EMAIL_PLACEHOLDER;
  });
}

/**
 * Replace every deny-listed local user name, boundary-aware like the gate so a
 * field name such as `bridge.user_message` is not rewritten by a name called
 * `user`.
 *
 * @param {string} text decoded string
 * @param {RegExp[]} namePatterns deny-listed names
 * @param {ReturnType<typeof createCounts>} counts per-line counters
 * @returns {string}
 */
function redactUserNames(text, namePatterns, counts) {
  let result = text;

  for (const pattern of namePatterns) {
    result = result.replace(pattern, () => {
      counts.username += 1;

      return USER_PLACEHOLDER;
    });
  }

  return result;
}

/**
 * Build the local-user-name deny-list, matching the gate: the platform answer
 * plus the two common environment variables, de-duplicated case-insensitively
 * and dropping one-character names (too noisy to be a leak signal).
 *
 * @returns {RegExp[]}
 */
function buildNamePatterns() {
  /** @type {Set<string>} */
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
    return undefined;
  }
}

/**
 * @param {Set<string>} names collected lower-cased names
 * @param {string | undefined} value candidate
 * @returns {void}
 */
function considerName(names, value) {
  if (typeof value !== "string") {
    return;
  }

  const name = value.trim();

  if (name.length >= 2) {
    names.add(name.toLowerCase());
  }
}

/**
 * @param {string} name lower-cased name
 * @returns {RegExp}
 */
function toNamePattern(name) {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "gi");
}

/**
 * @param {string} value raw text
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Depth-first walk over a parsed line, handing every string to `visit` with the
 * key it sits under. Arrays inherit their parent's key, as in the gate, so
 * `{"request_id": ["a", "b"]}` visits both strings as request ids.
 *
 * @param {unknown} node current value
 * @param {string} key key the value sits under, "" at the top
 * @param {(key: string, value: string) => void} visit called once per string
 * @returns {void}
 */
function walkStrings(node, key, visit) {
  if (typeof node === "string") {
    visit(key, node);

    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      walkStrings(item, key, visit);
    }

    return;
  }

  if (isObject(node)) {
    for (const [childKey, child] of Object.entries(node)) {
      walkStrings(child, childKey, visit);
    }
  }
}

/**
 * @param {unknown} value candidate
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Escape every non-ASCII code unit in a diagnostic string. Rule logs are public
 * too, and a machine path handed in on the command line may not be ASCII.
 *
 * @param {string} value raw text
 * @returns {string}
 */
function toAsciiText(value) {
  return value.replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Compact JSON with every non-ASCII code unit escaped, so the corpus file is
 * pure ASCII while its decoded strings are unchanged.
 *
 * @param {unknown} value parsed document
 * @returns {string}
 */
function toAsciiJson(value) {
  return toAsciiText(JSON.stringify(value));
}

/**
 * @returns {{ redactionState: number, path: number, username: number, email: number, token: number, requestId: number, requestIdKept: number }}
 */
function createCounts() {
  return {
    redactionState: 0,
    path: 0,
    username: 0,
    email: 0,
    token: 0,
    host: 0,
    requestId: 0,
    requestIdKept: 0,
  };
}

/**
 * @param {ReturnType<typeof createCounts>} target aggregate
 * @param {ReturnType<typeof createCounts>} source per-line
 * @returns {void}
 */
function addCounts(target, source) {
  for (const key of Object.keys(source)) {
    target[key] += source[key];
  }
}

/**
 * Print the deterministic summary, plus per-line detail under `--report`.
 *
 * @param {{ input: string, output: string, redaction: string, report: boolean }} options CLI options
 * @param {number} lineCount redacted lines
 * @param {ReturnType<typeof createCounts>} counts aggregate counters
 * @param {Array<{ line: number, counts: ReturnType<typeof createCounts> }>} perLine per-line counters
 * @param {number} mappedRequestIds distinct remapped request ids
 * @returns {void}
 */
function reportSummary(options, lineCount, counts, perLine, mappedRequestIds) {
  const rules = [
    `redaction-state=${counts.redactionState}`,
    `redaction-path=${counts.path}`,
    `redaction-username=${counts.username}`,
    `redaction-email=${counts.email}`,
    `redaction-token=${counts.token}`,
    `redaction-host=${counts.host}`,
    `redaction-request-id=${counts.requestId}`,
    `redaction-request-id-kept=${counts.requestIdKept}`,
  ];

  process.stderr.write(
    `redact: ${toAsciiText(options.input)} -> ${toAsciiText(options.output)}; lines=${lineCount}; ` +
      `redaction=${options.redaction}; ${rules.join(" ")}\n`,
  );

  if (!options.report) {
    return;
  }

  for (const entry of perLine) {
    const fired = COUNT_LABELS.filter(([, key]) => entry.counts[key] > 0).map(
      ([label, key]) => `${label}=${entry.counts[key]}`,
    );

    if (fired.length > 0) {
      process.stderr.write(`redact: line ${entry.line}: ${fired.join(" ")}\n`);
    }
  }

  process.stderr.write(`redact: request-id-map=${mappedRequestIds}\n`);
}

/**
 * @param {unknown} error thrown value
 * @returns {string} platform error code when available
 */
function errorCode(error) {
  if (isObject(error) && typeof error.code === "string") {
    return error.code;
  }

  return error instanceof Error ? error.message : String(error);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  process.stderr.write(`ERROR: ${toAsciiText(message)}\n`);
  process.exitCode = 2;
}
