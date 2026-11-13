/**
 * schema.mjs - constants, frozen key order and a structural validator for
 * `snapshot.json` v1.
 *
 * The shape is frozen by the route doc (08 section 3.4a) and by A2-D01: adding
 * a field requires bumping `schemaVersion`. Old snapshots stay diffable, so the
 * validator only knows v1 and reports everything else as a violation.
 *
 * Seam for snapshot assembly:
 *
 *   import { SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_KEY_ORDER, canonicalizeSnapshot,
 *            validateSnapshot } from "./lib/schema.mjs";
 *
 *   const snapshot = canonicalizeSnapshot({
 *     schemaVersion: SNAPSHOT_SCHEMA_VERSION,
 *     engine, counts, commands, messages, special, health,
 *   });
 *   // canonicalizeSnapshot(): frozen key order at every level, arrays sorted
 *   // (commands/messages by wire, fields by name, direction and the health /
 *   // special string arrays lexicographically). It is an ordering pass only: it
 *   // never drops or invents data. Unknown keys are appended in lexicographic
 *   // order and an illegal array element is kept in place, so the validator
 *   // reports them instead of the writer silently trusting them.
 *
 *   const { ok, violations } = validateSnapshot(snapshot);
 *   // ok === false -> each violation is {path, rule, message}, English, single
 *   // line. The extractor maps them to `contract-health` / `contract-stale`
 *   // lines; it must never rewrite the snapshot to make them pass.
 *
 * Sorting is code-unit order (`<` / `>`), not locale collation, so the bytes do
 * not depend on the host locale. `engine.extractedAt` is a normal field here;
 * ignoring it during diff is the diff's job.
 */

import { canonicalizeSnapshot as canonicalize } from "./canonical.mjs";
import { compareStrings, isPlainObject } from "./json.mjs";

/** The only accepted schema version. Bumping it needs a route-doc change. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Frozen key order per object. Every array is a required-key list in output
 * order; optional keys (`nested`, `readonly`, `proposal`-style additions) are
 * listed after the required ones so writers can omit them without reordering.
 */
export const SNAPSHOT_KEY_ORDER = Object.freeze({
  root: Object.freeze([
    "schemaVersion",
    "engine",
    "counts",
    "commands",
    "messages",
    "special",
    "health",
  ]),
  engine: Object.freeze(["version", "commit", "source", "extractedAt", "extractor"]),
  counts: Object.freeze([
    "unionMembers",
    "wireCommands",
    "messages",
    "inboundAccepted",
    "inboundOnly",
    "advertisedCommands",
    "dispatchCases",
  ]),
  command: Object.freeze([
    "wire",
    "type",
    "home",
    "direction",
    "inbound",
    "fields",
    "shapeFingerprint",
    "fieldLevel",
    "health",
  ]),
  message: Object.freeze([
    "wire",
    "type",
    "home",
    "fields",
    "shapeFingerprint",
    "fieldLevel",
    "health",
  ]),
  field: Object.freeze(["name", "type", "optional", "nested", "readonly"]),
  special: Object.freeze(["fileOps", "remoteCommands", "startupText"]),
  fileOps: Object.freeze(["wire", "directions"]),
  remoteCommands: Object.freeze([
    "advertised",
    "handledElsewhere",
    "unadvertisedAliases",
    "dispatchCases",
  ]),
  startupText: Object.freeze(["required", "optional"]),
  health: Object.freeze(["degraded", "coarse", "unparsed"]),
});

/** Allowed `engine.source` values. */
const ENGINE_SOURCES = Object.freeze(["clone", "npm-types"]);

/** Allowed `direction` values. */
const COMMAND_DIRECTIONS = Object.freeze(["c2s", "s2c"]);

/** Allowed per-record `health` values. `degraded` lives at the snapshot level. */
const RECORD_HEALTH = Object.freeze(["ok", "coarse"]);

/** `shapeFingerprint` / `fieldFingerprint` shape. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{12}$/;

/** `home` shape: engine-root relative posix path plus a 1-based line. */
const HOME_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*:\d+$/;

/**
 * Canonicalize a snapshot: frozen key order, sorted arrays, no data loss.
 *
 * Implemented in `canonical.mjs` and re-exported here so every consumer keeps
 * one import site. See that module for the no-data-loss guarantee.
 *
 * @param {unknown} snapshot
 * @returns {Record<string, unknown>}
 */
export function canonicalizeSnapshot(snapshot) {
  return canonicalize(snapshot, SNAPSHOT_KEY_ORDER);
}

/**
 * Validate a snapshot against v1. Never throws.
 *
 * Besides the per-record shape rules, the seven `counts` are cross-checked
 * against the detail sections (`count-mismatch`), so a stale or hand-edited
 * count cannot pass.
 *
 * @param {unknown} snapshot
 * @returns {{ ok: boolean, violations: {path: string, rule: string, message: string}[] }}
 */
export function validateSnapshot(snapshot) {
  /** @type {{path: string, rule: string, message: string}[]} */
  const violations = [];

  if (!isPlainObject(snapshot)) {
    violations.push(violation("$", "invalid-type", "snapshot must be an object"));

    return { ok: false, violations };
  }

  checkKeys(snapshot, SNAPSHOT_KEY_ORDER.root, "$", violations, true);

  if (Object.hasOwn(snapshot, "schemaVersion")) {
    if (typeof snapshot.schemaVersion !== "number") {
      violations.push(
        violation("$.schemaVersion", "invalid-type", "schemaVersion must be a number"),
      );
    } else if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      violations.push(
        violation(
          "$.schemaVersion",
          "invalid-value",
          `schemaVersion must be ${SNAPSHOT_SCHEMA_VERSION}, received ${String(snapshot.schemaVersion)}`,
        ),
      );
    }
  }

  validateEngine(snapshot.engine, violations);
  validateCounts(snapshot.counts, violations);
  validateCommands(snapshot.commands, violations);
  validateMessages(snapshot.messages, violations);
  validateSpecial(snapshot.special, violations);
  validateHealth(snapshot.health, violations);
  validateCountConsistency(snapshot, violations);

  return { ok: violations.length === 0, violations };
}

/**
 * Cross-check the seven derived counts against the records they describe.
 *
 * `counts` used to be write-only: any integer passed, and a snapshot could claim
 * 124 commands while carrying one. The equalities are all derivable from the
 * detail sections, so a stale or hand-edited count is now a hard violation:
 *
 *   wireCommands    = command records with a non-null wire (07 section 6.6)
 *   messages        = message records
 *   inboundAccepted = inbound command records + inboundOnly (set arithmetic:
 *                     |accepted| = |accepted & commands| + |accepted - commands|)
 *   advertisedCommands / dispatchCases = the lengths of the arrays in `special`
 *
 * A count of the wrong type is skipped here so `validateCounts` reports it once.
 *
 * @param {Record<string, unknown>} snapshot
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function validateCountConsistency(snapshot, violations) {
  const counts = isPlainObject(snapshot.counts) ? snapshot.counts : null;

  if (!counts) {
    return;
  }

  const path = "$.counts";
  const commands = Array.isArray(snapshot.commands)
    ? snapshot.commands.filter((command) => isPlainObject(command))
    : null;
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : null;

  if (commands) {
    const wired = commands.filter((command) => typeof command.wire === "string").length;
    const inbound = commands.filter((command) => command.inbound === true).length;

    checkCountEquals(
      counts.wireCommands,
      wired,
      `${path}.wireCommands`,
      violations,
      "command records with a wire",
    );

    if (Number.isInteger(counts.inboundOnly)) {
      checkCountEquals(
        counts.inboundAccepted,
        inbound + counts.inboundOnly,
        `${path}.inboundAccepted`,
        violations,
        "inbound command records plus inboundOnly",
      );
    }
  }

  if (messages) {
    checkCountEquals(
      counts.messages,
      messages.length,
      `${path}.messages`,
      violations,
      "message records",
    );
  }

  const special = isPlainObject(snapshot.special) ? snapshot.special : {};
  const remote = isPlainObject(special.remoteCommands) ? special.remoteCommands : null;

  if (remote) {
    if (Array.isArray(remote.advertised)) {
      checkCountEquals(
        counts.advertisedCommands,
        remote.advertised.length,
        `${path}.advertisedCommands`,
        violations,
        "remoteCommands.advertised entries",
      );
    }

    if (Array.isArray(remote.dispatchCases)) {
      checkCountEquals(
        counts.dispatchCases,
        remote.dispatchCases.length,
        `${path}.dispatchCases`,
        violations,
        "remoteCommands.dispatchCases entries",
      );
    }
  }
}

/**
 * @param {unknown} declared count as written in the snapshot
 * @param {number} actual value derived from the detail sections
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 * @param {string} subject what the count must equal
 */
function checkCountEquals(declared, actual, path, violations, subject) {
  if (typeof declared !== "number" || !Number.isInteger(declared)) {
    return;
  }

  if (declared !== actual) {
    violations.push(
      violation(
        path,
        "count-mismatch",
        `${path.split(".").pop()} must be ${actual} (${subject}), received ${declared}`,
      ),
    );
  }
}

/**
 * @param {unknown} engine
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function validateEngine(engine, violations) {
  const path = "$.engine";
  const object = requireObject(engine, path, violations);

  if (!object) {
    return;
  }

  checkKeys(object, SNAPSHOT_KEY_ORDER.engine, path, violations, true);
  checkString(object.version, `${path}.version`, violations);
  checkString(object.commit, `${path}.commit`, violations);
  checkString(object.extractor, `${path}.extractor`, violations);
  checkEnum(object.source, `${path}.source`, ENGINE_SOURCES, violations);

  if (typeof object.extractedAt === "string") {
    if (Number.isNaN(Date.parse(object.extractedAt))) {
      violations.push(
        violation(`${path}.extractedAt`, "invalid-value", "extractedAt must be an ISO 8601 date"),
      );
    }
  } else {
    violations.push(
      violation(`${path}.extractedAt`, "invalid-type", "extractedAt must be an ISO 8601 string"),
    );
  }
}

/**
 * @param {unknown} counts
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function validateCounts(counts, violations) {
  const path = "$.counts";
  const object = requireObject(counts, path, violations);

  if (!object) {
    return;
  }

  checkKeys(object, SNAPSHOT_KEY_ORDER.counts, path, violations, true);

  for (const key of SNAPSHOT_KEY_ORDER.counts) {
    const value = object[key];

    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      violations.push(
        violation(`${path}.${key}`, "invalid-type", `${key} must be a non-negative integer`),
      );
    }
  }
}

/**
 * @param {unknown} commands
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function validateCommands(commands, violations) {
  const list = requireArray(commands, "$.commands", violations);

  if (!list) {
    return;
  }

  list.forEach((command, index) => {
    const path = `$.commands[${index}]`;
    const object = requireObject(command, path, violations);

    if (!object) {
      return;
    }

    checkKeys(object, SNAPSHOT_KEY_ORDER.command, path, violations, true);
    checkWireRecord(object, path, violations, { direction: true, inbound: true });
    checkSortedStrings(object.direction, `${path}.direction`, violations, {
      allowed: COMMAND_DIRECTIONS,
    });

    if (object.fieldLevel !== true && Array.isArray(object.fields) && object.fields.length > 0) {
      violations.push(
        violation(
          `${path}.fields`,
          "fields-without-field-level",
          "fields must stay empty unless fieldLevel is true",
        ),
      );
    }
  });

  checkSortedByWire(list, "$.commands", violations);
  checkDuplicateWires(list, "$.commands", violations);
}

/**
 * @param {unknown} messages
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function validateMessages(messages, violations) {
  const list = requireArray(messages, "$.messages", violations);

  if (!list) {
    return;
  }

  list.forEach((message, index) => {
    const path = `$.messages[${index}]`;
    const object = requireObject(message, path, violations);

    if (!object) {
      return;
    }

    checkKeys(object, SNAPSHOT_KEY_ORDER.message, path, violations, true);
    checkWireRecord(object, path, violations, { direction: false, inbound: false });

    if (object.fieldLevel !== true && Array.isArray(object.fields) && object.fields.length > 0) {
      violations.push(
        violation(
          `${path}.fields`,
          "fields-without-field-level",
          "fields must stay empty unless fieldLevel is true",
        ),
      );
    }
  });

  checkSortedByWire(list, "$.messages", violations);
  checkDuplicateWires(list, "$.messages", violations);
}

/**
 * Shared checks for a command / message record.
 *
 * @param {Record<string, unknown>} object
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 * @param {{direction: boolean, inbound: boolean}} extra
 */
function checkWireRecord(object, path, violations, extra) {
  checkString(object.wire, `${path}.wire`, violations);
  checkString(object.type, `${path}.type`, violations);
  checkString(object.home, `${path}.home`, violations);

  if (typeof object.home === "string" && !HOME_PATTERN.test(object.home)) {
    violations.push(
      violation(`${path}.home`, "invalid-value", "home must be a posix path with a 1-based line"),
    );
  }

  if (extra.direction) {
    checkArray(object.direction, `${path}.direction`, violations);
  }

  if (extra.inbound && typeof object.inbound !== "boolean") {
    violations.push(violation(`${path}.inbound`, "invalid-type", "inbound must be a boolean"));
  }

  checkFields(object.fields, `${path}.fields`, violations);

  if (
    typeof object.shapeFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(object.shapeFingerprint)
  ) {
    violations.push(
      violation(
        `${path}.shapeFingerprint`,
        "invalid-value",
        "shapeFingerprint must be 12 lowercase hex characters",
      ),
    );
  }

  if (typeof object.fieldLevel !== "boolean") {
    violations.push(
      violation(`${path}.fieldLevel`, "invalid-type", "fieldLevel must be a boolean"),
    );
  }

  checkEnum(object.health, `${path}.health`, RECORD_HEALTH, violations);

  if (object.fieldLevel === true) {
    checkSortedByName(object.fields, `${path}.fields`, violations);
  }
}

/**
 * @param {unknown} fields
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function checkFields(fields, path, violations) {
  const list = requireArray(fields, path, violations);

  if (!list) {
    return;
  }

  list.forEach((field, index) => {
    const fieldPath = `${path}[${index}]`;

    if (!isPlainObject(field)) {
      violations.push(violation(fieldPath, "invalid-type", "field must be an object"));

      return;
    }

    checkKeys(field, SNAPSHOT_KEY_ORDER.field, fieldPath, violations, false);
    checkString(field.name, `${fieldPath}.name`, violations);
    checkString(field.type, `${fieldPath}.type`, violations);

    if (typeof field.optional !== "boolean") {
      violations.push(
        violation(`${fieldPath}.optional`, "invalid-type", "optional must be a boolean"),
      );
    }

    for (const flag of ["nested", "readonly"]) {
      if (Object.hasOwn(field, flag) && typeof field[flag] !== "boolean") {
        violations.push(
          violation(`${fieldPath}.${flag}`, "invalid-type", `${flag} must be a boolean`),
        );
      }
    }
  });
}

/**
 * @param {unknown} special
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function validateSpecial(special, violations) {
  const path = "$.special";
  const object = requireObject(special, path, violations);

  if (!object) {
    return;
  }

  checkKeys(object, SNAPSHOT_KEY_ORDER.special, path, violations, true);

  const fileOpsPath = `${path}.fileOps`;
  const fileOps = requireObject(object.fileOps, fileOpsPath, violations);

  if (fileOps) {
    checkKeys(fileOps, SNAPSHOT_KEY_ORDER.fileOps, fileOpsPath, violations, true);
    checkString(fileOps.wire, `${fileOpsPath}.wire`, violations);
    checkSortedStrings(fileOps.directions, `${fileOpsPath}.directions`, violations, {
      allowed: COMMAND_DIRECTIONS,
    });
  }

  const remotePath = `${path}.remoteCommands`;
  const remote = requireObject(object.remoteCommands, remotePath, violations);

  if (remote) {
    checkKeys(remote, SNAPSHOT_KEY_ORDER.remoteCommands, remotePath, violations, true);
    checkSortedStrings(remote.advertised, `${remotePath}.advertised`, violations);
    checkStringMap(remote.handledElsewhere, `${remotePath}.handledElsewhere`, violations);
    checkStringMap(remote.unadvertisedAliases, `${remotePath}.unadvertisedAliases`, violations);
    checkSortedStrings(remote.dispatchCases, `${remotePath}.dispatchCases`, violations);
  }

  const startupPath = `${path}.startupText`;
  const startup = requireObject(object.startupText, startupPath, violations);

  if (startup) {
    checkKeys(startup, SNAPSHOT_KEY_ORDER.startupText, startupPath, violations, true);
    checkSortedStrings(startup.required, `${startupPath}.required`, violations);
    checkSortedStrings(startup.optional, `${startupPath}.optional`, violations);
  }
}

/**
 * @param {unknown} health
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function validateHealth(health, violations) {
  const path = "$.health";
  const object = requireObject(health, path, violations);

  if (!object) {
    return;
  }

  checkKeys(object, SNAPSHOT_KEY_ORDER.health, path, violations, true);

  if (typeof object.degraded !== "boolean") {
    violations.push(violation(`${path}.degraded`, "invalid-type", "degraded must be a boolean"));
  }

  checkSortedStrings(object.coarse, `${path}.coarse`, violations);
  checkSortedStrings(object.unparsed, `${path}.unparsed`, violations);
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 * @returns {Record<string, unknown> | null}
 */
function requireObject(value, path, violations) {
  if (!isPlainObject(value)) {
    violations.push(violation(path, "invalid-type", "must be an object"));

    return null;
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 * @returns {unknown[] | null}
 */
function requireArray(value, path, violations) {
  if (!Array.isArray(value)) {
    violations.push(violation(path, "invalid-type", "must be an array"));

    return null;
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function checkArray(value, path, violations) {
  if (!Array.isArray(value)) {
    violations.push(violation(path, "invalid-type", "must be an array"));
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function checkString(value, path, violations) {
  if (typeof value !== "string" || value.length === 0) {
    violations.push(violation(path, "invalid-type", "must be a non-empty string"));
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {readonly string[]} allowed
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function checkEnum(value, path, allowed, violations) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    violations.push(violation(path, "invalid-value", `must be one of: ${allowed.join(", ")}`));
  }
}

/**
 * Check an array of strings and, when present, its lexicographic order.
 *
 * @param {unknown} value
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 * @param {{allowed?: readonly string[]}} [options]
 */
function checkSortedStrings(value, path, violations, options = {}) {
  const list = requireArray(value, path, violations);

  if (!list) {
    return;
  }

  for (const [index, item] of list.entries()) {
    if (typeof item !== "string") {
      violations.push(violation(`${path}[${index}]`, "invalid-type", "must be a string"));
    } else if (options.allowed && !options.allowed.includes(item)) {
      violations.push(
        violation(
          `${path}[${index}]`,
          "invalid-value",
          `must be one of: ${options.allowed.join(", ")}`,
        ),
      );
    }
  }

  const strings = list.filter((item) => typeof item === "string");

  if (strings.length !== list.length) {
    return;
  }

  const sorted = [...strings].sort(compareStrings);

  if (strings.some((item, index) => item !== sorted[index])) {
    violations.push(
      violation(path, "unsorted-array", "array must be in lexicographic (code unit) order"),
    );
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function checkStringMap(value, path, violations) {
  const object = requireObject(value, path, violations);

  if (!object) {
    return;
  }

  for (const [key, entry] of Object.entries(object)) {
    if (typeof key !== "string" || key.length === 0 || typeof entry !== "string") {
      violations.push(
        violation(`${path}.${key}`, "invalid-type", "map keys and values must be strings"),
      );
    }
  }
}

/**
 * @param {unknown} fields
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function checkSortedByName(fields, path, violations) {
  if (!Array.isArray(fields)) {
    return;
  }

  const names = fields
    .map((field) => (isPlainObject(field) && typeof field.name === "string" ? field.name : null))
    .filter((name) => name !== null);
  const sorted = [...names].sort(compareStrings);

  if (names.some((name, index) => name !== sorted[index])) {
    violations.push(
      violation(path, "unsorted-array", "fields must be sorted by name (code unit order)"),
    );
  }
}

/**
 * @param {unknown[]} list
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function checkSortedByWire(list, path, violations) {
  const wires = list
    .map((record) =>
      isPlainObject(record) && typeof record.wire === "string" ? record.wire : null,
    )
    .filter((wire) => wire !== null);
  const sorted = [...wires].sort(compareStrings);

  if (wires.some((wire, index) => wire !== sorted[index])) {
    violations.push(
      violation(path, "unsorted-array", "records must be sorted by wire (code unit order)"),
    );
  }
}

/**
 * @param {unknown[]} list
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 */
function checkDuplicateWires(list, path, violations) {
  const seen = new Set();

  for (const record of list) {
    if (!isPlainObject(record) || typeof record.wire !== "string") {
      continue;
    }

    if (seen.has(record.wire)) {
      violations.push(
        violation(path, "duplicate-wire", `wire ${record.wire} appears more than once`),
      );

      return;
    }

    seen.add(record.wire);
  }
}

/**
 * Check required keys, unknown keys and the frozen key order of one object.
 *
 * @param {Record<string, unknown>} object
 * @param {readonly string[]} order frozen key order; the required-key list
 * @param {string} path
 * @param {{path: string, rule: string, message: string}[]} violations
 * @param {boolean} requireAll true when every key in `order` is required
 */
function checkKeys(object, order, path, violations, requireAll) {
  const expected = requireAll ? order : [];

  for (const key of expected) {
    if (!Object.hasOwn(object, key)) {
      violations.push(violation(`${path}.${key}`, "missing-key", `missing required key ${key}`));
    }
  }

  for (const key of Object.keys(object)) {
    if (!order.includes(key)) {
      violations.push(
        violation(`${path}.${key}`, "unknown-key", `unknown key ${key} for schema v1`),
      );
    }
  }

  const present = Object.keys(object).filter((key) => order.includes(key));
  const reordered = [...present].sort((left, right) => order.indexOf(left) - order.indexOf(right));

  if (present.some((key, index) => key !== reordered[index])) {
    violations.push(
      violation(path, "key-order", `keys must follow the frozen order: ${order.join(", ")}`),
    );
  }
}

/**
 * @param {string} path
 * @param {string} rule
 * @param {string} message
 * @returns {{path: string, rule: string, message: string}}
 */
function violation(path, rule, message) {
  return { path, rule, message };
}
