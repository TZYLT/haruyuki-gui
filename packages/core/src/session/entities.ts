/**
 * The two list-shaped session entities: one agent, one conversation, folded from
 * the rows the caller fetched and from the changes that mention them.
 *
 * Both tables are fed in pages, because neither list arrives all at once: the
 * caller asks for twenty rows, gets twenty, and asks again while the engine says
 * there is more. Two consequences follow, and they are the whole reason this is a
 * fold of its own rather than a plain map:
 *
 * - **A page re-sent is a replacement, not an append.** A refresh, a reconnect or
 *   a scroll back to the top hands the same ids in again. Appending would show one
 *   conversation twice and keep a stale copy of every row, so an id already held
 *   replaces its entity. What the row does not carry is preserved from the entity
 *   already held rather than blanked: a list row says nothing about turns, context
 *   pressure or capability availability, and those belong to the layers that
 *   attach them.
 * - **Leaving the list is not a deletion.** The engine has no "conversation
 *   deleted" frame; a conversation is gone when the latest list no longer names
 *   it. That is a fact about a list, not about the conversation: the reader may
 *   still be looking at it, and nothing here closes a tab on its own. So the
 *   entity stays, its last readable row stays, and its state becomes `gone` -
 *   the word the conversation row view already uses. The same list can make it
 *   `ok` again, which is what the reader sees after an undo or after a refresh
 *   that brings the row back.
 *
 * "Absent from this page" only means gone when the page is the whole list. A page
 * the caller says has more behind it says nothing about the ids it does not name:
 * treating its absences as removals would report a deletion on every scroll, for
 * every conversation that simply lives on the next page.
 *
 * Three rules hold for every input:
 *
 * - **Nothing is invented.** A field the row does not carry stays `null`; a
 *   missing name is not an empty name. The one field with no null slot is an
 *   entity's own id: a row without a usable one cannot be filed at all, so it is
 *   counted and skipped rather than stored under a made-up key.
 * - **Nothing throws.** The caller is a page handler on a socket callback, so a
 *   hostile or truncated row costs one row and one counter, never the session. A
 *   conversation row whose payload cannot be read does not erase the row already
 *   held: it is marked unreadable and keeps what was last readable.
 * - **Neither table sorts, groups or counts.** The engine's order is the order,
 *   unread and pinned belong to the layers above, and the in-flight turn table
 *   owns turns - this module stores the id list it is handed and nothing more.
 */

import type { AgentEntity, ConversationEntity, ConversationRowView } from "@haruyuki/protocol";

import type { MergerChange } from "../merge/types.js";
import { freezeMap } from "./snapshot.js";

/** Longest id accepted. A longer one is not an id from this engine. */
export const ENTITY_ID_CHAR_LIMIT = 200;

/** Longest free-text field kept. A longer one is dropped, not truncated. */
export const ENTITY_TEXT_CHAR_LIMIT = 200;

/**
 * The three states a conversation row can be in.
 *
 * Taken from the protocol's row view rather than redeclared: a fourth word here
 * would be a state no page knows how to draw, and the point of `gone` is that the
 * tag stays open carrying a readable reason.
 */
export type ConversationTableState = ConversationRowView["state"];

/** Why a row could not be filed at all. */
export type EntityRowProblem =
  /** The row is not an object, so it has no fields to read. */
  | "wrong-type"
  /** No usable id, so there is no key to file the row under. */
  | "missing-id"
  /** The id is longer than this layer accepts; refused rather than shortened. */
  | "overlong-id";

/** Read-only counters for the agent table. Nothing here is rendered. */
export type AgentTableStats = {
  /** Rows handed in, across every page. */
  readonly rows: number;
  /** Agents currently held. */
  readonly held: number;
  /** Ids this table had not seen before. */
  readonly added: number;
  /** Ids that replaced an entity already held; a re-sent page counts here. */
  readonly replaced: number;
  /** Rows skipped for being the wrong type, or having no usable id. */
  readonly refused: number;
  /** Nullable fields the row left out or mistyped; stored as `null`. */
  readonly absentFields: number;
  /** Text fields dropped for being too long; stored as `null`. */
  readonly overlongFields: number;
};

/** Read-only counters for the conversation table. Nothing here is rendered. */
export type ConversationTableStats = {
  /** Rows handed in, across every page. */
  readonly rows: number;
  /** Pages handed in, complete or not. */
  readonly pages: number;
  /** Conversations currently held. */
  readonly held: number;
  /** Ids this table had not seen before. */
  readonly added: number;
  /** Ids that replaced an entity already held; a re-sent page counts here. */
  readonly replaced: number;
  /** One page naming the same id twice; the later row wins. */
  readonly duplicates: number;
  /** Rows skipped for being the wrong type, or having no usable id. */
  readonly refused: number;
  /** Rows whose id was readable but whose payload was not; state set, row kept. */
  readonly unreadable: number;
  /**
   * The part of {@link unreadable} that could not name its agent.
   *
   * Broken out because it is the one unreadable cause that has a diagnosis of its
   * own: a row without an agent has no owner to file it under, while the other
   * causes are about the payload a row did carry. A diagnostic page that only has
   * the total cannot tell "the engine omitted a field" from "the engine sent
   * something we could not read", and those two send the reader to different
   * places.
   */
  readonly missingAgentId: number;
  /** Conversations that left a complete list; the entity was kept. */
  readonly gone: number;
  /** Conversations that came back into a list or were named by a change again. */
  readonly revived: number;
  /** Nullable fields the row left out or mistyped; stored as `null`. */
  readonly absentFields: number;
  /** Text fields dropped for being too long; stored as `null`. */
  readonly overlongFields: number;
  /** Changes that named a conversation this table does not hold. */
  readonly unmatched: number;
};

/** What one change did to the conversation table. */
export type ConversationEffect =
  /** The conversation is held and stays present. */
  | "seen"
  /** The conversation was `gone` and is present again. */
  | "revived"
  /** The change says nothing about a conversation this table holds. */
  | "ignored";

/** What one applied change did, and to which conversation. */
export type ConversationSignal = {
  /** The change's kind, echoed for the caller's own logging. */
  readonly kind: string;
  readonly effect: ConversationEffect;
  readonly conversationId: string | null;
};

/** Whether a value names an id at all, before the length check. */
function looksLikeId(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

/** An id, or `null` when the value cannot be one. */
function readId(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > ENTITY_ID_CHAR_LIMIT) {
    return null;
  }

  return value;
}

/** A text field, or `null`; empty and over-long values read as absent. */
function readText(value: unknown): string | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }

  return value.length > ENTITY_TEXT_CHAR_LIMIT ? null : value;
}

/** A plain record; arrays and `null` are not records. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The string entries of a candidate list; empty when there is no list. */
function readIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const ids: string[] = [];

  for (const entry of value) {
    const id = readId(entry);

    if (id !== null) {
      ids.push(id);
    }
  }

  return ids;
}

/** How one row's nullable text fields turned out, and why. */
type TextFields = {
  readonly values: Readonly<Record<string, string | null>>;
  readonly absent: number;
  readonly overlong: number;
};

/**
 * Read a fixed set of optional text fields off one row.
 *
 * A field that is missing, `null` or of another type is absent; a field that is
 * too long is dropped. Both are stored as `null`, and both are counted, because
 * "the engine did not say" and "the engine said something unusable" are facts a
 * diagnostic reading needs to see.
 *
 * @param row the engine's row
 * @param keys the fields to read
 * @returns the values by key, with the two counters
 */
function textFieldsOf(row: Readonly<Record<string, unknown>>, keys: readonly string[]): TextFields {
  const values: Record<string, string | null> = {};
  let absent = 0;
  let overlong = 0;

  for (const key of keys) {
    const raw = row[key];

    if (typeof raw !== "string") {
      absent += 1;
      values[key] = null;

      continue;
    }

    const value = readText(raw);

    if (value === null) {
      overlong += 1;
    }

    values[key] = value;
  }

  return { values, absent, overlong };
}

/** One agent row, read into the fields the entity has. */
type AgentRow = {
  readonly agentId: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly absent: number;
  readonly overlong: number;
};

/** Read one agent row, or say why it cannot be filed. */
function agentRowOf(row: unknown): AgentRow | EntityRowProblem {
  if (!isRecord(row)) {
    return "wrong-type";
  }

  const rawId = row["id"] ?? row["agent_id"];
  const agentId = readId(rawId);

  if (agentId === null) {
    return looksLikeId(rawId) ? "overlong-id" : "missing-id";
  }

  const fields = textFieldsOf(row, ["name", "description"]);

  return {
    agentId,
    name: fields.values["name"] ?? null,
    description: fields.values["description"] ?? null,
    absent: fields.absent,
    overlong: fields.overlong,
  };
}

/** One conversation row, read into the fields the entity has. */
type ConversationRow = {
  readonly conversationId: string;
  readonly agentId: string;
  readonly lastActivityAt: string | null;
  readonly absent: number;
  readonly overlong: number;
};

/** A row whose id is readable but whose payload is not. */
type UnreadableRow = { readonly conversationId: string };

/** Read one conversation row, or say why it cannot be filed or read. */
function conversationRowOf(row: unknown): ConversationRow | UnreadableRow | EntityRowProblem {
  if (!isRecord(row)) {
    return "wrong-type";
  }

  const rawId = row["id"] ?? row["conversation_id"];
  const conversationId = readId(rawId);

  if (conversationId === null) {
    return looksLikeId(rawId) ? "overlong-id" : "missing-id";
  }

  // The conversation is in the list, so it has a row; if the row does not name
  // its agent, the entity cannot be composed and the state says unreadable
  // instead of a made-up owner.
  const agentId = readId(row["agent_id"]);

  if (agentId === null) {
    return { conversationId };
  }

  const fields = textFieldsOf(row, ["last_message_at", "updated_at", "created_at"]);

  // The engine sorts by these three in this order, so the same order decides
  // which one is the conversation's last activity. Another order would make the
  // list disagree with the order the engine already applied.
  const lastActivityAt =
    fields.values["last_message_at"] ??
    fields.values["updated_at"] ??
    fields.values["created_at"] ??
    null;

  return {
    conversationId,
    agentId,
    lastActivityAt,
    absent: fields.absent,
    overlong: fields.overlong,
  };
}

/** The agent table a session store keeps. */
export interface AgentTable {
  /**
   * Take one page of agent rows.
   *
   * An id already held replaces its entity; the conversation ids and the
   * capability table attached by other layers survive the replacement, because a
   * list row declares neither. Synchronous and never throws.
   *
   * @param rows the rows the caller fetched, in the engine's order
   */
  ingest(rows: readonly Readonly<Record<string, unknown>>[]): void;
  /** One agent, or `null` before its row arrives. */
  get(agentId: string): AgentEntity | null;
  /** Every agent, in the order the ids first appeared. */
  agents(): readonly AgentEntity[];
  /** The same entities as a read-only map, for the snapshot builder. */
  map(): ReadonlyMap<string, AgentEntity>;
  /**
   * Note that a conversation belongs to one agent, placed where the list put it.
   *
   * Called by the conversation table, not by a page: an agent row carries no
   * conversation list, so the only honest source of one is the conversation rows
   * themselves. An id already noted keeps its position; a conversation may move.
   *
   * Wiring, not a rule: the assembly layer calls this when it builds the two
   * tables together. If nobody ever calls it, both tables simply hold their own
   * rows and no relation is recorded - an empty relation, not a broken one. It is
   * deliberately not called from `ingest`, because one table's page arriving is
   * not an event about the other table.
   */
  join(agentId: string, conversationId: string): void;
  /**
   * Note that a conversation no longer belongs to one agent.
   *
   * The matching half of {@link join}, with the same standing: the assembly layer
   * drives it, and an unused pair leaves no relation rather than a wrong one.
   */
  leave(agentId: string, conversationId: string): void;
  /** A copy of the counters; later changes do not alter it. */
  stats(): AgentTableStats;
}

/**
 * Build the agent table.
 *
 * @returns the table over consecutive agent pages
 */
export function createAgentTable(): AgentTable {
  const entities = new Map<string, AgentEntity>();

  const counts = {
    rows: 0,
    added: 0,
    replaced: 0,
    refused: 0,
    absentFields: 0,
    overlongFields: 0,
  };

  /** A new entity for an agent nobody has described yet. */
  const blank = (agentId: string): AgentEntity =>
    Object.freeze({
      agentId,
      name: null,
      description: null,
      // Composed by the capability layer, which holds the probe and the engine
      // version; an empty table here means "not composed yet", not "none".
      capabilities: Object.freeze({}),
      conversations: Object.freeze([]),
    });

  /** Add or drop one conversation id, keeping the order the ids arrived in. */
  const withConversation = (
    entity: AgentEntity,
    conversationId: string,
    present: boolean,
  ): AgentEntity => {
    const previous = entity.conversations;
    const ids = present
      ? previous.includes(conversationId)
        ? previous
        : [...previous, conversationId]
      : previous.filter((id) => id !== conversationId);

    return ids === previous
      ? entity
      : Object.freeze({ ...entity, conversations: Object.freeze(ids) });
  };

  return {
    ingest(rows) {
      for (const row of rows) {
        counts.rows += 1;

        const reading = agentRowOf(row);

        if (typeof reading === "string") {
          counts.refused += 1;

          continue;
        }

        const previous = entities.get(reading.agentId) ?? null;

        if (previous === null) {
          counts.added += 1;
        } else {
          counts.replaced += 1;
        }

        counts.absentFields += reading.absent;
        counts.overlongFields += reading.overlong;

        entities.set(
          reading.agentId,
          Object.freeze({
            ...(previous ?? blank(reading.agentId)),
            name: reading.name,
            description: reading.description,
          }),
        );
      }
    },

    get(agentId) {
      return entities.get(agentId) ?? null;
    },

    agents() {
      return Object.freeze([...entities.values()]);
    },

    map() {
      return freezeMap(entities);
    },

    join(agentId, conversationId) {
      const id = readId(agentId);
      const conversation = readId(conversationId);

      if (id === null || conversation === null) {
        return;
      }

      entities.set(id, withConversation(entities.get(id) ?? blank(id), conversation, true));
    },

    leave(agentId, conversationId) {
      const id = readId(agentId);
      const conversation = readId(conversationId);
      const current = id === null ? null : (entities.get(id) ?? null);

      if (conversation === null || current === null) {
        return;
      }

      entities.set(current.agentId, withConversation(current, conversation, false));
    },

    stats() {
      return Object.freeze({ ...counts, held: entities.size });
    },
  };
}

/** Options for {@link createConversationTable}. */
export type ConversationTableOptions = {
  /**
   * The agent table that holds conversation membership.
   *
   * A conversation row is the only place an agent learns which conversations it
   * has, so the join happens here rather than by a second rule above both.
   */
  readonly agents?: AgentTable;
};

/**
 * The change kinds that are scoped to one conversation.
 *
 * Left out on purpose, and for different reasons: the device and loop states
 * describe the connection as a whole, so the conversation id they carry is the
 * merger's fallback rather than a conversation the engine named; a passthrough
 * carries whatever frame the merger chose to pass through untouched, and a
 * conversation list response is not one of those frames, so no list can arrive
 * through it at all. Membership comes from `ingest` and from nowhere else.
 *
 * A queue state also carries a `removed` list. Those are entries that left a
 * queue, not conversations that left the world; reading them as removals would
 * report a conversation gone every time a message was dequeued, so nothing here
 * looks at that field.
 */
const CONVERSATION_KINDS: ReadonlySet<string> = new Set([
  "message.delta",
  "message.final",
  "message.complete",
  "message.reset",
  "turn.stopped",
  "turn.finished",
  "state.queue",
  "state.subagents",
  "approval.requested",
  "usage.reported",
]);

/** The conversation table a session store keeps. */
export interface ConversationTable {
  /**
   * Take one page of conversation rows.
   *
   * A page whose `hasMore` is true is twenty rows of an unknown total, so it can
   * say nothing about the ids it does not name; only a complete page marks what it
   * left out as gone. Comparing every page against the table instead would report
   * the whole first page as missing on the second scroll - the opposite of showing
   * a conversation as gone only once it really left the list.
   *
   * @param rows the rows the caller fetched, in the engine's order
   * @param opts.hasMore whether the caller knows of more rows behind this page
   */
  ingest(
    rows: readonly Readonly<Record<string, unknown>>[],
    opts: { readonly hasMore: boolean },
  ): void;
  /**
   * Take one merged change.
   *
   * Only the kinds scoped to a conversation can say anything about one. A change
   * naming a conversation this table does not hold does not create an entity: an
   * entity without a row would be a row nobody sent.
   *
   * **The conversation list has no change kind of its own.** The merger's union
   * carries ten kinds and none of them is about the list, so membership only ever
   * arrives through `ingest`; there is nothing here to fold and nothing missing.
   * A `passthrough` does not carry it either - that kind is produced for a fixed
   * set of frames the merger names one by one, and a conversation list response
   * is not one of them. Inventing a kind, or reading the list out of a payload
   * that only passes through, would put a list in the fold that the engine never
   * declared.
   */
  apply(change: MergerChange): ConversationSignal;
  /** One conversation, or `null` before its row arrives. */
  get(conversationId: string): ConversationEntity | null;
  /** Every conversation, in the order the ids first appeared. */
  conversations(): readonly ConversationEntity[];
  /** The same entities as a read-only map, for the snapshot builder. */
  map(): ReadonlyMap<string, ConversationEntity>;
  /** One conversation's state, or `null` when it is not held at all. */
  stateOf(conversationId: string): ConversationTableState | null;
  /** The ids that left the latest complete list; their entities are still here. */
  gone(): readonly string[];
  /** Whether the caller reported more rows behind the last page it handed in. */
  hasMore(): boolean;
  /**
   * Store the turn refs that belong to one conversation, in chronological order.
   *
   * The turn table owns a turn's identity and its order; this only keeps the list
   * it hands over, so a page reads the turns of a conversation off its entity.
   *
   * Wiring, not a rule: the assembly layer calls this after folding turns, and if
   * it does not, the entity keeps the empty list it was composed with - the turn
   * table is still the owner of turns either way.
   *
   * @returns whether the conversation is held, i.e. whether anything was stored
   */
  setTurns(conversationId: string, turnRefs: readonly string[]): boolean;
  /** A copy of the counters; later changes do not alter it. */
  stats(): ConversationTableStats;
}

/**
 * Build the conversation table.
 *
 * @param options the agent table to keep membership in, when there is one
 * @returns the table over consecutive conversation pages and changes
 */
export function createConversationTable(options: ConversationTableOptions = {}): ConversationTable {
  const entities = new Map<string, ConversationEntity>();
  const states = new Map<string, ConversationTableState>();
  const agents = options.agents ?? null;

  let more = false;

  const counts = {
    rows: 0,
    pages: 0,
    added: 0,
    replaced: 0,
    duplicates: 0,
    refused: 0,
    unreadable: 0,
    missingAgentId: 0,
    gone: 0,
    revived: 0,
    absentFields: 0,
    overlongFields: 0,
    unmatched: 0,
  };

  /** Compose one entity for an id this table has not held before. */
  const fresh = (
    reading: ConversationRow,
    row: Readonly<Record<string, unknown>>,
  ): ConversationEntity =>
    Object.freeze({
      conversationId: reading.conversationId,
      agentId: reading.agentId,
      // Stored as sent: `hidden`, `context_message_count` and every field this
      // layer does not read are still there for the layers that do.
      row: Object.freeze({ ...row }),
      lastActivityAt: reading.lastActivityAt,
      turns: Object.freeze([]),
      context: null,
      incompleteTurnRefs: Object.freeze([]),
    });

  /** Move one conversation between agents, when its row names a new one. */
  const move = (previous: ConversationEntity | null, agentId: string): void => {
    if (agents === null || previous === null || previous.agentId === agentId) {
      return;
    }

    agents.leave(previous.agentId, previous.conversationId);
  };

  /**
   * Mark one conversation gone.
   *
   * The entity and its last readable row stay: nothing here closes a tag, and a
   * conversation the reader is looking at must be able to say why it looks empty.
   * Membership in the agent is kept as well - the agent still has a row for it,
   * which is exactly why the row can still be drawn.
   */
  const markGone = (conversationId: string): void => {
    if (states.get(conversationId) === "gone") {
      return;
    }

    states.set(conversationId, "gone");
    counts.gone += 1;
  };

  /** Count a conversation coming back into the world, if it had left it. */
  const revive = (conversationId: string): void => {
    if (states.get(conversationId) === "gone") {
      counts.revived += 1;
    }
  };

  return {
    ingest(rows, opts) {
      counts.pages += 1;
      more = opts.hasMore;

      const present = new Set<string>();
      const seenHere = new Set<string>();

      for (const row of rows) {
        counts.rows += 1;

        const reading = conversationRowOf(row);

        if (typeof reading === "string") {
          counts.refused += 1;

          continue;
        }

        if (!("agentId" in reading)) {
          // In the list, but its payload cannot compose an entity: the state
          // says why, and a row already held is not replaced by a blank.
          counts.unreadable += 1;
          // Counted apart as well: "no agent to file it under" is a different
          // diagnosis from "the payload was unreadable", and only the second one
          // is about a value the row did carry.
          counts.missingAgentId += 1;
          present.add(reading.conversationId);
          revive(reading.conversationId);
          states.set(reading.conversationId, "unreadable");

          continue;
        }

        if (seenHere.has(reading.conversationId)) {
          counts.duplicates += 1;
        }

        seenHere.add(reading.conversationId);
        present.add(reading.conversationId);

        const previous = entities.get(reading.conversationId) ?? null;

        if (previous === null) {
          counts.added += 1;
        } else {
          counts.replaced += 1;
        }

        counts.absentFields += reading.absent;
        counts.overlongFields += reading.overlong;

        move(previous, reading.agentId);

        // A replacement refreshes what the list carries and keeps what other
        // layers attached: a page is not a statement about turns or pressure.
        entities.set(
          reading.conversationId,
          previous === null
            ? fresh(reading, row)
            : Object.freeze({
                ...previous,
                agentId: reading.agentId,
                row: Object.freeze({ ...row }),
                lastActivityAt: reading.lastActivityAt,
              }),
        );

        revive(reading.conversationId);
        states.set(reading.conversationId, "ok");
        agents?.join(reading.agentId, reading.conversationId);
      }

      // Only a complete page can say something about the ids it does not name. A
      // partial page is twenty rows of an unknown total, so treating its
      // absences as removals would report a deletion on every scroll.
      if (opts.hasMore) {
        return;
      }

      for (const [conversationId, state] of states) {
        if (state === "gone" || present.has(conversationId)) {
          continue;
        }

        markGone(conversationId);
      }
    },

    apply(change) {
      const conversationId = readId(change.conversationId);
      const scoped = CONVERSATION_KINDS.has(change.kind);

      if (!scoped || conversationId === null || !entities.has(conversationId)) {
        if (scoped && conversationId !== null) {
          counts.unmatched += 1;
        }

        return { kind: change.kind, effect: "ignored", conversationId };
      }

      // An unreadable row is still a row: the change says the conversation is
      // alive, and the state stays unreadable until a readable row arrives.
      if (states.get(conversationId) !== "gone") {
        return { kind: change.kind, effect: "seen", conversationId };
      }

      // The engine is speaking about a conversation it had dropped from the list,
      // which is evidence that it exists again. Only the state moves; the row
      // already held is the last one anybody sent.
      revive(conversationId);
      states.set(conversationId, "ok");

      const entity = entities.get(conversationId);

      if (entity !== undefined) {
        agents?.join(entity.agentId, conversationId);
      }

      return { kind: change.kind, effect: "revived", conversationId };
    },

    get(conversationId) {
      return entities.get(conversationId) ?? null;
    },

    conversations() {
      return Object.freeze([...entities.values()]);
    },

    map() {
      return freezeMap(entities);
    },

    stateOf(conversationId) {
      return states.get(conversationId) ?? null;
    },

    gone() {
      const ids: string[] = [];

      for (const [conversationId, state] of states) {
        if (state === "gone") {
          ids.push(conversationId);
        }
      }

      return Object.freeze(ids);
    },

    hasMore() {
      return more;
    },

    setTurns(conversationId, turnRefs) {
      const id = readId(conversationId);
      const entity = id === null ? null : (entities.get(id) ?? null);

      if (id === null || entity === null) {
        return false;
      }

      entities.set(id, Object.freeze({ ...entity, turns: Object.freeze(readIds(turnRefs)) }));

      return true;
    },

    stats() {
      return Object.freeze({ ...counts, held: entities.size });
    },
  };
}
