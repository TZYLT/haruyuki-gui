/**
 * The in-flight turn table: one record per turn, from the change that starts it
 * to the change that closes it.
 *
 * Three measured facts decide the key, and each one rules out the obvious
 * alternative:
 *
 * 1. **A turn has no `turnId` while it streams.** Only the terminal frame
 *    carries one, so a table keyed on `turnId` would hold one turn twice: a
 *    record without an id while it runs, and a second record with an id once it
 *    ends.
 * 2. **One turn can span several runs.** In an approval the turn starts in one
 *    run, pauses on `requires_approval`, and continues in a new run after a
 *    person answers; exactly one `end_turn` closes it. A table keyed on `runId`
 *    would file the continuation as a second turn.
 * 3. **`runId` repeats.** The number is counted per instance from zero, so three
 *    different conversations have each used `local-run-1`, and two of them at
 *    the same time. A key that is not scoped to its conversation would let them
 *    overwrite one another.
 *
 * The key is therefore `<conversationId>#<ordinal>`: that conversation's own,
 * increasing turn number. It never changes over the life of a turn, including
 * when the terminal frame fills in `turnId`, `usage` and `incomplete`.
 *
 * Two rules shape everything else:
 *
 * - **`end_turn` is the only close signal.** The recording has exactly one
 *   `end_turn` per turn, for main and subagent alike, while `turn_finished` is
 *   missing from some turns entirely (a subagent turn has an `end_turn` and no
 *   terminal frame). The terminal frame only fills fields into the record that
 *   is already there; it closes nothing and creates nothing.
 * - **Nothing throws.** The caller is a socket callback: a change this table
 *   cannot place costs one change, one counter and a skipped record, never the
 *   session.
 *
 * The table is bounded. A close signal lost in a gap cannot grow it for the life
 * of the process, and every eviction is counted so the loss is visible in a
 * diagnostic reading instead of silent.
 */

import type { TurnEntity } from "@haruyuki/protocol";

import type { MergerChange, UsageSnapshot } from "../merge/types.js";

/** How many turn records the table keeps when the caller names no bound. */
export const TURN_TABLE_LIMIT = 512;

/** How many conversations keep a running ordinal when the caller names no bound. */
export const TURN_ORDINAL_LIMIT = 4096;

/** Separates a conversation id from its ordinal inside a turn ref. */
const TURN_REF_SEPARATOR = "#";

/** Separates a conversation id from the agent line inside it in an internal key. */
const LINE_SEPARATOR = "\u0000";

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
const STOPS_THE_TURN: ReadonlySet<string> = new Set([
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
const PAUSES_THE_TURN = "requires_approval";

/**
 * Whether a stop reason is one this module was written against.
 *
 * @param stopReason the reason a change named
 */
function isKnownStopReason(stopReason: string): boolean {
  return STOPS_THE_TURN.has(stopReason) || stopReason === PAUSES_THE_TURN;
}

/**
 * Which line a turn belongs to.
 *
 * The distinction has to be visible on the record and not only in a counter: an
 * unread badge counts the main agent's turns only, while a subagent's turn is a
 * real turn that opens and closes like any other but is not the reader's
 * business. This module does not count unread itself; it makes the distinction
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
  /** Close signals per line, which is what an unread count needs. */
  readonly endTurns: Readonly<{ main: number; subagent: number }>;
};

/** Bounds for the table. */
export type TurnTableOptions = {
  /** Maximum records kept; the oldest closed one is evicted first. */
  readonly limit?: number;
  /** Maximum conversations whose ordinal is remembered. */
  readonly ordinals?: number;
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

/** A non-empty string, or `null`. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A finite arrival time, or `null`. */
function readTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The string entries of a candidate list; empty when there is no list. */
function readStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => readString(item) !== null)
    : [];
}

/**
 * A reported usage snapshot, or `null`.
 *
 * An empty object stays distinct from `null`: `{}` means a report arrived and
 * named no usable number, while `null` means no report arrived. Folding the two
 * together would show a zero where the cost is simply unknown.
 */
function readUsage(value: unknown): UsageSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as UsageSnapshot;
}

/**
 * Read one field by name off a change.
 *
 * A change is a union whose arms carry different fields: `runId` exists on most
 * of them and not on an approval request, and `turnId` only on a stop and a
 * completion. Reading the few shared fields by name keeps one branch per
 * meaning instead of one branch per arm.
 *
 * @param change one merged change
 * @param name the field to read
 */
function fieldOf(change: MergerChange, name: string): unknown {
  return (change as unknown as Readonly<Record<string, unknown>>)[name];
}

/** A bound that a caller may pass: a positive integer, or the default. */
function readBound(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Build a turn table.
 *
 * @param options bounds for the records and for the remembered ordinals
 */
export function createTurnTable(options: TurnTableOptions = {}): TurnTable {
  const bound = readBound(options.limit, TURN_TABLE_LIMIT);
  const ordinalBound = readBound(options.ordinals, TURN_ORDINAL_LIMIT);

  /** Records by turn ref, in the order they started. */
  const records = new Map<string, TurnRecord>();

  /** Which agent line each record belongs to, so two lines never share a slot. */
  const lines = new Map<string, string>();

  /** The in-flight record of each agent line: line key -> turn ref. */
  const slots = new Map<string, string>();

  /** The last ordinal handed out per conversation, so it only ever increases. */
  const ordinals = new Map<string, number>();

  const counts = {
    opened: 0,
    attributed: 0,
    unmatched: 0,
    dropped: 0,
    backfilled: 0,
    lateCompletions: 0,
    closedWithoutTerminal: 0,
    paused: 0,
    unknownStopReason: 0,
    evicted: 0,
    endMain: 0,
    endSubagent: 0,
  };

  const lineKeyOf = (conversationId: string, subagentId: string | null): string =>
    `${conversationId}${LINE_SEPARATOR}${subagentId ?? ""}`;

  /**
   * The highest ordinal any record of this conversation still holds.
   *
   * Kept as a fallback under the ordinal map: a conversation whose counter was
   * evicted must not restart at one while its own records are still there, or
   * two different turns would share a ref.
   */
  const highestOrdinalInTable = (conversationId: string): number => {
    const prefix = `${conversationId}${TURN_REF_SEPARATOR}`;
    let highest = 0;

    for (const turnRef of records.keys()) {
      if (!turnRef.startsWith(prefix)) {
        continue;
      }

      const ordinal = Number.parseInt(turnRef.slice(prefix.length), 10);

      if (Number.isSafeInteger(ordinal) && ordinal > highest) {
        highest = ordinal;
      }
    }

    return highest;
  };

  /** Hand out this conversation's next ordinal; the map is refreshed, so it evicts least recent first. */
  const allocateOrdinal = (conversationId: string): number => {
    const last = Math.max(ordinals.get(conversationId) ?? 0, highestOrdinalInTable(conversationId));
    const next = last + 1;

    // Delete before set: `Map#set` on a present key keeps the old position, so
    // the refreshed entry would otherwise stay the next eviction candidate.
    ordinals.delete(conversationId);
    ordinals.set(conversationId, next);

    while (ordinals.size > ordinalBound) {
      const oldest = ordinals.keys().next();

      if (oldest.done === true) {
        break;
      }

      ordinals.delete(oldest.value);
    }

    return next;
  };

  /** Store a record; a replacement keeps its original position. */
  const keep = (record: TurnRecord): TurnRecord => {
    const frozen = Object.freeze(record);

    records.set(frozen.turnRef, frozen);

    return frozen;
  };

  /** Forget one record, its line and its slot if it held one. */
  const drop = (turnRef: string): void => {
    const lineKey = lines.get(turnRef);

    records.delete(turnRef);
    lines.delete(turnRef);

    if (lineKey !== undefined && slots.get(lineKey) === turnRef) {
      slots.delete(lineKey);
    }

    counts.evicted += 1;
  };

  /**
   * Evict until the table fits.
   *
   * Oldest closed first: a closed record is history the reader can lose, while an
   * open one is the turn currently being written. If every record is open - which
   * needs more concurrent conversations than the bound - the oldest open one goes
   * too, because an unbounded table is the worse failure.
   */
  const enforceBound = (): void => {
    while (records.size > bound) {
      let victim: string | null = null;

      for (const [turnRef, record] of records) {
        if (!record.open) {
          victim = turnRef;
          break;
        }
      }

      if (victim === null) {
        const oldest = records.keys().next();

        if (oldest.done === true) {
          break;
        }

        victim = oldest.value;
      }

      drop(victim);
    }
  };

  /** The in-flight record of one agent line, or `null`. A stale slot is cleared. */
  const openRecordOf = (conversationId: string, subagentId: string | null): TurnRecord | null => {
    const lineKey = lineKeyOf(conversationId, subagentId);
    const turnRef = slots.get(lineKey);

    if (turnRef === undefined) {
      return null;
    }

    const record = records.get(turnRef);

    if (record === undefined || !record.open) {
      slots.delete(lineKey);

      return null;
    }

    return record;
  };

  /**
   * The record a change of this line belongs to, opening one when there is none.
   *
   * Opening is idempotent per line: a second content change of the same turn
   * joins the record already in flight instead of starting a new turn. That is
   * what keeps a turn that continues under a new run in one piece.
   */
  const ensureOpen = (
    conversationId: string,
    subagentId: string | null,
    at: number,
    runId: string | null,
  ): { readonly record: TurnRecord; readonly created: boolean } => {
    const existing = openRecordOf(conversationId, subagentId);

    if (existing !== null) {
      // The opening change may not have named its run; a later one can. The run
      // is filled in once and never rewritten, so a turn that spans runs still
      // reports the run it started in.
      return {
        record: existing.runId === null && runId !== null ? keep({ ...existing, runId }) : existing,
        created: false,
      };
    }

    const turnRef = `${conversationId}${TURN_REF_SEPARATOR}${allocateOrdinal(conversationId)}`;
    const lineKey = lineKeyOf(conversationId, subagentId);

    const record: TurnRecord = {
      turnRef,
      turnId: null,
      runId,
      conversationId,
      stopReason: null,
      open: true,
      blocks: [],
      usage: null,
      incomplete: false,
      startedAt: at,
      finishedAt: null,
      agentKind: subagentId === null ? "main" : "subagent",
    };

    const frozen = keep(record);

    lines.set(turnRef, lineKey);
    slots.set(lineKey, turnRef);
    counts.opened += 1;
    enforceBound();

    return { record: frozen, created: true };
  };

  /**
   * Close one record.
   *
   * @param turnRef the record to close
   * @param at the arrival time of the closing change
   * @param stopReason the reason it named, if it named one
   * @returns false when there was nothing open to close
   */
  const closeTurn = (turnRef: string, at: number, stopReason: string | null): boolean => {
    const record = records.get(turnRef);

    if (record === undefined || !record.open) {
      return false;
    }

    const lineKey = lines.get(turnRef);

    keep({ ...record, open: false, stopReason: stopReason ?? record.stopReason, finishedAt: at });

    if (lineKey !== undefined && slots.get(lineKey) === turnRef) {
      slots.delete(lineKey);
    }

    if (record.agentKind === "main") {
      counts.endMain += 1;
    } else {
      counts.endSubagent += 1;
    }

    // The turn is closed, and nobody ever told us its id: the terminal frame was
    // lost. The close is a fact either way, so it stands; the gap is counted.
    if (record.turnId === null) {
      counts.closedWithoutTerminal += 1;
    }

    return true;
  };

  /**
   * The newest record of one line still waiting for its turn id.
   *
   * Used by the terminal frame, which fills fields into a record that already
   * exists. It is read newest-first because that record is the turn just ended;
   * an older one has presumably already been filled.
   */
  const pendingRecordOf = (
    conversationId: string,
    subagentId: string | null,
  ): TurnRecord | null => {
    const lineKey = lineKeyOf(conversationId, subagentId);
    const refs = [...records.keys()];

    for (let index = refs.length - 1; index >= 0; index -= 1) {
      const turnRef = refs[index];

      if (turnRef === undefined || lines.get(turnRef) !== lineKey) {
        continue;
      }

      const record = records.get(turnRef);

      if (record !== undefined && record.turnId === null) {
        return record;
      }
    }

    return null;
  };

  /** The id a content update names its block by, under either of its two names. */
  const blockIdOf = (value: unknown): string | null => {
    if (typeof value !== "object" || value === null) {
      return null;
    }

    const record = value as Readonly<Record<string, unknown>>;

    return readString(record["blockId"]) ?? readString(record["id"]);
  };

  const ignored = (kind: string): TurnSignal => ({ kind, effect: "ignored", turnRef: null });

  return {
    ingest(change) {
      const kind = readString(fieldOf(change, "kind")) ?? "";
      const conversationId = readString(fieldOf(change, "conversationId"));
      const at = readTime(fieldOf(change, "at"));

      if (kind === "" || conversationId === null || at === null) {
        counts.dropped += 1;

        return ignored(kind);
      }

      const subagentId = readString(fieldOf(change, "subagentId"));
      const runId = readString(fieldOf(change, "runId"));

      switch (kind) {
        case "message.delta":
        case "message.final":
        case "message.complete":
        case "message.reset": {
          const opened = ensureOpen(conversationId, subagentId, at, runId);

          counts.attributed += 1;

          return {
            kind,
            effect: opened.created ? "opened" : "attributed",
            turnRef: opened.record.turnRef,
          };
        }

        case "usage.reported": {
          const open = openRecordOf(conversationId, subagentId);

          if (open === null) {
            counts.unmatched += 1;

            return ignored(kind);
          }

          const usage = readUsage(fieldOf(change, "usage"));

          if (usage !== null) {
            keep({ ...open, usage, runId: open.runId ?? runId });
          }

          counts.attributed += 1;

          return { kind, effect: "attributed", turnRef: open.turnRef };
        }

        case "approval.requested": {
          // A request is part of the turn that is asking, not a turn of its own:
          // the turn keeps its place and resumes under a new run once a person
          // answers.
          const open = openRecordOf(conversationId, subagentId);

          if (open === null) {
            counts.unmatched += 1;

            return ignored(kind);
          }

          counts.attributed += 1;

          return { kind, effect: "attributed", turnRef: open.turnRef };
        }

        case "turn.stopped": {
          const stopReason = readString(fieldOf(change, "stopReason"));
          const open = openRecordOf(conversationId, subagentId);

          if (open === null) {
            counts.unmatched += 1;

            return ignored(kind);
          }

          if (stopReason !== null && !isKnownStopReason(stopReason)) {
            // A reason this module never heard of. Closing is the lesser error
            // by a wide margin: an open turn that nothing will close leaks a
            // record and makes the next change join a turn that already ended,
            // while a close that came one change too early is recoverable. The
            // count is how a newer engine becomes visible instead of silent.
            counts.unknownStopReason += 1;
          }

          if (stopReason !== null && STOPS_THE_TURN.has(stopReason)) {
            if (!closeTurn(open.turnRef, at, stopReason)) {
              counts.unmatched += 1;

              return ignored(kind);
            }

            counts.attributed += 1;

            return { kind, effect: "closed", turnRef: open.turnRef };
          }

          if (stopReason === null) {
            // No reason at all: the change cannot be placed, and guessing that it
            // ends the turn would close a turn on a frame that never said so.
            counts.dropped += 1;

            return ignored(kind);
          }

          // Only `requires_approval` reaches here: the turn stays open, because
          // the message may still grow after a person answers.
          if (stopReason === PAUSES_THE_TURN) {
            counts.paused += 1;
            counts.attributed += 1;

            return { kind, effect: "attributed", turnRef: open.turnRef };
          }

          // An unknown reason: counted above, and the turn is closed anyway.
          if (!closeTurn(open.turnRef, at, stopReason)) {
            counts.unmatched += 1;

            return ignored(kind);
          }

          counts.attributed += 1;

          return { kind, effect: "closed", turnRef: open.turnRef };
        }

        case "turn.finished": {
          const turnId = readString(fieldOf(change, "turnId"));
          const pending = pendingRecordOf(conversationId, subagentId);

          if (turnId === null) {
            counts.dropped += 1;

            return ignored(kind);
          }

          if (pending === null) {
            counts.lateCompletions += 1;

            return ignored(kind);
          }

          const usage = readUsage(fieldOf(change, "usage"));
          const stopReason = readString(fieldOf(change, "stopReason"));
          const incomplete = fieldOf(change, "incomplete") === true;

          // The same record, filled in: the ref, the open flag and the start
          // time are untouched, and no second record appears. A turn already
          // flagged incomplete stays incomplete, because a gap happened.
          keep({
            ...pending,
            turnId,
            runId: pending.runId ?? runId,
            usage: usage ?? pending.usage,
            incomplete: pending.incomplete || incomplete,
            stopReason: pending.stopReason ?? stopReason,
          });

          counts.backfilled += 1;
          counts.attributed += 1;

          return { kind, effect: "backfilled", turnRef: pending.turnRef };
        }

        default:
          // Conversation-level state and passthrough notices belong to no turn.
          return ignored(kind);
      }
    },

    ingestContent(conversationId, update) {
      const conversation = readString(conversationId);

      if (conversation === null) {
        counts.dropped += 1;

        return ignored("content");
      }

      const open = openRecordOf(conversation, null);

      if (open === null) {
        // A block for a turn that never opened: its opening change was lost, and
        // this module has no arrival time to start a turn with. Inventing a start
        // time would put a turn in the table that may not have existed, so the
        // update is counted and skipped instead.
        counts.unmatched += 1;

        return ignored("content");
      }

      const removes = readStrings(update?.removes);
      const kept = open.blocks.filter((blockId) => !removes.includes(blockId));
      const upserts = Array.isArray(update?.upserts) ? update.upserts : [];

      for (const upsert of upserts) {
        const blockId = blockIdOf(upsert);

        if (blockId === null) {
          counts.dropped += 1;

          continue;
        }

        // An upsert for a block already in the turn keeps its first position;
        // its content is the block layer's business, and this record only holds
        // the order.
        if (!kept.includes(blockId)) {
          kept.push(blockId);
        }
      }

      keep({ ...open, blocks: Object.freeze(kept) });
      counts.attributed += 1;

      return { kind: "content", effect: "attributed", turnRef: open.turnRef };
    },

    get(turnRef) {
      return records.get(turnRef) ?? null;
    },

    openTurn(conversationId) {
      return openRecordOf(conversationId, null);
    },

    openTurnOf(conversationId, subagentId) {
      return openRecordOf(conversationId, subagentId);
    },

    turns(conversationId) {
      const all = [...records.values()];

      return conversationId === undefined
        ? all
        : all.filter((record) => record.conversationId === conversationId);
    },

    stats() {
      const all = [...records.values()];
      const open = all.filter((record) => record.open).length;
      const conversations = new Set(all.map((record) => record.conversationId)).size;

      return Object.freeze({
        turns: all.length,
        open,
        closed: all.length - open,
        conversations,
        opened: counts.opened,
        attributed: counts.attributed,
        unmatched: counts.unmatched,
        dropped: counts.dropped,
        backfilled: counts.backfilled,
        lateCompletions: counts.lateCompletions,
        closedWithoutTerminal: counts.closedWithoutTerminal,
        paused: counts.paused,
        unknownStopReason: counts.unknownStopReason,
        evicted: counts.evicted,
        endTurns: Object.freeze({ main: counts.endMain, subagent: counts.endSubagent }),
      });
    },
  };
}
