/**
 * canonical.mjs - the canonical ordering pass for `snapshot.json` v1.
 *
 * Canonicalization is ordering only. It never drops or invents data:
 *
 *   - unknown keys are kept and appended in lexicographic order, so the
 *     validator can report them instead of the writer silently trusting them;
 *   - an array element that is not a record - a number where a command belongs -
 *     is kept (records with a string wire sort first, everything else follows in
 *     input order), so the validator reports `invalid-type` instead of the
 *     element disappearing;
 *   - a value whose type does not match the schema is passed through untouched,
 *     because only `validateSnapshot` decides what is legal.
 *
 * That guarantee matters because `buildSnapshot` canonicalizes before it
 * validates: dropping an illegal element here would turn `commands: [42]` into
 * `commands: []` and a "valid" snapshot.
 *
 * Sorting is code-unit order (`<` / `>`), not locale collation, so the bytes do
 * not depend on the host locale.
 */

import { compareStrings, isPlainObject, orderKeys, sortStrings, stringOrEmpty } from "./json.mjs";

/**
 * Canonicalize a snapshot against the frozen key order.
 *
 * @param {unknown} snapshot
 * @param {object} keyOrder frozen key order (see `SNAPSHOT_KEY_ORDER`)
 * @returns {Record<string, unknown>}
 */
export function canonicalizeSnapshot(snapshot, keyOrder) {
  const source = isPlainObject(snapshot) ? snapshot : {};
  const canonical = orderKeys(source, keyOrder.root);

  for (const [key, order] of [
    ["engine", keyOrder.engine],
    ["counts", keyOrder.counts],
  ]) {
    if (Object.hasOwn(canonical, key) && isPlainObject(canonical[key])) {
      canonical[key] = orderKeys(canonical[key], order);
    }
  }

  if (Object.hasOwn(canonical, "commands")) {
    canonical.commands = canonicalRecords(canonical.commands, keyOrder.command, keyOrder.field);
  }

  if (Object.hasOwn(canonical, "messages")) {
    canonical.messages = canonicalRecords(canonical.messages, keyOrder.message, keyOrder.field);
  }

  if (Object.hasOwn(canonical, "special")) {
    canonical.special = canonicalSpecial(canonical.special, keyOrder);
  }

  if (Object.hasOwn(canonical, "health")) {
    canonical.health = canonicalHealth(canonical.health, keyOrder.health);
  }

  return canonical;
}

/**
 * Canonicalize one record array: order the keys of each object record, sort the
 * records that carry a string wire, and append anything else in input order.
 *
 * @param {unknown} records
 * @param {readonly string[]} recordOrder
 * @param {readonly string[]} fieldOrder
 * @returns {unknown}
 */
function canonicalRecords(records, recordOrder, fieldOrder) {
  if (!Array.isArray(records)) {
    return records;
  }

  /** @type {Record<string, unknown>[]} */
  const sortable = [];
  /** @type {unknown[]} */
  const unsortable = [];

  for (const record of records) {
    if (!isPlainObject(record) || typeof record.wire !== "string") {
      unsortable.push(record);

      continue;
    }

    const ordered = orderKeys(record, recordOrder);

    if (Object.hasOwn(ordered, "direction")) {
      ordered.direction = sortStrings(ordered.direction);
    }

    if (Object.hasOwn(ordered, "fields")) {
      ordered.fields = canonicalFields(ordered.fields, fieldOrder);
    }

    sortable.push(ordered);
  }

  sortable.sort((left, right) => {
    const byWire = compareStrings(stringOrEmpty(left.wire), stringOrEmpty(right.wire));

    return byWire === 0
      ? compareStrings(stringOrEmpty(left.type), stringOrEmpty(right.type))
      : byWire;
  });

  return [...sortable, ...unsortable];
}

/**
 * Canonicalize one field array: order each field's keys, sort by name, and append
 * a non-object element in input order so the validator still rejects it.
 *
 * @param {unknown} fields
 * @param {readonly string[]} fieldOrder frozen `field` key order
 * @returns {unknown}
 */
function canonicalFields(fields, fieldOrder) {
  if (!Array.isArray(fields)) {
    return fields;
  }

  /** @type {Record<string, unknown>[]} */
  const objects = [];
  /** @type {unknown[]} */
  const others = [];

  for (const field of fields) {
    if (isPlainObject(field)) {
      objects.push(orderKeys(field, fieldOrder));
    } else {
      others.push(field);
    }
  }

  objects.sort((left, right) =>
    compareStrings(stringOrEmpty(left.name), stringOrEmpty(right.name)),
  );

  return [...objects, ...others];
}

/**
 * Canonicalize `special`: order the known sub-objects and their arrays, keep
 * unknown keys and wrong-typed values for the validator.
 *
 * @param {unknown} special
 * @param {object} keyOrder frozen key order
 * @returns {unknown}
 */
function canonicalSpecial(special, keyOrder) {
  if (!isPlainObject(special)) {
    return special;
  }

  const ordered = orderKeys(special, keyOrder.special);

  if (isPlainObject(ordered.fileOps)) {
    const fileOps = orderKeys(ordered.fileOps, keyOrder.fileOps);

    fileOps.directions = sortStrings(fileOps.directions);
    ordered.fileOps = fileOps;
  }

  if (isPlainObject(ordered.remoteCommands)) {
    const remote = orderKeys(ordered.remoteCommands, keyOrder.remoteCommands);

    remote.advertised = sortStrings(remote.advertised);
    remote.handledElsewhere = isPlainObject(remote.handledElsewhere)
      ? orderKeys(remote.handledElsewhere, [])
      : remote.handledElsewhere;
    remote.unadvertisedAliases = isPlainObject(remote.unadvertisedAliases)
      ? orderKeys(remote.unadvertisedAliases, [])
      : remote.unadvertisedAliases;
    remote.dispatchCases = sortStrings(remote.dispatchCases);
    ordered.remoteCommands = remote;
  }

  if (isPlainObject(ordered.startupText)) {
    const startup = orderKeys(ordered.startupText, keyOrder.startupText);

    startup.required = sortStrings(startup.required);
    startup.optional = sortStrings(startup.optional);
    ordered.startupText = startup;
  }

  return ordered;
}

/**
 * Canonicalize `health`. A wrong-typed list stays wrong-typed (the validator
 * reports it) instead of being replaced by an empty array.
 *
 * @param {unknown} health
 * @param {readonly string[]} order
 * @returns {unknown}
 */
function canonicalHealth(health, order) {
  if (!isPlainObject(health)) {
    return health;
  }

  const ordered = orderKeys(health, order);

  ordered.coarse = sortStrings(ordered.coarse);
  ordered.unparsed = sortStrings(ordered.unparsed);

  return ordered;
}
