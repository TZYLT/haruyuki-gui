/**
 * The send path: one typed request in, one wire frame out.
 *
 
 
 * 2.7c (the one reply frame that is not `<command>_response`) and 2.7d (the five
 
 *
 * This module is a **pure function over data**. It owns no table, no timer, no
 * socket and no memory of past sends: everything stateful about a command lives in
 * `channel.ts`, which decides which class a send belongs to and mints the id. What
 * is left here is the part with no state to keep - which fields go on the wire,
 * whether an id travels, and whether anything may be waited on afterwards.
 *
 * The boundary this module exists to hold: **a caller states a capability name
 * states a capability name and a body; the send path builds the rest.** A body
 * that tries to set a field the send path owns is refused, not merged and not
 * silently overwritten, because the forbidden thing is not "a bad value" but "a
 * caller assembling part of the envelope".
 *
 * Four facts that decide the shape of the code below, each of which has a wrong
 * version that fails silently rather than loudly:
 *
 * 1. **The reply frame name must be registered, never derived.**
 *    `message.send` is the single capability in the 68 whose acknowledgement is
 *    not `<wire>_response`; a sender that infers the name by prefix puts every
 *    message send on a promise nobody will ever resolve and discovers it only as
 *    a TIMEOUT, one per message. So this module never derives a reply name *and*
 *    never lets the reply name decide whether a send is tracked: tracking asks
 *    `tracksInFlightWith`, whose `response` class already counts a correlated
 *    acknowledgement under whatever name it arrives. The reply name is carried
 *    in the result for the layers that read frames; it is optional here because
 *    the capability table's table does not register one yet (see `SendDeps.replyWireOf`).
 * 2. **The id decides the wait, so the decision takes two arguments**
 *     §2.7d). For the five capabilities whose wire declares `request_id`
 *    as optional, an omitted id means the engine sends no reply at all
 *    (`message-router.ts:342,366,380`). `tracksInFlightWith(name, idSent)` is the
 *    only correct question; `tracksInFlight(name)` answers "yes" for a command
 *    that owes nothing and produces a guaranteed false TIMEOUT.
 * 3. **Three classes of id handling, not one.** Sixty
 *    capabilities take a correlatable id, two take an id but never answer
 *    (`file.watch`, `file.unwatch`), five have no id field at all, and the duplex
 *    wire has none either. Forwarding a caller's id to the last six would put a
 *    field on the wire that the engine does not read - the same defect class as
 *    speaking a field name it does not know.
 * 4. **Scope has two carriers.** Thirteen scoped capabilities
 *    carry a nested `runtime` object; `conversation.switch` carries
 *    `agent_id` / `conversation_id` at the top level and has no `runtime`
 *    container at all. "Scoped means a runtime object" is true 13 times out of 14
 *    and sends that one command a field its wire does not define.
 *
 * One deliberate non-fact: the outbound frame carries **no** `event_seq`,
 * `emitted_at` or `idempotency_key`. Those are among the envelope fields the
 * client builds, and `RuntimeEnvelope` does declare them - but `RuntimeEnvelope`
 * is a *server-to-client* shape: it is extended only by the state frames the
 * engine pushes, and of the 27 recorded c2s frames not one carries any of the
 * three. Adding them would be the same error as trap 3 in the other direction
 * (a field the peer does not read), so they stay off the wire and are still
 * *reserved* on the body side, because a caller putting one there would be doing
 * the client's envelope work. That tension with `RuntimeEnvelope` is stated here,
 * over.
 */

import type { CapabilityName } from "@haruyuki/protocol";

import {
  completionOf,
  findCapability,
  hasOptionalRequestId,
  scopeCarrierOf,
  tracksInFlightWith,
  wireIdOf,
} from "./capability-names";
import type { CompletionMode, ScopeCarrier } from "./capability-names";
import { resolveTimeout } from "./timeouts";
import type { ResolvedTimeout } from "./timeouts";
import type { CommandRequest, RuntimeScope } from "./types";

/**
 * Fields the send path owns on every frame, and therefore refuses in a body.
 *
 * `type` and `request_id` are the two the wire actually carries for a command.
 * The remaining three are the envelope fields the client owns; they are not
 * are not emitted (see the module header) but they are still refused, because a
 * caller writing one into a body is doing envelope work through the one channel
 * module closes.
 */
const ENVELOPE_OWNED_KEYS = [
  "type",
  "request_id",
  "event_seq",
  "emitted_at",
  "idempotency_key",
] as const;

/**
 * The two names the `top-level` scope carrier uses.
 *
 * Named as a pair because the reservation and the writing must agree: reserving
 * one and writing the other would let a body set the field that goes out.
 */
const TOP_LEVEL_SCOPE_KEYS = ["agent_id", "conversation_id"] as const;

/**
 * The keys no body may use, regardless of carrier.
 *
 * `runtime` is here unconditionally even though only thirteen wires carry it.
 * The alternative - reserving it per capability - would let a caller put a
 * `runtime` object into an unscoped command's body, where the field is not part
 * of the wire at all; a reserved word the send path *might* write must not be a
 * word the caller can write, or "who built this field" has two answers again.
 */
const BASE_RESERVED_SET: ReadonlySet<string> = new Set([...ENVELOPE_OWNED_KEYS, "runtime"]);

/**
 * The top-level carrier additionally owns the two ids it writes.
 *
 * Only `conversation.switch` uses this set. Every other capability either has no
 * scope or carries it in `runtime`, and many of them take `agent_id` or
 * `conversation_id` as ordinary body fields - `agent.delete` and
 * `conversation.get` are two - so reserving those names globally would break
 * correct callers.
 */
const TOP_LEVEL_RESERVED_SET: ReadonlySet<string> = new Set([
  ...ENVELOPE_OWNED_KEYS,
  "runtime",
  ...TOP_LEVEL_SCOPE_KEYS,
]);

/**
 * One command as it should leave this process.
 *
 * `raw` is what a transport writes. The rest is the decision, stated instead of
 * left to be re-derived by the caller: a channel that has to look at the
 * capability a second time to learn whether the send is trackable is a channel
 * that can disagree with the frame it just wrote.
 */
export type OutgoingFrame = {
  /** The serialized frame, ready for `transport.send`. */
  readonly raw: string;
  /**
   * The id that travelled, or `undefined` when the wire carries none.
   *
   * For the five untracked capabilities and the duplex one this is `undefined`
   * even when the caller supplied an id - the field does not exist on those
   * wires, so there is nothing truthful to report.
   */
  readonly requestId: string | undefined;
  /**
   * Whether the caller may wait for an answer.
   *
   * Computed as `tracksInFlightWith(name, requestId !== undefined)`: the class
   * decides whether a reply is possible, and an id that did not travel decides
   * whether one was actually requested.
   */
  readonly tracksInFlight: boolean;
  /** The budget for this request, in milliseconds, from the family table. */
  readonly timeoutMs: number;
  /**
   * Whether the caller's `timeoutMs` was cut to the 10x cap.
   *
   * Exposed rather than acted on: a defensive parameter must not cost the caller
   * parameter must not cost the caller their command, so the cap is a fact to
   * report, not a failure to return.
   */
  readonly clamped: boolean;
  /**
   * The registered name of the frame that will acknowledge this command, when
   * the mapping table knows one.
   *
   * `undefined` does not mean "no reply is coming" - that question is answered by
   * {@link OutgoingFrame.tracksInFlight}. It means "this build has no registered
   * name for it", which is the state of the capability table today: `replyWire`
   * part of `CapabilityEntry`. Nothing below reads this field back, so leaving it
   * leaving it unknown cannot mis-time a send; it is carried so the frame reader
   * diagnostics can name the expected answer once the registration lands.
   */
  readonly replyWire: string | undefined;
};

/**
 * What the send path may be handed beyond the request.
 *
 * Both members are ports rather than imports for the same reason
 * `channel.ts` takes its collaborators this way: the frozen tables are the
 * production defaults, and a test that wants to prove a decision ("the cap
 * applied", "the reply name came from the registry") should be able to state the
 * input instead of hunting for a capability that produces it.
 *
 * Neither port may become a source of truth. `resolveTimeoutOf` replaces ,
 * it does not replace the decision to call ; and a `replyWireOf` that returns
 * nothing changes no bit of the frame - see the module header on trap 1.
 */
export interface SendDeps {
  /**
   * Resolves the registered acknowledgement frame for one capability.
   *
   * Omitted in production until the capability table registers `replyWire` in
   * `CapabilityEntry`. This module will not derive it from `<wire>_response`:
   * that rule is wrong for exactly one capability, and the one it is wrong for
   * is the one the product cannot afford to get wrong.
   */
  readonly replyWireOf?: (name: CapabilityName) => string | undefined;
  /**
   * Resolves one request's budget. Defaults to `resolveTimeout` (`timeouts.ts`),
   * family table and the 10x clamp keep one home.
   */
  readonly resolveTimeoutOf?: (name: CapabilityName, requestedMs?: number) => ResolvedTimeout;
}

/**
 * Turns one request into the frame the engine reads.
 *
 * Everything the caller may **not** decide is decided here: the wire id, the
 * correlation id's presence, the scope's carrier, and the budget. Everything the
 * caller **must** decide arrives on the request: which capability, which body,
 * which scope, which explicit id and which timeout override.
 *
 * Invalid input throws rather than producing a wrong frame. That is the one
 * exception docs/26 §6.1 allows for `send` ("不抛异常（入参非法除外）"), and the
 * cases are all cases where the alternative is a frame that reaches the engine
 * as something nobody asked for: an unknown capability (no wire id, so the frame
 * would have no `type` at all), a non-object body (no named fields to merge), a
 * body that sets an envelope field, a scoped capability with no scope, or a
 * capability that must carry a request id with none available.
 *
 * @param request the capability, body and overrides the caller stated
 * @param deps the two ports, both optional
 * @param mintedId the id the channel minted for this send, if it minted one
 * @returns the serialized frame plus the decisions behind it
 * @throws TypeError when the request cannot be turned into a truthful frame
 */
export function buildFrame(
  request: CommandRequest,
  deps: SendDeps,
  mintedId: string | undefined,
): OutgoingFrame {
  const name = request.capability;

  // Validated before anything is read from the tables: `wireIdOf` on a name that
  // is not a capability returns `undefined`, `JSON.stringify` then drops the key,
  // and the result is a frame with no `type` - refused by the engine as a whole
  // instead of reported as the caller's mistake.
  const entry = findCapability(name);
  if (entry === undefined) {
    throw new TypeError(
      `unknown capability "${String(name)}": the send path resolves wire ids from the ` +
        "capability table, so a name that is not in it has no frame to send",
    );
  }

  const body = bodyOf(request.body, name);
  refusePrototypeKey(body, name);
  const carrier = scopeCarrierOf(name);
  refuseEnvelopeKeys(body, name, carrier);

  const completion = completionOf(name);
  const requestId = requestIdOf(request, mintedId, completion, hasOptionalRequestId(name), name);
  const budget = (deps.resolveTimeoutOf ?? resolveTimeout)(name, request.timeoutMs);

  // Key order is not part of the contract, but the *set* is, and the two are
  // easy to confuse when a frame is assembled by spreading three objects. The
  // frame is therefore built in one place, field group by field group.
  const frame: Record<string, unknown> = { type: wireIdOf(name) };
  attachScope(frame, request.runtime, name, carrier);
  if (requestId !== undefined) {
    frame.request_id = requestId;
  }
  for (const key of Object.keys(body)) {
    frame[key] = body[key];
  }

  return {
    raw: JSON.stringify(frame),
    requestId,
    // Two arguments, never one: see the module header on trap 2. `requestId` is
    // the second half of the question - a capability that owes a reply but went
    // out without an id owes nothing, and waiting would be waiting on nothing.
    tracksInFlight: tracksInFlightWith(name, requestId !== undefined),
    timeoutMs: budget.ms,
    clamped: budget.clamped,
    replyWire: deps.replyWireOf?.(name),
  };
}

/**
 * Reads the body as the set of named fields a wire command expects.
 *
 * `undefined` and `null` are the empty body: several commands are all envelope
 * (`device.info`, `provider.listConnected`), and forcing a caller to write `{}`
 * for them would invent a distinction the contract does not have. Anything else
 * that is not a non-array object is refused - spreading a string or a number
 * into a frame produces numeric keys, which is a body the engine cannot read.
 *
 * Values that `JSON.stringify` rewrites (a `Date`, a `Map`, `NaN`) are *not*
 * checked here. That judgement - "would this value arrive as something else" -
 * belongs to the renderer bridge validator, which owns it for every payload that
 * crosses a process boundary; deciding it a second time here would give the
 * repository two rules that can disagree.
 *
 * @param body whatever the caller put in `CommandRequest.body`
 * @param name the capability, for the error message
 * @returns the body's own enumerable fields
 * @throws TypeError when the body is not an object or is an array
 */
function bodyOf(body: unknown, name: CapabilityName): Record<string, unknown> {
  if (body === undefined || body === null) {
    return {};
  }

  if (typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError(
      `${name}: body must be a plain object of wire fields, not ${Array.isArray(body) ? "an array" : typeof body}`,
    );
  }

  return body as Record<string, unknown>;
}

/**
 * Picks the reserved key set for one capability's carrier.
 *
 * The two sets differ by exactly the fields `attachScope` may write, so a body
 * can never collide with a field this module is about to set.
 *
 * @param carrier how this capability expresses scope
 * @returns the keys the body may not use
 */
function reservedKeys(carrier: ScopeCarrier): ReadonlySet<string> {
  return carrier === "top-level" ? TOP_LEVEL_RESERVED_SET : BASE_RESERVED_SET;
}

/**
 * Refuses a body carrying `__proto__` as an own key.
 *
 * Not a style rule: `JSON.parse('{"__proto__":{...}}')` really does produce an
 * own enumerable `__proto__` key, and copying it with `frame[key] = value` sets
 * the object's prototype instead of adding a field. The frame would then be
 * missing the field the caller thought they sent *and* would carry an inherited
 * shape into whatever reads it next - two defects from one assignment, neither of
 * which shows up in the serialized string.
 *
 * @param body the caller's body
 * @param name the capability, for the error message
 * @throws TypeError when the body has an own `__proto__` key
 */
function refusePrototypeKey(body: Record<string, unknown>, name: CapabilityName): void {
  if (!Object.prototype.hasOwnProperty.call(body, "__proto__")) {
    return;
  }

  throw new TypeError(
    `${name}: body must not carry "__proto__"; copying that key sets the frame's prototype ` +
      "instead of writing a field, so the frame would silently lose it",
  );
}

/**
 * Refuses a body that assembles an envelope field.
 *
 * Refusing rather than overwriting is the whole point. Overwriting makes a
 * caller's mistake invisible (their value silently loses); merging makes it
 * fatal in a different way (the engine reads a value the client did not decide).
 * An error names the field and the capability, so the fix is a one-line change
 * at the call site instead of an investigation into why an id did not match.
 *
 * @param body the caller's body
 * @param name the capability, for the error message
 * @param carrier how this capability expresses scope
 * @throws TypeError when the body sets a reserved field
 */
function refuseEnvelopeKeys(
  body: Record<string, unknown>,
  name: CapabilityName,
  carrier: ScopeCarrier,
): void {
  const reserved = reservedKeys(carrier);
  const taken = Object.keys(body).filter((key) => reserved.has(key));

  if (taken.length === 0) {
    return;
  }

  throw new TypeError(
    `${name}: body must not set ${taken.join(", ")}. Those fields are built by the send path ` +
      "from the request itself (docs/26 D-06, diagnostic-bundle-tree), so a body that sets one is assembling part " +
      "of the envelope",
  );
}

/**
 * Decides whether a correlation id travels, and which one.
 *
 * Four outcomes, one per class plus the caller's own id:
 *
 * - `untracked` (5) and `duplex` (1): no id, whatever the caller passed. The
 *   wire has no such field, so forwarding one would send the engine a name it
 *   does not read - and, for `terminal.input`, two keystrokes must stay two
 *   identical frames rather than becoming one correlatable pair.
 * - `silent` (2): an id is required by the wire but nothing answers. Still not
 *   tracked - that decision is `tracksInFlightWith`'s, not this function's.
 * - `response` with an id available: that id travels.
 * - `response` whose id is optional and absent: legal, and simply means no reply
 *   was requested. Legal *only* for those five; the same absence
 *   on a capability that must carry an id is a frame the engine could never
 *   correlate, so it is refused here rather than turned into a later TIMEOUT.
 *
 * An empty string counts as absent. The engine's own reply paths are gated on
 * `if (parsed.request_id)`, so `""` is a value that produces no answer - sending
 * it would claim a correlation that cannot exist.
 *
 * @param request the caller's request
 * @param mintedId the channel's id, if it minted one
 * @param completion how the end of this capability is observed
 * @param optionalId whether this wire declares `request_id` as optional
 * @param name the capability, for the error message
 * @returns the id to send, or `undefined` when none should
 * @throws TypeError when the wire requires an id and none is available
 */
function requestIdOf(
  request: CommandRequest,
  mintedId: string | undefined,
  completion: CompletionMode,
  optionalId: boolean,
  name: CapabilityName,
): string | undefined {
  if (completion === "untracked" || completion === "duplex") {
    return undefined;
  }

  // The caller's explicit id wins over the mint ("except for an explicit
  // mint is a convenience, the parameter is a decision.
  const supplied = nonEmptyId(request.requestId) ?? nonEmptyId(mintedId);

  if (supplied !== undefined) {
    return supplied;
  }

  if (optionalId) {
    return undefined;
  }

  throw new TypeError(
    `${name}: this capability carries a request id and neither the request nor the mint supplied ` +
      "one, so its answer could never be correlated",
  );
}

/**
 * Treats an empty id as no id (see {@link requestIdOf}).
 *
 * @param value the candidate id
 * @returns the id, or `undefined` when it is absent or empty
 */
function nonEmptyId(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Writes the scope in the carrier this capability's wire uses.
 *
 * Three cases, and the third is the one a single "if scoped, attach runtime"
 * branch gets wrong:
 *
 * - `none`: nothing is written. A scope supplied to an unscoped command is
 *   dropped, not refused: the caller's intent ("this is the conversation I am
 *   working in") is not wrong, the command simply has no slot for it, and
 *   refusing would make a shared "current scope" argument unusable.
 * - `runtime`: a nested object holding exactly the two ids. It is rebuilt rather
 *   than spread so a caller's extra keys cannot ride along - the envelope is the
 *   send path's, and `acting_user_id` is not part of our scope type.
 * - `top-level`: `conversation_id` always, `agent_id` only when it is a string.
 *   `RuntimeScope.agent_id` is nullable, and `conversation.switch` declares a
 *   bare `agent_id?: string` with no null in it: a `null` there would be a value
 *   the wire does not define, so absence carries the same meaning honestly.
 *
 * @param frame the frame being built
 * @param runtime the caller's scope, if any
 * @param name the capability, for the error message
 * @param carrier how this capability expresses scope
 * @throws TypeError when the capability is scoped and no scope was given
 */
function attachScope(
  frame: Record<string, unknown>,
  runtime: RuntimeScope | undefined,
  name: CapabilityName,
  carrier: ScopeCarrier,
): void {
  if (carrier === "none") {
    return;
  }

  if (runtime === undefined) {
    throw new TypeError(
      `${name}: this capability is scoped, so request.runtime is required; without it the frame ` +
        "addresses no runtime at all",
    );
  }

  if (carrier === "runtime") {
    frame.runtime = {
      agent_id: runtime.agent_id,
      conversation_id: runtime.conversation_id,
    };
    return;
  }

  if (runtime.agent_id !== null) {
    frame.agent_id = runtime.agent_id;
  }
  frame.conversation_id = runtime.conversation_id;
}
