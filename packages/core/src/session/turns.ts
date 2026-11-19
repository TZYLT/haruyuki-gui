/**
 * The in-flight turn table: one record per turn, from the change that starts it
 * to the change that closes it.
 *
 * The vocabulary the table speaks - the record, the signal, the counters a
 * diagnostic reads and the closed set of stop reasons - lives in
 * `turns-types.ts`. How a turn is named lives in `turns-ref.ts`, and the two
 * bounded convenience indexes - which turn owns a message, which turn a run ran
 * in - live in `turns-notes.ts`. What stays here is the state machine: opening,
 * attributing, closing, backfilling, and the bound that keeps the table finite.
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

import type { MergerChange, UsageSnapshot } from "../merge/types.js";

import { createNoteBook, type NoteBook } from "./turns-notes.js";
import {
  createOrdinalAllocator,
  highestOrdinalOf,
  lineKeyOf,
  ordinalOf,
  TURN_REF_SEPARATOR,
} from "./turns-ref.js";
import {
  isKnownStopReason,
  PAUSES_THE_TURN,
  STOPS_THE_TURN,
  TURN_MESSAGE_NOTE_LIMIT,
  TURN_ORDINAL_LIMIT,
  TURN_RUN_NOTE_LIMIT,
  TURN_TABLE_LIMIT,
  type TurnContentUpdate,
  type TurnRecord,
  type TurnSignal,
  type TurnTable,
  type TurnTableOptions,
  type TurnTableStats,
} from "./turns-types.js";

// The public vocabulary is re-stated here so consumers keep importing this
// module for every name it always exported. The table below is a local
// declaration, so this is a defining module, not a pure forwarding one.
export {
  isCountedTurn,
  TURN_MESSAGE_NOTE_LIMIT,
  TURN_ORDINAL_LIMIT,
  TURN_RUN_NOTE_LIMIT,
  TURN_TABLE_LIMIT,
  type AgentKind,
  type TurnContentUpdate,
  type TurnEffect,
  type TurnRecord,
  type TurnSignal,
  type TurnTable,
  type TurnTableOptions,
  type TurnTableStats,
} from "./turns-types.js";

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
  const messageNoteBound = readBound(options.messageNotes, TURN_MESSAGE_NOTE_LIMIT);
  const runNoteBound = readBound(options.runNotes, TURN_RUN_NOTE_LIMIT);

  /** Records by turn ref, in the order they started. */
  const records = new Map<string, TurnRecord>();

  /** Which agent line each record belongs to, so two lines never share a slot. */
  const lines = new Map<string, string>();
  /** The in-flight record of each agent line: line key -> turn ref. */
  const slots = new Map<string, string>();

  /** This conversation's running turn number, so it only ever increases. */
  const allocateOrdinal = createOrdinalAllocator(ordinalBound, (conversationId) =>
    highestOrdinalOf(records.keys(), conversationId),
  );

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
    messageNotesExpired: 0,
    runNotesExpired: 0,
    endMain: 0,
    endSubagent: 0,
  };

  /**
   * Which turn each message belongs to, keyed by conversation and message.
   *
   * A note, not a copy: the value is the ref the record already has, so this
   * cannot disagree with the table about who owns what - it can only forget.
   */
  const messageNotes = createNoteBook(messageNoteBound, () => {
    counts.messageNotesExpired += 1;
  });

  /** Which turn each run belongs to, keyed by conversation and run. */
  const runNotes = createNoteBook(runNoteBound, () => {
    counts.runNotesExpired += 1;
  });

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

    // The notes outlive their record on purpose: a closed turn is exactly the
    // one a block layer still asks about while the screen catches up. A note
    // whose record is gone is dropped by the lookup, not here.
    counts.evicted += 1;
  };

  /**
   * The record a note points at, or `null`.
   *
   * A note whose record has been evicted answers `null` instead of handing back
   * a ref nobody can resolve. That is the one place where the note and the table
   * are reconciled, so no caller has to check twice.
   */
  const recordOfNote = (
    notes: NoteBook,
    conversationId: string,
    subjectId: string,
  ): TurnRecord | null => {
    const turnRef = notes.refOf(conversationId, subjectId);

    return turnRef === undefined ? null : (records.get(turnRef) ?? null);
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

    // The run that opened the turn is noted here; the run a continuation uses is
    // noted by the change that carries it. Both point at this same ref.
    if (runId !== null) {
      runNotes.note(conversationId, runId, turnRef);
    }

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
          const messageId = readString(fieldOf(change, "messageId"));

          // One turn holds several messages, and every one of them is noted
          // against the same ref: a block layer asking about any of them must
          // land on this turn, not on a neighbour.
          if (messageId !== null) {
            messageNotes.note(conversationId, messageId, opened.record.turnRef);
          }

          if (runId !== null) {
            runNotes.note(conversationId, runId, opened.record.turnRef);
          }

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
            // A reason this layer never heard of. Closing is the lesser error
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

    ingestContent(conversationId, update: TurnContentUpdate) {
      const conversation = readString(conversationId);

      if (conversation === null) {
        counts.dropped += 1;

        return ignored("content");
      }

      const open = openRecordOf(conversation, null);

      if (open === null) {
        // A block for a turn that never opened: its opening change was lost, and
        // this layer has no arrival time to start a turn with. Inventing a start
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

    turnOfMessage(conversationId, messageId) {
      const conversation = readString(conversationId);
      const message = readString(messageId);

      if (conversation === null || message === null) {
        return null;
      }

      return recordOfNote(messageNotes, conversation, message);
    },

    turnOfRun(conversationId, runId) {
      const conversation = readString(conversationId);
      const run = readString(runId);

      if (conversation === null || run === null) {
        return null;
      }

      const noted = recordOfNote(runNotes, conversation, run);

      // The note already points at the newest turn this conversation ran under
      // that id, because every later note overwrites the earlier one.
      if (noted !== null) {
        return noted;
      }

      // Without a note - an evicted one, or a run noted by nobody - fall back to
      // reading the table itself, newest first: the same answer, from the record
      // rather than from the index.
      let newest: TurnRecord | null = null;

      for (const record of records.values()) {
        if (record.conversationId !== conversation || record.runId !== run) {
          continue;
        }

        if (newest === null || ordinalOf(record.turnRef) >= ordinalOf(newest.turnRef)) {
          newest = record;
        }
      }

      return newest;
    },

    stats(): TurnTableStats {
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
        messageNotes: messageNotes.size(),
        messageNotesExpired: counts.messageNotesExpired,
        runNotes: runNotes.size(),
        runNotesExpired: counts.runNotesExpired,
        endTurns: Object.freeze({ main: counts.endMain, subagent: counts.endSubagent }),
      });
    },
  };
}
