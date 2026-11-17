/**
 * Header-field reporting for the fixture corpus gate.
 *
 * The gate validates the fields it understands and says nothing about the rest,
 * which makes two failures identical from the outside: a field nobody added yet,
 * and a field somebody added with a typo. The first is fine, the second makes a
 * rule report the wrong thing -- a fixture whose `redaction` is spelled
 * `redaction_` fails with "redaction must be r1 or later", which is true and
 * points at the wrong place.
 *
 * So an unrecognised field is reported by name with its type and size, and a name
 * within two edits of a known one is a warning instead of a note. Nothing is
 * rejected: a whitelist would turn away the next legitimate extension.
 */

/**
 * Header keys the corpus format defines. Everything else is reported, never
 * rejected.
 *
 * "Known" means "not worth a note", not "this gate reads it": the gate itself
 * only reads `schemaVersion`, `kind`, `redaction` and `engine`. Filling this set
 * with what the gate reads would make every ordinary wire fixture report its
 * `scenario`, `clock` and `recordedAt`, and a note that fires on everything hides
 * the one field that really is new.
 *
 * The public list of fields is the table in `fixtures/README.md`; this set has to
 * agree with it, and nothing enforces that automatically, so change both.
 */
export const KNOWN_HEADER_KEYS = new Set([
  "kind",
  "schemaVersion",
  "engine",
  "scenario",
  "redaction",
  "clock",
  "recordedAt",
  // Bridge frames carry their own version and a free-text note; both are
  // documented in the corpus README, so neither is news to report.
  "bridgeVersion",
  "note",
]);

/** How far a key may drift from a known one before it stops looking like a typo. */
const NEAR_MISS_DISTANCE = 2;

/**
 * Report header fields the gate does not read.
 *
 * The value is described by type and length, not quoted: the point is to show
 * that something is there and whether it carries content, and an empty field is
 * more suspicious than an unknown one.
 *
 * @param {string} relative repo-relative fixture path
 * @param {Record<string, unknown>} header parsed header
 * @param {string[]} warnings collected diagnostics
 * @returns {void}
 */
export function checkHeaderFields(relative, header, warnings) {
  const unknown = Object.keys(header)
    .filter((key) => !KNOWN_HEADER_KEYS.has(key))
    .sort();

  if (unknown.length === 0) {
    return;
  }

  for (const key of unknown) {
    const near = [...KNOWN_HEADER_KEYS].find(
      (known) => editDistance(key.toLowerCase(), known.toLowerCase()) <= NEAR_MISS_DISTANCE,
    );

    if (near !== undefined) {
      warnings.push(
        `WARN ${relative}:1 header-field near "${near}": this gate does not read "${key}" ` +
          `(${describeValue(header[key])}) -- a near-miss is usually a typo, and the field it ` +
          `was meant to be is what the checks below read`,
      );

      return;
    }
  }

  const described = unknown.map((key) => `${key} (${describeValue(header[key])})`);

  warnings.push(
    `note ${relative}:1 header-field unknown: this gate does not read ${described.join(", ")}`,
  );
}

/**
 * Describe a value by type and size, so a diagnostic shows content without
 * echoing it.
 *
 * @param {unknown} value any header value
 * @returns {string}
 */
function describeValue(value) {
  if (typeof value === "string") return `string, ${String(value.length)} chars`;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return `array, ${String(value.length)} items`;
  if (typeof value === "object" && value !== null) {
    return `object, ${String(Object.keys(value).length)} keys`;
  }

  return String(value);
}

/**
 * Levenshtein distance, used only to tell a typo from a new name.
 *
 * @param {string} left first string
 * @param {string} right second string
 * @returns {number}
 */
function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }

    previous = current;
  }

  return previous[right.length];
}
