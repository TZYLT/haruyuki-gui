/**
 * The command envelope: one call shape, three reply arms, and the closed code
 * set the renderer branches on.
 *
 * Why the codes are split in two unions
 *   A failed command has exactly two possible authors. Either the core's own
 *   command layer refused before a byte moved (the five `COMMAND_*` codes), or
 *   the engine client answered and classified the failure itself (the seven
 *   `EngineClientErrorCode`s). Keeping them apart means a log or a test can ask
 *   "did this fail here or there" without matching string prefixes, while a
 *   consumer still only has one union to switch on. The engine codes are not
 *   re-spelled here: {@link CommandErrorCode} is a union with the imported type,
 *   so adding a client code cannot leave this surface behind.
 *
 * Why `capability` is a plain `string`
 *   The signed shape of this surface takes a string and validates it at the door
 *   (`isCapabilityName`), because the value arrives from another process as
 *   data. A later typing pass narrows it to the generated `CapabilityName` and
 *   the body to the per-capability input type; that is a type-only change and
 *   does not move bytes on the wire, so it is deliberately not anticipated here.
 *
 * Why `body` is a `Record<string, unknown>`
 *   Same reason, one step further: the command layer never interprets a body. It
 *   gates the envelope, forwards the record verbatim, and lets the engine be the
 *   only authority on a capability's fields. The per-capability shape is not
 *   this layer's property to claim.
 *
 * Why the `runtime` type is the engine client's `RuntimeScope`
 *   The two ids are forwarded untouched, so a second local spelling of
 *   `{ agent_id, conversation_id }` would be a place for a silent mismatch to
 *   live. The engine client's type is already the frozen wire spelling; reusing
 *   it keeps one definition and one place to change if the wire ever does.
 */

import type { EngineClientErrorCode } from "../engine/client/errors.js";
import type { RuntimeScope } from "../engine/client/types.js";

/**
 * The failures this layer can produce, as a walkable tuple.
 *
 * The tuple is the single source of truth for {@link CommandLayerErrorCode}, so
 * a test can iterate the whole set and a switch over the union can be checked
 * exhaustively. Order is the order the dispatcher checks them in, which is the
 * order a reader wants to see on a failure report.
 *
 * - `COMMAND_UNKNOWN_CAPABILITY` - no such capability exists in the frozen
 *   table. A build or spelling problem, not a transient one.
 * - `COMMAND_CAPABILITY_UNAVAILABLE` - the capability exists, but this runtime
 *   does not offer it. The caller should hide the affordance, not retry.
 * - `COMMAND_SCOPE_REQUIRED` - the capability needs a `runtime` scope and the
 *   call had none, or had a malformed one.
 * - `COMMAND_BAD_PAYLOAD` - the call or its `body` is not a plain object, or the
 *   body smuggles an envelope field. The caller built the request wrong.
 * - `COMMAND_CHANNEL_UNAVAILABLE` - there was no live channel to send on: the
 *   pool was never built, or is closed. Retrying is the shell's decision, never
 *   this layer's.
 */
export const COMMAND_LAYER_ERROR_CODES = [
  "COMMAND_UNKNOWN_CAPABILITY",
  "COMMAND_CAPABILITY_UNAVAILABLE",
  "COMMAND_SCOPE_REQUIRED",
  "COMMAND_BAD_PAYLOAD",
  "COMMAND_CHANNEL_UNAVAILABLE",
] as const;

/** The closed set of failures produced by this layer (see above). */
export type CommandLayerErrorCode = (typeof COMMAND_LAYER_ERROR_CODES)[number];

/**
 * Every way a command can fail, whoever refused it.
 *
 * The engine client's codes are carried unchanged: a `NOT_CONNECTED` that
 * reaches this layer is reported as `NOT_CONNECTED`, never translated into a
 * `COMMAND_*` code, because the classification is the channel's to make and the
 * renderer branches on the value it was given.
 */
export type CommandErrorCode = EngineClientErrorCode | CommandLayerErrorCode;

/**
 * One command, as the caller states it.
 *
 * `runtime` is a *sibling* of `body`, not a field inside it: it scopes this one
 * call, it is not a channel-level default and it is never cached. A capability
 * with `needsScope` requires it; a device-wide capability omits it and is routed
 * to the control channel instead.
 */
export type CommandCall = {
  /** The capability name; validated against the frozen table at the door. */
  readonly capability: string;
  /** The command body, forwarded verbatim. Must not carry envelope fields. */
  readonly body: Record<string, unknown>;
  /** The scope this one call applies to, when the capability needs one. */
  readonly runtime?: RuntimeScope;
};

/**
 * The answer to one command: three arms, no fourth.
 *
 * `answered` and `accepted` say different things, and the difference is
 * load-bearing. `answered` means a correlated reply arrived and `data` is it.
 * `accepted` means the command was *written to the channel* and nothing more: a
 * silent capability never answers, an id-less one has nothing to correlate, and
 * a duplex wire has no request/reply pairing at all. A page that renders
 * "done" on `accepted` is claiming an effect only a pushed frame can prove, so
 * the word is chosen to make that mistake visible in review.
 *
 * `ok: false` carries a code and two human-facing strings. `detail` is written
 * here, in English ASCII, for logs; `engineText` is the engine's own words and
 * is untrusted - it is shown to a user verbatim (that is its entire purpose) and
 * is never parsed for control flow. Both are optional in the type because a
 * producer may have nothing useful to add; `code` is not optional because it is
 * the only branch key.
 */
export type CommandReply =
  | { readonly ok: true; readonly completion: "answered"; readonly data: unknown }
  | { readonly ok: true; readonly completion: "accepted" }
  | {
      readonly ok: false;
      readonly code: CommandErrorCode;
      readonly detail?: string;
      readonly engineText?: string;
    };
