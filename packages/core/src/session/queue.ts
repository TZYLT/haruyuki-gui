/**
 * Two state frames folded into their session entities: the pending-input queue
 * of a conversation, and the subagent runs attached to it.
 *
 * The two look alike - both are "what is true now" payloads - but they need
 * different rules, and that difference is the reason this module exists.
 *
 * ### The queue frame is a snapshot *and* a departure list
 *
 * `update_queue` carries `queue`, the current list, and `removed`, a list of
 * transition records naming the entries that just left it. Each record is
 * `{ client_message_id, disposition }`, where the disposition says whether the
 * entry was dequeued or cancelled. Reading the list alone leaves a departed
 * entry on screen forever: no later frame mentions it again, because the next
 * snapshot simply does not contain it, and "absent from a list" is not a signal
 * a reader can tell apart from "not loaded yet". That is the failure this module
 * prevents - the "queued" mark on a message that has already started would never
 * be withdrawn.
 *
 * One frame is therefore applied as: its list, minus every entry that same frame
 * names as departed. The departure wins over the list when both mention an
 * entry, and the reason is a timing one: within one frame the list is what the
 * engine knew when it began building the frame, while `removed` is the event
 * that made it build one. A snapshot that still names a departed entry is the
 * stale half. Applying the list over the departures - the other order - would
 * put the entry straight back and the mark would stay.
 *
 * Departures are not remembered across frames. That buys the two properties a
 * consumer of a lossy channel needs:
 *
 * - **Replay is idempotent.** Feeding one payload twice lands on the same
 *   entity, because an entry that is already gone is not there to leave twice.
 * - **The last frame alone is enough**, for every payload the engine sends: each
 *   recorded queue frame carries its list, so a late subscriber that drops all
 *   intermediate frames lands on the same entity as one that folded every one.
 *   A payload carrying only `removed` has no list of its own and is applied to
 *   the list the caller already has; that path exists because such a payload
 *   says nothing about the rest of the queue, and it is the one case where the
 *   fold needs history - a property of the payload, not of the fold.
 *
 * The order of the list is the engine's order. Nothing here sorts, groups or
 * de-duplicates it, and every field of an entry is kept untouched - `paused:
 * true` in particular, which marks an entry parked by an interrupt.
 *
 * ### The subagent frame is a snapshot only
 *
 * `update_subagent_state` carries `subagents`, the full list of runs for a
 * conversation, and no departure list: a run that starts as `pending` and later
 * reports `completed` is the same row with a new status, and a snapshot needs no
 * delta to say something is over. The entity's status is a closed set of four
 * words. A row naming a fifth word is counted and dropped rather than labelled
 * with a word the contract does not have: a guessed status is a statement about
 * a run nobody made, and keeping the raw string past the type that says it
 * cannot occur would push the problem into every reader.
 *
 * ### The rules both obey
 *
 * - **Nothing throws.** The caller is a socket callback, so a hostile or
 *   truncated payload costs one row and one counter, never the session, and a
 *   frame that cannot be read never clears the last good entity.
 * - **Nothing is invented.** A count the payload does not report stays `0`
 *   because the contract has no null for it, and it is counted as defaulted so
 *   the fill-in is visible in diagnostics. A missing parent or conversation
 *   stays `null`.
 * - **The count a page draws is the list it can see.** The engine reports no
 *   second number for the queue, so `count` is the number of rows, and the two
 *   can never disagree.
 */

import type { QueueEntity, SubagentEntity } from "@haruyuki/protocol";

import { asRecord } from "../merge/envelope.js";
import type { MergerChange } from "../merge/types.js";

/** One queue entry as the engine sent it. */
type QueueItem = Readonly<Record<string, unknown>>;

/** Why a queue payload produced no entity. */
export type QueueProblem =
  /** The caller handed in another kind; a misuse, not malformed data. */
  | "not-a-queue-change"
  /** No usable conversation identity, so there is no key to file the row under. */
  | "no-conversation"
  /** The payload names neither a list nor a departure list. */
  | "no-payload"
  /** A field that has to be a list was present with another type. */
  | "wrong-type"
  /** Reading the payload itself failed; a hostile object can throw from a getter. */
  | "unreadable";

/** One queue payload's outcome: an entity, or the code explaining its absence. */
export type QueueReading = {
  readonly entity: QueueEntity | null;
  readonly problem: QueueProblem | null;
};

/** Why a subagent payload produced no list. */
export type SubagentProblem =
  "not-a-subagent-change" | "no-conversation" | "no-payload" | "wrong-type" | "unreadable";

/** One subagent payload's outcome: the conversation's rows, or why there are none. */
export type SubagentsReading = {
  readonly entities: readonly SubagentEntity[] | null;
  readonly problem: SubagentProblem | null;
};

/** What applying one state change did. */
export type StateEffect = "applied" | "ignored";

/** What one applied queue change did, and to which conversation. */
export type QueueSignal = {
  readonly kind: string;
  readonly effect: StateEffect;
  readonly conversationId: string | null;
  /** The entries this frame said have left, by `client_message_id`. */
  readonly removed: readonly string[];
};

/** What one applied subagent change did, and to which conversation. */
export type SubagentSignal = {
  readonly kind: string;
  readonly effect: StateEffect;
  readonly conversationId: string | null;
  /** Rows in the list that was applied; `0` when the change was ignored. */
  readonly count: number;
};

/** Read-only counters for the queue table. Nothing here is rendered. */
export type QueueTableStats = {
  /** Changes that produced an entity. */
  readonly applied: number;
  /** Applied payloads that carried departures. */
  readonly withRemovals: number;
  /** Applied payloads that carried a list of their own. */
  readonly snapshots: number;
  /** Departures naming an entry the list did not have; replay makes more. */
  readonly removalMisses: number;
  /** Departure records that named no entry at all. */
  readonly badRemovals: number;
  /** Rows seen with no identity, so no departure can ever name them. */
  readonly untracked: number;
  /** Changes refused: no conversation, no payload, wrong types, unreadable. */
  readonly refused: number;
};

/** Read-only counters for the subagent table. Nothing here is rendered. */
export type SubagentTableStats = {
  /** Changes that produced a list. An empty list counts. */
  readonly applied: number;
  /** Rows with a status outside the closed set; counted, then dropped. */
  readonly unknownStatus: number;
  /** Rows with no `subagent_id`, so no key to file them under; dropped. */
  readonly missingId: number;
  /** Rows that were not objects; dropped. */
  readonly malformedRows: number;
  /** Numeric fields the payload omitted or mistyped, filled with `0`. */
  readonly defaultedFields: number;
  /** Repeated `subagent_id` in one list; the later row replaces the earlier. */
  readonly duplicates: number;
  /** Changes refused: no conversation, no payload, wrong types, unreadable. */
  readonly refused: number;
};

/** The statuses the contract has. Anything else is not a status. */
const SUBAGENT_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "error",
]);

/** A non-empty string, or `null`. */
function readId(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A finite number, or `null`; a numeric string is not a number here. */
function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A plain record; arrays and `null` are not records. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a record carries a field at all, as opposed to holding `undefined`. */
function has(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Read the engine state out of a change's value.
 *
 * The value is the engine's message as the merger received it, so the state sits
 * at its top level. A caller that hands in the transport line instead - the one
 * that nests the message under `msg` - works too; one level is unwrapped here
 * rather than demanded of every caller.
 *
 * @param raw the change's value
 * @returns the state record, or `null` when there is none
 */
function payloadOf(raw: unknown): Readonly<Record<string, unknown>> | null {
  const value = asRecord(raw);

  if (value === null) {
    return null;
  }

  return asRecord(value["msg"]) ?? value;
}

/**
 * The identity an entry can be removed by.
 *
 * The departure list names entries by `client_message_id`; the entry itself
 * carries one as well as an `id`. Both names are read so a payload that uses
 * only one of them still works.
 *
 * @param item one queue entry
 * @returns the id, or `null` when the entry names none
 */
function itemIdOf(item: Readonly<Record<string, unknown>>): string | null {
  return readId(item["client_message_id"]) ?? readId(item["id"]);
}

/**
 * The entries a departure list names.
 *
 * Each record is `{ client_message_id, disposition }`, but a bare id string is
 * accepted too: the field is read for what it says rather than for its type, so
 * a caller that summarised the departures does not have to rebuild the records.
 *
 * @param value the payload's `removed` field, whatever it is
 * @returns the ids, and how many records named none
 */
function removalsOf(value: unknown): { readonly ids: readonly string[]; readonly bad: number } {
  if (value === undefined) {
    return { ids: [], bad: 0 };
  }

  if (!Array.isArray(value)) {
    return { ids: [], bad: 1 };
  }

  const ids: string[] = [];
  let bad = 0;

  for (const entry of value) {
    const record = isRecord(entry) ? entry : null;
    const id =
      typeof entry === "string"
        ? readId(entry)
        : (readId(record?.["client_message_id"]) ?? readId(record?.["id"]));

    if (id === null) {
      bad += 1;

      continue;
    }

    ids.push(id);
  }

  return { ids, bad };
}

/** One queue payload, folded. */
type QueueFold = {
  readonly entity: QueueEntity;
  readonly removed: readonly string[];
  readonly misses: number;
  readonly badRemovals: number;
  readonly untracked: number;
  /** False for a payload that carried departures only. */
  readonly snapshot: boolean;
};

/**
 * Fold one queue payload over the list already held.
 *
 * @param conversationId the conversation the queue belongs to
 * @param payload the engine's state record
 * @param previous the entity the caller already has, used only by a payload
 *   with no list of its own
 * @returns the folded queue, or the code explaining why there is none
 */
function foldQueue(
  conversationId: string,
  payload: Readonly<Record<string, unknown>>,
  previous: QueueEntity | null,
): QueueFold | QueueProblem {
  const carriesList = has(payload, "queue");
  const queueValue = payload["queue"];

  if (carriesList && !Array.isArray(queueValue)) {
    return "wrong-type";
  }

  if (!carriesList && !has(payload, "removed")) {
    return "no-payload";
  }

  const candidates: readonly QueueItem[] = carriesList
    ? (queueValue as unknown[]).filter(isRecord)
    : (previous?.items ?? []);

  if (!carriesList && previous === null) {
    // A departure-only payload with nothing behind it says nothing about the
    // rest of the queue yet, so there is no honest entity to publish.
    return "no-payload";
  }

  const departures = removalsOf(payload["removed"]);
  const leaving = new Set(departures.ids);

  const kept: QueueItem[] = [];
  const present = new Set<string>();
  let untracked = 0;

  for (const item of candidates) {
    const id = itemIdOf(item);

    if (id === null) {
      // No identity means no departure can ever name it. Keeping it is the only
      // honest choice; the counter makes the gap visible instead of silent.
      untracked += 1;
      kept.push(item);

      continue;
    }

    present.add(id);

    if (leaving.has(id)) {
      continue;
    }

    kept.push(item);
  }

  const misses = [...leaving].filter((id) => !present.has(id)).length;
  const items = Object.freeze(kept);

  return {
    entity: Object.freeze({ conversationId, items, count: items.length }),
    removed: departures.ids,
    misses,
    badRemovals: departures.bad,
    untracked,
    snapshot: carriesList,
  };
}

/**
 * The fold a caller asked for, with the counters and the signal it produced.
 *
 * @param change the change to project
 * @param previous the entity already held; used only by a payload with no list
 */
function foldChange(
  change: MergerChange,
  previous: QueueEntity | null,
): QueueReading & { readonly fold: QueueFold | null } {
  if (change.kind !== "state.queue") {
    return { entity: null, problem: "not-a-queue-change", fold: null };
  }

  if (change.conversationId === "") {
    return { entity: null, problem: "no-conversation", fold: null };
  }

  try {
    const payload = payloadOf(change.value);

    if (payload === null) {
      return { entity: null, problem: "no-payload", fold: null };
    }

    const folded = foldQueue(change.conversationId, payload, previous);

    return typeof folded === "string"
      ? { entity: null, problem: folded, fold: null }
      : { entity: folded.entity, problem: null, fold: folded };
  } catch {
    // A payload can be a proxy, a throwing getter or a revoked object. The
    // caller is a socket callback: costing one row is the acceptable failure.
    return { entity: null, problem: "unreadable", fold: null };
  }
}

/**
 * Project one queue change onto its conversation's queue.
 *
 * @param change the change to project
 * @param previous the entity already held; used only by a payload with no list
 * @returns the entity, or the code explaining why there is none
 */
export function projectQueue(
  change: MergerChange,
  previous: QueueEntity | null = null,
): QueueReading {
  const { entity, problem } = foldChange(change, previous);

  return { entity, problem };
}

/**
 * The status the contract has room for.
 *
 * @param value the payload's `status` field
 * @returns the status, or `null` when the payload used a word not in the set
 */
function statusOf(value: unknown): SubagentEntity["status"] | null {
  return typeof value === "string" && SUBAGENT_STATUSES.has(value)
    ? (value as SubagentEntity["status"])
    : null;
}

/** A reported number, or `0` and one defaulted-field count. */
function numberOrZero(value: unknown, counts: { defaultedFields: number }): number {
  const number = readNumber(value);

  if (number === null) {
    counts.defaultedFields += 1;

    return 0;
  }

  return number;
}

/**
 * Compose one entity from a subagent row.
 *
 * @param subagentId the row's own id, already read
 * @param status the row's status, already validated
 * @param record the row as the engine sent it
 * @param counts the table's counters
 */
function composeSubagent(
  subagentId: string,
  status: SubagentEntity["status"],
  record: Readonly<Record<string, unknown>>,
  counts: { defaultedFields: number },
): SubagentEntity {
  return Object.freeze({
    subagentId,
    // Absent and "no parent" are the same fact for a subagent, and the contract
    // spells it `null`; nothing is made up to fill it in.
    parentAgentId: readId(record["parent_agent_id"]) ?? readId(record["parentAgentId"]),
    conversationId: readId(record["conversation_id"]) ?? readId(record["conversationId"]),
    status,
    totalTokens: numberOrZero(record["total_tokens"] ?? record["totalTokens"], counts),
    durationMs: numberOrZero(record["duration_ms"] ?? record["durationMs"], counts),
    error: readId(record["error"]),
  });
}

/** The counters a subagent fold needs. */
type SubagentCounts = {
  unknownStatus: number;
  missingId: number;
  malformedRows: number;
  defaultedFields: number;
  duplicates: number;
};

/**
 * Fold the rows of one subagent payload.
 *
 * @param value the payload's `subagents` field, whatever it is
 * @param counts the table's counters
 * @returns the rows in the engine's order, or `null` when the field is not a list
 */
function foldSubagents(value: unknown, counts: SubagentCounts): readonly SubagentEntity[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const rows = new Map<string, SubagentEntity>();

  for (const entry of value) {
    if (!isRecord(entry)) {
      counts.malformedRows += 1;

      continue;
    }

    const subagentId = readId(entry["subagent_id"]) ?? readId(entry["subagentId"]);

    if (subagentId === null) {
      counts.missingId += 1;

      continue;
    }

    const status = statusOf(entry["status"]);

    if (status === null) {
      // A fifth status word is not a status. Dropping the row keeps every
      // published row inside the closed set the contract promises.
      counts.unknownStatus += 1;

      continue;
    }

    if (rows.has(subagentId)) {
      counts.duplicates += 1;
    }

    // A Map keeps the first position and takes the last value, so a repeated id
    // does not reorder the list and does not publish two rows for one run.
    rows.set(subagentId, composeSubagent(subagentId, status, entry, counts));
  }

  return Object.freeze([...rows.values()]);
}

/**
 * Project one subagent change onto its conversation's runs.
 *
 * @param change the change to project
 * @param counts the counters a fold updates; omitted by a read-only call
 * @returns the rows, or the code explaining why there are none
 */
export function projectSubagents(
  change: MergerChange,
  counts: SubagentCounts = {
    unknownStatus: 0,
    missingId: 0,
    malformedRows: 0,
    defaultedFields: 0,
    duplicates: 0,
  },
): SubagentsReading {
  if (change.kind !== "state.subagents") {
    return { entities: null, problem: "not-a-subagent-change" };
  }

  if (change.conversationId === "") {
    return { entities: null, problem: "no-conversation" };
  }

  try {
    const payload = payloadOf(change.value);

    if (payload === null || payload["subagents"] === undefined) {
      return { entities: null, problem: "no-payload" };
    }

    const entities = foldSubagents(payload["subagents"], counts);

    return entities === null
      ? { entities: null, problem: "wrong-type" }
      : { entities, problem: null };
  } catch {
    return { entities: null, problem: "unreadable" };
  }
}

/** Folds a stream of queue changes into the latest queue per conversation. */
export interface QueueTable {
  /** Take one merged change. Synchronous, never throws. */
  apply(change: MergerChange): QueueSignal;
  /** One conversation's queue, or `null` before any readable frame. */
  get(conversationId: string): QueueEntity | null;
  /** Every queue, in the order the conversations first appeared. */
  queues(): readonly QueueEntity[];
  /** A copy of the counters; later changes do not alter it. */
  stats(): QueueTableStats;
}

/**
 * Build the queue table.
 *
 * The table keeps the last entity per conversation. A frame that cannot be read
 * leaves the stored entity alone, so a bad payload never blanks a list that was
 * fine a moment ago.
 *
 * @returns the table over consecutive queue changes
 */
export function createQueueTable(): QueueTable {
  const entities = new Map<string, QueueEntity>();
  const counts = {
    applied: 0,
    withRemovals: 0,
    snapshots: 0,
    removalMisses: 0,
    badRemovals: 0,
    untracked: 0,
    refused: 0,
  };

  return {
    apply(change) {
      const conversationId =
        change.kind === "state.queue" && change.conversationId !== ""
          ? change.conversationId
          : null;
      const previous = conversationId === null ? null : (entities.get(conversationId) ?? null);
      const reading = foldChange(change, previous);

      if (reading.entity === null || reading.fold === null) {
        counts.refused += 1;

        return { kind: change.kind, effect: "ignored", conversationId, removed: [] };
      }

      const { fold } = reading;

      if (fold.snapshot) {
        counts.snapshots += 1;
      }

      if (fold.removed.length > 0) {
        counts.withRemovals += 1;
      }

      counts.removalMisses += fold.misses;
      counts.badRemovals += fold.badRemovals;
      counts.untracked += fold.untracked;
      counts.applied += 1;
      entities.set(reading.entity.conversationId, reading.entity);

      return {
        kind: change.kind,
        effect: "applied",
        conversationId: reading.entity.conversationId,
        removed: fold.removed,
      };
    },

    get(conversationId) {
      return entities.get(conversationId) ?? null;
    },

    queues() {
      return Object.freeze([...entities.values()]);
    },

    stats() {
      return Object.freeze({ ...counts });
    },
  };
}

/** Folds a stream of subagent changes into the latest rows per conversation. */
export interface SubagentTable {
  /** Take one merged change. Synchronous, never throws. */
  apply(change: MergerChange): SubagentSignal;
  /** One conversation's runs, or `null` before any readable frame. */
  subagents(conversationId: string): readonly SubagentEntity[] | null;
  /** Every conversation's rows, in the order the conversations first appeared. */
  all(): readonly (readonly SubagentEntity[])[];
  /** A copy of the counters; later changes do not alter it. */
  stats(): SubagentTableStats;
}

/**
 * Build the subagent table.
 *
 * A payload is the conversation's whole list, so a new readable payload replaces
 * the old one rather than adding to it: a new attachment shows up because the
 * list contains it, and a finished run stays in the list with a new status
 * instead of disappearing. A payload that cannot be read leaves the old list
 * alone.
 *
 * @returns the table over consecutive subagent changes
 */
export function createSubagentTable(): SubagentTable {
  const entities = new Map<string, readonly SubagentEntity[]>();
  const counts: SubagentCounts = {
    unknownStatus: 0,
    missingId: 0,
    malformedRows: 0,
    defaultedFields: 0,
    duplicates: 0,
  };
  let applied = 0;
  let refused = 0;

  return {
    apply(change) {
      const conversationId =
        change.kind === "state.subagents" && change.conversationId !== ""
          ? change.conversationId
          : null;
      const reading = projectSubagents(change, counts);

      if (reading.entities === null) {
        refused += 1;

        return { kind: change.kind, effect: "ignored", conversationId, count: 0 };
      }

      applied += 1;

      if (conversationId !== null) {
        entities.set(conversationId, reading.entities);
      }

      return {
        kind: change.kind,
        effect: "applied",
        conversationId,
        count: reading.entities.length,
      };
    },

    subagents(conversationId) {
      return entities.get(conversationId) ?? null;
    },

    all() {
      return Object.freeze([...entities.values()]);
    },

    stats() {
      return Object.freeze({ applied, refused, ...counts });
    },
  };
}
