/**
 * Engine client: the outward contract of one agent's channel.
 *
 * Shape source: docs/26-B2 sections 6.1, 6.2, 6.4 and 6.5 (the request, result,
 * scope, event, capability, diagnostic and endpoint shapes) and  section
 * 5.1 (the `Channel` and `ChannelPool` signatures). Those shapes are signed and
 * are reproduced here without a signature change; the file is types only - no
 * class, no default, no parsing, no capability resolution - so the
 * implementation (D4) can change without reopening the contract.
 *
 * Architecture decision that shapes everything below: **one WebSocket per
 * agent.** `Channel` is the only handle a consumer ever holds; the socket, the
 * endpoint and the pending-request table stay private to the implementation.
 * `ChannelPool` is the agentId -> Channel map. A conversation id is a request
 * scope, never a second connection.
 *
 * Three rules the types exist to enforce:
 *
 * 1. **No wire vocabulary.** A command is named by its capability name
 *    (`CapabilityName`, generated in `@haruyuki/protocol`); the wire ids the
 *    engine answers to never appear in `packages/core`. Resolving a capability
 *    name to its wire id belongs to the mapping package, and so does
 *    appending the wire fields to a body.
 * 2. **Raw output is carried, not interpreted.** Every type that mirrors engine
 *    output keeps the untouched frame in `raw: unknown`, so an engine-side
 *    schema change cannot leak into our types. Mirrored envelope fields are
 *    optional and unvalidated: they are passed through verbatim, and nothing in
 *    this module derives state from them.
 * 3. **Failure is a value, not a throw.** `CommandResult` discriminates on
 *    `ok`, and its failure arm carries a classified `EngineClientError` whose
 *    `code` is the only branch key (see `./errors`).
 */

import type { CapabilityName } from "@haruyuki/protocol";

import type { EngineClientError } from "./errors";

/**
 * The runtime scope a command applies to, in the wire's own spelling.
 *
 * The two field names are snake_case on purpose: the object is forwarded to the
 * engine as part of the request body, and a second spelling of the same two ids
 * would be a place for a silent mismatch to live. `agent_id` is nullable so the
 * shape stays constant - a scope that is not bound to an agent carries `null`
 * rather than dropping the key, which keeps the object literal-comparable in
 * tests and in logs.
 */
export type RuntimeScope = {
  readonly agent_id: string | null;
  readonly conversation_id: string;
};

/**
 * One command, as the caller states it: a capability and a body.
 *
 * `capability` is a capability NAME. Turning it into a wire id, and folding the
 * body plus `runtime` plus `requestId` into the frame the engine expects, is the
 * mapping package's job; the channel only carries the result. Keeping
 * that split means this package can be compiled and tested without knowing a
 * single wire id.
 *
 * `body` is `unknown` rather than a per-capability generic: the contract is one
 * non-generic request shape (§6.1), and per-capability typing belongs to the
 * caller's own wrapper. `requestId` is minted by the implementation when
 * omitted. `runtime` is omitted for the device-wide commands that carry no
 * scope. `timeoutMs` is a per-request budget; the channel default applies when
 * it is omitted.
 */
export type CommandRequest = {
  readonly capability: CapabilityName;
  readonly body: unknown;
  readonly requestId?: string;
  readonly runtime?: RuntimeScope;
  readonly timeoutMs?: number;
};

/**
 * The answer to one {@link CommandRequest}.
 *
 * A discriminated union on `ok`, because *every* failure is an answer here: a
 * timeout, a refusal and a socket that died mid-flight all resolve, none of them
 * reject. That is what lets a caller write one `if` instead of a `try`/`catch`
 * around every call, and it is why `SEND_FAILED`, `NOT_CONNECTED` and `TIMEOUT`
 * are codes rather than thrown error classes.
 *
 * `data` is the decoded answer and `raw` the untouched frame; both are
 * `unknown`, so a consumer narrows the fields it needs and this layer never
 * grows a dependency on the engine's message schema.
 *
 * Branch on `error.code` only. `error.detail` and `error.engineText` are for
 * humans and logs, never for control flow (see `./errors`).
 */
export type CommandResult =
  | {
      readonly ok: true;
      /** The decoded answer, unvalidated by this layer. */
      readonly data: unknown;
      /** The untouched response frame. */
      readonly raw: unknown;
    }
  | {
      readonly ok: false;
      /** The classified failure; `code` is the branch key. */
      readonly error: EngineClientError;
    };

/**
 * The optional metadata block the engine may attach to any event frame.
 *
 * Every field is optional twice over: the engine omits the whole block on some
 * frames and individual fields on others, so a partial envelope is a normal
 * value and not a decode failure. All four fields are **passed through
 * verbatim** - this layer does not validate them, does not deduplicate on
 * `idempotency_key`, does not order on `event_seq`, and derives no state from
 * `runtime`. The consumer that needs them decodes them; the channel stays a
 * carrier.
 *
 * `emitted_at` keeps the wire's string form (ISO 8601 by observation) instead of
 * being converted to a number: converting would be interpretation, and it would
 * invent a timezone rule the engine never stated. `event_seq` is the engine's
 * own counter and is deliberately not turned into this process's ordering
 * authority - the receive order of `Channel.onEvent` is.
 */
export type EngineEventEnvelope = {
  readonly runtime?: RuntimeScope;
  readonly event_seq?: number;
  readonly emitted_at?: string;
  readonly idempotency_key?: string;
};

/**
 * One event frame, as it crossed the channel.
 *
 * `type` is the engine's own event type and stays a plain `string`: the engine
 * may emit a type this build has never heard of (a newer engine behind an older
 * host is a normal upgrade order), and refusing it would turn a forward
 * compatible addition into a broken channel. An unrecognised type is reported
 * through the `unknown-event` diagnostic; it is not a parse failure, and it does
 * not close the channel.
 *
 * `at` is the millisecond epoch at which **this process received** the frame,
 * taken from our clock. It is not `envelope.emitted_at`, and the two must not be
 * compared: they come from different clocks on different machines.
 *
 * `raw` is the untouched frame, so everything the type surface does not mirror
 * is still reachable - the diagnostic path included.
 */
export type EngineEventFrame = {
  /** The engine's event type, in the engine's own spelling. */
  readonly type: string;
  /** The untouched frame. */
  readonly raw: unknown;
  /** Millisecond epoch at which this process received the frame. */
  readonly at: number;
  /** The optional metadata block, verbatim (see {@link EngineEventEnvelope}). */
  readonly envelope?: EngineEventEnvelope;
};

/**
 * What the channel knows about one agent's capabilities: a **three-state**
 * union.
 *
 * The three states are not decoration, and the union must not be collapsed into
 * "a flag map plus an array":
 *
 * - `unknown` - nobody has asked yet. This is the state at startup, and it is
 *   distinct from "there are none". A consumer that renders slash commands must
 *   wait (or offer them optimistically) instead of concluding they are all
 *   unavailable, which is exactly what a collapsed `{ booleans: {}, slash: [] }`
 *   would make it do on the first frame it ever renders.
 * - `probed` - a probe answered, and these are its answers. `booleans` is the
 *   open-ended flag map (the engine advertises flags we do not enumerate, so an
 *   index signature is the honest shape) and `slashCommands` the advertised
 *   command names.
 * - `confirmed-empty` - the probe answered and the answer was *nothing*. It is
 *   kept apart from `probed` with empty collections because "the engine has no
 *   slash commands" is a durable fact worth caching and auditing, while an
 *   empty `probed` is indistinguishable from a probe that silently returned
 *   nothing.
 *
 * `probedAt` is our clock (millisecond epoch) and exists so a caller can decide
 * to re-probe; it is not an engine timestamp.
 */
export type CapabilitySnapshot =
  | { readonly state: "unknown" }
  | {
      readonly state: "probed";
      readonly booleans: Readonly<Record<string, boolean>>;
      readonly slashCommands: readonly string[];
      readonly probedAt: number;
    }
  | { readonly state: "confirmed-empty"; readonly probedAt: number };

/**
 * The diagnostic signals a channel can report, as a walkable tuple.
 *
 * The tuple is the single source of truth for {@link DiagnosticKind}: a
 * consumer can iterate it (log filters, a settings screen) and an exhaustive
 * `Record` in a test fails to compile when a member is added.
 *
 * Note that these are *signals*, not error codes. `unknown-event` has no
 * `EngineClientErrorCode` counterpart, because an unrecognised event type is not
 * a failed command, and `NOT_CONNECTED` / `AUTH_FAILED` have no signal here,
 * because a dead channel has no channel left to report on - those two surface
 * through a rejected `send` instead.
 */
export const DIAGNOSTIC_KINDS = [
  "timeout",
  "unknown-command",
  "unknown-event",
  "rejected",
  "send-failed",
  "malformed",
] as const;

/** The closed set of diagnostic signals (see {@link DIAGNOSTIC_KINDS}). */
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

/**
 * One diagnostic record: a failure the caller can *see* but must not treat as a
 * failed command.
 *
 * The field split is deliberate. `at` stamps *when we saw it*; `kind` is the
 * stable value a consumer branches on; `subject` names what the record is about
 * (the capability name, the event type, the request id - whatever makes the
 * record findable); and `engineText` / `engineVersion` carry the engine's own
 * words and build so a field report can be matched against engine output without
 * re-running the failing scenario. Those five together are what the diagnostic
 * surface shows a user . The seam for "which 4.2): a code, the operation, a time and
 * the engine version.
 *
 * `engineText` is untrusted engine output. It is never rendered as UI text and
 * never parsed for control flow: it is quoted in logs. Nothing in this module
 * branches on it, and `detail`-style human strings are not branch keys either
 * (see `./errors`).
 */
export type DiagnosticRecord = {
  /**
   * Millisecond epoch on **this process's clock**, taken when the record was
   * produced.
   *
   * This is our time, not the engine's. It is deliberately NOT
   * `envelope.emitted_at`: that one is the engine's own clock, its timezone is
   * not stated anywhere, and the two are therefore **not comparable**. Do not
   * subtract one from the other to derive a latency, a skew or an age - the
   * difference is dominated by clock offset between two machines and means
   * nothing. `at` answers "when did we see this", which is the only question a
   * diagnostic needs to answer; ordering engine events is `event_seq`'s job.
   *
   * It exists so the diagnostic shown to a user can carry a timestamp at all
   * . The seam for "whichs 4.2 and 6.5): "it broke a moment ago" is unusable
   * against a record with no time on it.
   */
  readonly at: number;
  /** The stable branch key. */
  readonly kind: DiagnosticKind;
  /** What the record is about, as one searchable English token or name. */
  readonly subject: string;
  /** The engine's own words, when it said anything. Untrusted, log-only. */
  readonly engineText?: string;
  /** The engine build that produced `engineText`, when it is known. */
  readonly engineVersion?: string;
};

/**
 * Where one agent's channel connects, and the secret that authorises it.
 *
 * `url` is the loopback WebSocket URL the port discovery resolved; `token` is
 * the capability token read from the token file. The token travels only in the
 * `Authorization` header - never in argv, never in a URL query, never in a log
 * line, and never in a `DiagnosticRecord`. This type is deliberately the only
 * place the token is named, so a grep for it is a complete audit trail of who
 * holds the secret.
 */
export type Endpoint = {
  readonly url: string;
  readonly token: string;
};

/**
 * One agent's channel: the only handle a consumer holds.
 *
 * The connection, the socket, the request correlation table and the retry policy
 * are implementation details behind this interface. That is the point of the
 * architecture decision: a caller can send a command and watch the event stream
 * for one agent without ever being able to touch another agent's transport, and
 * closing one agent cannot affect a neighbour.
 *
 * Behaviour the signatures imply (and the implementation must honour):
 *
 * - `send` resolves, it never rejects. Every failure - including the ones that
 *   happen before a byte leaves, such as `NOT_CONNECTED` - is the `ok: false`
 *   arm. A rejection would be a contract breach, because callers are expected
 *   to branch instead of catching.
 * - `onEvent` / `onDiagnostic` return their own unsubscribe function; removing a
 *   subscriber is idempotent, affects only future deliveries, and never
 *   disturbs other subscribers.
 * - `capabilities()` is synchronous. It reports what is known *now* without
 *   starting a probe, which is why the return type is a snapshot and not a
 *   promise; the caller decides whether `unknown` is worth waiting for.
 * - `close()` is idempotent. Once it returns, no subscriber is called again and
 *   any later `send` resolves `NOT_CONNECTED`.
 */
export interface Channel {
  readonly agentId: string;
  send(request: CommandRequest): Promise<CommandResult>;
  onEvent(subscriber: (frame: EngineEventFrame) => void): () => void;
  onDiagnostic(subscriber: (record: DiagnosticRecord) => void): () => void;
  capabilities(): CapabilitySnapshot;
  close(): void;
}

/**
 * The agentId -> {@link Channel} map.
 *
 * One channel per agent, created on demand by `getChannel`. `conversationId` is
 * an optional *default scope* for requests on that channel - it does not open a
 * second connection, and two different conversation ids for one agent share the
 * same socket. That follows from the one-connection-per-agent decision: the
 * engine multiplexes conversation scopes inside a single channel, so a
 * per-conversation socket would be a second transport for the same agent.
 *
 * `channels()` returns a point-in-time snapshot, not a live view: holding the
 * array does not keep a closed channel reachable, and iterating it while another
 * part of the process closes a channel is safe. `closeChannel` drops one entry
 * (a subsequent `getChannel` for that agent builds a fresh channel);
 * `closeAll` closes every entry and is idempotent.
 */
export interface ChannelPool {
  getChannel(agentId: string, conversationId?: string): Channel;
  channels(): readonly Channel[];
  closeChannel(agentId: string): void;
  closeAll(): void;
}
