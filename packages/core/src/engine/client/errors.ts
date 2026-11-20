/**
 * Engine client errors: the closed code set, the one error shape, and the
 * code -> message-key table.
 *
 * The seven codes are frozen: a failure that does not fit one of them is a
 * design gap to be fixed, not a new member to be added here.
 *
 * Two rules this file exists to make mechanical:
 *
 * 1. **`code` is the only branch key.** `detail` is a one-line English ASCII
 *    string written for humans and log grep, and `engineText` is the engine's
 *    own words kept for a field report. Neither is parsed, matched, compared or
 *    switched on anywhere - not by this module, not by the channel, not by a
 *    consumer. A test that asserts on `detail` is testing prose; assert on
 *    `code` instead. The English-ASCII rule for `detail` is not decoration
 *    either: it keeps a log line readable in a terminal with a non-UTF-8
 *    locale, while `engineText` is allowed to be anything the engine said.
 * 2. **The table is exhaustive.** {@link CODE_TO_KEY} is checked with
 *    `satisfies Record<EngineClientErrorCode, string>`, so adding a code
 *    without a key is a compile error at this exact line - a missing
 *    translation cannot reach a user.
 *
 * These keys are **message keys, not translations**: this package has no
 * catalogue (the renderer owns the locale files), so the string is handed to
 * whichever layer resolves it. `engine.client.*` is the namespace, and a
 * resolver that has not been given these keys yet still has the `code` to fall
 * back on.
 */

/**
 * Every way an engine client operation can fail, as a walkable tuple.
 *
 * The tuple is the single source of truth for {@link EngineClientErrorCode}, so
 * tests and log filters can iterate the whole set and an exhaustive `Record`
 * fails to compile when a member is added. The order is fixed, not an ordering
 * the code depends on.
 *
 * - `TIMEOUT` - the request or the bounded wait outlived its budget.
 * - `UNKNOWN_COMMAND` - the engine does not implement this capability. A build
 *   skew, not a caller bug: the mapping is generated from a recorded engine, and
 *   the recorded engine is older or newer than the running one.
 * - `REJECTED` - the engine answered and said no (a validation failure, a
 *   forbidden operation). The answer exists; it is just negative.
 * - `NOT_CONNECTED` - there is no live channel to send on: never opened, already
 *   closed, or closed mid-flight.
 * - `SEND_FAILED` - the channel was live but the write itself failed (socket
 *   error, backpressure, a frame that could not be serialised).
 * - `MALFORMED_RESPONSE` - bytes arrived and did not decode into the answer
 *   shape. The engine's reply is the fault, not the request.
 * - `AUTH_FAILED` - the upgrade was refused: a stale token, a token file that
 *   changed under us, or a rejected credential.
 */
export const ENGINE_CLIENT_ERROR_CODES = [
  "TIMEOUT",
  "UNKNOWN_COMMAND",
  "REJECTED",
  "NOT_CONNECTED",
  "SEND_FAILED",
  "MALFORMED_RESPONSE",
  "AUTH_FAILED",
] as const;

/** The closed set of client failure codes (see {@link ENGINE_CLIENT_ERROR_CODES}). */
export type EngineClientErrorCode = (typeof ENGINE_CLIENT_ERROR_CODES)[number];

/**
 * One classified client failure.
 *
 * `readonly` on all three fields: an error is a value that is passed around (to
 * a log, to a `CommandResult`, to a diagnostic) and a later holder mutating the
 * code would make the original branch unreproducible. Construct a new object
 * instead of editing one.
 *
 * `detail` is human-facing only - a short English ASCII sentence or phrase that
 * names the operation and the measured fact ("timeout after 10000 ms waiting
 * for conversation.sync"). It must not embed a wire id, a token or a file path.
 * `engineText` is the engine's reply verbatim when one exists; it is untrusted,
 * it is not rendered as UI text, and it is never used for control flow.
 *
 * `engineText` is optional-but-not-undefined by construction of the callers:
 * under `exactOptionalPropertyTypes` the key is either present with a string or
 * absent, never present with `undefined`.
 */
export type EngineClientError = {
  readonly code: EngineClientErrorCode;
  readonly detail: string;
  readonly engineText?: string;
};

/**
 * Code -> message key. Every code must have exactly one entry.
 *
 * `satisfies` rather than `: Record<...>` so the literal key set stays available
 * (`keyof typeof CODE_TO_KEY`) while a missing or misspelled member is still a
 * compile error: the annotation form would silently accept a widened object,
 * the `satisfies` form refuses a code that is absent.
 *
 * The keys are stable message ids, so a renderer can resolve them against its
 * catalogue. They are not the `code` with a prefix glued on by convention: the
 * two spellings differ where the UI wording does (see `notConnected`), and
 * renaming a key is a catalogue change, not a refactor.
 */
export const CODE_TO_KEY = {
  TIMEOUT: "engine.client.timeout",
  UNKNOWN_COMMAND: "engine.client.unknownCommand",
  REJECTED: "engine.client.rejected",
  NOT_CONNECTED: "engine.client.notConnected",
  SEND_FAILED: "engine.client.sendFailed",
  MALFORMED_RESPONSE: "engine.client.malformedResponse",
  AUTH_FAILED: "engine.client.authFailed",
} as const satisfies Record<EngineClientErrorCode, string>;

/**
 * The message key for one code.
 *
 * A total function by construction: `CODE_TO_KEY` is exhaustive, so this can
 * never miss. It exists because callers hold a `code` value they did not write
 * literally (it came out of a `CommandResult`), and an index expression at every
 * call site would otherwise need its own non-null assertion.
 *
 * @param code the classified failure code
 */
export function messageKeyFor(code: EngineClientErrorCode): string {
  return CODE_TO_KEY[code];
}
