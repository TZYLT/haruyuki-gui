/**
 * The turn table's vocabulary: the record, the signal, the counters a diagnostic
 * reads, and the closed set of stop reasons that decides what ends a turn. Kept
 * apart from the table so an unread badge or a block layer that only *names*
 * these shapes does not carry the machinery that stores them.
 */

import type { TurnEntity } from "@haruyuki/protocol";

import type { MergerChange } from "../merge/types.js";

/** How many turn records the table keeps when the caller names no bound. */
export const TURN_TABLE_LIMIT = 512;

/** How many conversations keep a running ordinal when the caller names no bound. */
export const TURN_ORDINAL_LIMIT = 4096;

/**
 * How many `messageId -> turnRef` notes are kept when the caller names no bound.
 *
 * A note is a convenience index, not the record itself: the turn is already in
 * the table, and a message whose note has expired still has its blocks - they
 * just cannot be traced back to a turn any more, which is what the query answers
 * `null` for. The bound exists because a long-lived process sees one note per
 * message and would otherwise grow without limit.
 */
export const TURN_MESSAGE_NOTE_LIMIT = 4096;

/** How many `runId -> turnRef` notes are kept when the caller names no bound. */
export const TURN_RUN_NOTE_LIMIT = 1024;

/**
 * The stop reasons that end a turn, taken from the engine's own closed set.
 *
 * It is every value of the engine's `StopReasonType` except one, and the shape
 * is deliberate: an explicit list, not "anything that is not a pause", because
 * the list is a statement about the engine and a negative test is not. The
 * recording only ever showed two of these, so the rest are here because the
 * engine declares them, and a reason added upstream without this list growing
 * still lands on the {@link isKnownStopReason} branch rather than leaking.
 */
export const STOPS_THE_TURN: ReadonlySet<string> = new Set([
  "end_turn",
  "error",
  "llm_api_error",
  "invalid_llm_response",
  "invalid_tool_call",
  "max_steps",
  "max_tokens_exceeded",
  "no_tool_call",
  "tool_rule",
  "cancelled",
  "insufficient_credits",
  "context_window_overflow_in_system_prompt",
]);

/**
 * The one reason that does not end a turn.
 *
 * The tool call is waiting for a person; after the answer the engine continues
 * the same turn under a new run, so closing here would file the continuation as
 * a second turn.
 */
export const PAUSES_THE_TURN = "requires_approval";

/**
 * Whether a stop reason is one this layer was written against.
 *
 * @param stopReason the reason a change named
 */
export function isKnownStopReason(stopReason: string): boolean {
  return STOPS_THE_TURN.has(stopReason) || stopReason === PAUSES_THE_TURN;
}

/**
 * Which line a turn belongs to.
 *
 * The distinction has to be visible on the record and not only in a counter: an
 * unread badge counts the main agent's turns only, while a subagent's turn is a
 * real turn that opens and closes like any other but is not the reader's
 * business. This layer does not count unread itself; it makes the distinction
 * readable, and {@link isCountedTurn} states the rule in one place.
 */
export type AgentKind = "main" | "subagent";

/**
 * One turn.
 *
 * The shape is the protocol's `TurnEntity` plus the one field that layer does
 * not carry yet: which agent line produced the turn. Everything the protocol
 * declares about a turn - the stable ref, the nullable `turnId`, the open flag,
 * the usage filled in by the terminal frame - is exactly what this table keeps.
 */
export type TurnRecord = TurnEntity & { readonly agentKind: AgentKind };

/** What one ingested change did to the table. */
export type TurnEffect = "opened" | "attributed" | "backfilled" | "closed" | "ignored";

/** What one ingested change did, and to which turn. */
export type TurnSignal = {
  /** The change's kind, echoed for the caller's own logging. */
  readonly kind: string;
  readonly effect: TurnEffect;
  /** The record it touched, or `null` when it touched none. */
  readonly turnRef: string | null;
};

/**
 * One content update for a conversation's in-flight turn.
 *
 * The same three fields the session store's `ingestContent` takes: which message
 * the blocks belong to, the blocks to insert or replace, and the block ids to
 * drop. The block's own shape belongs to the block layer, so the only thing read
 * here is its id, under either of the two names a producer uses.
 */
export type TurnContentUpdate = {
  readonly messageId: string;
  readonly upserts: readonly Readonly<Record<string, unknown>>[];
  readonly removes: readonly string[];
};

/** Read-only counters for diagnostics. Nothing here is rendered. */
export type TurnTableStats = {
  /** Records currently held, open and closed together. */
  readonly turns: number;
  readonly open: number;
  readonly closed: number;
  /** Distinct conversations that still hold at least one record. */
  readonly conversations: number;
  /** Turns this table started. */
  readonly opened: number;
  /** Changes filed against a record. */
  readonly attributed: number;
  /** Changes that arrived with no record to belong to; counted, then skipped. */
  readonly unmatched: number;
  /** Inputs that could not be read at all; counted, then skipped. */
  readonly dropped: number;
  /** Terminal frames that filled an existing record. */
  readonly backfilled: number;
  /** Terminal frames that had no record to fill; nothing was created for them. */
  readonly lateCompletions: number;
  /**
   * Turns closed by `end_turn` while their `turnId` was still absent: the
   * terminal frame was lost. A non-zero reading is the reason a turn shows a
   * close time but no id.
   */
  readonly closedWithoutTerminal: number;
  /** `requires_approval` pauses seen; the turn stays open across them. */
  readonly paused: number;
  /**
   * Close signals whose stop reason this table does not know.
   *
   * A reason outside the engine's known list still closes the turn - see
   * {@link STOPS_THE_TURN} - and is counted here, because the asymmetry matters:
   * an open turn that never closes leaks a record and makes the next change join
   * a turn that already ended, while closing a turn that had not ended yet is
   * recoverable. This counter is the only trace that a newer engine taught us a
   * word we did not know.
   */
  readonly unknownStopReason: number;
  /** Records evicted to stay inside the bound. */
  readonly evicted: number;
  /** `messageId` notes currently held, and how many expired at the bound. */
  readonly messageNotes: number;
  readonly messageNotesExpired: number;
  /** `runId` notes currently held, and how many expired at the bound. */
  readonly runNotes: number;
  readonly runNotesExpired: number;
  /** Close signals per line, which is what an unread count needs. */
  readonly endTurns: Readonly<{ main: number; subagent: number }>;
};

/** Bounds for the table. */
export type TurnTableOptions = {
  /** Maximum records kept; the oldest closed one is evicted first. */
  readonly limit?: number;
  /** Maximum conversations whose ordinal is remembered. */
  readonly ordinals?: number;
  /** Maximum `messageId` notes kept, oldest evicted first. */
  readonly messageNotes?: number;
  /** Maximum `runId` notes kept, oldest evicted first. */
  readonly runNotes?: number;
};

/** The table a session store keeps for its conversations. */
export interface TurnTable {
  /** Take one merged change. Synchronous, never throws, never creates a throwaway record. */
  ingest(change: MergerChange): TurnSignal;
  /** Attach one content update to the conversation's in-flight turn. Never throws. */
  ingestContent(conversationId: string, update: TurnContentUpdate): TurnSignal;
  /** One record by its ref, or `null`. */
  get(turnRef: string): TurnRecord | null;
  /** The main agent's in-flight turn of one conversation, or `null`. */
  openTurn(conversationId: string): TurnRecord | null;
  /** The in-flight turn of one agent line, or `null`. */
  openTurnOf(conversationId: string, subagentId: string | null): TurnRecord | null;
  /** Records in the order they started; all of them, or one conversation's. */
  turns(conversationId?: string): readonly TurnRecord[];
  /**
   * The turn a message's content belongs to, or `null` when nothing claims it.
   *
   * The block layer knows which message it is rendering and has to know which
   * turn owns those blocks. It cannot read the answer off the record, because a
   * turn does not declare which messages it contains: one turn can hold several
   * messages, and the recording shows it. Asking here is the point: a second
   * note kept by the block layer would be a second ownership rule, and two rules
   * eventually disagree by hanging one message's blocks on two turns.
   *
   * `null` is an ordinary answer: the note may have expired, or the message may
   * have arrived before its turn.
   */
  turnOfMessage(conversationId: string, messageId: string): TurnRecord | null;
  /**
   * The newest turn of one conversation that ran under `runId`, or `null`.
   *
   * `runId` is not unique over time: the counter restarts with each instance, so
   * one conversation has used `local-run-1` for several different turns. When
   * more than one turn matches, this returns the one with the highest ordinal -
   * the older turns are closed, and the newest is the one in flight - so a caller
   * never has to compare them itself.
   */
  turnOfRun(conversationId: string, runId: string): TurnRecord | null;
  /** A copy of the counters; later changes do not alter it. */
  stats(): TurnTableStats;
}

/**
 * Whether a closed turn counts toward an unread badge.
 *
 * Only the main agent's turns are the reader's; a subagent's turn is noise from
 * the conversation's point of view. The rule lives here, as a predicate, so a
 * caller does not have to know that `agentKind` is the field that says it.
 *
 * @param turn one record from a table
 */
export function isCountedTurn(turn: TurnRecord): boolean {
  return turn.agentKind === "main";
}
