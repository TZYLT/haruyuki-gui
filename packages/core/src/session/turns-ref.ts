/**
 * How a turn is named, and how a conversation's ordinal is handed out.
 *
 * The key is `<conversationId>#<ordinal>`: a turn has no `turnId` while it
 * streams, one turn can span several runs across an approval, and `runId` is
 * counted per instance so two conversations reuse the same one. The ref never
 * changes over a turn's life, including when the terminal frame fills in
 * `turnId`, `usage` and `incomplete`.
 */

/** Separates a conversation id from its ordinal inside a turn ref. */
export const TURN_REF_SEPARATOR = "#";

/** Separates a conversation id from the agent line inside it in an internal key. */
export const LINE_SEPARATOR = "\u0000";

/**
 * The internal key of one agent line of one conversation.
 *
 * @param conversationId the conversation the line belongs to
 * @param subagentId the line's subagent, or `null` for the main line
 */
export function lineKeyOf(conversationId: string, subagentId: string | null): string {
  return `${conversationId}${LINE_SEPARATOR}${subagentId ?? ""}`;
}

/**
 * The ordinal part of a turn ref, or zero when it cannot be read.
 *
 * Reading the number back out of the ref keeps "newest" one definition instead
 * of a second one stored beside it: the ref already sorts, because it ends in
 * the ordinal.
 *
 * @param turnRef a ref this layer built
 */
export function ordinalOf(turnRef: string): number {
  const separator = turnRef.lastIndexOf(TURN_REF_SEPARATOR);
  const ordinal = separator === -1 ? Number.NaN : Number.parseInt(turnRef.slice(separator + 1), 10);

  return Number.isSafeInteger(ordinal) ? ordinal : 0;
}

/**
 * The highest ordinal any ref of this conversation still holds.
 *
 * Kept as a fallback under the ordinal map: a conversation whose counter was
 * evicted must not restart at one while its own records are still there, or two
 * different turns would share a ref.
 *
 * @param turnRefs every ref the table currently holds
 * @param conversationId the conversation to look at
 */
export function highestOrdinalOf(turnRefs: Iterable<string>, conversationId: string): number {
  const prefix = `${conversationId}${TURN_REF_SEPARATOR}`;
  let highest = 0;

  for (const turnRef of turnRefs) {
    if (!turnRef.startsWith(prefix)) {
      continue;
    }

    const ordinal = Number.parseInt(turnRef.slice(prefix.length), 10);

    if (Number.isSafeInteger(ordinal) && ordinal > highest) {
      highest = ordinal;
    }
  }

  return highest;
}

/** Hand out each conversation's next ordinal, remembering the last one it used. */
export type OrdinalAllocator = (conversationId: string) => number;

/**
 * Build the ordinal allocator.
 *
 * @param bound how many conversations are remembered; least recent is evicted first
 * @param highestOf the highest ordinal a conversation still holds in the table
 */
export function createOrdinalAllocator(
  bound: number,
  highestOf: (conversationId: string) => number,
): OrdinalAllocator {
  /** The last ordinal handed out per conversation, so it only ever increases. */
  const ordinals = new Map<string, number>();

  return (conversationId) => {
    const last = Math.max(ordinals.get(conversationId) ?? 0, highestOf(conversationId));
    const next = last + 1;

    // Delete before set: `Map#set` on a present key keeps the old position, so
    // the refreshed entry would otherwise stay the next eviction candidate.
    ordinals.delete(conversationId);
    ordinals.set(conversationId, next);

    while (ordinals.size > bound) {
      const oldest = ordinals.keys().next();

      if (oldest.done === true) {
        break;
      }

      ordinals.delete(oldest.value);
    }

    return next;
  };
}
