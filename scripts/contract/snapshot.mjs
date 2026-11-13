/**
 * snapshot.mjs - assemble the v1 contract snapshot from the frozen extractors.
 *
 * Pipeline (route doc 08 section 3.1):
 *
 *   engine source -> command records + messages/inbound + parity
 *                 -> this module: capability join, counts, health merge
 *                 -> canonicalizeSnapshot() -> validateSnapshot() -> snapshot
 *
 * The output shape is frozen by route doc 08 section 3.4(a). Key order, array
 * ordering and the "fields only when fieldLevel" rule come from
 * `lib/schema.mjs`; this module supplies data and lets the validator reject
 * anything else, so no second copy of the shape can drift.
 *
 * Capability join
 *   `fieldLevel` is true exactly when `capabilities.json` registers the wire
 *   with `detail: true`. The detail set is read from the file at runtime and is
 *   never hard-coded, because table B keeps growing in that file. Commands and
 *   flight. Commands and messages share the same rule (today only commands are
 *   registered, but a future detail message would pass through the same join); a
 *   record outside the detail set keeps `fields: []` even though the extractors
 *   extracted fields for it.
 *
 * Counts
 *   Every one of the seven keys is derived from extraction data, never written
 *   down here:
 *     unionMembers        command-union member count (115)
 *     wireCommands        expanded command records (124)
 *     messages            expanded message records (136, not the 127 union)
 *     inboundAccepted     accepted inbound set size (124)
 *     inboundOnly         accepted set minus the wire command set (0)
 *     advertisedCommands  advertised command length (14)
 *     dispatchCases       dispatch switch case count (12)
 *
 * Health
 *   `degraded` is true when any extractor degraded, when the engine
 *   `package.json` version cannot be read (A2-D14) or when the git commit cannot
 *   be read. `coarse` and `unparsed` are deduplicated and sorted: the capability table and 
 *   can report the same message-side item, so raw concatenation is not allowed.
 *   A coarse command with a null wire stays in `commands[]` and makes
 *   `validateSnapshot` fail loudly, which is the intended "no plausible-looking
 *   empty result" behaviour .
 *
 * Determinism
 *   The same inputs always yield the same object except `engine.extractedAt`,
 *   the single time-varying field. Nothing else is derived from wall-clock time,
 *   locale sorting or Set/Map iteration order.
 *
 * Serialization
 *   `serializeSnapshot` writes plain JSON with one command / message record per
 *   line. That keeps the file far below the 2000-line ceiling (discipline 03
 *   section 1.2.2) while still giving a per-wire git diff, and `JSON.parse` never
 *   needs a custom reader.
 *
 * Failure semantics
 *   Missing engine tree, missing/unparseable capabilities file and a failed
 *   parity read all throw with an actionable ASCII message. A degraded but
 *   structurally valid extraction still returns a snapshot and records the
 *   degradation in `health`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { extractCommands } from "./extract-commands.mjs";
import { extractMessages } from "./extract-messages.mjs";
import { extractParity } from "./extract-parity.mjs";
import { createTypeIndex } from "./lib/scan.mjs";
import { SNAPSHOT_SCHEMA_VERSION, canonicalizeSnapshot, validateSnapshot } from "./lib/schema.mjs";

/** Value of `engine.extractor` for schema v1. */
export const EXTRACTOR_ID = "contract-snapshot@1";

/** Value of `engine.source` for a source checkout extraction. */
export const ENGINE_SOURCE = "clone";

/** Placeholder used when a metadata read fails (A2-D14). */
const UNKNOWN = "unknown";

/**
 * Code-unit string comparison, so ordering never depends on the host locale.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deduplicate, then sort lexicographically by code unit.
 *
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqueSorted(values) {
  return [...new Set(values)].sort(compareStrings);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Read the engine version from `<engineRoot>/package.json`.
 *
 * A missing, unreadable or malformed manifest yields `unknown` plus
 * `degraded: true` instead of throwing, so a real snapshot still records the
 * provenance gap (worklog A2-D14).
 *
 * @param {string} engineRoot engine checkout root
 * @returns {{version: string, degraded: boolean}}
 */
export function readEngineVersion(engineRoot) {
  const manifest = path.join(engineRoot, "package.json");

  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    const version = isPlainObject(parsed) ? parsed.version : null;

    if (typeof version === "string" && version.length > 0) {
      return { version, degraded: false };
    }
  } catch {
    // Fall through: unreadable or malformed manifest.
  }

  return { version: UNKNOWN, degraded: true };
}

/**
 * Read the pinned commit with a read-only `git rev-parse --short HEAD`.
 *
 * The engine tree is never modified; a failed read becomes `unknown` plus
 * `degraded: true` for the same reason as the version.
 *
 * @param {string} engineRoot engine checkout root
 * @returns {{commit: string, degraded: boolean}}
 */
function readEngineCommit(engineRoot) {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: engineRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();

    if (commit.length > 0) {
      return { commit, degraded: false };
    }
  } catch {
    // Fall through: git unavailable or the tree is not a checkout.
  }

  return { commit: UNKNOWN, degraded: true };
}

/**
 * Load the runtime `detail: true` wire set from `capabilities.json`.
 *
 * Entries without a usable wire are skipped here; the coverage gate (`map.mjs`) is
 * responsible for rejecting them, not the snapshot assembler.
 *
 * @param {string} capabilitiesPath absolute path to capabilities.json
 * @returns {Set<string>}
 */
function loadDetailWires(capabilitiesPath) {
  if (!existsSync(capabilitiesPath)) {
    throw new Error(`buildSnapshot: capabilities file not found: ${capabilitiesPath}`);
  }

  let parsed;

  try {
    parsed = JSON.parse(readFileSync(capabilitiesPath, "utf8"));
  } catch (error) {
    throw new Error(
      `buildSnapshot: capabilities file is not valid JSON: ${capabilitiesPath} ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed)
      ? parsed.capabilities
      : null;

  if (!Array.isArray(entries)) {
    throw new Error(
      `buildSnapshot: capabilities file has no capability array: ${capabilitiesPath}`,
    );
  }

  /** @type {Set<string>} */
  const detailWires = new Set();

  for (const entry of entries) {
    if (isPlainObject(entry) && entry.detail === true) {
      const wire = entry.wire;

      if (typeof wire === "string" && wire.length > 0) {
        detailWires.add(wire);
      }
    }
  }

  return detailWires;
}

/**
 * Render one health entry as a stable ASCII line.
 *
 * the extractors already report strings; `transport.ts` reports structured objects
 * (`{file, line, symbol, reason}`). Both end up in `health.coarse`, which the
 * frozen schema requires to be an array of strings.
 *
 * @param {unknown} entry
 * @returns {string}
 */
function healthLine(entry) {
  if (typeof entry === "string") {
    return entry;
  }

  if (!isPlainObject(entry)) {
    return "";
  }

  const file = stringOrEmpty(entry.file);
  const line = Number.isInteger(entry.line) ? `:${String(entry.line)}` : "";
  const location = `${file}${line}`;
  const symbol = stringOrEmpty(entry.symbol);
  const reason = stringOrEmpty(entry.reason) || "coarse item";
  const subject =
    symbol.length > 0 && location.length > 0
      ? `${symbol}@${location}`
      : symbol.length > 0
        ? symbol
        : location;

  return subject.length > 0 ? `${subject}: ${reason}` : reason;
}

/**
 * Merge extractor health sections: any degraded wins, lists are deduplicated.
 *
 * @param {({degraded?: boolean, coarse?: unknown[], unparsed?: unknown[]} | null | undefined)[]} parts
 * @param {boolean} [extraDegraded]
 * @returns {{degraded: boolean, coarse: string[], unparsed: string[]}}
 */
function mergeHealth(parts, extraDegraded = false) {
  let degraded = extraDegraded;
  /** @type {string[]} */
  const coarse = [];
  /** @type {string[]} */
  const unparsed = [];

  for (const part of parts) {
    if (!part) {
      continue;
    }

    if (part.degraded === true) {
      degraded = true;
    }

    for (const entry of Array.isArray(part.coarse) ? part.coarse : []) {
      const line = healthLine(entry);

      if (line.length > 0) {
        coarse.push(line);
      }
    }

    for (const entry of Array.isArray(part.unparsed) ? part.unparsed : []) {
      const line = healthLine(entry);

      if (line.length > 0) {
        unparsed.push(line);
      }
    }
  }

  return { degraded, coarse: uniqueSorted(coarse), unparsed: uniqueSorted(unparsed) };
}

/**
 * Join one command record with the inbound set and the detail set.
 *
 * @param {object} record command record
 * @param {Set<string>} inboundWires accepted inbound wires
 * @param {Set<string>} detailWires `detail: true` wires
 * @returns {Record<string, unknown>}
 */
function toCommandRecord(record, inboundWires, detailWires) {
  const source = isPlainObject(record) ? record : {};
  const wire = typeof source.wire === "string" ? source.wire : null;
  const fieldLevel = wire !== null && detailWires.has(wire);
  const fields = fieldLevel && Array.isArray(source.fields) ? source.fields : [];

  return {
    wire,
    type: source.type,
    home: source.home,
    direction: Array.isArray(source.direction) ? [...source.direction] : [],
    inbound: wire !== null && inboundWires.has(wire),
    fields,
    shapeFingerprint: source.shapeFingerprint,
    fieldLevel,
    health: source.health,
  };
}

/**
 * Join one message record with the detail set.
 *
 * Messages follow the command rule so a future `detail` registration would not
 * need a second code path; until then every message stays `fieldLevel: false`
 * with empty fields.
 *
 * @param {object} record message record
 * @param {Set<string>} detailWires `detail: true` wires
 * @returns {Record<string, unknown>}
 */
function toMessageRecord(record, detailWires) {
  const source = isPlainObject(record) ? record : {};
  const wire = typeof source.wire === "string" ? source.wire : null;
  const fieldLevel = wire !== null && detailWires.has(wire);
  const fields = fieldLevel && Array.isArray(source.fields) ? source.fields : [];

  return {
    wire,
    type: source.type,
    home: source.home,
    fields,
    shapeFingerprint: source.shapeFingerprint,
    fieldLevel,
    health: source.health,
  };
}

/**
 * Copy the remote command facts in the frozen key order.
 *
 * @param {object} remoteCommands `remoteCommands` from parity extraction
 * @returns {Record<string, unknown>}
 */
function toRemoteCommands(remoteCommands) {
  const source = isPlainObject(remoteCommands) ? remoteCommands : {};

  return {
    advertised: Array.isArray(source.advertised) ? [...source.advertised] : [],
    handledElsewhere: isPlainObject(source.handledElsewhere) ? { ...source.handledElsewhere } : {},
    unadvertisedAliases: isPlainObject(source.unadvertisedAliases)
      ? { ...source.unadvertisedAliases }
      : {},
    dispatchCases: Array.isArray(source.dispatchCases) ? [...source.dispatchCases] : [],
  };
}

/**
 * Assemble, canonicalize and validate the v1 snapshot.
 *
 * @param {{engineRoot?: string, capabilitiesPath?: string}} [options]
 * @returns {Record<string, unknown>} the canonical snapshot (frozen key order)
 */
export function buildSnapshot({ engineRoot, capabilitiesPath } = {}) {
  if (typeof engineRoot !== "string" || engineRoot.length === 0) {
    throw new TypeError("buildSnapshot: engineRoot must be a non-empty string");
  }

  if (typeof capabilitiesPath !== "string" || capabilitiesPath.length === 0) {
    throw new TypeError("buildSnapshot: capabilitiesPath must be a non-empty string");
  }

  const root = path.resolve(engineRoot);
  const typesDirectory = path.join(root, "src", "types");

  if (!existsSync(typesDirectory)) {
    throw new Error(`buildSnapshot: engine type directory not found: ${typesDirectory}`);
  }

  const detailWires = loadDetailWires(path.resolve(capabilitiesPath));
  const index = createTypeIndex(root);
  const commandExtraction = extractCommands({ engineRoot: root, index });
  const messageExtraction = extractMessages({ engineRoot: root, index });
  const parityExtraction = extractParity({ engineRoot: root });

  if (parityExtraction.ok !== true) {
    throw new Error(
      `buildSnapshot: parity extraction failed (${String(parityExtraction.code)}): ` +
        String(parityExtraction.message),
    );
  }

  const accepted = Array.isArray(messageExtraction.inbound.accepted)
    ? messageExtraction.inbound.accepted.filter((wire) => typeof wire === "string")
    : [];
  const inboundWires = new Set(accepted);
  const commands = commandExtraction.commands.map((record) =>
    toCommandRecord(record, inboundWires, detailWires),
  );
  const messages = messageExtraction.messages.map((record) => toMessageRecord(record, detailWires));
  const commandWires = new Set(
    commands.filter((command) => typeof command.wire === "string").map((command) => command.wire),
  );
  const version = readEngineVersion(root);
  const commit = readEngineCommit(root);

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    engine: {
      version: version.version,
      commit: commit.commit,
      source: ENGINE_SOURCE,
      extractedAt: new Date().toISOString(),
      extractor: EXTRACTOR_ID,
    },
    counts: {
      unionMembers: commandExtraction.counts.unionMembers,
      wireCommands: commands.length,
      messages: messages.length,
      inboundAccepted: accepted.length,
      inboundOnly: accepted.filter((wire) => !commandWires.has(wire)).length,
      advertisedCommands: parityExtraction.counts.advertisedCommands,
      dispatchCases: parityExtraction.counts.dispatchCases,
    },
    commands,
    messages,
    special: {
      fileOps: {
        wire: messageExtraction.special.fileOps.wire,
        directions: [...messageExtraction.special.fileOps.directions],
      },
      remoteCommands: toRemoteCommands(parityExtraction.remoteCommands),
      startupText: {
        required: [...parityExtraction.startupText.required],
        optional: [...parityExtraction.startupText.optional],
      },
    },
    health: mergeHealth(
      [commandExtraction.health, messageExtraction.health, parityExtraction.health],
      version.degraded || commit.degraded,
    ),
  };

  const canonical = canonicalizeSnapshot(snapshot);
  const validation = validateSnapshot(canonical);

  if (!validation.ok) {
    const details = validation.violations
      .map((violation) => `${violation.path} ${violation.rule} ${violation.message}`)
      .join("; ");

    throw new Error(`buildSnapshot: snapshot validation failed: ${details}`);
  }

  return canonical;
}

/**
 * Render one wire-record array as one element per line.
 *
 * @param {unknown[]} records command or message records
 * @returns {string[]}
 */
function serializeRecordLines(records) {
  return records.map((record, index) => {
    const suffix = index === records.length - 1 ? "" : ",";

    return `    ${JSON.stringify(record)}${suffix}`;
  });
}

/**
 * Serialize a snapshot deterministically as plain JSON with one record per line.
 *
 * A blanket two-space pretty print would expand the 124 command records and 136
 * message records into ~4500 lines, which breaks the "no file at or above 2000
 * lines" rule (discipline 03 section 1.2.2). Keeping one record per line stays
 * near 270 lines, makes a snapshot diff point at the exact changed wire and
 * still parses with `JSON.parse`. The small top-level objects stay compact
 * because nothing diffs well when split across four lines of punctuation.
 *
 * @param {unknown} snapshot canonical snapshot object
 * @returns {string} file text, ending with exactly one LF
 */
export function serializeSnapshot(snapshot) {
  const source = isPlainObject(snapshot) ? snapshot : {};
  const commands = Array.isArray(source.commands) ? source.commands : [];
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const lines = [
    "{",
    `  "schemaVersion": ${JSON.stringify(source.schemaVersion)},`,
    `  "engine": ${JSON.stringify(source.engine)},`,
    `  "counts": ${JSON.stringify(source.counts)},`,
    '  "commands": [',
    ...serializeRecordLines(commands),
    "  ],",
    '  "messages": [',
    ...serializeRecordLines(messages),
    "  ],",
    `  "special": ${JSON.stringify(source.special)},`,
    `  "health": ${JSON.stringify(source.health)}`,
    "}",
  ];

  return `${lines.join("\n")}\n`;
}

/**
 * Write a snapshot to disk after validating it.
 *
 * The caller owns parent-directory creation; this helper only writes the file
 * (single-point write, never a recursive delete). It returns the absolute path
 * so callers can report it without recomputing.
 *
 * @param {string} filePath target path, e.g. `packages/protocol/src/contract/snapshot.json`
 * @param {unknown} snapshot snapshot object (canonical or not)
 * @returns {string} absolute path written
 */
export function writeSnapshot(filePath, snapshot) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("writeSnapshot: filePath must be a non-empty string");
  }

  const validation = validateSnapshot(snapshot);

  if (!validation.ok) {
    const details = validation.violations
      .map((violation) => `${violation.path} ${violation.rule} ${violation.message}`)
      .join("; ");

    throw new Error(`writeSnapshot: refusing to write an invalid snapshot: ${details}`);
  }

  const target = path.resolve(filePath);

  writeFileSync(target, serializeSnapshot(snapshot), "utf8");

  return target;
}
