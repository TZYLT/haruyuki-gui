/**
 * diff-parity.mjs - the parity surface of the snapshot diff.
 *
 * Split out of `diff.mjs` without changing a byte of output: the `special`
 * block comparison (fileOps, remoteCommands, startupText) and the two pure
 * list/map helpers were moved verbatim so the seven-section report keeps
 * rendering exactly as before. The freed room carries two extra comparisons:
 *
 *   - the per-record `inbound` flag of every command present on both sides, so
 *     a wire that stays in the union but leaves the `parseServerMessage` OR
 *     chain is visible (`inbound.accepted` lost/gained). Before this, a counts
 *     drift of `inbound` was printed in the header and then lost: no section
 *     owned it, so `summary.total` stayed 0 and `check --engine` exited 0.
 *   - the four counts the report header prints, plus `inboundOnly`, as
 *     `counts.<attribute> changed from=<n> to=<n>`. Contract drift is not a
 *     detail: these entries land in section 5, reach `summary.parityChanges`
 *     and therefore reach `summary.total`, which is the value `check --engine`
 *     gates on. The independent `diff` CLI keeps its report-mode exit code.
 *
 * The seven-section layout from requirements doc 07 section 6.5 is frozen and
 * owned by `report.mjs`, so both comparisons are merged into section 5
 * (PARITY) instead of adding sections. Duplication with sections 1/2 is
 * intentional: a count that moved while every record stayed put is exactly the
 * drift the report must not hide.
 */

/** Normalize the `special` block for comparison. */
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

/** Compare the parity surface: the four `remoteCommands` sub-keys, the two `startupText` lists and `fileOps`. */
export function diffParity(a, b, leftCounts = {}, rightCounts = {}) {
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
  diffInboundFlags(asArray(a.commands), asArray(b.commands), changes);
  diffCountFacts(leftCounts, rightCounts, changes);
  changes.sort(
    (first, second) =>
      compareText(first.area, second.area) ||
      compareText(first.change, second.change) ||
      compareText(first.key, second.key),
  );
  return { changes, fileOpsWire: rightWire.length > 0 ? rightWire : leftWire };
}

/**
 * Compare the `inbound` flag of every command wire present on both sides.
 *
 * `lost` = the wire is still in the union but no longer in the
 * `parseServerMessage` accepted set (P5-1). `gained` is the reverse. Wires that
 * exist on one side only are left to sections 1 and 2, so no entry is reported
 * twice.
 */
function diffInboundFlags(leftCommands, rightCommands, changes) {
  const left = indexInbound(leftCommands);
  const right = indexInbound(rightCommands);
  for (const wire of [...left.keys()].sort(compareText)) {
    if (!right.has(wire)) continue;
    const before = left.get(wire) === true;
    const after = right.get(wire) === true;
    if (before === after) continue;
    changes.push({ area: "inbound.accepted", change: after ? "gained" : "lost", key: wire });
  }
}

/** Index `wire -> inbound === true`, keeping only string wires. */
function indexInbound(commands) {
  const index = new Map();
  for (const record of commands) {
    if (!isPlainObject(record) || typeof record.wire !== "string") continue;
    if (index.has(record.wire)) continue;
    index.set(record.wire, record.inbound === true);
  }
  return index;
}

/**
 * Compare the count attributes the report prints, plus `inboundOnly`.
 *
 * `inboundOnly` is the accepted-set-minus-union count: a positive value means
 * the inbound set holds a wire the union does not (a "wireOnly" difference in
 * the other direction). Numbers, not prose, so the report line stays stable.
 */
function diffCountFacts(leftCounts, rightCounts, changes) {
  const keys = ["commands", "messages", "inbound", "advertised", "inboundOnly"].sort(compareText);
  for (const key of keys) {
    const before = leftCounts[key];
    const after = rightCounts[key];
    if (before === after) continue;
    changes.push({ area: `counts.${key}`, change: "changed", from: before, to: after });
  }
}

/** Diff two string lists as `added` / `removed` parity entries. */
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

/** Diff two object maps by key only; values are engine prose, not wire data. */
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

/** Locale-free string comparison. */
function compareText(left, right) {
  const first = typeof left === "string" ? left : "";
  const second = typeof right === "string" ? right : "";
  if (first < second) return -1;
  return first > second ? 1 : 0;
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => typeof value === "string"))].sort(compareText);
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
