/**
 * The navigation list: the left rail's conversation rows, in the order the
 * engine already put them in.
 *
 * The engine sorts this list once - the most recent conversation first - and
 * that sort is the authority. Nothing here compares two timestamps: the only
 * thing this layer moves is the set of conversations the reader pinned, and it
 * moves them to the front without touching the order inside either half. A
 * second sort would quietly disagree with the engine's own tie-breaking, and the
 * disagreement would show up as rows swapping places on every refresh.
 *
 * Three properties, and nothing else:
 *
 * - **Pinning is an input, not a state.** The set lives in the layout document;
 *   this function is handed it, hoists what it names, and forgets it. An id that
 *   is not in the list is ignored rather than inserted as a row nobody sent, and
 *   the order of the pinned ids themselves means nothing - the engine's order
 *   decides which pinned row comes first.
 * - **One unreadable row costs one row.** A row whose payload cannot be read
 *   keeps its place in the list carrying a problem code, and every other row is
 *   returned as usual, so a page draws the flagged row and the rest normally. A
 *   conversation that left the engine's list stays on screen marked as gone
 *   instead of disappearing: a reader may still be looking at it, and closing a
 *   tag is not this layer's decision. Nothing here throws, and nothing is
 *   filtered out for being broken.
 * - **Derived numbers come from their owners.** The badge is asked for, never
 *   counted here; whether a conversation is still writing, or may be missing
 *   content, is supplied by the layers that fold turns. This module arranges
 *   rows and does arithmetic on nothing.
 *
 * The protocol's row type has no state slot, and none is added here: the problem
 * code is the one place a page reads a row's condition from. A conversation that
 * left the list and a conversation whose payload could not be read are therefore
 * distinguishable at a glance, without widening a signed frame body.
 */

import type { ConversationRowView, NavRow, NavView } from "@haruyuki/protocol";
import { SESSION_CONVERSATION_GONE, SESSION_ROW_UNREADABLE } from "@haruyuki/protocol";

import { ENTITY_ID_CHAR_LIMIT } from "./entities.js";
import { UNREAD_CAP } from "./unread.js";

/** The three words a conversation row's state can take, as the protocol declares them. */
type NavConversationState = ConversationRowView["state"];

/**
 * One row handed in.
 *
 * Every field is optional and untyped on purpose: the caller's rows come off a
 * socket, and this layer's job includes the row that arrived truncated. A row
 * whose id cannot be read has no place in a list and is skipped; every other
 * field degrades to a documented default per row.
 */
export type NavRowSource = {
  readonly conversationId?: unknown;
  readonly title?: unknown;
  readonly state?: unknown;
  readonly streaming?: unknown;
  readonly approvals?: unknown;
  readonly lastActivityAt?: unknown;
  /** A code from the protocol's problem table, when the caller already has one. */
  readonly problem?: unknown;
};

/** What one conversation's badge reads as, as its owner reports it. */
export type NavBadgeReading = {
  /** Closed turns that arrived while the conversation was not watched. */
  readonly unread?: number;
  /** Pending approvals, as the approval table reports them. */
  readonly approvals?: number;
  /** `unread + approvals`; a page displays it and never adds. */
  readonly badge?: number;
  /** Whether the page renders the capped form for this row. */
  readonly badgeCapped?: boolean;
};

/** Everything one navigation list is built from. */
export type NavBuildInput = {
  /** The engine's own order, newest conversation first. It is never re-sorted. */
  readonly rows: readonly NavRowSource[];
  /** The ids the reader pinned, as an input. Not stored, not written back. */
  readonly pinned: readonly string[];
  /** Whether the caller knows of more rows behind the ones it handed in. Echoed. */
  readonly hasMore: boolean;
  /** The badge owner: unread turns plus pending approvals, for one conversation. */
  readonly badgeOf: (conversationId: string) => NavBadgeReading | null | undefined;
  /** Whether one conversation is currently writing; defaults to the row's own field. */
  readonly streamingOf?: (conversationId: string) => boolean;
  /** Whether one conversation may be missing content; defaults to false. */
  readonly incompleteOf?: (conversationId: string) => boolean;
};

/** The id length this layer accepts, matching the conversation table's rule. */
const ID_CHAR_LIMIT = ENTITY_ID_CHAR_LIMIT;

/** An id, or `null` when the value cannot be one. */
function readId(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > ID_CHAR_LIMIT) {
    return null;
  }

  return value;
}

/** A text field, or `null`; an empty value is a missing one, not an empty name. */
function readText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A count, or `null` when the value is not one a badge could be. */
function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A flag, read strictly: anything but `true` is not a yes. */
function readFlag(value: unknown): boolean {
  return value === true;
}

/** A row's state, or `null` when the value is not one of the three words. */
function readState(value: unknown): NavConversationState | null {
  return value === "ok" || value === "gone" || value === "unreadable" ? value : null;
}

/**
 * Read one field, or take the fallback.
 *
 * A row is a value off a socket, so reading it may itself be what fails: a
 * getter that throws must cost this field and no more. This is the only reason
 * the reader below is written field by field.
 */
function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** The pinned ids as a set: unknown, duplicated and unusable entries cost nothing. */
function readPinned(pinned: readonly string[]): ReadonlySet<string> {
  const ids = new Set<string>();
  const entries: readonly unknown[] = Array.isArray(pinned) ? pinned : [];

  for (const entry of entries) {
    const id = readId(entry);

    if (id !== null) {
      ids.add(id);
    }
  }

  return ids;
}

/**
 * Why one row carries a problem, or `null` when it is fine.
 *
 * The caller's own code wins when it has one; otherwise a row that left the
 * engine's list is gone, and a row whose payload could not be read - including
 * the row whose state word is not one of the three - is unreadable. This is a
 * per-row answer: a page draws a flagged row and its neighbours normally.
 */
function problemOf(state: NavConversationState | null, declared: string | null): string | null {
  if (declared !== null) {
    return declared;
  }

  if (state === "gone") {
    return SESSION_CONVERSATION_GONE;
  }

  return state === "ok" ? null : SESSION_ROW_UNREADABLE;
}

/**
 * Build the navigation list for one page of conversation rows.
 *
 * @param input the rows in the engine's order, the pinned ids, the echoed
 *   `hasMore`, and the owner functions for the derived figures
 * @returns the rows, pinned ones hoisted, plus `hasMore` unchanged
 */
export function buildNavView(input: NavBuildInput): NavView {
  const pinned = readPinned(input.pinned);
  const handed: readonly unknown[] = Array.isArray(input.rows) ? input.rows : [];
  const badgeOf = input.badgeOf;
  const streamingOf = input.streamingOf;
  const incompleteOf = input.incompleteOf;

  /**
   * The badge for one row, from its owner, with a local fallback.
   *
   * The owner is authoritative and is asked for every row, including a row whose
   * own payload was unreadable: a conversation whose badge is known should still
   * show it. When the owner has nothing to say - it threw, it is absent, or it
   * named no figure at all - the row's own approval count is all that is left,
   * and that is what it gets. The cap is never re-derived from a figure the owner
   * already capped.
   */
  const badgeOfRow = (
    conversationId: string,
    rowApprovals: number,
  ): { readonly badge: number; readonly badgeCapped: boolean } => {
    const reading: NavBadgeReading | null | undefined = attempt(
      () => badgeOf(conversationId),
      null,
    );
    const asked =
      reading === null || reading === undefined
        ? null
        : attempt(() => {
            const unread = readCount(reading.unread);
            const approvals = readCount(reading.approvals);
            const whole = readCount(reading.badge);
            const named =
              whole ??
              (unread === null && approvals === null ? null : (unread ?? 0) + (approvals ?? 0));

            return {
              named,
              capped: typeof reading.badgeCapped === "boolean" ? reading.badgeCapped : null,
            };
          }, null);

    const badge = asked?.named ?? rowApprovals;

    return {
      badge,
      badgeCapped: asked?.capped ?? badge > UNREAD_CAP,
    };
  };

  /** One row, composed from what its payload could be read as. */
  const composeRow = (raw: unknown, conversationId: string): NavRow => {
    const source = raw as NavRowSource;
    const state = readState(attempt(() => source.state, undefined));
    const declared = readText(attempt(() => source.problem, null));
    const rowApprovals = readCount(attempt(() => source.approvals, null)) ?? 0;
    const rowStreaming = readFlag(attempt(() => source.streaming, false));
    const figures = badgeOfRow(conversationId, rowApprovals);

    const streaming =
      streamingOf === undefined
        ? rowStreaming
        : readFlag(attempt(() => streamingOf(conversationId), rowStreaming));
    const incomplete =
      incompleteOf === undefined
        ? false
        : readFlag(attempt(() => incompleteOf(conversationId), false));

    return Object.freeze({
      conversationId,
      title: readText(attempt(() => source.title, null)),
      badge: figures.badge,
      badgeCapped: figures.badgeCapped,
      streaming,
      incomplete,
      pinned: pinned.has(conversationId),
      lastActivityAt: readText(attempt(() => source.lastActivityAt, null)),
      problem: problemOf(state, declared),
    });
  };

  // Two halves, each in the order it arrived: the pinned rows first, then the
  // rest. Nothing is compared, and nothing is reordered inside a half.
  const hoisted: NavRow[] = [];
  const remainder: NavRow[] = [];
  const held = new Set<string>();

  for (const raw of handed) {
    const conversationId = attempt(
      () => readId((raw as NavRowSource | null)?.conversationId),
      null,
    );

    // A row without a usable id is not a row: there is nothing to file it under
    // and nothing a page could key its tag on. A re-sent row replaces nothing
    // here, so the first one keeps the place - the engine's order decides it.
    if (conversationId === null || held.has(conversationId)) {
      continue;
    }

    held.add(conversationId);

    const row = composeRow(raw, conversationId);

    if (pinned.has(conversationId)) {
      hoisted.push(row);
    } else {
      remainder.push(row);
    }
  }

  return Object.freeze({
    rows: Object.freeze([...hoisted, ...remainder]),
    hasMore: input.hasMore,
  });
}
