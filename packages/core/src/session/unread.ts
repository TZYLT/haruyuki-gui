/**
 * The unread badge: how many turns a conversation finished while nobody was
 * looking at it.
 *
 * Three rulings shape this module, and each one is a place where the obvious
 * implementation is wrong:
 *
 * 1. **Turns, not messages.** A turn is one reply, however many messages and
 *    blocks it produced. Counting message frames would turn one long answer into
 *    a five, so the unit is a closed turn record and nothing smaller is read.
 * 2. **Only while the conversation is not being watched.** What the reader sees
 *    on screen is not news. The caller owns the notion of "watched" -- it knows
 *    which view instances are active -- and reports it through
 *    {@link UnreadCounter.setActive}; a close that arrives while watched still
 *    gets remembered, so a duplicate delivery afterwards cannot count either.
 * 3. **Entering clears it.** A badge exists to say "there is something over
 *    there", not to be a ledger: one look is enough to decide, so the count goes
 *    back to zero the moment a conversation becomes watched. This module offers
 *    {@link UnreadCounter.clear} for that; when the transition happens is the
 *    subscriber's business, because only it sees view instances come and go.
 *
 * Two shapes are passed in rather than imported, because both are produced by
 * modules this one must not depend on:
 *
 * - the closed turn record, whose "is this the reader's turn?" question is
 *   already answered upstream and is asked here through that same predicate
 *   rather than a second copy of the rule;
 * - the pending-approval count, which belongs to the approval table. It arrives
 *   as a function so that the merged badge exists even when that module has not
 *   landed yet, or never does: absent means zero, and a function that throws is
 *   treated as zero too. A working count must not be lost to a broken neighbour.
 *
 * The merged figure is `unread + approvals`, computed only here, because a page
 * that added the two would own the arithmetic and a second place could disagree.
 *
 * Everything is in memory and bounded: a conversation that never comes back is
 * evicted rather than kept for the life of the process, and every eviction is
 * counted so a mistake shows up in a diagnostic reading instead of a slow leak.
 * Nothing throws -- the caller is a socket callback, and a badge is never worth
 * a session.
 */

import { isCountedTurn, type TurnRecord } from "./turns.js";

/** How many conversations are remembered when the caller names no bound. */
export const UNREAD_CONVERSATION_LIMIT = 256;

/** How many closed-turn keys are remembered for duplicate suppression. */
export const UNREAD_SEEN_LIMIT = 4096;

/** Above this figure the badge is flagged, and the page renders the capped form. */
export const UNREAD_CAP = 99;

/** Separates a conversation id from a turn id in a duplicate-suppression key. */
const KEY_SEPARATOR = "\u0000";

/**
 * Pending approvals for one conversation.
 *
 * Supplied by the assembly layer, which is the only place that can see both this
 * badge and the approval table.
 */
export type CountApprovals = (conversationId: string) => number;

/** What one navigation row shows: the two parts and their sum. */
export type UnreadBadge = {
  readonly conversationId: string;
  /** Closed turns that arrived while the conversation was not watched. */
  readonly unread: number;
  /** Pending approvals, as the injected function reported them. */
  readonly approvals: number;
  /** `unread + approvals`; a page displays it and never adds. */
  readonly badge: number;
  /** True when the number to display is "99+"; the figure itself stays honest. */
  readonly badgeCapped: boolean;
};

/** Bounds and the one injected collaborator. */
export interface UnreadCounterOptions {
  /** Maximum conversations remembered; a value that is not a positive integer is corrected. */
  readonly conversations?: number;
  /** Maximum closed-turn keys remembered; corrected the same way. */
  readonly seen?: number;
  /** Pending approvals per conversation. Absent or failing means zero. */
  readonly countApprovals?: CountApprovals;
}

/** Read-only counters for diagnostics. Nothing here is rendered. */
export type UnreadStats = {
  /** Conversations currently remembered. */
  readonly conversations: number;
  /** Closes that raised a count. */
  readonly counted: number;
  /** Closes that would have counted but the conversation was watched. */
  readonly suppressed: number;
  /** Closes on a subagent line, which are real turns but not the reader's. */
  readonly delegated: number;
  /** Redeliveries of a close already counted; a duplicate of a read turn is one too. */
  readonly duplicated: number;
  /** Closes skipped because they were not finished turns yet. */
  readonly premature: number;
  /** Inputs that could not be read at all. */
  readonly dropped: number;
  /** Conversations evicted to stay inside the bound. */
  readonly evicted: number;
};

/** What one conversation is remembered as. */
type Entry = {
  unread: number;
  active: boolean;
};

/** The table the session store keeps for its unread badges. */
export interface UnreadCounter {
  /**
   * Offer one closed turn record.
   *
   * Counts it when it is the reader's line, has not been seen before, and the
   * conversation is not being watched. Never throws.
   *
   * @param turn a record whose turn has ended
   * @returns whether the unread count rose
   */
  observe(turn: TurnRecord): boolean;
  /**
   * Report whether one conversation currently has an active view instance.
   *
   * Called by the subscriber layer whenever that answer changes. Nothing is
   * cleared here: watching turning on is the caller's signal to call
   * {@link clear}, and keeping the two calls apart means an idle re-report cannot
   * quietly wipe a count.
   *
   * @param conversationId the conversation
   * @param active true when at least one view instance is active on it
   */
  setActive(conversationId: string, active: boolean): void;
  /** Whether the conversation is currently reported as watched. */
  isActive(conversationId: string): boolean;
  /**
   * Set the unread count back to zero, as entering a conversation does.
   *
   * Idempotent, and unknown conversations are a no-op. Turn keys already seen
   * stay seen: a redelivered close of a turn that was read cannot come back as
   * new.
   *
   * @param conversationId the conversation the reader entered
   */
  clear(conversationId: string): void;
  /** Unread turns alone, uncapped. */
  unreadOf(conversationId: string): number;
  /** The merged figure a navigation row shows. */
  badgeOf(conversationId: string): UnreadBadge;
  /** A copy of the counters; later changes do not alter it. */
  stats(): UnreadStats;
}

/** The bound to use: the caller's when it is a positive integer, the default otherwise. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** A non-empty string, or `null`. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Build an unread badge table.
 *
 * @param options bounds and the injected approval count
 */
export function createUnreadCounter(options: UnreadCounterOptions = {}): UnreadCounter {
  const bound = positiveOr(options.conversations, UNREAD_CONVERSATION_LIMIT);
  const seenBound = positiveOr(options.seen, UNREAD_SEEN_LIMIT);
  const countApprovals = options.countApprovals;

  // Insertion order is recency order: every use deletes before setting, so the
  // front entry is the least recently used one.
  const entries = new Map<string, Entry>();
  const seen = new Set<string>();

  const counts = {
    counted: 0,
    suppressed: 0,
    delegated: 0,
    duplicated: 0,
    premature: 0,
    dropped: 0,
    evicted: 0,
  };

  /** Refresh one entry's position, so a conversation in use is evicted last. */
  const touch = (conversationId: string, entry: Entry): void => {
    entries.delete(conversationId);
    entries.set(conversationId, entry);
  };

  /**
   * The entry for one conversation, creating it when needed.
   *
   * A new entry can push the table past its bound. What goes first is an entry
   * with nothing to lose -- no count and not watched -- because evicting the
   * conversation the reader is sitting in would silently lose its state.
   */
  const entryOf = (conversationId: string): Entry => {
    const existing = entries.get(conversationId);

    if (existing !== undefined) {
      return existing;
    }

    while (entries.size >= bound) {
      let victim: string | null = null;

      for (const [key, entry] of entries) {
        if (entry.unread === 0 && !entry.active) {
          victim = key;
          break;
        }
      }

      if (victim === null) {
        const oldest = entries.keys().next();

        if (oldest.done === true) {
          break;
        }

        victim = oldest.value;
      }

      entries.delete(victim);
      counts.evicted += 1;
    }

    const created: Entry = { unread: 0, active: false };

    entries.set(conversationId, created);

    return created;
  };

  /** Remember one close, evicting the oldest key once the bound is exceeded. */
  const remember = (key: string): void => {
    seen.add(key);

    while (seen.size > seenBound) {
      const oldest = seen.values().next();

      if (oldest.done === true) {
        break;
      }

      seen.delete(oldest.value);
    }
  };

  /** The injected approval count, or zero when there is none to read. */
  const approvalsOf = (conversationId: string): number => {
    if (countApprovals === undefined) {
      return 0;
    }

    let reported: unknown;

    try {
      reported = countApprovals(conversationId);
    } catch {
      // A neighbour still being written must not cost the badge it feeds.
      return 0;
    }

    return typeof reported === "number" && Number.isSafeInteger(reported) && reported > 0
      ? reported
      : 0;
  };

  const unreadOf = (conversationId: string): number => {
    const entry = entries.get(conversationId);

    if (entry === undefined) {
      return 0;
    }

    touch(conversationId, entry);

    return entry.unread;
  };

  return {
    observe(turn) {
      if (typeof turn !== "object" || turn === null) {
        counts.dropped += 1;

        return false;
      }

      const conversationId = readString(turn.conversationId);

      if (conversationId === null) {
        counts.dropped += 1;

        return false;
      }

      // A record still in flight is not a finished turn. Counting it would make
      // the badge grow while the answer is visibly being written.
      if (turn.open !== false) {
        counts.premature += 1;

        return false;
      }

      // Which line produced the turn is not read here: the predicate owns the
      // rule, so a change to the rule reaches both callers at once.
      if (!isCountedTurn(turn)) {
        counts.delegated += 1;

        return false;
      }

      // Keyed by the id the terminal frame carries, with the record's own stable
      // ref as the fallback for a turn whose terminal frame was lost. Neither:
      // nothing that could tell a redelivery from a new turn, so it is skipped
      // rather than risking one count per delivery.
      //
      // Scoped to the conversation: an id is unique inside one engine session at
      // best, and two conversations that both reported `t-1` are two turns. A key
      // without the scope would let the second one pass for a redelivery.
      const id = readString(turn.turnId) ?? readString(turn.turnRef);

      if (id === null) {
        counts.dropped += 1;

        return false;
      }

      const key = `${conversationId}${KEY_SEPARATOR}${id}`;

      if (seen.has(key)) {
        counts.duplicated += 1;

        return false;
      }

      const entry = entryOf(conversationId);

      // Remembered before the watched check: the reader saw this one, so the
      // same close arriving twice must not count later either.
      remember(key);

      if (entry.active) {
        counts.suppressed += 1;

        return false;
      }

      entry.unread += 1;
      counts.counted += 1;
      touch(conversationId, entry);

      return true;
    },

    setActive(conversationId, active) {
      const id = readString(conversationId);

      if (id === null) {
        counts.dropped += 1;

        return;
      }

      const entry = entryOf(id);

      entry.active = active === true;
      touch(id, entry);
    },

    isActive(conversationId) {
      return entries.get(conversationId)?.active === true;
    },

    clear(conversationId) {
      const id = readString(conversationId);

      if (id === null) {
        counts.dropped += 1;

        return;
      }

      const entry = entries.get(id);

      if (entry === undefined) {
        return;
      }

      entry.unread = 0;
      touch(id, entry);
    },

    unreadOf,

    badgeOf(conversationId) {
      const unread = unreadOf(conversationId);
      const approvals = approvalsOf(conversationId);
      const badge = unread + approvals;

      return {
        conversationId,
        unread,
        approvals,
        badge,
        badgeCapped: badge > UNREAD_CAP,
      };
    },

    stats() {
      return { conversations: entries.size, ...counts };
    },
  };
}
