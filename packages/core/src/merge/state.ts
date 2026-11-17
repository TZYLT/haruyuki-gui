/**
 * State events: the engine payloads that describe "what is true now" rather
 * than a step in a message.
 *
 * The payload is handed on whole, and that is deliberate. A queue update looks
 * like a snapshot -- `queue` is the current list -- but it also carries
 * `removed`, a delta naming the entries that just left, which is the only
 * signal a consumer has for clearing a "queued" mark. Replacing the payload
 * with the newest `queue` array alone would leave that mark stranded forever,
 * because no later event mentions the departed entry again.
 *
 * Only four types are state. Anything else returns `null` rather than a
 * passthrough change, so the caller decides what an unknown type means; this
 * module never invents a kind.
 */

import type { EnvelopeFacts } from "./envelope.js";
import type { ChangeBase, MergerChange } from "./types.js";

/** The state kinds this module can produce. */
type StateKind = "state.loop" | "state.device" | "state.queue" | "state.subagents";

/**
 * Map an engine event type to its state kind.
 *
 * @param type the engine event type, matched exactly and case-sensitively
 * @returns the kind, or `null` when the type is not a state event
 */
function stateKindOf(type: string): StateKind | null {
  switch (type) {
    case "update_loop_status":
      return "state.loop";
    case "update_device_status":
      return "state.device";
    case "update_queue":
      return "state.queue";
    case "update_subagent_state":
      return "state.subagents";
    default:
      return null;
  }
}

/**
 * The who/where/when fields every change carries.
 *
 * `runtimeAgentId` becomes `""` rather than staying `null`: the change shape
 * requires a string, and an empty one keeps "the envelope named no connection"
 * distinguishable from a made-up agent id. The other identity fields keep their
 * `null`, because "no author" is a fact rather than a missing value.
 *
 * `conversationId` gets the same treatment, but only as a shape guard: the
 * envelope reader already substitutes the merger's default, so `null` reaches
 * this function only from a hand-built fact set.
 *
 * @param facts the frame's envelope facts
 */
function baseOf(facts: EnvelopeFacts): ChangeBase {
  return {
    authorAgentId: facts.authorAgentId,
    runtimeAgentId: facts.runtimeAgentId ?? "",
    subagentId: facts.subagentId,
    conversationId: facts.conversationId,
    at: facts.at,
  };
}

/**
 * Build the change for one state event.
 *
 * @param type the engine event type
 * @param raw the engine payload, kept untouched so no field can be lost
 * @param facts the frame's envelope facts
 * @returns the change, or `null` when the type is not a state event
 */
export function stateChangeOf(
  type: string,
  raw: unknown,
  facts: EnvelopeFacts,
): MergerChange | null {
  const kind = stateKindOf(type);

  if (kind === null) {
    return null;
  }

  return { ...baseOf(facts), kind, value: raw };
}
