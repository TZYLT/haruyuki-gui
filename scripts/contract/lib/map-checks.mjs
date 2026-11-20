/**
 * map-checks.mjs - the capability-table checks behind the map gate.
 *
 * This module owns validation only: it never renders TypeScript and never reads
 * or writes a file. `scripts/contract/map.mjs` calls `collectViolations` before
 * emitting the artifact, and the stale comparison in the same module reuses it,
 * so one implementation of every rule serves both the generator and the gate.
 *
 * Inputs are the two truth sources (route doc 08 sections 3.4a and 07 section
 * 4.2) and, optionally, the names read back from the committed artifact. The
 * capability table is the human truth source; the snapshot supplies the pinned
 * engine version, the command set and the field-level registration.
 *
 * Rules (ids frozen by route doc 08 section 3.4c)
 *
 *   contract-map     one entry missing from the generated map, an orphan map
 *                    entry, a duplicate name, two capabilities sharing one
 *                    `wire` (07 section 4.1.5: one capability per wire), a
 *                    `fallback` pointing at a name that does not exist, a
 *                    `wire` that is not a snapshot command (pending entries are
 *                    exempt), a `since` newer than the pinned engine (pending
 *                    only), a pending entry without a proposal, plus structural
 *                    checks that would otherwise emit invalid TypeScript (name
 *                    grammar, closed domain, field types, non-semver `since`).
 *   contract-cover   `detail: true` wires must equal the field-level snapshot
 *                    commands; both differences are reported separately.
 *                    The three `execute_command` parity invariants are also
 *                    re-evaluated here by the gate: an advertised id
 *                    without a handler, an unadvertised dispatch case without
 *                    an alias, and an alias without a dispatch case.
 *   contract-health  `health.degraded === true` is red; `coarse` entries are a
 *                    warning, because a name-level map is still usable (G-6). An
 *                    empty parity input (`advertised` and `dispatchCases` both
 *                    empty) is also red, because a vanished extraction must not
 *                    read as a clean parity surface (P5-9).
 *
 * Severity
 *   `severity: "error"` fails the gate, `severity: "warning"` is reported but
 *   must not. A consumer that hands these straight to `finish()` would turn a
 *   coarse warning into a red gate, so filter on severity first.
 *
 * Failure semantics
 *   Wrong top-level shapes throw (exit code 2: broken input). Data disagreements
 *   are returned as violations (exit code 1). Nothing is ever silently skipped.
 *
 * Determinism
 *   The output is sorted (rule, code, message) and every message is English and
 *   single line, so a repeated run over the same data prints the same bytes.
 */

import { SNAPSHOT_SCHEMA_VERSION } from "./schema.mjs";

/** Generated artifact, repo-relative posix path. */
export const MAP_FILE = "packages/protocol/src/contract/command-map.generated.ts";

/** Capability table (the human truth source), repo-relative posix path. */
export const CAPABILITIES_FILE = "packages/protocol/src/contract/capabilities.json";

/** Contract snapshot (generated, committed), repo-relative posix path. */
export const SNAPSHOT_FILE = "packages/protocol/src/contract/snapshot.json";

/**
 * The only accepted `capabilities.json` schema version (A2-D01).
 *
 * Mirrors `SNAPSHOT_SCHEMA_VERSION` from `schema.mjs`: a table written for a
 * different major shape must fail loudly (exit 2) instead of being coerced into
 * the current one.
 */
export const CAPABILITY_SCHEMA_VERSION = 1;

/** Rule ids frozen by route doc 08 section 3.4(c). */
export const MAP_RULES = Object.freeze({
  map: "contract-map",
  stale: "contract-stale",
  cover: "contract-cover",
  health: "contract-health",
});

/** Allowed `scope` values (07 section 4.2). */
export const CAPABILITY_SCOPES = Object.freeze(["agent", "conversation", "none"]);

/** Allowed `shape` values (07 section 4.2). */
export const CAPABILITY_SHAPES = Object.freeze([
  "request-response",
  "one-way",
  "bidirectional",
  "raw",
]);

/** Closed `domain` vocabulary (07 section 4.1). */
export const CAPABILITY_DOMAINS = Object.freeze([
  "agent",
  "compaction",
  "connect",
  "context",
  "conversation",
  "device",
  "file",
  "git",
  "memory",
  "message",
  "model",
  "provider",
  "queue",
  "settings",
  "skill",
  "slash",
  "subagent",
  "terminal",
  "toolset",
  "topic",
  "usage",
  "workspace",
]);

/** Boolean flags whose only legal value is `true` (07 section 4.2). */
export const CAPABILITY_FLAG_KEYS = Object.freeze(["pending", "legacy", "detail"]);

/** Every sub-rule code this module can return, in documentation order. */
export const MAP_CHECK_CODES = Object.freeze([
  "missing-capability",
  "orphan-capability",
  "duplicate-name",
  "duplicate-wire",
  "dangling-fallback",
  "unknown-wire",
  "since-ahead",
  "pending-without-proposal",
  "invalid-name",
  "invalid-field",
  "invalid-since",
  "invalid-capabilities",
  "detail-without-fields",
  "fields-without-detail",
  "advertised-without-handler",
  "unadvertised-case-without-alias",
  "alias-without-case",
  "degraded-snapshot",
  "empty-parity",
  "coarse-fields",
  "invalid-snapshot",
  "stale-artifact",
  "missing-artifact",
]);

/** Capability name shape: `<domain>.<action>`, exactly two segments (07 section 4.1). */
const NAME_PATTERN = /^([a-z][a-z0-9]*)\.([a-z][A-Za-z0-9]*)$/;

/** Semver shape accepted by `since`; a leading `v` is tolerated. */
const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * @typedef {object} Violation
 * @property {string} file Repo-relative posix path the violation points at.
 * @property {number} [line] 1-based line, when the check can point at one.
 * @property {string} rule Frozen rule id (`contract-map`, ...).
 * @property {string} code Stable sub-rule code (`duplicate-name`, ...).
 * @property {"error"|"warning"} severity Errors fail the gate; warnings never do.
 * @property {string} message English, single line, code-prefixed.
 */

/**
 * Code-unit comparison, so output order never depends on the locale.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * True for a non-null, non-array object.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Quote a string for a message.
 *
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return JSON.stringify(value);
}

/**
 * Build one violation record.
 *
 * @param {string} rule
 * @param {string} code
 * @param {string} message
 * @param {{file?: string, line?: number, severity?: "error"|"warning"}} [options]
 * @returns {Violation}
 */
function violation(rule, code, message, options = {}) {
  /** @type {Violation} */
  const entry = {
    file: options.file ?? CAPABILITIES_FILE,
    rule,
    code,
    severity: options.severity ?? "error",
    message: `${code}: ${message}`,
  };

  if (options.line !== undefined) {
    entry.line = options.line;
  }

  return entry;
}

/**
 * Parse a semver string into three numbers, or null when it does not parse.
 *
 * @param {unknown} version
 * @returns {number[] | null}
 */
function parseSemver(version) {
  if (typeof version !== "string") {
    return null;
  }

  const match = SEMVER_PATTERN.exec(version.trim());

  if (match === null) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two parsed semvers, ignoring pre-release/build metadata.
 *
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number}
 */
function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }

  return 0;
}

/**
 * Require the snapshot `schemaVersion` supported by this module.
 *
 * A different version is broken input, not a data disagreement: the reader does
 * not know that shape, so returning a verdict would be a guess (A2-D01, P6-F6).
 *
 * @param {unknown} snapshot
 * @param {string} [label] file name used in the message
 * @returns {void}
 */
export function requireSnapshotVersion(snapshot, label = SNAPSHOT_FILE) {
  if (!isPlainObject(snapshot)) {
    throw new TypeError(`${label} must be a JSON object`);
  }

  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError(
      `${label} schemaVersion ${String(snapshot.schemaVersion)} is not supported` +
        ` (expected ${SNAPSHOT_SCHEMA_VERSION})`,
    );
  }
}

/**
 * Require the capability-table `schemaVersion` supported by this module.
 *
 * @param {unknown} capabilities
 * @param {string} [label] file name used in the message
 * @returns {void}
 */
export function requireCapabilitiesVersion(capabilities, label = CAPABILITIES_FILE) {
  if (!isPlainObject(capabilities)) {
    throw new TypeError(`${label} must be a JSON object`);
  }

  if (capabilities.schemaVersion !== CAPABILITY_SCHEMA_VERSION) {
    throw new TypeError(
      `${label} schemaVersion ${String(capabilities.schemaVersion)} is not supported` +
        ` (expected ${CAPABILITY_SCHEMA_VERSION})`,
    );
  }
}

/**
 * Require the snapshot keys the rules consume.
 *
 * @param {unknown} snapshot
 * @returns {{
 *   engine: Record<string, unknown>,
 *   commands: Record<string, unknown>[],
 *   health: Record<string, unknown>,
 *   special: Record<string, unknown>,
 * }}
 */
export function requireSnapshot(snapshot) {
  requireSnapshotVersion(snapshot);
  const { engine, commands, health, special } = /** @type {Record<string, unknown>} */ (snapshot);

  if (!isPlainObject(engine) || typeof engine.version !== "string") {
    throw new TypeError("snapshot.engine.version must be a string");
  }

  if (typeof engine.commit !== "string") {
    throw new TypeError("snapshot.engine.commit must be a string");
  }

  if (!Array.isArray(commands)) {
    throw new TypeError("snapshot.commands must be an array");
  }

  if (!isPlainObject(health)) {
    throw new TypeError("snapshot.health must be an object");
  }

  return {
    engine,
    commands: commands.filter((entry) => isPlainObject(entry)),
    health,
    special: isPlainObject(special) ? special : {},
  };
}

/**
 * Require the capability table shape and return its entries.
 *
 * @param {unknown} capabilities
 * @returns {Record<string, unknown>[]}
 */
export function requireCapabilities(capabilities) {
  requireCapabilitiesVersion(capabilities);
  const entries = /** @type {Record<string, unknown>} */ (capabilities).capabilities;

  if (!Array.isArray(entries)) {
    throw new TypeError("capabilities.capabilities must be an array");
  }

  return entries.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new TypeError(`capabilities.capabilities[${index}] must be an object`);
    }

    return entry;
  });
}

/**
 * Sort violations into a deterministic order: rule, code, message.
 *
 * @param {Violation[]} violations
 * @returns {Violation[]}
 */
export function sortViolations(violations) {
  return violations.slice().sort((left, right) => {
    const byRule = compareStrings(left.rule, right.rule);

    if (byRule !== 0) {
      return byRule;
    }

    const byCode = compareStrings(left.code, right.code);

    if (byCode !== 0) {
      return byCode;
    }

    return compareStrings(left.message, right.message);
  });
}

/**
 * Whether a capability entry is declared pending (`pending: true` only).
 *
 * @param {Record<string, unknown>} entry
 * @returns {boolean}
 */
function isPending(entry) {
  return entry.pending === true;
}

/**
 * Structural + semantic checks over one capability entry.
 *
 * Pushes violations; never throws for data problems.
 *
 * @param {Record<string, unknown>} entry
 * @param {number} index Position in `capabilities.capabilities`.
 * @param {{names: Set<string>, wireSet: Set<string>, engineVersion: string}} context
 * @param {Violation[]} violations
 */
function checkCapabilityEntry(entry, index, context, violations) {
  const file = CAPABILITIES_FILE;
  const name = entry.name;

  if (typeof name !== "string" || name === "") {
    violations.push(
      violation(MAP_RULES.map, "invalid-name", `entry ${index} has no "name" string`, { file }),
    );

    return;
  }

  const nameMatch = NAME_PATTERN.exec(name);

  if (nameMatch === null) {
    violations.push(
      violation(
        MAP_RULES.map,
        "invalid-name",
        `${quote(name)} must be "<domain>.<action>" with exactly two lowercase segments`,
        { file },
      ),
    );
  } else if (!CAPABILITY_DOMAINS.includes(nameMatch[1])) {
    violations.push(
      violation(
        MAP_RULES.map,
        "invalid-name",
        `${quote(name)} uses a domain outside the closed vocabulary`,
        { file },
      ),
    );
  }

  if (typeof entry.wire !== "string" || entry.wire === "") {
    violations.push(
      violation(MAP_RULES.map, "invalid-field", `${quote(name)} has no "wire" string`, { file }),
    );
  }

  if (typeof entry.since !== "string" || entry.since === "") {
    violations.push(
      violation(MAP_RULES.map, "invalid-field", `${quote(name)} has no "since" string`, { file }),
    );
  }

  if (!CAPABILITY_SCOPES.includes(entry.scope)) {
    violations.push(
      violation(
        MAP_RULES.map,
        "invalid-field",
        `${quote(name)} has scope ${quote(String(entry.scope))} outside ${CAPABILITY_SCOPES.join(" | ")}`,
        { file },
      ),
    );
  }

  if (!CAPABILITY_SHAPES.includes(entry.shape)) {
    violations.push(
      violation(
        MAP_RULES.map,
        "invalid-field",
        `${quote(name)} has shape ${quote(String(entry.shape))} outside ${CAPABILITY_SHAPES.join(" | ")}`,
        { file },
      ),
    );
  }

  for (const key of CAPABILITY_FLAG_KEYS) {
    if (entry[key] !== undefined && entry[key] !== true) {
      violations.push(
        violation(
          MAP_RULES.map,
          "invalid-field",
          `${quote(name)} has ${key} set to a non-true value`,
          { file },
        ),
      );
    }
  }

  if (
    entry.proposal !== undefined &&
    (typeof entry.proposal !== "string" || entry.proposal === "")
  ) {
    violations.push(
      violation(MAP_RULES.map, "invalid-field", `${quote(name)} has a non-string proposal`, {
        file,
      }),
    );
  }

  if (entry.notes !== undefined && typeof entry.notes !== "string") {
    violations.push(
      violation(MAP_RULES.map, "invalid-field", `${quote(name)} has a non-string notes`, { file }),
    );
  }

  const since = parseSemver(entry.since);

  if (typeof entry.since === "string" && since === null) {
    violations.push(
      violation(
        MAP_RULES.map,
        "invalid-since",
        `${quote(name)} has a non-semver since ${quote(entry.since)}`,
        { file },
      ),
    );
  }

  const pending = isPending(entry);

  if (pending && entry.proposal === undefined) {
    violations.push(
      violation(
        MAP_RULES.map,
        "pending-without-proposal",
        `${quote(name)} is pending but declares no proposal id`,
        { file },
      ),
    );
  }

  if (
    typeof entry.wire === "string" &&
    entry.wire !== "" &&
    !pending &&
    !context.wireSet.has(entry.wire)
  ) {
    violations.push(
      violation(
        MAP_RULES.map,
        "unknown-wire",
        `${quote(name)} declares wire ${quote(entry.wire)} which is not a command in the pinned snapshot`,
        { file },
      ),
    );
  }

  if (since !== null && !pending) {
    const engine = parseSemver(context.engineVersion);

    if (engine !== null && compareSemver(since, engine) > 0) {
      violations.push(
        violation(
          MAP_RULES.map,
          "since-ahead",
          `${quote(name)} declares since ${quote(entry.since)} newer than the pinned engine ${quote(
            context.engineVersion,
          )} without pending`,
          { file },
        ),
      );
    }
  }

  if (entry.fallback !== undefined) {
    if (typeof entry.fallback !== "string" || !context.names.has(entry.fallback)) {
      violations.push(
        violation(
          MAP_RULES.map,
          "dangling-fallback",
          `${quote(name)} has fallback ${quote(String(entry.fallback))} which is not a declared capability`,
          { file },
        ),
      );
    }
  }
}

/**
 * Coverage closure: `detail: true` wires == field-level snapshot commands.
 *
 * @param {Record<string, unknown>[]} entries
 * @param {Record<string, unknown>[]} commands
 * @param {Violation[]} violations
 */
function checkCoverage(entries, commands, violations) {
  /** @type {Map<string, string>} wire -> first capability name that registers it */
  const detailWires = new Map();

  for (const entry of entries) {
    if (entry.detail === true && typeof entry.wire === "string" && entry.wire !== "") {
      if (!detailWires.has(entry.wire)) {
        detailWires.set(entry.wire, typeof entry.name === "string" ? entry.name : entry.wire);
      }
    }
  }

  const fieldLevelWires = commands
    .filter((command) => command.fieldLevel === true && typeof command.wire === "string")
    .map((command) => String(command.wire));

  for (const [wire, name] of detailWires) {
    if (!fieldLevelWires.includes(wire)) {
      violations.push(
        violation(
          MAP_RULES.cover,
          "detail-without-fields",
          `detail capability ${quote(name)} registers wire ${quote(wire)} but that snapshot command is not field-level`,
        ),
      );
    }
  }

  for (const wire of fieldLevelWires) {
    if (!detailWires.has(wire)) {
      violations.push(
        violation(
          MAP_RULES.cover,
          "fields-without-detail",
          `snapshot command ${quote(wire)} is field-level but no detail capability registers it`,
        ),
      );
    }
  }
}

/**
 * Health: degraded is red, coarse is a warning only.
 *
 * @param {Record<string, unknown>} health
 * @param {Violation[]} violations
 */
function checkHealth(health, violations) {
  if (health.degraded === true) {
    violations.push(
      violation(
        MAP_RULES.health,
        "degraded-snapshot",
        "snapshot health is degraded; regenerate it against the pinned engine before mapping",
        { file: SNAPSHOT_FILE },
      ),
    );
  }

  const coarse = Array.isArray(health.coarse) ? health.coarse : [];

  if (coarse.length > 0) {
    violations.push(
      violation(
        MAP_RULES.health,
        "coarse-fields",
        `snapshot has ${coarse.length} coarse entries (name-level only): ${coarse.slice(0, 3).join(" | ")}`,
        { file: SNAPSHOT_FILE, severity: "warning" },
      ),
    );
  }
}

/**
 * 1-based line of each capability entry's `"name"` key, or null when the text
 * and the parsed table disagree (a caller passed no text, or the file is
 * minified/annotated in a way this scanner cannot follow).
 *
 * The scanner is intentionally narrow: `capabilities.json` is a generated-by-
 * hand file whose entries all carry exactly one `"name"` key, so counting those
 * keys in order maps entry index to source line without a JSON parser.
 *
 * @param {string | null | undefined} text capabilities.json text
 * @param {number} count parsed entry count
 * @returns {number[] | null}
 */
function capabilityEntryLines(text, count) {
  if (typeof text !== "string" || count <= 0) {
    return null;
  }

  const lines = [];
  const pattern = /"name"\s*:/g;
  let match = pattern.exec(text);

  while (match !== null) {
    lines.push(text.slice(0, match.index).split("\n").length);
    match = pattern.exec(text);
  }

  return lines.length === count ? lines : null;
}

/**
 * Report one capability that re-uses a `wire` already claimed by an earlier
 * entry (07 section 4.1.5: one capability per wire, so `CAPABILITY_TO_WIRE`
 * stays injective).
 *
 * @param {Record<string, unknown>[]} entries
 * @param {string | null | undefined} capabilitiesText
 * @param {Violation[]} violations
 */
function checkDuplicateWires(entries, capabilitiesText, violations) {
  const lines = capabilityEntryLines(capabilitiesText, entries.length);
  /** @type {Map<string, {name: string, index: number}>} */
  const firstByWire = new Map();

  entries.forEach((entry, index) => {
    if (typeof entry.wire !== "string" || entry.wire === "") {
      return;
    }

    const first = firstByWire.get(entry.wire);

    if (first === undefined) {
      firstByWire.set(entry.wire, {
        name: typeof entry.name === "string" ? entry.name : entry.wire,
        index,
      });

      return;
    }

    const currentName = typeof entry.name === "string" ? entry.name : entry.wire;

    // A repeated name is the same capability declared twice, which
    // `duplicate-name` already reports; the injective-wire rule only speaks
    // about two *different* capabilities sharing one wire.
    if (currentName === first.name) {
      return;
    }

    const record = violation(
      MAP_RULES.map,
      "duplicate-wire",
      `wire ${quote(entry.wire)} is registered by both ${quote(first.name)} (entry ${first.index})` +
        ` and ${quote(currentName)} (entry ${index}); one capability may back only one wire`,
    );
    const line = lines === null ? undefined : lines[index];

    if (line !== undefined) {
      record.line = line;
    }

    violations.push(record);
  });
}

/**
 * Map the three `execute_command` parity invariants (P5-8, F5a's
 * `checkParityConsistency`) to gate violations.
 *
 * `contract-cover` carries the three real disagreements; `contract-health`
 * carries the empty-input case, because a vanished extraction must never read
 * as a clean parity surface (P5-9).
 *
 * @param {{
 *   ok: boolean,
 *   vacuous: boolean,
 *   advertisedWithoutHandler: string[],
 *   unadvertisedCaseWithoutAlias: string[],
 *   aliasWithoutCase: string[],
 * }} consistency result of `checkParityConsistency(snapshot.special.remoteCommands)`
 * @returns {Violation[]}
 */
export function checkParityViolations(consistency) {
  /** @type {Violation[]} */
  const violations = [];
  const advertisedWithoutHandler = Array.isArray(consistency.advertisedWithoutHandler)
    ? consistency.advertisedWithoutHandler
    : [];
  const unadvertisedCaseWithoutAlias = Array.isArray(consistency.unadvertisedCaseWithoutAlias)
    ? consistency.unadvertisedCaseWithoutAlias
    : [];
  const aliasWithoutCase = Array.isArray(consistency.aliasWithoutCase)
    ? consistency.aliasWithoutCase
    : [];

  for (const id of advertisedWithoutHandler) {
    violations.push(
      violation(
        MAP_RULES.cover,
        "advertised-without-handler",
        `advertised id ${quote(String(id))} has neither a dispatch case nor a handledElsewhere entry`,
        { file: SNAPSHOT_FILE },
      ),
    );
  }

  for (const id of unadvertisedCaseWithoutAlias) {
    violations.push(
      violation(
        MAP_RULES.cover,
        "unadvertised-case-without-alias",
        `dispatch case ${quote(String(id))} is not advertised and has no unadvertisedAliases entry`,
        { file: SNAPSHOT_FILE },
      ),
    );
  }

  for (const id of aliasWithoutCase) {
    violations.push(
      violation(
        MAP_RULES.cover,
        "alias-without-case",
        `unadvertised alias ${quote(String(id))} has no dispatch case`,
        { file: SNAPSHOT_FILE },
      ),
    );
  }

  if (consistency.vacuous === true) {
    violations.push(
      violation(
        MAP_RULES.health,
        "empty-parity",
        "empty parity input, untrustworthy: snapshot.special.remoteCommands has neither advertised ids nor dispatch cases",
        { file: SNAPSHOT_FILE },
      ),
    );
  }

  return violations;
}

/**
 * Run every capability-table check and return the sorted violations.
 *
 * `generatedNames` is optional: when the caller passes the names read back from
 * the committed artifact, the missing / orphan checks become meaningful. A plain
 * generation call passes nothing, because there is no artifact to compare with.
 *
 * `capabilitiesText` is optional and only supplies line numbers for the
 * `duplicate-wire` violation; the judgement never depends on it.
 *
 * @param {{
 *   snapshot: unknown,
 *   capabilities: unknown,
 *   generatedNames?: string[] | null,
 *   capabilitiesText?: string | null,
 * }} input
 * @returns {Violation[]}
 */
export function collectViolations({
  snapshot,
  capabilities,
  generatedNames = null,
  capabilitiesText = null,
}) {
  const requiredSnapshot = requireSnapshot(snapshot);
  const entries = requireCapabilities(capabilities);

  /** @type {Violation[]} */
  const violations = [];
  const engineVersion = requiredSnapshot.engine.version;
  const wireSet = new Set(
    requiredSnapshot.commands
      .filter((command) => typeof command.wire === "string")
      .map((command) => String(command.wire)),
  );
  const names = new Set(
    entries.filter((entry) => typeof entry.name === "string").map((entry) => String(entry.name)),
  );

  /** @type {Map<string, number>} */
  const firstIndexByName = new Map();

  entries.forEach((entry, index) => {
    if (typeof entry.name === "string") {
      const firstIndex = firstIndexByName.get(entry.name);

      if (firstIndex === undefined) {
        firstIndexByName.set(entry.name, index);
      } else {
        violations.push(
          violation(
            MAP_RULES.map,
            "duplicate-name",
            `${quote(entry.name)} is declared more than once (first at index ${firstIndex}, again at index ${index})`,
          ),
        );
      }
    }

    checkCapabilityEntry(entry, index, { names, wireSet, engineVersion }, violations);
  });

  if (generatedNames !== null && generatedNames !== undefined) {
    const declared = new Set(generatedNames.map((value) => String(value)));

    for (const name of names) {
      if (!declared.has(name)) {
        violations.push(
          violation(
            MAP_RULES.map,
            "missing-capability",
            `${quote(name)} is declared in capabilities.json but absent from the generated map`,
            { file: MAP_FILE },
          ),
        );
      }
    }

    for (const name of declared) {
      if (!names.has(name)) {
        violations.push(
          violation(
            MAP_RULES.map,
            "orphan-capability",
            `${quote(name)} appears in the generated map but is not declared in capabilities.json`,
            { file: MAP_FILE },
          ),
        );
      }
    }
  }

  checkCoverage(entries, requiredSnapshot.commands, violations);
  checkDuplicateWires(entries, capabilitiesText, violations);
  checkHealth(requiredSnapshot.health, violations);

  return sortViolations(violations);
}
