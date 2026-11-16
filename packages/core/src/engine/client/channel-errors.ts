/**
 * Channel failure constructors: the one place a channel failure becomes an
 * `EngineClientError`.
 *
 * Every reason a command can fail on a channel is built here, and nowhere else.
 * That is not organisation for its own sake: `code` is the only branch key a
 * consumer may switch on (see `errors.ts`), so "which code does
 * this situation produce" has to have one answer per situation. Splitting the
 * constructors out of {@link EngineChannel} keeps that answer readable on its own
 * and makes it testable without standing up a channel.
 *
 * Two rules hold for everything in this file:
 *
 * 1. **`detail` is English ASCII and human-only.** One line, naming the operation
 *    and the measured fact. It never carries a wire id, a token or a file path,
 *    because it is quoted in logs. No code in this repository branches on it - the
 *    only exception is the `NOT_CONNECTED` wording below, which  section
 *    5.2.2 makes a requirement *for a human reader* (B3 may map it), not for a
 *    parser.
 * 2. **Every failure is a value.** Nothing here throws: these constructors return
 *    the `ok: false` arm's payload, so `send` can resolve instead of reject.
 */

import type { EngineClientError, EngineClientErrorCode } from "./errors";
import type { DiagnosticKind } from "./types";

/**
 * Response code -> diagnostic signal, for the codes that have one.
 *
 * `NOT_CONNECTED` and `AUTH_FAILED` are deliberately absent. `types.ts` records
 * the reason: a dead channel has no channel left to report on, and those two codes
 * surface through the rejected `send` result instead. Giving them a signal here
 * would mean a diagnostics panel reporting a failure on a channel that cannot
 * deliver the report.
 *
 * `MALFORMED_RESPONSE` is present but is not the only producer of the `malformed`
 * signal: a frame that does not parse at all is reported by the channel directly,
 * because it never becomes a `CommandResult`.
 */
const DIAGNOSTIC_FOR_CODE = {
  TIMEOUT: "timeout",
  UNKNOWN_COMMAND: "unknown-command",
  REJECTED: "rejected",
  SEND_FAILED: "send-failed",
  MALFORMED_RESPONSE: "malformed",
} as const satisfies Partial<Record<EngineClientErrorCode, DiagnosticKind>>;

/**
 * The diagnostic signal for a failed command, if that failure has one.
 *
 * `Partial` rather than total because two codes have no signal (see
 * {@link DIAGNOSTIC_FOR_CODE}), and a lookup that always returned a kind would
 * have to invent one for them. The `in` guard is what satisfies
 * `noUncheckedIndexedAccess` while reading as the question being asked: "does this
 * code have a signal at all?".
 *
 * @param code the classified failure code
 * @returns the signal kind, or `undefined` when the code has none
 */
export function diagnosticFor(code: EngineClientErrorCode): DiagnosticKind | undefined {
  return code in DIAGNOSTIC_FOR_CODE
    ? DIAGNOSTIC_FOR_CODE[code as keyof typeof DIAGNOSTIC_FOR_CODE]
    : undefined;
}

/**
 * A tracked request outlived its budget.
 *
 * The quoted number is the budget that was actually granted, not the family
 * default, so a clamped override is visible in the message a user reports
 * .
 *
 * @param capability the capability that did not answer
 * @param timeoutMs the budget that expired
 * @returns the TIMEOUT error
 */
export function timeoutError(capability: string, timeoutMs: number): EngineClientError {
  return {
    code: "TIMEOUT",
    detail: `timeout after ${timeoutMs} ms waiting for ${capability}`,
  };
}

/**
 * The in-flight table is full, so this command was refused rather than queued.
 *
 * Refusing is the whole point: a queue would hide the caller bug that
 * filled the table and would make the next waiter wait a full budget to learn
 * nothing. The bound is named in the message so a field report says which limit
 * was hit.
 *
 * @param capability the capability that was refused
 * @param limit the table's capacity
 * @returns the REJECTED error
 */
export function tableFullError(capability: string, limit: number): EngineClientError {
  return {
    code: "REJECTED",
    detail: `in-flight table is full at ${limit} entries; refused ${capability}`,
  };
}

/**
 * A caller-supplied request id is already in flight.
 *
 * Two waiters on one id would be settled by whichever answer arrived first, and
 * the second promise would wait for an answer already spent. Refusing the second
 * send is the only reading that keeps one entry per promise.
 *
 * @param capability the capability that was refused
 * @param requestId the id already in flight
 * @returns the REJECTED error
 */
export function duplicateIdError(capability: string, requestId: string): EngineClientError {
  return {
    code: "REJECTED",
    detail: `request id ${requestId} is already in flight; refused ${capability}`,
  };
}

/**
 * The engine answered, and its answer was a refusal.
 *
 * Distinct from every other REJECTED in this file: those are refusals **by the
 * client** (table full, duplicate id), this one is the engine saying no. The code
 * is the same because the caller's next move is the same - do not retry blindly,
 * read the reason - and because the wire has no client-side error taxonomy to
 * borrow from.
 *
 * `detail` carries the engine's own words when it offered any. That text is
 * untrusted and never branched on; the branch key is that this is a refusal at
 * all.
 *
 * @param requestId the correlation id the engine refused
 * @param engineText the engine's explanation, when it gave one
 * @returns the REJECTED error
 */
export function refusedByEngineError(
  requestId: string,
  engineText: string | undefined,
): EngineClientError {
  const base = `the engine refused request ${requestId}`;

  return {
    code: "REJECTED",
    detail: engineText === undefined ? base : `${base}: ${engineText}`,
  };
}

/**
 * A write itself failed: the socket was gone, backpressured, or the frame could
 * not be serialized.
 *
 * Distinct from `NOT_CONNECTED` on purpose - that one says there was no channel to
 * write on, this one says there was and the write still failed.
 *
 * @param capability the capability whose frame was not written
 * @returns the SEND_FAILED error
 */
export function sendFailedError(capability: string): EngineClientError {
  return {
    code: "SEND_FAILED",
    detail: `the frame for ${capability} could not be written`,
  };
}

/**
 * Build a `NOT_CONNECTED` failure, worded so its two cases stay distinguishable.
 *
 * A human must be able to tell the two cases apart:
 *
 * | situation | wording | meaning |
 * |---|---|---|
 * | never came up (`idle`/`spawning`/`handshaking`) | `engine has not become ready` | a startup problem |
 * | was up, then dropped | `channel was ready and dropped` | a reconnect problem |
 *
 * The distinction exists because B3 decides from it whether a send is worth
 * replaying at all: "never connected" has nothing to resume, while "dropped" is
 * exactly the case a reconnect handles. The code stays the same on both arms -
 * both arms - the error-code list is closed and a new code is not available - so
 * wording is the only carrier, which is why it is pinned by test.
 *
 * @param everReady whether this channel was ever usable
 * @param extra optional clause naming the operation, appended after the state
 * @returns the NOT_CONNECTED error
 */
export function notConnectedError(everReady: boolean, extra?: string): EngineClientError {
  const state = everReady ? "channel was ready and dropped" : "engine has not become ready";
  return {
    code: "NOT_CONNECTED",
    detail: extra === undefined ? state : `${state}; ${extra}`,
  };
}
