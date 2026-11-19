/**
 * Shape checks for an incoming command envelope.
 *
 * Why these live apart from the dispatcher
 *   Each predicate answers one yes/no question about untrusted data, and each is
 *   used by the dispatcher at a specific point in its order. Keeping them here
 *   means the order in `dispatch.ts` reads as prose, and means a test can pin a
 *   single rule without building a dispatcher around it.
 *
 * Why "plain object" is spelled out rather than assumed
 *   The value arrives from another process. An array, `null`, a class instance
 *   and a `Date` all report `typeof === "object"`, and every one of them would
 *   either lose its fields on JSON serialisation or arrive at the engine as a
 *   shape the engine never documented. The check is deliberately narrow: an
 *   object whose prototype is `Object.prototype` (or `null`) and that is not an
 *   array. Nothing here inspects an object's contents beyond that - a body is
 *   opaque to this layer.
 *
 * Why the envelope keys are forbidden inside `body`
 *   `capability`, `runtime` and the request id belong to the envelope, and the
 *   envelope is assembled by the send path. If a body were allowed to carry its
 *   own copy, the two spellings could disagree - and whichever one the engine
 *   happened to read would decide the command's meaning. Both spellings of the
 *   request id are listed because the wire uses snake_case while this surface
 *   uses camelCase; a body carrying either one is carrying envelope state.
 *   Rejection is by *key presence*, not by value: `runtime: undefined` is still
 *   a caller that built the wrong request, and it is refused the same way.
 */

import type { RuntimeScope } from "../engine/client/types.js";

/**
 * Object keys that belong to the envelope and must never appear in a `body`.
 *
 * Sorted, and declared once so the rejection message can name exactly which key
 * was found without the dispatcher re-spelling the list.
 */
export const ENVELOPE_BODY_KEYS = [
  "capability",
  "requestId",
  "request_id",
  "runtime",
  "type",
] as const;

/**
 * Decides whether a value is a JSON-object-shaped record.
 *
 * "Plain" means the prototype is `Object.prototype` or `null`. The narrower
 * check matters: a `Date`, a `Map` or a class instance is `typeof "object"` too,
 * and forwarding one would either lose its fields on serialisation or reach the
 * engine as a shape it never documented.
 *
 * @param value any value, typically from another process
 * @returns `true` for a non-array plain object
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Decides whether a value is a usable string name.
 *
 * Empty and whitespace-only strings are refused: the table has no key of either
 * shape, so accepting them would only move the failure one layer down where the
 * error would be less clear.
 *
 * @param value any value
 * @returns `true` for a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Decides whether a value has the runtime scope shape.
 *
 * The shape is exact in what it checks and tolerant in what it does not:
 * `agent_id` must be a string or `null` (the key is present and null for a scope
 * that is not bound to an agent), and `conversation_id` must be a string. An
 * empty `conversation_id` is accepted here - it is a semantic question for the
 * engine, and rejecting it would make this predicate the second authority on
 * scope validity.
 *
 * @param value any value, typically the `runtime` member of a call
 * @returns `true` when the value can be forwarded as a scope
 */
export function isRuntimeScope(value: unknown): value is RuntimeScope {
  if (!isPlainRecord(value)) {
    return false;
  }

  const agentId = value["agent_id"];
  if (agentId !== null && typeof agentId !== "string") {
    return false;
  }

  return typeof value["conversation_id"] === "string";
}

/**
 * Lists the envelope keys a body smuggles, in the declared order.
 *
 * An empty array means the body is clean. The list is returned rather than a
 * boolean so the caller can name the offending keys in its log line, and so a
 * test can assert that *every* forbidden key is found rather than the first one.
 *
 * @param body a body already known to be a plain record
 * @returns the forbidden keys present in `body`
 */
export function findEnvelopeBodyKeys(body: Record<string, unknown>): string[] {
  return ENVELOPE_BODY_KEYS.filter((key) => Object.hasOwn(body, key));
}
