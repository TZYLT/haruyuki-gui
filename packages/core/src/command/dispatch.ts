/**
 * The core half of the command path: one call in, one of three replies out.
 *
 * What this module is responsible for
 *   Turning a {@link CommandCall} - untrusted data that crossed a process
 *   boundary - into either a refusal this layer owns or a `Channel.send` whose
 *   result is folded into the reply shape. It is the only place that decides
 *   *which* channel a command goes to, and the only place that derives
 *   `answered` versus `accepted`.
 *
 * What it deliberately does not do
 *   No retry, no batching, no timeout. A failed command is failed: reconnection
 *   and replay belong to the channel's own machinery, a caller that needs to
 *   coalesce high-frequency input owns that decision, and a budget is per-request
 *   state the caller sets on the request. Adding any of the three here would
 *   make the layer a scheduler, and the layer's value is that it is not one.
 *
 *   No wire vocabulary either. Capabilities are named, never spelled as ids; the
 *   send path resolves the id, and this module never sees a frame field it did
 *   not receive as an opaque body.
 *
 * Why the order of checks matters
 *   Each check is cheap, and each failure tells the caller something different
 *   about whose mistake it was. The order is "can I even read this call" ->
 *   "does the capability exist" -> "does this runtime offer it" -> "is the scope
 *   right" -> "is the payload clean" -> "is there a channel". A malformed body on
 *   an unknown capability therefore reports the unknown capability: the first
 *   question the caller has to answer is whether the name is right, and a
 *   payload complaint about a command that does not exist would send it looking
 *   in the wrong place.
 *
 * Why failure never throws
 *   The caller is a renderer that renders an error state from a code. A rejected
 *   promise would have to be caught somewhere - probably in every call site -
 *   and the classifications would then be re-invented at each of them. So every
 *   foreseeable refusal is an `ok: false` reply. The one thing that does
 *   propagate is a programming error: a callback this factory was given
 *   (`getChannel`, `isAvailable`) throwing, or a channel whose `send` rejects
 *   despite promising not to. Those are bugs in the wiring, not answers.
 */

import type { CapabilityName } from "../engine/client/capability-names.js";
import { completionOf, isCapabilityName, needsScope } from "../engine/client/capability-names.js";
import type { CommandRequest, CommandResult } from "../engine/client/types.js";

import type { CommandCall, CommandLayerErrorCode, CommandReply } from "./types.js";
import {
  findEnvelopeBodyKeys,
  isNonEmptyString,
  isPlainRecord,
  isRuntimeScope,
} from "./validate.js";

/**
 * The channel id reserved for commands that carry no scope.
 *
 * Device-wide capabilities (`device.info`, `agent.list`, ...) are still sent
 * over a channel; the pool's control connection is the one that exists without
 * an agent behind it. The id is not an agent and must never be handed out as
 * one, which is why it is spelled with the double-underscore reserved form.
 */
export const CONTROL_AGENT_ID = "__control__" as const;

/**
 * The only thing this layer needs from a channel: `send`.
 *
 * Structural on purpose. The engine client's `Channel` satisfies it, and so does
 * a test double that does nothing else, which keeps the dispatcher independent of
 * the transport's lifecycle, its event stream and its diagnostics.
 */
export interface CommandSendChannel {
  send(request: CommandRequest): Promise<CommandResult>;
}

/**
 * What the shell hands the dispatcher.
 *
 * `getChannel` returns `undefined` rather than throwing when there is no channel
 * for that id: "the pool is not built yet" and "the pool is closed" are normal
 * states during startup and shutdown, not wiring bugs, so they are an answer and
 * not an exception. A throwing `isAvailable` or `getChannel` is treated as a
 * programming error and is allowed to propagate.
 */
export interface CommandDispatcherOptions {
  getChannel(agentId: string): CommandSendChannel | undefined;
  /**
   * Whether this runtime offers the capability at all.
   *
   * Optional: without it, a capability that exists in the table is assumed to be
   * available, and the engine gets to refuse with its own classified error. The
   * hook exists so a shell that knows its engine build is old can hide the
   * affordance instead of offering a command that can only fail.
   */
  isAvailable?(capability: CapabilityName): boolean;
}

/** The handle the shell calls; the call shape is the whole point of the surface. */
export interface CommandDispatcher {
  invoke(call: CommandCall): Promise<CommandReply>;
}

/** Build one refusal from this layer, with an English ASCII `detail`. */
function refusal(code: CommandLayerErrorCode, detail: string): CommandReply {
  return { ok: false, code, detail };
}

/**
 * Folds one channel result into a reply.
 *
 * The `answered`/`accepted` split is decided here, from the capability table,
 * and never by the caller: a page that had to look up a capability's completion
 * mode would need the table, and the table stops at this boundary.
 */
function toReply(capability: CapabilityName, result: CommandResult): CommandReply {
  if (result.ok) {
    return completionOf(capability) === "response"
      ? { ok: true, completion: "answered", data: result.data }
      : { ok: true, completion: "accepted" };
  }

  // `engineText` is optional-but-present-or-absent under
  // `exactOptionalPropertyTypes`, so it is spread in rather than assigned:
  // assigning `undefined` would put the key on the object and a later
  // `"engineText" in reply` would become true for no reason.
  const { code, detail, engineText } = result.error;
  return engineText === undefined
    ? { ok: false, code, detail }
    : { ok: false, code, detail, engineText };
}

/**
 * Creates the dispatcher the shell keeps for the lifetime of one engine.
 *
 * @param options the channel lookup and the optional availability gate
 * @returns the dispatcher whose `invoke` implements the documented order
 */
export function createCommandDispatcher(options: CommandDispatcherOptions): CommandDispatcher {
  return {
    async invoke(call: CommandCall): Promise<CommandReply> {
      // 1. Read the call. Anything that is not a plain record cannot even be
      //    asked about a capability.
      if (!isPlainRecord(call)) {
        return refusal("COMMAND_BAD_PAYLOAD", "the command call is not a plain object");
      }

      // 2. Resolve the name. Non-strings and empty strings are not names, and a
      //    name outside the frozen table is a caller or build problem; both are
      //    the same answer to the caller.
      const capability: unknown = call.capability;
      if (!isNonEmptyString(capability) || !isCapabilityName(capability)) {
        return refusal(
          "COMMAND_UNKNOWN_CAPABILITY",
          "the capability is not in the frozen capability table",
        );
      }

      // 3. Ask the runtime whether it offers the capability. The hook is
      //    consulted before the payload is inspected because an unavailable
      //    command is not worth validating.
      if (options.isAvailable !== undefined && !options.isAvailable(capability)) {
        return refusal(
          "COMMAND_CAPABILITY_UNAVAILABLE",
          "the capability is not available on this runtime",
        );
      }

      // 4. Scoped capabilities must carry a scope for this call. The scope is a
      //    sibling of the body, so a body that looks like it has one is not a
      //    substitute.
      const runtime: unknown = call.runtime;
      if (needsScope(capability)) {
        if (runtime === undefined || !isRuntimeScope(runtime)) {
          return refusal(
            "COMMAND_SCOPE_REQUIRED",
            "the capability needs a runtime scope and the call did not carry a valid one",
          );
        }
      } else if (runtime !== undefined && !isRuntimeScope(runtime)) {
        // An unscoped capability may still be called with a scope (a caller
        // fanning out a shared request). A malformed one is refused rather than
        // silently dropped: forwarding a shape the engine cannot read is worse
        // than saying it is wrong.
        return refusal(
          "COMMAND_SCOPE_REQUIRED",
          "the runtime scope present on the call does not have the expected shape",
        );
      }

      // 5. Validate the payload: a plain record, and no envelope fields inside
      //    it. The body itself is not interpreted.
      const body: unknown = call.body;
      if (!isPlainRecord(body)) {
        return refusal("COMMAND_BAD_PAYLOAD", "the command body is not a plain object");
      }

      const smuggled = findEnvelopeBodyKeys(body);
      if (smuggled.length > 0) {
        return refusal(
          "COMMAND_BAD_PAYLOAD",
          `the command body carries envelope keys: ${smuggled.join(", ")}`,
        );
      }

      // 6. Pick the channel. A scoped call goes to its agent; anything else goes
      //    to the control channel, which is the only one that exists without an
      //    agent behind it.
      const agentId =
        runtime === undefined ? CONTROL_AGENT_ID : (runtime.agent_id ?? CONTROL_AGENT_ID);
      const channel = options.getChannel(agentId);
      if (channel === undefined) {
        return refusal(
          "COMMAND_CHANNEL_UNAVAILABLE",
          "no channel is available for the requested scope",
        );
      }

      // 7. Send, once. The channel owns correlation, timeouts and reconnection;
      //    this layer adds none of them.
      const request: CommandRequest =
        runtime === undefined ? { capability, body } : { capability, body, runtime };
      const result = await channel.send(request);

      // 8. Fold the answer into the reply shape.
      return toReply(capability, result);
    },
  };
}
