/**
 * Capability names: the one place under `client/` that resolves a capability to
 * its wire id.
 *
 * The command model is owned by the protocol package; the vocabulary itself is
 * is generated, never authored here.
 *
 * The rule this module exists to keep: `packages/core/src/engine/client/` must
 * not contain a wire id literal. Nothing below names one.
 * Every row is projected from `@haruyuki/protocol`, whose generated artifact
 * (`contract/command-map.generated.ts`) is the frozen definition of the
 * 68-capability table and already carries `satisfies Record<CapabilityName, ...>`
 * on both of its records. A capability name is what business code writes: names
 * are the stable spelling, wire ids are the engine's spelling, and they stop at
 * this boundary.
 *
 * What the projection adds on top of the protocol artifact:
 *
 * 1. `completion` - how the end of a command is observed. `CapabilityShape`
 *    cannot answer that on its own: `one-way` covers both a capability whose
 *    acknowledged frame comes back (`message.send`) and one where nothing ever
 *    comes back (`file.watch`), and that difference decides whether a send may
 *    enter the in-flight table at all. Entering it for a silent capability turns
 *    every send into a false TIMEOUT.
 * 2. `scopeCarrier` - how the wire expresses its scope. The scope label alone is
 *    not enough to send a command: 13 of the 14 scoped capabilities carry a
 *    nested `runtime` object, while `conversation.switch` expresses the same
 *    scope through top-level `agent_id` / `conversation_id` fields. A sender that
 *    attaches a runtime object to that one wire sends a field the engine does not
 *    read, and a capability therefore cannot be sent on `scope !== "none"` alone.
 * 3. A single import site. Every other module under `client/` reads this table
 *    from here, so the client cannot grow a second, drifting copy.
 *
 * The name lists below are rows rather than derivations, because
 * `capabilities.json` states name, wire, since, scope, shape and notes but not
 * which class a capability belongs to; the field evidence lives in
 * `snapshot.json`. The companion test derives every class from the snapshot and
 * compares it with these lists, so a contract change that moves a capability
 * between the classes goes red instead of silently mis-timing or mis-addressing
 * it.
 */

import { CAPABILITY_META, CAPABILITY_TO_WIRE } from "@haruyuki/protocol";
import type { CapabilityName, CapabilityScope, CapabilityShape } from "@haruyuki/protocol";

export type { CapabilityName, CapabilityScope, CapabilityShape };

/**
 * How the end of one command is observed.
 *
 * - `response`  a correlated answer arrives; the send may enter the in-flight
 *               table and a missing answer is a real TIMEOUT.
 * - `silent`    the command carries a request id but the engine never answers;
 *               it must never wait, and must never enter the in-flight table.
 * - `untracked` the command carries no request id at all, so there is nothing to
 *               correlate; the effect is observed through state/stream frames.
 * - `duplex`    the wire runs in both directions with no request/reply pairing.
 */
export type CompletionMode = "response" | "silent" | "untracked" | "duplex";

/**
 * How the wire carries the scope a scoped command applies to.
 *
 * - `runtime`  a nested `runtime` object (`ConversationRuntimeScope` or
 *              `AgentRuntimeScope`) names the scope, and its shape differs by
 *              scope, so the sender has to know which one it is addressing.
 * - `top-level` the scope is expressed by top-level id fields instead of a
 *              nested object. Only `conversation.switch` does this: starting a
 *              runtime cannot be addressed *by* the runtime it is about to
 *              create, so it takes `agent_id` / `conversation_id` directly.
 * - `none`     the command is not scoped; there is nothing to attach.
 */
export type ScopeCarrier = "runtime" | "top-level" | "none";

/** One row of the table: everything `client/` may ask about a capability. */
export interface CapabilityEntry {
  /** The capability name; the only spelling business code uses. */
  readonly name: CapabilityName;
  /** The engine's wire id. Handed to the wire layer, never written down here. */
  readonly wire: string;
  readonly shape: CapabilityShape;
  readonly scope: CapabilityScope;
  readonly completion: CompletionMode;
  /** How the send expresses its scope; `none` when the command is unscoped. */
  readonly scopeCarrier: ScopeCarrier;
  /** `true` when the send must carry scope information, by whichever carrier. */
  readonly needsScope: boolean;
  /**
   * `true` when the wire makes `request_id` optional, so a reply arrives only if
   * one was set. For these the send decides whether it is trackable: omit the id
   * and the command must not be waited on.
   */
  readonly optionalRequestId: boolean;
  /**
   * The registered name of the frame that acknowledges this command, or
   * `undefined` when no reply frame exists at all.
   *
   * Read this as a *diagnostic*, not as a decision: whether an answer is owed is
   * answered by {@link CapabilityEntry.completion} and
   * {@link tracksInFlightWith}. This field exists so that a real timeout can name
   * the frame it was waiting for, instead of a reader having to re-derive it.
   *
   * `undefined` means "no reply frame is registered for this capability" - the
   * two silent watchers, the five id-less commands and the duplex wire. It never
   * means "this build forgot the name": the projection fills it for every
   * capability that has one, and the tests fail if a reply appears that the
   * projection cannot name.
   */
  readonly replyWire: string | undefined;
}

/**
 * Capabilities that carry a request id and never get an answer.
 *
 * `file.watch` and `file.unwatch` both declare `request_id` in the snapshot, but
 * neither has any reply frame; the contract notes say failures are silent and
 * changes arrive as file-changed broadcasts. Waiting on them is precisely the
 * bug the `silent` class exists to prevent.
 */
const SILENT_REQUEST_NAMES: readonly CapabilityName[] = ["file.watch", "file.unwatch"];

/**
 * Capabilities whose wire has no request id at all.
 *
 * Five commands in this family exist; the effect of each arrives as a broadcast
 * frame (a spawned notice, terminal output, terminal exit, and the device status
 * update for the device setter). None of them can be correlated, so none of them
 * may enter any table.
 */
const UNTRACKED_NAMES: readonly CapabilityName[] = [
  "device.setState",
  "terminal.input",
  "terminal.kill",
  "terminal.resize",
  "terminal.spawn",
];

/**
 * The one scoped capability that expresses its scope with top-level id fields.
 *
 * `conversation.switch` starts or switches a conversation runtime. It cannot
 * carry `runtime: { conversation_id }`, because the runtime is what the command
 * creates; it takes the ids at the top level instead. `capabilities.json` still
 * files it under `scope: "conversation"`, which is correct: the *semantics* are
 * conversation-scoped, only the encoding differs.
 */
const TOP_LEVEL_SCOPE_NAMES: readonly CapabilityName[] = ["conversation.switch"];

/**
 * Capabilities whose wire declares `request_id` as optional.
 *
 * This is the difference between "there is an answer" and "there is an answer
 * only if the client asks for one". Two of these are load-bearing:
 * `conversation.sync` returns its reply only when a request id is set, and
 * `message.abort` answers optionally while the authoritative result arrives as
 * state frames. A client that omits the id on these must not then wait for a
 * reply: the timeout would fire on a promise that was never made. The rest of
 * the table requires the id, so their answer is unconditional.
 */
const OPTIONAL_REQUEST_ID_NAMES: readonly CapabilityName[] = [
  "conversation.sync",
  "message.abort",
  "message.send",
  "queue.resume",
  "workspace.list",
];

const SILENT_REQUEST_SET: ReadonlySet<CapabilityName> = new Set(SILENT_REQUEST_NAMES);
const UNTRACKED_SET: ReadonlySet<CapabilityName> = new Set(UNTRACKED_NAMES);
const TOP_LEVEL_SCOPE_SET: ReadonlySet<CapabilityName> = new Set(TOP_LEVEL_SCOPE_NAMES);
const OPTIONAL_REQUEST_ID_SET: ReadonlySet<CapabilityName> = new Set(OPTIONAL_REQUEST_ID_NAMES);

/**
 * Ordering for the exposed name list: UTF-16 code unit order, never locale order.
 *
 * `localeCompare` would make the table's order depend on the host locale, and a
 * table whose order depends on the machine is a table two machines can disagree
 * about. Code unit order is also what the generator emits, so the committed
 * artifacts and this list read the same way.
 *
 * @param a left capability name
 * @param b right capability name
 * @returns negative, zero or positive, per the comparison contract
 */
function compareNames(a: CapabilityName, b: CapabilityName): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Every capability name, sorted.
 *
 * Derived from the generated table rather than typed out: a hand-written list of
 * 68 entries would drift, and the drift would be invisible because the type
 * system cannot count union members.
 */
export const CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze(
  (Object.keys(CAPABILITY_META) as CapabilityName[]).sort(compareNames),
);

const CAPABILITY_NAME_SET: ReadonlySet<string> = new Set<string>(CAPABILITY_NAMES);

/**
 * Decide the completion mode for one capability.
 *
 * `shape` decides the duplex edge first: both directions on one wire means no
 * request/reply pairing exists to correlate. After that the two name lists are
 * authoritative, and everything left over is a real request/response, which is
 * the overwhelming majority of the table.
 *
 * @param name capability name
 * @param shape the declared shape for that capability
 * @returns the completion mode
 */
function completionModeFor(name: CapabilityName, shape: CapabilityShape): CompletionMode {
  if (shape === "bidirectional") {
    return "duplex";
  }
  if (SILENT_REQUEST_SET.has(name)) {
    return "silent";
  }
  if (UNTRACKED_SET.has(name)) {
    return "untracked";
  }
  return "response";
}

/**
 * Decide how one capability expresses its scope.
 *
 * Order matters: an unscoped command has no scope to express whatever its wire
 * happens to contain, and the one top-level exception is checked before the
 * default. Naming the exception explicitly (rather than probing the wire) keeps
 * the table honest about the contract: the fact comes from the snapshot, and the
 * companion test re-derives it from there.
 *
 * @param name capability name
 * @param scope the declared scope for that capability
 * @returns the carrier the sender has to use
 */
function scopeCarrierFor(name: CapabilityName, scope: CapabilityScope): ScopeCarrier {
  if (scope === "none") {
    return "none";
  }
  return TOP_LEVEL_SCOPE_SET.has(name) ? "top-level" : "runtime";
}

/**
 * The reply frame's default suffix: a capability whose wire is `X` is normally
 * acknowledged by `X_response`.
 *
 * These suffixes are contract *vocabulary*, not wire ids: neither this token nor
 * `accepted` below is a wire id on its own, and neither is spelled out as one
 * here. The full reply name is assembled from the wire id this table already
 * holds plus one of these suffixes, which keeps `client/` free of wire literals
 * while still naming the frame.
 */
const DEFAULT_REPLY_SUFFIX = "response";

/**
 * Capabilities whose reply frame does not follow the default suffix.
 *
 * There is exactly one, and it matters more than its size suggests: sending a
 * message is the product's core action, and its acknowledgement carries the
 * `accepted` suffix rather than the default one. A reader that derived the reply
 * from the default rule would look for a frame that never arrives - the send
 * would still work, and every message would be reported as a timeout.
 *
 * The map is a suffix table rather than a list of full wire ids on purpose: it
 * records the *shape* of the exception (this capability answers with a different
 * trailing token) instead of copying a wire id into `client/`. The tests compare
 * the assembled names with `snapshot.json` and fail if the exception count or the
 * exception's identity changes.
 */
const REPLY_SUFFIX_EXCEPTIONS: ReadonlyMap<CapabilityName, string> = new Map<
  CapabilityName,
  string
>([["message.send", "accepted"]]);

/**
 * Assemble the acknowledgement frame name for one capability.
 *
 * `undefined` exactly when no reply frame exists: the two silent watchers, the
 * five commands without a request id and the duplex wire. Every other capability
 * answers, so it gets a name.
 *
 * @param name capability name
 * @param wire the capability's wire id
 * @param completion how the end of the command is observed
 * @returns the reply frame name, or `undefined` when none exists
 */
function replyWireFor(
  name: CapabilityName,
  wire: string,
  completion: CompletionMode,
): string | undefined {
  if (completion !== "response") {
    return undefined;
  }
  const suffix = REPLY_SUFFIX_EXCEPTIONS.get(name) ?? DEFAULT_REPLY_SUFFIX;
  return `${wire}_${suffix}`;
}

/**
 * Project the generated capability table into the client's own shape.
 *
 * Both generated records are read here on purpose: the wire comes from the
 * dedicated `CAPABILITY_TO_WIRE`, the rest from `CAPABILITY_META`. If the two
 * artifacts ever disagreed about a capability, the contract parity test compares
 * the result with `capabilities.json` and fails.
 *
 * @returns the frozen lookup table, keyed by capability name
 */
function buildCapabilities(): Readonly<Record<CapabilityName, CapabilityEntry>> {
  const table = {} as Record<CapabilityName, CapabilityEntry>;

  for (const name of CAPABILITY_NAMES) {
    const meta = CAPABILITY_META[name];
    const wire = CAPABILITY_TO_WIRE[name];
    const scopeCarrier = scopeCarrierFor(name, meta.scope);
    const completion = completionModeFor(name, meta.shape);
    table[name] = Object.freeze({
      name,
      wire,
      shape: meta.shape,
      scope: meta.scope,
      completion,
      scopeCarrier,
      needsScope: scopeCarrier !== "none",
      optionalRequestId: OPTIONAL_REQUEST_ID_SET.has(name),
      replyWire: replyWireFor(name, wire, completion),
    });
  }

  return Object.freeze(table);
}

/** The frozen capability table: name to wire id, shape, scope and completion. */
export const CAPABILITIES: Readonly<Record<CapabilityName, CapabilityEntry>> = buildCapabilities();

/**
 * Narrows an arbitrary string to a capability name.
 *
 * Used where a name arrives as data (a log line, a scenario file, a message from
 * the host) and has to be validated before it is trusted.
 *
 * @param text candidate spelling
 * @returns `true` when `text` is one of the 68 capability names
 */
export function isCapabilityName(text: string): text is CapabilityName {
  return CAPABILITY_NAME_SET.has(text);
}

/**
 * Looks up one capability by name, tolerating an invalid name.
 *
 * @param text candidate spelling
 * @returns the entry, or `undefined` when the string is not a capability name
 */
export function findCapability(text: string): CapabilityEntry | undefined {
  return isCapabilityName(text) ? CAPABILITIES[text] : undefined;
}

/**
 * Reads one capability row.
 *
 * @param name capability name
 * @returns the row for that capability
 */
export function capabilityEntry(name: CapabilityName): CapabilityEntry {
  return CAPABILITIES[name];
}

/**
 * Resolves a capability name to the engine's wire id.
 *
 * This is the only sanctioned way for code under `client/` to obtain a wire id.
 *
 * @param name capability name
 * @returns the wire id the engine answers to
 */
export function wireIdOf(name: CapabilityName): string {
  return CAPABILITIES[name].wire;
}

/**
 * @param name capability name
 * @returns the declared shape
 */
export function shapeOf(name: CapabilityName): CapabilityShape {
  return CAPABILITIES[name].shape;
}

/**
 * @param name capability name
 * @returns the declared scope
 */
export function scopeOf(name: CapabilityName): CapabilityScope {
  return CAPABILITIES[name].scope;
}

/**
 * @param name capability name
 * @returns `true` when the send must carry scope information
 */
export function needsScope(name: CapabilityName): boolean {
  return CAPABILITIES[name].needsScope;
}

/**
 * @param name capability name
 * @returns which carrier the send has to use for its scope
 */
export function scopeCarrierOf(name: CapabilityName): ScopeCarrier {
  return CAPABILITIES[name].scopeCarrier;
}

/**
 * Whether the send has to attach a nested `runtime` object.
 *
 * The narrow question, and the one a sender actually asks: `true` only for the
 * scoped capabilities whose wire carries a runtime object. `conversation.switch`
 * is scoped but answers `false`, so a sender that gates on this never sends it a
 * runtime object it cannot read. Use {@link needsScope} to ask the broad
 * question instead.
 *
 * @param name capability name
 * @returns `true` when a nested runtime object belongs in the body
 */
export function attachesRuntimeObject(name: CapabilityName): boolean {
  return CAPABILITIES[name].scopeCarrier === "runtime";
}

/**
 * @param name capability name
 * @returns how the end of that command is observed
 */
export function completionOf(name: CapabilityName): CompletionMode {
  return CAPABILITIES[name].completion;
}

/**
 * Whether a send may enter the in-flight table.
 *
 * Only a real request/response qualifies: a correlated answer exists, so a
 * timeout is meaningful. The other three modes must never be tracked, or the
 * timeout would fire on a capability that never promised an answer.
 *
 * @param name capability name
 * @returns `true` when the command is tracked until its answer or TIMEOUT
 */
export function tracksInFlight(name: CapabilityName): boolean {
  return CAPABILITIES[name].completion === "response";
}

/**
 * Whether a send may enter the in-flight table **given that it carried an id**.
 *
 * The narrower question, and the one a sender with an optional id has to ask:
 * for a wire whose `request_id` is optional, omitting the id means the engine
 * sends no reply, so waiting is a guaranteed false TIMEOUT.
 *
 * @param name capability name
 * @param requestIdSent whether the send set a request id
 * @returns `true` only when a reply is actually owed
 */
export function tracksInFlightWith(name: CapabilityName, requestIdSent: boolean): boolean {
  const entry = CAPABILITIES[name];
  if (entry.completion !== "response") {
    return false;
  }
  return requestIdSent || !entry.optionalRequestId;
}

/**
 * @param name capability name
 * @returns `true` when the wire makes `request_id` optional
 */
export function hasOptionalRequestId(name: CapabilityName): boolean {
  return CAPABILITIES[name].optionalRequestId;
}

/**
 * The registered name of the frame that acknowledges one capability.
 *
 * This is the production value for `SendDeps.replyWireOf`, which is why
 * it exists even though nothing on the send path branches on it: a real timeout
 * has to be able to say which frame it waited for.
 *
 * @param name capability name
 * @returns the reply frame name, or `undefined` when the capability has no reply
 */
export function replyWireOf(name: CapabilityName): string | undefined {
  return CAPABILITIES[name].replyWire;
}
