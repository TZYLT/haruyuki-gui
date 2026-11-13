/**
 * json.mjs - small JSON-shape primitives shared by the snapshot schema modules.
 *
 * These helpers are deliberately boring: `isPlainObject` has to agree between the
 * canonicalizer and the validator, and both sort with code-unit order so the
 * bytes never depend on the host locale. Keeping one copy here is what stops the
 * two modules from drifting apart again.
 */

/**
 * True for a plain object: any non-null, non-array object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Code-unit string comparison, so ordering never depends on the host locale.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Copy known keys in frozen order, then unknown keys lexicographically.
 *
 * Unknown keys are kept on purpose: the validator has to see them. A missing
 * known key is kept missing, so `missing-key` stays visible instead of turning
 * into an `undefined` own property.
 *
 * @param {unknown} value
 * @param {readonly string[]} order
 * @returns {Record<string, unknown>}
 */
export function orderKeys(value, order) {
  const source = isPlainObject(value) ? value : {};
  const ordered = {};

  for (const key of order) {
    if (Object.hasOwn(source, key)) {
      ordered[key] = source[key];
    }
  }

  const extras = Object.keys(source)
    .filter((key) => !order.includes(key))
    .sort(compareStrings);

  for (const key of extras) {
    ordered[key] = source[key];
  }

  return ordered;
}

/**
 * Sort an array of strings. Anything that is not an all-string array is returned
 * as a shallow copy, because dropping a non-string element would hide a schema
 * violation from the validator.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortStrings(value) {
  if (!Array.isArray(value)) {
    return value;
  }

  if (!value.every((item) => typeof item === "string")) {
    return [...value];
  }

  return [...value].sort(compareStrings);
}
