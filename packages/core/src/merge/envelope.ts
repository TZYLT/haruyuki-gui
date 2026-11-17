/**
 * Reads the facts a frame carries without interpreting the event.
 *
 * The client hands the envelope over as `unknown` on purpose: its four fields
 * belong to the engine, not to us, and 30 of 295 recorded frames have no
 * `event_seq` at all. This module is the only place that turns those unknowns
 * into values, and it never guesses:
 *
 * - a field that is missing stays `null` (never `0`, never `""`);
 * - `event_seq` must be a finite integer, so a string or a float is "no
 *   sequence" rather than a silent cast;
 * - the author fallback chain is `delta.agent_id -> delta.session_id ->
 *   runtime.agent_id`, and `session_id` must stay ahead of `runtime.agent_id`.
 *   The measured reason: a subagent's `stop_reason` has `agent_id = null`,
 *   `session_id = <subagent>` and `runtime.agent_id = <main>`, so putting
 *   `runtime` first files the subagent's turn under the main agent and it never
 *   closes.
 */

import type { EngineEventFrame } from "../engine/client/index.js";

/** The envelope facts one frame contributes, with `null` for "not present". */
export type EnvelopeFacts = {
  /** Finite integer `event_seq`, or `null` when the frame is unordered. */
  readonly seq: number | null;
  /** `idempotency_key`, or `null`. */
  readonly idempotencyKey: string | null;
  /** `runtime.agent_id`, or `null` when the envelope is absent. */
  readonly runtimeAgentId: string | null;
  /** `runtime.conversation_id`, already defaulted by the caller. */
  readonly conversationId: string;
  /** `delta.agent_id ?? delta.session_id ?? runtime.agent_id`, or `null`. */
  readonly authorAgentId: string | null;
  /** `msg.subagent_id`, or `null` on the main line. */
  readonly subagentId: string | null;
  /** Arrival time from B2 (not the engine's `emitted_at`). */
  readonly at: number;
};

/** Narrow an unknown to a plain record without trusting it. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** A non-empty string, or `null`. */
export function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A finite integer, or `null`; floats and numeric strings are refused. */
export function readSeq(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Read one frame's envelope facts.
 *
 * @param frame one B2 event frame
 * @param defaultConversationId used when `runtime.conversation_id` is absent
 */
export function readEnvelope(
  frame: EngineEventFrame,
  defaultConversationId: string,
): EnvelopeFacts {
  const envelope = asRecord(frame.envelope);
  const runtime = asRecord(envelope?.["runtime"]);
  const raw = asRecord(frame.raw);
  const delta = asRecord(raw?.["delta"]);

  const runtimeAgentId = readString(runtime?.["agent_id"]);

  const authorAgentId =
    readString(delta?.["agent_id"]) ?? readString(delta?.["session_id"]) ?? runtimeAgentId;

  return {
    seq: readSeq(envelope?.["event_seq"]),
    idempotencyKey: readString(envelope?.["idempotency_key"]),
    runtimeAgentId,
    conversationId: readString(runtime?.["conversation_id"]) ?? defaultConversationId,
    authorAgentId,
    subagentId: readString(raw?.["subagent_id"]),
    at: typeof frame.at === "number" && Number.isFinite(frame.at) ? frame.at : 0,
  };
}
