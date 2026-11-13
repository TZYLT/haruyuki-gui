/**
 * diff.mjs - structural diff between two contract snapshots.
 *
 * `contract diff <a.json> [b.json]` compares two snapshot files, or a file
 * against the committed snapshot when `b` is omitted (requirements doc 07
 * section 5.2). Snapshot objects are accepted too; no extractor runs, no engine
 * source is read and nothing reaches the network.
 *
 * Output: the seven-section report from requirements doc 07 section 6.5,
 * rendered by `report.mjs`. Section 6 reverse-looks-up affected wires in
 * `capabilities.json` and marks field-level (`detail`) capabilities.
 *
 * Exit codes: 0 = report generated, even with changes (report mode); 1 = never
 * used here (gate-only); 2 = broken input (missing file, bad JSON, unknown
 * schemaVersion, malformed snapshot or capability table). `engine.extractedAt`
 * is ignored. `runDiff({a, b, out})` throws `DiffInputError` for the caller to
 * caller to map to 2; field changes need `fieldLevel` on both sides; suspected
 * renames pair unique fingerprints only; added/removed lists stay complete.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fieldFingerprint } from "./lib/fingerprint.mjs";
import { SNAPSHOT_SCHEMA_VERSION } from "./lib/schema.mjs";
import { renderReport } from "./report.mjs";
export const DEFAULT_SNAPSHOT_PATH = "packages/protocol/src/contract/snapshot.json";
export const DEFAULT_CAPABILITIES_PATH = "packages/protocol/src/contract/capabilities.json";
export const SUMMARY_KEYS = Object.freeze([
  "added",
  "removed",
  "suspectedRenames",
  "fieldChanges",
  "parityChanges",
  "capabilityImpacts",
  "actions",
  "total",
]);
const KIND_LABEL = Object.freeze({ commands: "command", messages: "message" });
const TARGET_CAPABILITIES = "capabilities.json";
const TARGET_B4 = "B4";
const TARGET_NOTICE = "notice";
const TARGET_RANK = Object.freeze({
  [TARGET_CAPABILITIES]: 0,
  [TARGET_B4]: 1,
  [TARGET_NOTICE]: 2,
});
// Repository root from this module, so default artifacts never depend on cwd.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = `Usage:
  node scripts/contract/diff.mjs <a.json> [b.json] [--out <file>]

Compare two contract snapshots and print the seven-section report.
Without b.json the comparison is against the snapshot committed in this repo.

Exit codes: 0 report generated (changes or not), 2 broken input.`;
// Raised for anything that maps to exit code 2.
export class DiffInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DiffInputError";
    this.code = code;
  }
}
// Read and parse one JSON file, mapping every failure to DiffInputError.
export function readJsonFile(filePath, label = "file") {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) {
    throw new DiffInputError("file-not-found", `${label} not found: ${absolute}`);
  }
  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new DiffInputError("read-failed", `${label} cannot be read: ${describeError(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DiffInputError("invalid-json", `${label} is not valid JSON: ${absolute}`);
  }
}
// Load a snapshot from a path, or accept an already parsed snapshot object.
export function loadSnapshot(source, options = {}) {
  const { cwd = process.cwd(), label = "snapshot" } = options;
  if (typeof source === "string") {
    const absolute = path.resolve(cwd, source);
    return assertSnapshot(readJsonFile(absolute, label), absolute);
  }
  return assertSnapshot(source, label);
}
// Check the structural essentials of a v1 snapshot and return it unchanged.
export function assertSnapshot(value, label = "snapshot") {
  if (!isPlainObject(value)) {
    throw new DiffInputError("not-a-snapshot", `${label} is not a JSON object`);
  }
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new DiffInputError(
      "unsupported-schema-version",
      `${label} schemaVersion ${String(value.schemaVersion)} is not supported` +
        ` (expected ${SNAPSHOT_SCHEMA_VERSION})`,
    );
  }
  for (const key of ["engine", "counts", "special", "health"]) {
    if (!isPlainObject(value[key])) throw malformed(`${label}.${key} must be an object`);
  }
  for (const key of ["commands", "messages"]) {
    if (!Array.isArray(value[key])) throw malformed(`${label}.${key} must be an array`);
    for (const record of value[key]) assertRecord(record, `${label}.${key}`);
  }
  for (const key of ["fileOps", "remoteCommands", "startupText"]) {
    if (!isPlainObject(value.special[key]))
      throw malformed(`${label}.special.${key} must be an object`);
  }
  return value;
}
// Validate one command/message record, including its `fields` list.
function assertRecord(record, label) {
  if (!isPlainObject(record)) throw malformed(`${label} record is not an object`);
  for (const key of ["wire", "type", "home", "shapeFingerprint"]) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw malformed(`${label} record needs a non-empty ${key}`);
    }
  }
  if (!Array.isArray(record.fields) || typeof record.fieldLevel !== "boolean") {
    throw malformed(`${label} record needs fields[] and fieldLevel`);
  }
  for (const field of record.fields) {
    if (!isPlainObject(field) || typeof field.name !== "string" || typeof field.type !== "string") {
      throw malformed(`${label} record has a malformed field entry`);
    }
  }
}
// Load the capability table from a path, an array or `{capabilities: []}`.
export function loadCapabilities(source, options = {}) {
  const { cwd = process.cwd() } = options;
  const value =
    typeof source === "string" ? readJsonFile(path.resolve(cwd, source), "capabilities") : source;
  return normalizeCapabilities(value);
}
// Normalize a capability list to the fields the report needs.
export function normalizeCapabilities(value) {
  const list = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.capabilities)
      ? value.capabilities
      : undefined;
  if (list === undefined) {
    throw new DiffInputError(
      "malformed-capabilities",
      "capabilities input must be an array or a { capabilities: [] } object",
    );
  }
  return list.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || typeof entry.wire !== "string") {
      throw new DiffInputError(
        "malformed-capabilities",
        "every capability entry needs a string name and wire",
      );
    }
    return {
      name: entry.name,
      wire: entry.wire,
      detail: entry.detail === true,
      legacy: entry.legacy === true,
    };
  });
}
// Compare two snapshots.
export function diffSnapshots(left, right, options = {}) {
  const a = assertSnapshot(left, "a");
  const b = assertSnapshot(right, "b");
  const capsByWire = indexCapabilities(normalizeCapabilities(options.capabilities ?? []));
  const commandDiff = diffRecordKind("commands", a.commands, b.commands);
  const messageDiff = diffRecordKind("messages", a.messages, b.messages);
  const suspectedRenames = [
    ...pairRenames("commands", commandDiff.removed, commandDiff.added),
    ...pairRenames("messages", messageDiff.removed, messageDiff.added),
  ].sort(
    (first, second) =>
      compareText(first.kind, second.kind) || compareText(first.from?.wire, second.from?.wire),
  );
  const commandFields = diffFields("commands", commandDiff.left, commandDiff.right);
  const messageFields = diffFields("messages", messageDiff.left, messageDiff.right);
  const fieldChanges = [...commandFields.changes, ...messageFields.changes].sort(
    (first, second) =>
      compareText(first.kind, second.kind) ||
      compareText(first.wire, second.wire) ||
      compareText(first.field, second.field) ||
      compareText(first.change, second.change),
  );
  const detailToggles = [...commandFields.toggles, ...messageFields.toggles].sort(
    (first, second) => compareText(first.kind, second.kind) || compareText(first.wire, second.wire),
  );
  const parity = diffParity(a, b);
  const capabilityImpacts = diffCapabilityImpact({
    commandDiff,
    messageDiff,
    fieldChanges,
    parity,
    capsByWire,
  });
  const healthFlip = degradedFlip(a, b);
  const actions = buildActions({
    commandDiff,
    messageDiff,
    suspectedRenames,
    fieldChanges,
    parityChanges: parity.changes,
    detailToggles,
    capsByWire,
    healthFlip,
  });
  const added = {
    commands: commandDiff.added.map(summarizeRecord),
    messages: messageDiff.added.map(summarizeRecord),
  };
  const removed = {
    commands: commandDiff.removed.map(summarizeRecord),
    messages: messageDiff.removed.map(summarizeRecord),
  };
  const summary = summarize(
    added,
    removed,
    suspectedRenames,
    fieldChanges,
    parity.changes,
    capabilityImpacts,
    actions,
  );
  return {
    a: { engine: engineFact(a), counts: countsFact(a) },
    b: { engine: engineFact(b), counts: countsFact(b) },
    added,
    removed,
    suspectedRenames,
    fieldChanges,
    parityChanges: parity.changes,
    capabilityImpacts,
    actions,
    summary,
  };
}
// Diff one record kind (commands or messages).
function diffRecordKind(kind, leftRecords, rightRecords) {
  const left = indexRecords(leftRecords, KIND_LABEL[kind]);
  const right = indexRecords(rightRecords, KIND_LABEL[kind]);
  const added = [...right.values()].filter((record) => !left.has(record.wire));
  const removed = [...left.values()].filter((record) => !right.has(record.wire));
  added.sort(byWire);
  removed.sort(byWire);
  return { added, removed, left, right };
}
// Index records by wire, rejecting a duplicate wire inside one kind.
function indexRecords(records, label) {
  const index = new Map();
  for (const record of asArray(records)) {
    if (index.has(record.wire)) throw malformed(`duplicate ${label} wire ${record.wire}`);
    index.set(record.wire, record);
  }
  return index;
}
// Pair a removed record with an added one when the shape fingerprint matches.
function pairRenames(kind, removed, added) {
  const removedByFingerprint = groupBy(removed, (record) => record.shapeFingerprint);
  const addedByFingerprint = groupBy(added, (record) => record.shapeFingerprint);
  const pairs = [];
  for (const [fingerprint, fromRecords] of removedByFingerprint) {
    const toRecords = addedByFingerprint.get(fingerprint);
    if (toRecords === undefined || fromRecords.length !== 1 || toRecords.length !== 1) continue;
    if (fingerprint.length === 0 || fromRecords[0].wire === toRecords[0].wire) continue;
    pairs.push({
      kind: KIND_LABEL[kind],
      shapeFingerprint: fingerprint,
      from: summarizeRecord(fromRecords[0]),
      to: summarizeRecord(toRecords[0]),
    });
  }
  return pairs;
}
// Compare the fields of wires present on both sides, only when both are field-level (A2-D02).
function diffFields(kind, left, right) {
  const changes = [];
  const toggles = [];
  for (const wire of [...new Set([...left.keys(), ...right.keys()])].sort(compareText)) {
    const before = left.get(wire);
    const after = right.get(wire);
    if (before === undefined || after === undefined) continue;
    if (!before.fieldLevel || !after.fieldLevel) {
      if (before.fieldLevel !== after.fieldLevel) {
        toggles.push({
          kind: KIND_LABEL[kind],
          wire,
          from: before.fieldLevel === true,
          to: after.fieldLevel === true,
        });
      }
      continue;
    }
    changes.push(...diffFieldList(KIND_LABEL[kind], wire, before.fields, after.fields));
  }
  return { changes, toggles };
}
// Compare two field lists of one wire.
function diffFieldList(kind, wire, leftFields, rightFields) {
  const left = indexFields(leftFields, wire);
  const right = indexFields(rightFields, wire);
  const changes = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort(compareText)) {
    const before = left.get(name);
    const after = right.get(name);
    if (before === undefined) {
      changes.push({
        kind,
        wire,
        change: "added",
        field: name,
        type: normalizeFieldType(after.type),
        optional: after.optional === true,
      });
      continue;
    }
    if (after === undefined) {
      changes.push({
        kind,
        wire,
        change: "removed",
        field: name,
        type: normalizeFieldType(before.type),
        optional: before.optional === true,
      });
      continue;
    }
    if (normalizeFieldType(before.type) !== normalizeFieldType(after.type)) {
      changes.push({
        kind,
        wire,
        change: "type-changed",
        field: name,
        fromType: normalizeFieldType(before.type),
        toType: normalizeFieldType(after.type),
      });
    }
    if ((before.optional === true) !== (after.optional === true)) {
      changes.push({
        kind,
        wire,
        change: "optionality-changed",
        field: name,
        fromOptional: before.optional === true,
        toOptional: after.optional === true,
      });
    }
  }
  if (changes.length === 0) {
    const fromFingerprint = fieldFingerprint(leftFields);
    const toFingerprint = fieldFingerprint(rightFields);
    if (fromFingerprint !== toFingerprint) {
      changes.push({ kind, wire, change: "field-text-changed", fromFingerprint, toFingerprint });
    }
  }
  return changes;
}
// Index a field list by name, rejecting duplicates.
function indexFields(fields, wire) {
  const index = new Map();
  for (const field of asArray(fields)) {
    if (index.has(field.name)) throw malformed(`wire ${wire} has a duplicate field ${field.name}`);
    index.set(field.name, field);
  }
  return index;
}
// Compare the parity surface: the four `remoteCommands` sub-keys, the two `startupText` lists and `fileOps`.
function diffParity(a, b) {
  const left = specialView(a);
  const right = specialView(b);
  const changes = [];
  diffStringArray("remoteCommands.advertised", left.advertised, right.advertised, changes);
  diffObjectKeys(
    "remoteCommands.handledElsewhere",
    left.handledElsewhere,
    right.handledElsewhere,
    changes,
  );
  diffObjectKeys(
    "remoteCommands.unadvertisedAliases",
    left.unadvertisedAliases,
    right.unadvertisedAliases,
    changes,
  );
  diffStringArray("remoteCommands.dispatchCases", left.dispatchCases, right.dispatchCases, changes);
  diffStringArray("startupText.required", left.startupRequired, right.startupRequired, changes);
  diffStringArray("startupText.optional", left.startupOptional, right.startupOptional, changes);
  const leftWire = typeof left.fileOps.wire === "string" ? left.fileOps.wire : "";
  const rightWire = typeof right.fileOps.wire === "string" ? right.fileOps.wire : "";
  if (leftWire !== rightWire) {
    changes.push({
      area: "fileOps.wire",
      change: "changed",
      from: leftWire.length > 0 ? leftWire : "unknown",
      to: rightWire.length > 0 ? rightWire : "unknown",
    });
  }
  diffStringArray("fileOps.directions", left.directions, right.directions, changes);
  changes.sort(
    (first, second) =>
      compareText(first.area, second.area) ||
      compareText(first.change, second.change) ||
      compareText(first.key, second.key),
  );
  return { changes, fileOpsWire: rightWire.length > 0 ? rightWire : leftWire };
}
// Reverse-look-up every affected wire in the capability table.
function diffCapabilityImpact({ commandDiff, messageDiff, fieldChanges, parity, capsByWire }) {
  const affected = new Map();
  const mark = (wire, reason) => {
    if (typeof wire !== "string" || wire.length === 0) return;
    const reasons = affected.get(wire) ?? new Set();
    reasons.add(reason);
    affected.set(wire, reasons);
  };
  for (const record of commandDiff.removed) mark(record.wire, "removed-wire");
  for (const record of messageDiff.removed) mark(record.wire, "removed-wire");
  for (const record of commandDiff.added) mark(record.wire, "added-wire");
  for (const record of messageDiff.added) mark(record.wire, "added-wire");
  for (const change of fieldChanges) mark(change.wire, fieldReason(change));
  for (const change of parity.changes) {
    if (change.area === "fileOps.wire") {
      mark(change.from, "file-ops-wire-removed");
      mark(change.to, "file-ops-wire-added");
    }
    if (change.area === "fileOps.directions")
      mark(parity.fileOpsWire, "file-ops-directions-changed");
  }
  const impacts = [];
  for (const wire of [...affected.keys()].sort(compareText)) {
    const reasons = [...affected.get(wire)].sort(compareText);
    const status = impactStatus(reasons);
    const capabilities = capsByWire.get(wire) ?? [];
    if (capabilities.length === 0) {
      if (status !== "ok") impacts.push({ wire, capability: null, detail: false, status, reasons });
      continue;
    }
    for (const capability of capabilities) {
      impacts.push({
        wire,
        capability: capability.name,
        detail: capability.detail === true,
        status,
        reasons,
      });
    }
  }
  return impacts.sort(
    (first, second) =>
      compareText(first.wire, second.wire) ||
      compareText(first.capability ?? "", second.capability ?? ""),
  );
}
// Derive executable follow-ups.
function buildActions(input) {
  const {
    commandDiff,
    messageDiff,
    suspectedRenames,
    fieldChanges,
    parityChanges,
    detailToggles,
    capsByWire,
    healthFlip,
  } = input;
  const actions = [];
  const seen = new Set();
  const add = (target, text) => {
    const key = `${target}\u0000${text}`;
    if (!seen.has(key)) {
      seen.add(key);
      actions.push({ target, text });
    }
  };
  const capsFor = (wire) => capsByWire.get(wire) ?? [];
  const renameTargets = new Set(suspectedRenames.map((rename) => rename.to.wire));
  for (const record of commandDiff.removed) {
    const capabilities = capsFor(record.wire);
    if (capabilities.length === 0) {
      add(
        TARGET_NOTICE,
        `wire ${record.wire} was removed and no capability is registered for it; confirm the removal is intended`,
      );
    }
    for (const capability of capabilities) {
      add(
        TARGET_CAPABILITIES,
        `remove or repoint capability ${capability.name} (wire ${record.wire} was removed)`,
      );
      add(
        TARGET_B4,
        `check typed call sites for capability ${capability.name} (wire ${record.wire} was removed)`,
      );
    }
  }
  for (const record of messageDiff.removed) {
    add(TARGET_B4, `check listeners for removed message wire ${record.wire}`);
  }
  for (const record of commandDiff.added) {
    if (!renameTargets.has(record.wire)) {
      add(
        TARGET_CAPABILITIES,
        `register a capability for new wire ${record.wire} or record the exclusion`,
      );
    }
  }
  for (const record of messageDiff.added) {
    add(TARGET_B4, `check listeners for new message wire ${record.wire}`);
  }
  for (const rename of suspectedRenames) {
    add(
      TARGET_NOTICE,
      `confirm whether wire ${rename.from.wire} was renamed to ${rename.to.wire}` +
        ` (shape fingerprint ${rename.shapeFingerprint} matches; suspected rename only)`,
    );
    for (const capability of capsFor(rename.from.wire)) {
      add(
        TARGET_CAPABILITIES,
        `if the rename is confirmed, repoint capability ${capability.name}` +
          ` from ${rename.from.wire} to ${rename.to.wire}`,
      );
      add(
        TARGET_B4,
        `if the rename is confirmed, update typed call sites for capability ${capability.name}` +
          ` (${rename.from.wire} -> ${rename.to.wire})`,
      );
    }
  }
  const groups = new Map();
  for (const change of fieldChanges) {
    if (change.change === "field-text-changed") {
      add(
        TARGET_NOTICE,
        `confirm field text drift for wire ${change.wire}` +
          ` (fieldFingerprint ${change.fromFingerprint} -> ${change.toFingerprint};` +
          " no per-field difference is visible)",
      );
      continue;
    }
    const key = `${change.kind}|${change.wire}`;
    const group = groups.get(key) ?? {
      kind: change.kind,
      wire: change.wire,
      breaking: [],
      pending: [],
    };
    if (change.change === "removed" || change.change === "type-changed") {
      group.breaking.push(`${change.field} ${change.change}`);
    } else if (change.change === "added" || change.change === "optionality-changed") {
      group.pending.push(`${change.field} ${change.change}`);
    }
    groups.set(key, group);
  }
  for (const group of [...groups.values()].sort(
    (first, second) => compareText(first.kind, second.kind) || compareText(first.wire, second.wire),
  )) {
    if (group.breaking.length > 0) {
      const detail = group.breaking.join(", ");
      const capabilities = capsFor(group.wire);
      if (capabilities.length === 0)
        add(TARGET_B4, `check typed call sites for wire ${group.wire} (${detail})`);
      for (const capability of capabilities) {
        add(
          TARGET_B4,
          `check typed call sites for capability ${capability.name} (wire ${group.wire}: ${detail})`,
        );
      }
    }
    if (group.pending.length > 0) {
      const detail = group.pending.join(", ");
      const capabilities = capsFor(group.wire);
      if (capabilities.length === 0)
        add(TARGET_B4, `re-read the typed payload for wire ${group.wire} (${detail})`);
      for (const capability of capabilities) {
        add(
          TARGET_B4,
          `re-read the typed payload for capability ${capability.name} (wire ${group.wire}: ${detail})`,
        );
      }
    }
  }
  for (const change of parityChanges) {
    switch (change.area) {
      case "remoteCommands.advertised":
        add(
          TARGET_NOTICE,
          `advertised remote command list changed (${change.change} ${change.key});` +
            " re-check the parity pin and B4 dispatch coverage",
        );
        break;
      case "remoteCommands.dispatchCases":
        add(
          TARGET_NOTICE,
          `dispatch case list changed (${change.change} ${change.key}); re-check the parity pin`,
        );
        break;
      case "remoteCommands.handledElsewhere":
        add(
          TARGET_NOTICE,
          `remote command routing changed (${change.key} ${change.change} the handledElsewhere list)`,
        );
        break;
      case "remoteCommands.unadvertisedAliases":
        add(
          TARGET_NOTICE,
          `remote command alias routing changed (${change.key} ${change.change} the unadvertised alias list)`,
        );
        break;
      case "startupText.required":
      case "startupText.optional":
        add(
          TARGET_NOTICE,
          `startup text shape changed (${change.area} ${change.change} ${change.key});` +
            " update the startup assertions",
        );
        break;
      case "fileOps.wire":
        add(
          TARGET_CAPABILITIES,
          `repoint capability file.ops to wire ${change.to} (file_ops wire changed)`,
        );
        add(TARGET_B4, `check file_ops call sites (wire ${change.from} -> ${change.to})`);
        break;
      case "fileOps.directions":
        add(
          TARGET_NOTICE,
          `file_ops direction coverage changed (${change.change} ${change.key}); confirm both directions stay covered`,
        );
        break;
      default:
        break;
    }
  }
  for (const toggle of detailToggles) {
    add(
      TARGET_CAPABILITIES,
      `update detail registration for wire ${toggle.wire}` +
        ` (fieldLevel ${flagText(toggle.from)} -> ${flagText(toggle.to)})`,
    );
  }
  if (healthFlip !== null) {
    add(
      TARGET_NOTICE,
      `snapshot health degraded flag changed ${flagText(healthFlip.from)} -> ${flagText(healthFlip.to)}`,
    );
  }
  if (hasChanges(input)) {
    add(
      TARGET_NOTICE,
      "re-run contract:update --engine <dir> and contract:generate after the accepted changes",
    );
  }
  return actions.sort(
    (first, second) =>
      (TARGET_RANK[first.target] ?? 9) - (TARGET_RANK[second.target] ?? 9) ||
      compareText(first.text, second.text),
  );
}
// True when any of the seven sections would be non-empty.
function hasChanges(input) {
  return (
    input.commandDiff.added.length > 0 ||
    input.commandDiff.removed.length > 0 ||
    input.messageDiff.added.length > 0 ||
    input.messageDiff.removed.length > 0 ||
    input.suspectedRenames.length > 0 ||
    input.fieldChanges.length > 0 ||
    input.parityChanges.length > 0 ||
    input.detailToggles.length > 0 ||
    input.healthFlip !== null
  );
}
// Map a field-change record onto a short reason token.
function fieldReason(change) {
  switch (change.change) {
    case "added":
      return `field-added:${change.field}`;
    case "removed":
      return `field-removed:${change.field}`;
    case "type-changed":
      return `type-changed:${change.field}`;
    case "optionality-changed":
      return `optionality-changed:${change.field}`;
    default:
      return "field-text-changed";
  }
}
// Three-level capability status (requirements doc 07 section 6.5).
function impactStatus(reasons) {
  const breaking = reasons.some(
    (reason) =>
      reason === "removed-wire" ||
      reason === "file-ops-wire-removed" ||
      reason.startsWith("field-removed:") ||
      reason.startsWith("type-changed:"),
  );
  if (breaking) return "breaking";
  const pending = reasons.some(
    (reason) =>
      reason.startsWith("field-added:") ||
      reason.startsWith("optionality-changed:") ||
      reason === "field-text-changed" ||
      reason === "file-ops-directions-changed",
  );
  return pending ? "pending" : "ok";
}
// Reduce a command/message record to the report fields.
function summarizeRecord(record) {
  return { wire: record.wire, type: record.type, home: record.home };
}
// Engine fields the header prints; everything else in `engine` is ignored.
function engineFact(snapshot) {
  const engine = asObject(snapshot.engine);
  return {
    version: typeof engine.version === "string" ? engine.version : "unknown",
    commit: typeof engine.commit === "string" ? engine.commit : "unknown",
  };
}
// Counts the header prints, with array-length fallbacks for hand-built input.
function countsFact(snapshot) {
  const counts = asObject(snapshot.counts);
  const commands = asArray(snapshot.commands);
  const remote = asObject(asObject(snapshot.special).remoteCommands);
  return {
    commands: integerOr(counts.wireCommands, commands.length),
    messages: integerOr(counts.messages, asArray(snapshot.messages).length),
    inbound: integerOr(
      counts.inboundAccepted,
      commands.filter((record) => record.inbound === true).length,
    ),
    advertised: integerOr(counts.advertisedCommands, stringArray(remote.advertised).length),
  };
}
// Build the per-section counts plus their total.
function summarize(
  added,
  removed,
  suspectedRenames,
  fieldChanges,
  parityChanges,
  capabilityImpacts,
  actions,
) {
  const summary = {
    added: added.commands.length + added.messages.length,
    removed: removed.commands.length + removed.messages.length,
    suspectedRenames: suspectedRenames.length,
    fieldChanges: fieldChanges.length,
    parityChanges: parityChanges.length,
    capabilityImpacts: capabilityImpacts.length,
    actions: actions.length,
  };
  summary.total =
    summary.added +
    summary.removed +
    summary.suspectedRenames +
    summary.fieldChanges +
    summary.parityChanges +
    summary.capabilityImpacts +
    summary.actions;
  return summary;
}
// Normalize the `special` block for comparison.
function specialView(snapshot) {
  const special = asObject(snapshot.special);
  const remote = asObject(special.remoteCommands);
  const startup = asObject(special.startupText);
  const fileOps = asObject(special.fileOps);
  return {
    fileOps,
    directions: stringArray(fileOps.directions),
    advertised: stringArray(remote.advertised),
    handledElsewhere: asObject(remote.handledElsewhere),
    unadvertisedAliases: asObject(remote.unadvertisedAliases),
    dispatchCases: stringArray(remote.dispatchCases),
    startupRequired: stringArray(startup.required),
    startupOptional: stringArray(startup.optional),
  };
}
// Diff two string lists as `added` / `removed` parity entries.
function diffStringArray(area, left, right, changes) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  for (const value of sortedUnique([...rightSet].filter((item) => !leftSet.has(item)))) {
    changes.push({ area, change: "added", key: value });
  }
  for (const value of sortedUnique([...leftSet].filter((item) => !rightSet.has(item)))) {
    changes.push({ area, change: "removed", key: value });
  }
}
// Diff two object maps by key only; values are engine prose, not wire data.
function diffObjectKeys(area, left, right, changes) {
  const leftKeys = new Set(Object.keys(left));
  const rightKeys = new Set(Object.keys(right));
  for (const key of sortedUnique([...rightKeys].filter((item) => !leftKeys.has(item)))) {
    changes.push({ area, change: "added", key });
  }
  for (const key of sortedUnique([...leftKeys].filter((item) => !rightKeys.has(item)))) {
    changes.push({ area, change: "removed", key });
  }
}
// Detect a degraded-flag flip; coarse/unparsed lists are not diffed here.
function degradedFlip(a, b) {
  const from = asObject(a.health).degraded === true;
  const to = asObject(b.health).degraded === true;
  return from === to ? null : { from, to };
}
// Index the capability table by wire.
function indexCapabilities(capabilities) {
  const index = new Map();
  for (const capability of capabilities) {
    const list = index.get(capability.wire) ?? [];
    list.push(capability);
    index.set(capability.wire, list);
  }
  return index;
}
// Group records by a string key.
function groupBy(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  return groups;
}
// Read the diff inputs, defaulting `b` to the committed snapshot.
export function runDiff(options = {}) {
  const {
    a,
    b,
    out = null,
    cwd = process.cwd(),
    capabilities,
    capabilitiesPath = DEFAULT_CAPABILITIES_PATH,
    snapshotPath = DEFAULT_SNAPSHOT_PATH,
  } = options;
  if (a === undefined)
    throw new DiffInputError("bad-argument", "a snapshot path or object is required");
  const left = loadSnapshot(a, { cwd, label: "a" });
  const right =
    b === undefined
      ? loadSnapshot(path.join(REPO_ROOT, snapshotPath), { cwd, label: "b" })
      : loadSnapshot(b, { cwd, label: "b" });
  const capabilityTable =
    capabilities === undefined
      ? loadCapabilities(path.join(REPO_ROOT, capabilitiesPath))
      : normalizeCapabilities(capabilities);
  const result = diffSnapshots(left, right, { capabilities: capabilityTable });
  const lines = renderReport(result);
  if (typeof out === "string" && out.length > 0) {
    const outPath = path.resolve(cwd, out);
    try {
      writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
    } catch (error) {
      throw new DiffInputError(
        "write-failed",
        `report cannot be written to ${outPath}: ${describeError(error)}`,
      );
    }
  }
  return { lines, result };
}
// Parse the CLI arguments.
function parseArgv(argv) {
  const positionals = [];
  const options = { out: null, help: false };
  const errors = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string") continue;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--out" || argument.startsWith("--out=")) {
      if (options.out !== null) {
        errors.push("--out was given more than once");
        continue;
      }
      if (argument === "--out") {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          errors.push("--out requires a value");
          continue;
        }
        options.out = value;
        index += 1;
        continue;
      }
      const inline = argument.slice("--out=".length);
      if (inline.length === 0) {
        errors.push("--out requires a value");
        continue;
      }
      options.out = inline;
      continue;
    }
    if (argument.startsWith("--")) {
      errors.push(`unknown option ${argument}`);
      continue;
    }
    positionals.push(argument);
  }
  if (positionals.length === 0) errors.push("a snapshot path is required");
  if (positionals.length > 2)
    errors.push(`expected one or two snapshot paths, received ${positionals.length}`);
  return { options, positionals, errors };
}
// CLI entry point.
export function main(argv = process.argv.slice(2)) {
  const { options, positionals, errors } = parseArgv(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (errors.length > 0) {
    for (const message of errors) process.stderr.write(`contract diff: ${message}\n`);
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const { lines } = runDiff({ a: positionals[0], b: positionals[1], out: options.out });
    if (options.out === null) process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`contract diff: ${describeError(error)}\n`);
    return 2;
  }
}
// One-line ASCII description for stderr.
function describeError(error) {
  if (error instanceof DiffInputError) return error.message;
  return error instanceof Error
    ? `internal error: ${error.message}`
    : `internal error: ${String(error)}`;
}
// Build the malformed-snapshot error.
function malformed(message) {
  return new DiffInputError("malformed-snapshot", `snapshot is malformed: ${message}`);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asObject(value) {
  return isPlainObject(value) ? value : {};
}
function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function stringArray(value) {
  return asArray(value).filter((item) => typeof item === "string");
}
function sortedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === "string"))].sort(compareText);
}
// Locale-free string comparison.
function compareText(left, right) {
  const first = typeof left === "string" ? left : "";
  const second = typeof right === "string" ? right : "";
  if (first < second) return -1;
  return first > second ? 1 : 0;
}
function byWire(left, right) {
  return compareText(left.wire, right.wire);
}
// Collapse whitespace in a field type so a re-wrapped declaration is not a change and every report line stays single-line (risk R-06).
function normalizeFieldType(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
function integerOr(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}
function flagText(value) {
  return value === true ? "true" : value === false ? "false" : "unknown";
}
const MODULE_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(MODULE_PATH)) {
  process.exitCode = main();
}
