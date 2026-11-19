/**
 * Reasoning segments: the engine sends one thinking message per fragment, and
 * several fragments may share one reasoning id.
 *
 * The assembly rule is deliberately small:
 *
 * - A fragment with `seq_id` is a numbered piece of its segment, so the segment
 *   is rebuilt by sorting those pieces. A repeated `seq_id` is ignored after its
 *   first copy -- a retransmitted frame must not make the paragraph stutter.
 * - A fragment without `seq_id` has no declared position, so it keeps arrival
 *   order. Stream fragments of one segment are contiguous, which makes arrival
 *   order the only order the provider gave us.
 * - The segment's own position in the conversation is the order it was first
 *   seen. A late fragment never moves a segment behind a newer one.
 *
 * Nothing here writes to `MessageState` or touches the protocol: the aggregator
 * is in-flight assembly owned by this module, and the returned block is a copy
 * the facade hands to the store.
 */

import type { ReasoningBlock } from "@haruyuki/protocol";

import type { SourceMessage } from "./types.js";

/** One upsert of a reasoning block, addressed to its parent assistant message. */
export type ReasoningBlockUpdate = {
  readonly messageId: string;
  readonly block: ReasoningBlock;
};

/**
 * One reasoning segment and the fragments seen for it.
 *
 * `chunks` holds the numbered fragments; `loose` holds the unnumbered ones in
 * arrival order. `text` is the last text handed out, so a duplicate or a repeat
 * that changes nothing can be reported as "no update" instead of emitting an
 * identical block again.
 */
export type ReasoningSegment = {
  /** The reasoning id exactly as the engine sent it; the map key. */
  readonly reasoningId: string;
  /** The block id derived from the parent and the segment number. */
  readonly blockId: string;
  /** The parent assistant message, or the reasoning id when it could not be split. */
  readonly messageId: string;
  /** The parsed segment number, or `null` when the id did not contain one. */
  readonly segment: number | null;
  runId: string | null;
  readonly chunks: Map<number, string>;
  readonly loose: string[];
  text: string;
};

/** In-flight reasoning state for one conversation. */
export type ReasoningAggregator = {
  /** Segments keyed by reasoning id, in first-appearance order. */
  readonly segments: Map<string, ReasoningSegment>;
};

/** Start an empty aggregator; one per conversation, like the content model. */
export function createReasoningAggregator(): ReasoningAggregator {
  return { segments: new Map<string, ReasoningSegment>() };
}

/** Drop every segment at a connection or conversation boundary. */
export function clearReasoning(aggregator: ReasoningAggregator): void {
  aggregator.segments.clear();
}

/**
 * Drop the segments that belong to one consumed message.
 *
 * A segment's owner is its parent assistant message when the reasoning id could
 * be split; when it could not, the reasoning id itself is the owner. Releasing
 * only that owner gives the memory back without touching another message's
 * segments. A later fragment for the same reasoning id starts a new segment
 * with the same block id -- the rebuild the release contract allows -- because
 * the released text is gone and must not be invented back.
 */
export function releaseReasoning(aggregator: ReasoningAggregator, messageId: string): void {
  for (const [reasoningId, segment] of aggregator.segments) {
    if (segment.messageId === messageId || segment.reasoningId === messageId) {
      aggregator.segments.delete(reasoningId);
    }
  }
}

/**
 * `<parent>:reasoning:<segment>` with a parent that may itself contain colons.
 *
 * The greedy prefix plus the anchored numeric tail means `a:b:reasoning:7`
 * splits into parent `a:b` and segment `7`, while a plain reasoning id such as
 * `reasoning-abc` does not match at all and falls back to the whole id.
 */
const REASONING_ID_PATTERN = /^(.*):reasoning:(\d+)$/;

/** The two parts of a reasoning id that can be recovered from its text. */
type ParsedReasoningId = {
  readonly parentId: string;
  readonly segment: number;
};

/** Split a reasoning id, or `null` when it does not have the documented shape. */
function parseReasoningId(reasoningId: string): ParsedReasoningId | null {
  const match = REASONING_ID_PATTERN.exec(reasoningId);
  if (match === null) {
    return null;
  }

  const parentId = match[1];
  const digits = match[2];
  if (parentId === undefined || parentId.length === 0 || digits === undefined) {
    return null;
  }

  const segment = Number(digits);
  if (!Number.isSafeInteger(segment)) {
    return null;
  }

  return { parentId, segment };
}

/** One fragment read out of a reasoning message's body. */
type ReasoningFragment = {
  readonly text: string;
  /** The provider's sequence number, or `null` when the fragment has none. */
  readonly seq: number | null;
};

/**
 * Read the fragment fields without trusting the body.
 *
 * A non-string `reasoning` is not a fragment (a malformed frame must not throw
 * and must not consume a slot); a non-finite `seq_id` is treated as absent
 * rather than sorting the segment by an unusable value.
 */
function fragmentOf(body: unknown): ReasoningFragment | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const record = body as { readonly reasoning?: unknown; readonly seq_id?: unknown };
  if (typeof record.reasoning !== "string") {
    return null;
  }

  const seq =
    typeof record.seq_id === "number" && Number.isFinite(record.seq_id) ? record.seq_id : null;

  return { text: record.reasoning, seq };
}

/**
 * Join the fragments of one segment.
 *
 * No separator is inserted: the pieces are slices of the provider's stream and
 * any word boundary is already part of the text (`"hel" + "lo" = "hello"`).
 * Numbered pieces come first in sequence order; unnumbered pieces follow in
 * arrival order, which is the only order available for them.
 */
function joinFragments(segment: ReasoningSegment): string {
  let text = "";

  if (segment.chunks.size > 0) {
    const seqs = [...segment.chunks.keys()].sort((left, right) => left - right);
    for (const seq of seqs) {
      text += segment.chunks.get(seq) ?? "";
    }
  }

  for (const chunk of segment.loose) {
    text += chunk;
  }

  return text;
}

/** Build a fresh block so the caller cannot mutate the aggregator's state. */
function blockOf(segment: ReasoningSegment): ReasoningBlock {
  return {
    id: segment.blockId,
    messageId: segment.messageId,
    runId: segment.runId,
    role: "assistant",
    type: "reasoning",
    text: segment.text,
  };
}

/** Create the segment entry for a reasoning id that was just seen. */
function createSegment(aggregator: ReasoningAggregator, message: SourceMessage): ReasoningSegment {
  const parsed = parseReasoningId(message.id);
  const blockId =
    parsed === null
      ? `${message.id}:reasoning:0`
      : `${parsed.parentId}:reasoning:${parsed.segment}`;

  const segment: ReasoningSegment = {
    reasoningId: message.id,
    blockId,
    messageId: parsed === null ? message.id : parsed.parentId,
    segment: parsed === null ? null : parsed.segment,
    runId: message.runId,
    chunks: new Map<number, string>(),
    loose: [],
    text: "",
  };

  aggregator.segments.set(message.id, segment);

  return segment;
}

/**
 * Fold one reasoning message into its segment and return the upsert to apply.
 *
 * Returns `null` when the message is not a reasoning message, when its text is
 * empty or malformed, when its `seq_id` was already seen, or when the rebuilt
 * text did not change. A non-null result always carries the whole segment text,
 * not just the new fragment, because the consumer replaces the block in place.
 */
export function ingestReasoning(
  aggregator: ReasoningAggregator,
  message: SourceMessage,
): ReasoningBlockUpdate | null {
  if (message.messageType !== "reasoning_message") {
    return null;
  }

  const fragment = fragmentOf(message.body);
  if (fragment === null || fragment.text.length === 0) {
    return null;
  }

  const existing = aggregator.segments.get(message.id);
  const segment = existing ?? createSegment(aggregator, message);

  // A later fragment may be the first one to carry a run id (history pages do
  // not always have one); a later null must not erase what we already know.
  if (message.runId !== null) {
    segment.runId = message.runId;
  }

  if (fragment.seq !== null) {
    if (segment.chunks.has(fragment.seq)) {
      // First copy wins: a retransmitted frame must not duplicate or rewrite
      // the paragraph, and a conflicting rewrite is not something to guess at.
      return null;
    }
    segment.chunks.set(fragment.seq, fragment.text);
  } else {
    segment.loose.push(fragment.text);
  }

  const text = joinFragments(segment);
  if (text === segment.text) {
    return null;
  }
  segment.text = text;

  return { messageId: segment.messageId, block: blockOf(segment) };
}
