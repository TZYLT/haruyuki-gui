/**
 * Reads what one `stream_delta` frame means without interpreting the engine's
 * other events.
 *
 * A delta is a union in disguise: the same wire type carries an assistant's
 * text, a usage report, a stop reason, or an approval request, and the only
 * discriminator is `delta.message_type`. One reading is done here, so the
 * merger does not have to repeat the field names in every branch and so a
 * malformed payload has one place to fall back to `other` instead of throwing.
 *
 * Two rules shape the code:
 *
 * 1. **Nothing is invented.** An assistant delta without a string `id` or an
 *    integer `seq_id` cannot be placed in a message, so it becomes `other`
 *    rather than an assistant change with a made-up id. A usage payload keeps
 *    only the numbers it actually reported: a missing token count is "not
 *    reported", and writing `0` would make a cost page disagree with itself.
 * 2. **The envelope is not this module's business.** `event_seq` and `runtime`
 *    belong to the envelope reader; reading them here would give the merger two
 *    sources for the same fact. Only the payload is touched.
 *
 * The field names are the engine's, not ours: the recorder writes snake_case
 * (`prompt_tokens`, `cost_input_usd`) and the snapshot keeps its camelCase names,
 * so the mapping is explicit rather than a generic snake-to-camel conversion,
 * which would also rename fields that happen to look alike.
 */

import { asRecord, readSeq, readString } from "./envelope.js";
import type { AssistantPart, UsageSnapshot } from "./types.js";

/** What one `stream_delta` payload turned out to be. */
export type DeltaClassification =
  | {
      readonly kind: "assistant";
      readonly messageId: string;
      readonly runId: string | null;
      readonly runSeq: number;
      readonly parts: readonly AssistantPart[];
    }
  | { readonly kind: "usage"; readonly runId: string | null; readonly usage: UsageSnapshot }
  | { readonly kind: "stop"; readonly runId: string | null; readonly stopReason: string }
  | {
      readonly kind: "other";
      readonly messageType: string;
      readonly messageId: string | null;
      readonly runId: string | null;
      readonly body: unknown;
    };

/**
 * Engine usage field name to snapshot field name.
 *
 * Named one by one on purpose: a generic conversion would rename a field the
 * snapshot does not have and drop the value silently, which is exactly the
 * failure this table makes impossible.
 */
const USAGE_FIELDS = [
  ["prompt_tokens", "promptTokens"],
  ["completion_tokens", "completionTokens"],
  ["total_tokens", "totalTokens"],
  ["cached_input_tokens", "cachedInputTokens"],
  ["cache_write_tokens", "cacheWriteTokens"],
  ["reasoning_tokens", "reasoningTokens"],
  ["context_tokens", "contextTokens"],
  ["context_system_tokens", "contextSystemTokens"],
  ["context_messages_tokens", "contextMessagesTokens"],
  ["context_tools_tokens", "contextToolsTokens"],
  ["cost_usd", "costUsd"],
  ["cost_input_usd", "costInputUsd"],
  ["cost_output_usd", "costOutputUsd"],
  ["cost_cache_read_usd", "costCacheReadUsd"],
  ["cost_cache_write_usd", "costCacheWriteUsd"],
] as const;

/** A usage frame that reported no number the snapshot can hold. */
const EMPTY_USAGE: UsageSnapshot = Object.freeze({});

/**
 * Copy the usage numbers a delta carries, and only those.
 *
 * @param delta the engine delta
 * @returns a snapshot with the reported fields, or `null` when none were
 */
function usageFrom(delta: Record<string, unknown>): UsageSnapshot | null {
  const reported: Record<string, number> = {};

  for (const [rawKey, snapshotKey] of USAGE_FIELDS) {
    const value = delta[rawKey];

    // A string or `null` is not a count. Dividing a string later would produce
    // `NaN` in a cost total, which is worse than the field being absent.
    if (typeof value === "number" && Number.isFinite(value)) {
      reported[snapshotKey] = value;
    }
  }

  if (Object.keys(reported).length === 0) {
    return null;
  }

  // Frozen for the same reason the merger's changes are: usage is reported once
  // and read by several consumers, and a shared mutable snapshot would let one
  // of them rewrite what another sees.
  return Object.freeze(reported) as UsageSnapshot;
}

/**
 * The usage a `stream_delta` payload reported, if it reported any.
 *
 * The message type is not checked: a caller that already knows it is looking at
 * a usage frame should not have to pass that fact back in, and a payload with
 * no usage fields answers `null` either way.
 *
 * @param raw the engine event, whose `delta` holds the numbers
 */
export function usageOf(raw: unknown): UsageSnapshot | null {
  const event = asRecord(raw);
  const delta = asRecord(event?.["delta"]);

  return delta === null ? null : usageFrom(delta);
}

/**
 * The content parts an assistant delta carries.
 *
 * An element without a string `type` is skipped: the part type is what tells the
 * consumer how to render it, and keeping a typeless element would hand the
 * renderer something it cannot display. Every other field is preserved as sent,
 * because a part's shape is the engine's to define.
 *
 * @param delta the engine delta
 */
function partsOf(delta: Record<string, unknown>): readonly AssistantPart[] {
  const content = delta["content"];

  if (!Array.isArray(content)) {
    return [];
  }

  const parts: AssistantPart[] = [];

  for (const item of content) {
    const record = asRecord(item);
    const type = readString(record?.["type"]);

    if (record !== null && type !== null) {
      parts.push({ ...record, type });
    }
  }

  return parts;
}

/**
 * The run id a delta names.
 *
 * @param delta the engine delta
 * @returns the id, or `null` when the payload does not name one
 */
function runIdOf(delta: Record<string, unknown>): string | null {
  return readString(delta["run_id"]);
}

/** An `other` classification for a payload this module will not interpret. */
function asOther(messageType: string, delta: Record<string, unknown>): DeltaClassification {
  return {
    kind: "other",
    messageType,
    messageId: readString(delta["id"]),
    runId: runIdOf(delta),
    body: delta,
  };
}

/**
 * Classify one engine event.
 *
 * @param raw the engine event; anything that is not a `stream_delta` with a
 *   `delta` object is not this module's to interpret
 * @returns the classification, or `null` for an event this module does not own
 */
export function classifyDelta(raw: unknown): DeltaClassification | null {
  const event = asRecord(raw);

  if (event === null || event["type"] !== "stream_delta") {
    return null;
  }

  const delta = asRecord(event["delta"]);

  if (delta === null) {
    return null;
  }

  const messageType = readString(delta["message_type"]);

  // A delta without a message type names no kind; guessing one would file the
  // payload under a branch that was never meant for it.
  if (messageType === null) {
    return null;
  }

  if (messageType === "assistant_message") {
    const messageId = readString(delta["id"]);
    const runSeq = readSeq(delta["seq_id"]);

    // An assistant delta is placed in a message by its id and ordered by its
    // sequence; without either it cannot be assembled, and inventing a value
    // would merge it into the wrong message.
    if (messageId === null || runSeq === null) {
      return asOther(messageType, delta);
    }

    return {
      kind: "assistant",
      messageId,
      runId: runIdOf(delta),
      runSeq,
      parts: partsOf(delta),
    };
  }

  if (messageType === "usage_statistics") {
    return { kind: "usage", runId: runIdOf(delta), usage: usageFrom(delta) ?? EMPTY_USAGE };
  }

  if (messageType === "stop_reason") {
    const stopReason = readString(delta["stop_reason"]);

    return stopReason === null
      ? asOther(messageType, delta)
      : { kind: "stop", runId: runIdOf(delta), stopReason };
  }

  return asOther(messageType, delta);
}
