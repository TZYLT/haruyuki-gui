/**
 * heritage.mjs - fold interface `extends` chains into the type index entries.
 *
 * A syntax-only index sees `interface StreamDeltaMessage extends RuntimeEnvelope`
 * as two independent declarations. Reading only the own members reported 3 fields
 * for a message that has 7 on the wire, and a base-class edit was invisible to the
 * fingerprint. This module runs once, after every file is parsed, and rewrites
 * each interface entry:
 *
 *   - `fields`: base members first, own members win on a name collision (between
 *     two bases the first `extends` operand wins);
 *   - `bodyText`: the fingerprint input becomes
 *     `extends Base { <base bodyText> } { <own body> }`, recursively, so adding a
 *     field to a base changes every descendant fingerprint;
 *   - `heritageProblems`: one single-line English reason per base that could not
 *     be merged.
 *
 * Failure policy (never silent):
 *   - an unresolvable base, an ambiguous base or a non-interface (type alias)
 *     base cannot be flattened by a syntax-only index, so it is reported as a
 *     `coarse` line. An external SDK base is the common case.
 *   - a cycle can hide an unknown number of fields, so it is reported as
 *     `unparsed` and marks the section `degraded`.
 *
 * The caller decides where those lines go (the type index health, and then the
 * snapshot record that is actually emitted).
 */

import { compareStrings } from "./json.mjs";

/** Heritage (`extends`) problem codes, reported through `health`. */
export const HERITAGE_CODES = Object.freeze({
  UNRESOLVED: "heritage-unresolved",
  NOT_AN_INTERFACE: "heritage-not-an-interface",
  CYCLE: "heritage-cycle",
});

/**
 * Collapse all whitespace runs to one space and trim.
 *
 * @param {string} value
 * @returns {string}
 */
function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Merge inherited fields with the declaring interface's own fields.
 *
 * @param {object[]} inherited base fields, in `extends` order
 * @param {object[]} own child fields
 * @returns {object[]} one entry per name, first slot preserved
 */
function mergeFields(inherited, own) {
  /** @type {Map<string, object>} */
  const byName = new Map();

  for (const field of inherited) {
    if (!byName.has(field.name)) {
      byName.set(field.name, field);
    }
  }

  for (const field of own) {
    byName.set(field.name, field);
  }

  return [...byName.values()];
}

/**
 * Fold every `extends` chain among `entries`, in place.
 *
 * @param {object[]} entries type index entries in declaration order
 * @param {(ref: string, fromFile: string) => object} resolveTypeRef index resolver
 * @returns {{degraded: boolean, coarse: string[], unparsed: string[]}}
 */
export function mergeHeritage(entries, resolveTypeRef) {
  /** @type {{degraded: boolean, coarse: string[], unparsed: string[]}} */
  const health = { degraded: false, coarse: [], unparsed: [] };
  /** @type {Map<string, {text: string, fields: object[]}>} */
  const memo = new Map();

  /**
   * @param {object} entry
   * @returns {string}
   */
  function entryKey(entry) {
    return `${entry.file}:${entry.line}:${entry.qualifiedName}`;
  }

  /**
   * @param {object} entry referring entry
   * @param {string} code
   * @param {string} reason
   */
  function recordProblem(entry, code, reason) {
    const line = `${entry.name}@${entry.file}:${entry.line}: ${code}: ${reason}`;

    entry.heritageProblems.push(line);

    if (code === HERITAGE_CODES.CYCLE) {
      health.degraded = true;
      health.unparsed.push(line);
    } else {
      health.coarse.push(line);
    }
  }

  /**
   * Merge one interface's heritage. `trail` is the current `extends` chain; a key
   * already on it means the base graph is cyclic.
   *
   * @param {object} entry interface entry
   * @param {Set<string>} trail keys of the ancestors currently being merged
   * @returns {{text: string, fields: object[]}}
   */
  function mergeOne(entry, trail) {
    const key = entryKey(entry);
    const memoized = memo.get(key);

    if (memoized) {
      return memoized;
    }

    if (trail.has(key)) {
      recordProblem(entry, HERITAGE_CODES.CYCLE, `extends chain loops back to ${entry.name}`);

      return { text: "", fields: [] };
    }

    trail.add(key);

    const inherited = [];
    const parts = [];

    for (const ref of entry.heritageRefs) {
      const resolved = resolveTypeRef(ref, entry.file);

      if (!resolved.ok) {
        recordProblem(
          entry,
          HERITAGE_CODES.UNRESOLVED,
          `${ref} (${resolved.code}: ${resolved.message})`,
        );
        parts.push(`extends ${collapseWhitespace(ref)}`);
        continue;
      }

      const base = resolved.entry;

      if (base.kind !== "interface") {
        recordProblem(
          entry,
          HERITAGE_CODES.NOT_AN_INTERFACE,
          `${ref} is a ${base.kind} alias, not an interface`,
        );
        parts.push(`extends ${collapseWhitespace(ref)}`);
        continue;
      }

      const baseMerged = mergeOne(base, trail);

      inherited.push(...baseMerged.fields);
      parts.push(`extends ${collapseWhitespace(ref)} { ${baseMerged.text} }`);
    }

    trail.delete(key);

    const fields =
      inherited.length === 0 ? entry.ownFields : mergeFields(inherited, entry.ownFields);
    const text = parts.length === 0 ? entry.ownBodyText : `${parts.join(" ")} ${entry.ownBodyText}`;

    entry.fields = fields;
    entry.bodyText = text;

    const result = { text, fields };

    memo.set(key, result);

    return result;
  }

  for (const entry of entries) {
    if (entry.kind !== "interface" || entry.heritageRefs.length === 0) {
      continue;
    }

    mergeOne(entry, new Set());
  }

  health.coarse.sort(compareStrings);
  health.unparsed.sort(compareStrings);

  return health;
}
