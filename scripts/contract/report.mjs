/**
 * report.mjs - render a contract snapshot diff as the frozen seven-section report.
 *
 * The format is fixed by requirements doc 07 section 6.5 and route doc 08
 * section 3.4b: a header block (title, engine line, counts line, summary line)
 * followed by seven sections in a fixed order. Empty sections still print a
 * single `(none)` line so a script can assert the report shape without parsing
 * prose. Every line is plain ASCII and holds exactly one entry; the report is
 * meant to be read by a human and grepped by a gate.
 *
 * Section order
 *   1 added          2 removed        3 suspected renames   4 field changes
 *   5 parity         6 capability impact                   7 action required
 *
 * The order follows route doc 08 section 4.2 and the assigned work package:
 * added before removed. Requirements doc 07 section 6.5 was aligned to the same
 * order (decision D-18), so section 1 is added and section 2 is removed.
 *
 * Rendering is pure: `renderReport(result)` takes the object produced by
 * `scripts/contract/diff.mjs`, returns a string array and never reads files.
 * Ordering of entries is owned by the diff, so rendering the same result twice
 * yields identical bytes and no locale, clock or hash order can leak in.
 *
 * Suspected renames are deliberately worded as a suspicion: a matching
 * `shapeFingerprint` proves only that two declarations have the same body text,
 * never that one wire was renamed into the other. Section 3 must not read as a
 * conclusion.
 */

/** Section headings, in the frozen order. Index 0 is section 1. */
export const SECTION_TITLES = Object.freeze([
  "[1] ADDED (additive)",
  "[2] REMOVED (breaking candidates)",
  "[3] SUSPECTED RENAMES (shape fingerprint equal, name differs)",
  "[4] FIELD CHANGES (detail set only)",
  "[5] PARITY (dispatch / advertised / aliases / startup text)",
  "[6] CAPABILITY IMPACT (which CapabilityName is affected, and how)",
  "[7] ACTION REQUIRED",
]);

/** Printed for every empty section so the seven-section shape never varies. */
export const EMPTY_SECTION = "(none)";

/** Report title, the first line of every report. */
export const REPORT_TITLE = "CONTRACT SNAPSHOT DIFF";

/**
 * Render a diff result object as report lines.
 *
 * The result shape is owned by the diff (see diff.mjs): every change list is
 * already sorted and every record already reduced to its report fields, so this
 * function only formats. It never mutates `result`.
 *
 * @param {{
 *   a: {engine: {version: string, commit: string}, counts: Record<string, number>},
 *   b: {engine: {version: string, commit: string}, counts: Record<string, number>},
 *   added: {commands: Record<string, unknown>[], messages: Record<string, unknown>[]},
 *   removed: {commands: Record<string, unknown>[], messages: Record<string, unknown>[]},
 *   suspectedRenames: Record<string, unknown>[],
 *   fieldChanges: Record<string, unknown>[],
 *   parityChanges: Record<string, unknown>[],
 *   capabilityImpacts: Record<string, unknown>[],
 *   actions: {target: string, text: string}[],
 *   summary: Record<string, number>,
 * }} result
 * @returns {string[]} report lines without a trailing newline
 */
export function renderReport(result) {
  if (result === null || typeof result !== "object") {
    throw new TypeError("renderReport expects the diff result object");
  }

  const lines = [
    REPORT_TITLE,
    `engine: ${engineLine(result.a)} -> ${engineLine(result.b)}`,
    `counts: ${countsLine(result)}`,
    `summary: ${summaryLine(result.summary)}`,
  ];

  appendSection(lines, SECTION_TITLES[0], addedLines(result.added));
  appendSection(lines, SECTION_TITLES[1], removedLines(result.removed));
  appendSection(lines, SECTION_TITLES[2], renameLines(result.suspectedRenames));
  appendSection(lines, SECTION_TITLES[3], fieldChangeLines(result.fieldChanges));
  appendSection(lines, SECTION_TITLES[4], parityLines(result.parityChanges));
  appendSection(lines, SECTION_TITLES[5], capabilityLines(result.capabilityImpacts));
  appendSection(lines, SECTION_TITLES[6], actionLines(result.actions));

  return lines;
}

/**
 * Push one section behind its blank line, or `(none)` when it has no entries.
 *
 * @param {string[]} lines accumulator
 * @param {string} title section heading
 * @param {string[]} entries already formatted entry lines
 */
function appendSection(lines, title, entries) {
  lines.push("");
  lines.push(title);

  if (entries.length === 0) {
    lines.push(EMPTY_SECTION);

    return;
  }

  lines.push(...entries);
}

/**
 * `version @ commit`, or `unknown` for a missing field.
 *
 * @param {{engine?: {version?: unknown, commit?: unknown}} | undefined} side
 * @returns {string}
 */
function engineLine(side) {
  const engine = side && typeof side === "object" ? side.engine : undefined;
  const version = engine && typeof engine === "object" ? engine.version : undefined;
  const commit = engine && typeof engine === "object" ? engine.commit : undefined;

  return `${text(version)} @ ${text(commit)}`;
}

/**
 * The four counts a reader needs to see move. Message count is included because
 * messages are half of the wire surface even though doc 07 section 6.5 only
 * shows three columns.
 *
 * @param {{a?: {counts?: unknown}, b?: {counts?: unknown}}} result
 * @returns {string}
 */
function countsLine(result) {
  const left = countsOf(result.a);
  const right = countsOf(result.b);

  return [
    `commands ${left.commands} -> ${right.commands}`,
    `messages ${left.messages} -> ${right.messages}`,
    `inbound ${left.inbound} -> ${right.inbound}`,
    `advertised ${left.advertised} -> ${right.advertised}`,
  ].join(" | ");
}

/**
 * Read the four displayed counts with 0 fallbacks so a minimal snapshot object
 * can still be rendered in a test.
 *
 * @param {unknown} side
 * @returns {{commands: number, messages: number, inbound: number, advertised: number}}
 */
function countsOf(side) {
  const counts = side && typeof side === "object" ? side.counts : undefined;
  const value = (key) => {
    const raw = counts && typeof counts === "object" ? counts[key] : undefined;

    return Number.isInteger(raw) ? raw : 0;
  };

  return {
    commands: value("commands"),
    messages: value("messages"),
    inbound: value("inbound"),
    advertised: value("advertised"),
  };
}

/** Render `<count> <singular>`, adding a plural suffix when needed. */
function plural(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** One-line summary: per-section counts plus the total. */
function summaryLine(summary) {
  const counts = summary && typeof summary === "object" ? summary : {};
  const value = (key) => (Number.isInteger(counts[key]) ? counts[key] : 0);

  return [
    `${value("added")} added`,
    `${value("removed")} removed`,
    plural(value("suspectedRenames"), "suspected rename"),
    plural(value("fieldChanges"), "field change"),
    plural(value("parityChanges"), "parity change"),
    plural(value("capabilityImpacts"), "capability impact"),
    plural(value("actions"), "action"),
    `(total ${value("total")})`,
  ].join(", ");
}

/**
 * Format the added records, commands before messages.
 *
 * @param {{commands?: unknown, messages?: unknown} | undefined} added
 * @returns {string[]}
 */
function addedLines(added) {
  return recordLines(added);
}

/**
 * Format the removed records, commands before messages.
 *
 * @param {{commands?: unknown, messages?: unknown} | undefined} removed
 * @returns {string[]}
 */
function removedLines(removed) {
  return recordLines(removed);
}

/**
 * @param {{commands?: unknown, messages?: unknown} | undefined} side
 * @returns {string[]}
 */
function recordLines(side) {
  const bucket = side && typeof side === "object" ? side : {};
  const lines = [];

  for (const record of arrayOf(bucket.commands)) {
    lines.push(recordLine("command", record));
  }

  for (const record of arrayOf(bucket.messages)) {
    lines.push(recordLine("message", record));
  }

  return lines;
}

/**
 * One added/removed record, e.g.
 * `command agent_list type=AgentListCommand home=src/types/protocol_v2.ts:1608`.
 *
 * @param {string} kind `command` or `message`
 * @param {unknown} record
 * @returns {string}
 */
function recordLine(kind, record) {
  const entry = record && typeof record === "object" ? record : {};

  return `${kind} ${text(entry.wire)} type=${text(entry.type)} home=${text(entry.home)}`;
}

/**
 * Format suspected rename pairs. The wording keeps the inference explicit:
 * `suspected rename`, fingerprint match only, not a confirmed rename.
 *
 * @param {unknown} renames
 * @returns {string[]}
 */
function renameLines(renames) {
  return arrayOf(renames).map((rename) => {
    const entry = rename && typeof rename === "object" ? rename : {};
    const from = entry.from && typeof entry.from === "object" ? entry.from : {};
    const to = entry.to && typeof entry.to === "object" ? entry.to : {};
    const kind = text(entry.kind);

    return (
      `${kind} ${text(from.wire)} -> ${text(to.wire)} shape=${text(entry.shapeFingerprint)} ` +
      "suspected rename (fingerprint match only, not a confirmed rename)"
    );
  });
}

/**
 * Format field changes, one line per classified change.
 *
 * @param {unknown} changes
 * @returns {string[]}
 */
function fieldChangeLines(changes) {
  return arrayOf(changes).map((change) => {
    const entry = change && typeof change === "object" ? change : {};
    const prefix = `${text(entry.kind)} ${text(entry.wire)}`;

    switch (entry.change) {
      case "added":
        return (
          `${prefix} field ${text(entry.field)} added type=${text(entry.type)} ` +
          `optional=${flag(entry.optional)}`
        );
      case "removed":
        return (
          `${prefix} field ${text(entry.field)} removed type=${text(entry.type)} ` +
          `optional=${flag(entry.optional)}`
        );
      case "type-changed":
        return (
          `${prefix} field ${text(entry.field)} type-changed ` +
          `from=${text(entry.fromType)} to=${text(entry.toType)}`
        );
      case "optionality-changed":
        return (
          `${prefix} field ${text(entry.field)} optionality-changed ` +
          `from=${flag(entry.fromOptional)} to=${flag(entry.toOptional)}`
        );
      case "field-text-changed":
        return (
          `${prefix} field-text-changed from=${text(entry.fromFingerprint)} ` +
          `to=${text(entry.toFingerprint)} (no per-field difference is visible)`
        );
      default:
        return (
          `${prefix} field ${text(entry.field)} ${text(entry.change)} ` +
          `from=${text(entry.fromType)} to=${text(entry.toType)}`
        );
    }
  });
}

/**
 * Format parity changes. `changed` entries carry from/to, added/removed entries
 * carry the affected key.
 *
 * @param {unknown} changes
 * @returns {string[]}
 */
function parityLines(changes) {
  return arrayOf(changes).map((change) => {
    const entry = change && typeof change === "object" ? change : {};
    const area = text(entry.area);

    if (entry.change === "changed") {
      return `${area} changed from=${text(entry.from)} to=${text(entry.to)}`;
    }

    if (typeof entry.key === "string" && entry.key.length > 0) {
      return `${area} ${text(entry.change)} ${entry.key}`;
    }

    return `${area} ${text(entry.change)}`;
  });
}

/**
 * Format capability impact lines, marking detail registration and the three
 * status levels from doc 07 section 6.5.
 *
 * @param {unknown} impacts
 * @returns {string[]}
 */
function capabilityLines(impacts) {
  return arrayOf(impacts).map((impact) => {
    const entry = impact && typeof impact === "object" ? impact : {};
    const capability =
      typeof entry.capability === "string" && entry.capability.length > 0
        ? entry.capability
        : "(none)";
    const reasons = arrayOf(entry.reasons)
      .map((reason) => text(reason))
      .join(",");

    return (
      `wire ${text(entry.wire)} capability ${capability} detail=${flag(entry.detail)} ` +
      `status=${text(entry.status)} reasons=${reasons.length > 0 ? reasons : "unknown"}`
    );
  });
}

/**
 * Format action lines as `<target>: <text>`, keeping the three action targets
 * from doc 07 section 6.5 (`capabilities.json`, `B4`, `notice`).
 *
 * @param {unknown} actions
 * @returns {string[]}
 */
function actionLines(actions) {
  return arrayOf(actions).map((action) => {
    const entry = action && typeof action === "object" ? action : {};

    return `${text(entry.target)}: ${text(entry.text)}`;
  });
}

/**
 * Coerce a value for display without letting `undefined` or `null` print.
 *
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "unknown";
}

/**
 * Render a boolean as `yes` / `no`; anything else is unknown.
 *
 * @param {unknown} value
 * @returns {string}
 */
function flag(value) {
  if (value === true) {
    return "yes";
  }

  if (value === false) {
    return "no";
  }

  return "unknown";
}

/**
 * Defensive array read: a hand-built result object in a test may omit a list.
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}
