/**
 * parity-rules.mjs - the three `execute_command` parity invariants.
 *
 * The criteria are copied from the engine's own parity contract,
 * `src/websocket/listener/commands-dispatch-parity.test.ts`, so the extractor
 * watches the same agreement the engine already pins:
 *
 *   1. every advertised id is either a dispatch `case` or documented in
 *      `REMOTE_COMMANDS_HANDLED_ELSEWHERE`;
 *   2. every dispatch `case` that is not advertised is documented in
 *      `UNADVERTISED_REMOTE_COMMAND_ALIASES`;
 *   3. every alias key is still a dispatch `case`.
 *
 * The evaluator is side-effect free and never throws: it takes the four
 * extracted lists/records and returns the violation ids plus `vacuous` (P5-8).
 * Whether a non-empty list means exit 1 is the caller's decision (the gate makes
 * that call); recording the reason is this module's only job.
 *
 * Empty input is not a pass (P5-9). When both `advertised` and `dispatchCases`
 * are empty the three invariants are satisfied on nothing at all, so `ok` is
 * forced to false and `vacuous` is true; a caller cannot mistake a vanished
 * extraction for a clean parity surface. Repeated ids are deduplicated before
 * the filter, so a duplicated input entry is reported once, not once per copy.
 *
 * Reusable export (consumed by the contract gate through `map-checks`):
 *   checkParityConsistency({ advertised, handledElsewhere, unadvertisedAliases,
 *                            dispatchCases })
 *     -> { ok, vacuous, advertisedWithoutHandler,
 *          unadvertisedCaseWithoutAlias, aliasWithoutCase }
 * The four inputs are exactly `snapshot.special.remoteCommands`, and every
 * returned list is sorted, deduplicated and empty unless violated.
 *
 * Split out of `extract-parity.mjs` so the parsing seam and the judgement seam
 * can be reviewed - and reused by the gate fixtures - independently.
 */

/**
 * Deterministic code-point ordering (locale independent).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deduplicate and sort a string array (an input id may appear twice).
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function uniqueStrings(value) {
  const list = Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

  return [...new Set(list)].sort(compareStrings);
}

/**
 * Read a string-keyed record defensively; a missing or malformed record is `{}`.
 *
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function keyMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Evaluate the three parity invariants on extracted facts.
 *
 * Never throws; every violation is returned as an id, sorted and deduplicated,
 * so a report is deterministic. The caller decides whether a non-empty list (or
 * `vacuous`) is exit 1.
 *
 * @param {{
 *   advertised?: string[],
 *   handledElsewhere?: Record<string, string>,
 *   unadvertisedAliases?: Record<string, string>,
 *   dispatchCases?: string[],
 * }} remoteCommands the `snapshot.special.remoteCommands` block
 * @returns {{
 *   ok: boolean,
 *   vacuous: boolean,
 *   advertisedWithoutHandler: string[],
 *   unadvertisedCaseWithoutAlias: string[],
 *   aliasWithoutCase: string[],
 * }}
 */
export function checkParityConsistency(remoteCommands) {
  const input = remoteCommands !== null && typeof remoteCommands === "object" ? remoteCommands : {};
  const advertised = uniqueStrings(input.advertised);
  const dispatchCases = uniqueStrings(input.dispatchCases);
  const handledElsewhere = keyMap(input.handledElsewhere);
  const unadvertisedAliases = keyMap(input.unadvertisedAliases);
  const advertisedSet = new Set(advertised);
  const dispatchSet = new Set(dispatchCases);
  const handledElsewhereSet = new Set(Object.keys(handledElsewhere));
  const aliasKeys = Object.keys(unadvertisedAliases);

  const advertisedWithoutHandler = uniqueStrings(
    advertised.filter((id) => !dispatchSet.has(id) && !handledElsewhereSet.has(id)),
  );

  const unadvertisedCaseWithoutAlias = uniqueStrings(
    dispatchCases.filter((id) => !advertisedSet.has(id) && !aliasKeys.includes(id)),
  );

  const aliasWithoutCase = uniqueStrings(aliasKeys.filter((id) => !dispatchSet.has(id)));

  const vacuous = advertised.length === 0 && dispatchCases.length === 0;

  return {
    ok:
      !vacuous &&
      advertisedWithoutHandler.length === 0 &&
      unadvertisedCaseWithoutAlias.length === 0 &&
      aliasWithoutCase.length === 0,
    vacuous,
    advertisedWithoutHandler,
    unadvertisedCaseWithoutAlias,
    aliasWithoutCase,
  };
}
