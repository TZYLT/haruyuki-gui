/**
 * Deciding whether a replay left a hole in the history, and how to describe it.
 *
 * After a reconnect the engine answers a page of recent messages. Comparing that
 * page against the cursor where our conversation stopped is the only evidence
 * available, so this module works strictly from that comparison: it reports a
 * gap only when the cursor is absent from a page that has messages, which is the
 * one case where the break is visible from here. Everything else is either
 * continuous or unproven, and unproven is reported as no gap rather than as a
 * guess dressed up as one.
 *
 * ## Why an empty page is not a gap
 *
 * An empty answer proves nothing either way. It can mean "no new messages", it
 * can mean "the engine has nothing to give", and it can mean the request landed
 * before anything was written. None of those tells us where a boundary would be,
 * so inventing one - `range: { from: cursor, to: null }` or any variant of it -
 * would show the user a hole that may not exist and place it at a position we
 * never saw. The module refuses, and returns `null`.
 *
 * ## Why `hasMore` is not a gap
 *
 * `hasMore` says the engine holds older messages than this page; it says nothing
 * about whether any of them are missing from what we already had. Those are
 * different facts, and only the second one is a gap. A cursor that came back in
 * the page therefore stays continuous even when `hasMore` is true; the older
 * messages are simply ones we chose not to fetch.
 *
 * ## Time is the caller's
 *
 * `detectedAt` is an argument and the clock is never read here. The stamp says
 * when the caller noticed, which is the fact we hold; it is not when the gap
 * happened, and this module has no way to know that.
 */

import type { MessageId, ReplayGap } from "./types";

/** What the caller knows about where the conversation stopped and what came back. */
export interface GapInput {
  /** Where our local conversation stopped, or `null` for a conversation we never had. */
  readonly cursor: MessageId | null;
  /** Message ids the engine returned, in the order it returned them (oldest first). */
  readonly replayed: readonly string[];
  /** Whether the engine said older messages exist beyond this page. */
  readonly hasMore: boolean;
  /** When the caller noticed, ISO 8601. Never read from the clock in here. */
  readonly detectedAt: string;
}

/**
 * The provable gap between `cursor` and what the engine replayed, or `null`.
 *
 * Returns `null` for a first load, for a page that contains the cursor, and for
 * an empty page; see the module comment for why the last one is deliberate.
 */
export function detectHistoryGap(input: GapInput): ReplayGap | null {
  const { cursor, replayed, detectedAt } = input;

  // A conversation we never had has nothing to be discontinuous with.
  if (cursor === null) return null;

  // Empty page: no evidence, so no boundary to report. The destructure also
  // narrows `oldest` away from `undefined`, which is the empty case itself.
  const [oldest] = replayed;
  if (oldest === undefined) return null;

  // Continuity is proven by the cursor being present, however many ids follow.
  if (replayed.includes(cursor)) return null;

  // The cursor is missing from a non-empty page: the page starts after it, so
  // the hole runs from the cursor to the oldest id the engine did return.
  return {
    kind: "history-gap",
    at: cursor,
    range: { from: cursor, to: oldest },
    detectedAt,
  };
}

/**
 * A stream that was cut mid-answer, reported where it stopped.
 *
 * The range is always `null`: a half-streamed answer has no two ends to bound,
 * and saying `{ from: at, to: null }` would imply the other end is just unknown
 * rather than impossible to state.
 */
export function streamTruncated(at: MessageId | null, detectedAt: string): ReplayGap {
  return { kind: "stream-truncated", at, range: null, detectedAt };
}
