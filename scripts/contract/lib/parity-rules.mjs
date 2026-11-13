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
 * extracted lists/records and returns the violation ids, sorted. Whether a
 * non-empty list means exit 1 is the caller's decision (the gate makes that
 * call); recording the reason is this module's only job.
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
 * Evaluate the three parity invariants on extracted facts.
 *
 * Never throws; every violation is returned as an id, sorted, so a report is
 * deterministic. The caller decides whether a non-empty list is exit 1.
 *
 * @param {{
 *   advertised: string[],
 *   handledElsewhere: Record<string, string>,
 *   unadvertisedAliases: Record<string, string>,
 *   dispatchCases: string[],
 * }} remoteCommands
 * @returns {{
 *   ok: boolean,
 *   advertisedWithoutHandler: string[],
 *   unadvertisedCaseWithoutAlias: string[],
 *   aliasWithoutCase: string[],
 * }}
 */
export function checkParityConsistency(remoteCommands) {
  const advertised = remoteCommands.advertised;
  const advertisedSet = new Set(advertised);
  const dispatchSet = new Set(remoteCommands.dispatchCases);
  const handledElsewhereSet = new Set(Object.keys(remoteCommands.handledElsewhere));
  const aliasKeys = Object.keys(remoteCommands.unadvertisedAliases);

  const advertisedWithoutHandler = advertised
    .filter((id) => !dispatchSet.has(id) && !handledElsewhereSet.has(id))
    .sort(compareStrings);

  const unadvertisedCaseWithoutAlias = remoteCommands.dispatchCases
    .filter((id) => !advertisedSet.has(id) && !aliasKeys.includes(id))
    .sort(compareStrings);

  const aliasWithoutCase = aliasKeys.filter((id) => !dispatchSet.has(id)).sort(compareStrings);

  return {
    ok:
      advertisedWithoutHandler.length === 0 &&
      unadvertisedCaseWithoutAlias.length === 0 &&
      aliasWithoutCase.length === 0,
    advertisedWithoutHandler,
    unadvertisedCaseWithoutAlias,
    aliasWithoutCase,
  };
}
