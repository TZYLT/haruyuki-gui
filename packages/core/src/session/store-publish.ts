/**
 * Snapshot publication: which rows moved, and whether telling anyone is worth a
 * revision.
 *
 * A snapshot is republished only when something visible moved, so a replayed or
 * empty change costs no frame. The comparison is by reference, and the caches
 * below are what make it mean something: a fold that produced the row it already
 * had hands back the same entity, so a row nobody touched keeps its reference and
 * no subscriber is woken. That is why the published entities are cached here and
 * only here - a second cache would be a second answer to "is this the same row".
 *
 * The revision states what is published, not how many frames arrived; that
 * difference is what keeps a busy engine from re-rendering at event rate.
 */

import type {
  ApprovalEntity,
  ConversationEntity,
  ContextView,
  DeviceEntity,
  SubagentEntity,
  TurnEntity,
  UsageEntity,
} from "@haruyuki/protocol";

import type { ApprovalTable } from "./approvals.js";
import type { BlockTable } from "./blocks.js";
import type { AgentTable, ConversationTable } from "./entities.js";
import type { QueueTable, SubagentTable } from "./queue.js";
import type { SnapshotBuilder, SnapshotMapField, SnapshotPatch } from "./snapshot.js";
import { sameIds, sameMap } from "./store-types.js";
import type { SubscriptionTable } from "./subscriptions.js";
import type { TurnRecord, TurnTable } from "./turns.js";

/** Everything a publication reads. Every table here is owned by the store. */
export type PublisherDeps = {
  /** The snapshot being published, and the revision it carries. */
  readonly builder: SnapshotBuilder;
  /** The fields the next publication carries; this module clears it. */
  readonly dirty: Set<SnapshotMapField>;
  readonly turns: TurnTable;
  readonly blocks: BlockTable;
  readonly conversations: ConversationTable;
  readonly agents: AgentTable;
  readonly queues: QueueTable;
  readonly subagents: SubagentTable;
  readonly approvals: ApprovalTable;
  /** The maps the store composes itself, because no fold publishes them. */
  readonly usageEntities: ReadonlyMap<string, UsageEntity>;
  readonly devices: ReadonlyMap<string, DeviceEntity>;
  readonly subagentKeys: ReadonlySet<string>;
  readonly contextViews: ReadonlyMap<string, ContextView>;
  readonly subscriptions: SubscriptionTable;
  /** The publication counter; the store owns the object and reads the others. */
  readonly counts: { coalesced: number };
};

/** The outward member. */
export interface Publisher {
  /**
   * Republish what moved and tell the subscriptions that read it; a publication
   * with nothing new is not a revision, so no subscriber is woken.
   *
   * @returns whether the revision advanced
   */
  publish(): boolean;
}

/**
 * Build one publisher.
 *
 * @param deps the tables, the snapshot being published and the counters
 * @returns the publication member and the published-entity caches behind it
 */
export function createPublisher(deps: PublisherDeps): Publisher {
  const {
    builder,
    dirty,
    turns,
    blocks,
    conversations,
    agents,
    queues,
    subagents,
    approvals,
    usageEntities,
    devices,
    subagentKeys,
    contextViews,
    subscriptions,
    counts,
  } = deps;

  // Published entities per record, so a turn or a row nobody touched keeps its
  // reference and the map comparison below still recognises it.
  const turnEntities = new Map<
    string,
    { readonly record: TurnRecord; readonly entity: TurnEntity }
  >();
  const conversationEntities = new Map<
    string,
    {
      source: ConversationEntity;
      context: ContextView | null;
      incomplete: readonly string[];
      published: ConversationEntity;
    }
  >();

  /** The turn refs of one conversation, in the order the turn table holds them. */
  const turnRefsOf = (conversationId: string): readonly string[] =>
    turns.turns(conversationId).map((record) => record.turnRef);

  /** The turns of one conversation that may be missing content. */
  const incompleteRefsOf = (conversationId: string): readonly string[] =>
    turns
      .turns(conversationId)
      .filter((record) => record.incomplete)
      .map((record) => record.turnRef);

  /**
   * Keep a conversation's turn list in step with the turn table: the table states
   * the order and the entity carries it, and neither may own both. A list that
   * did not move is not rewritten, so an untouched row keeps its reference.
   */
  const syncTurns = (conversationId: string): void => {
    const held = conversations.get(conversationId);

    if (held === null) {
      return;
    }

    const refs = turnRefsOf(conversationId);

    if (sameIds(held.turns, refs)) {
      return;
    }

    conversations.setTurns(conversationId, refs);
  };

  /** Bring every held conversation's turn list up to date before publishing. */
  const syncAllTurns = (): void => {
    for (const conversationId of conversations.map().keys()) {
      syncTurns(conversationId);
    }
  };

  /**
   * The published form of one conversation row: the entity's own members, plus
   * the pressure derived from usage reports and the list of turns that may be
   * missing content.
   */
  const publishedConversation = (entity: ConversationEntity): ConversationEntity => {
    const context = contextViews.get(entity.conversationId) ?? null;
    const incomplete = incompleteRefsOf(entity.conversationId);
    const cached = conversationEntities.get(entity.conversationId);

    if (
      cached !== undefined &&
      cached.source === entity &&
      cached.context === context &&
      sameIds(cached.incomplete, incomplete)
    ) {
      return cached.published;
    }

    const published = Object.freeze({
      ...entity,
      context,
      incompleteTurnRefs: Object.freeze(incomplete),
    });

    conversationEntities.set(entity.conversationId, {
      source: entity,
      context,
      incomplete,
      published,
    });

    return published;
  };

  /** The published form of one turn: the contract's shape, without the internal field. */
  const publishedTurn = (record: TurnRecord): TurnEntity => {
    const cached = turnEntities.get(record.turnRef);

    if (cached !== undefined && cached.record === record) {
      return cached.entity;
    }

    // The record also says which agent line it belongs to, which the published
    // shape has no slot for. That is deliberate and not a loss: the unread badge
    // is the only reader of the field and it reads the record, not the snapshot.
    const entity: TurnEntity = Object.freeze({
      turnRef: record.turnRef,
      turnId: record.turnId,
      runId: record.runId,
      conversationId: record.conversationId,
      stopReason: record.stopReason,
      open: record.open,
      blocks: record.blocks,
      usage: record.usage,
      incomplete: record.incomplete,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    });

    turnEntities.set(record.turnRef, { record, entity });

    return entity;
  };

  /**
   * The patch for the fields that moved. A field whose rows are all the
   * references already published is left out, so a change some fold refused
   * cannot advance the revision here. Turns come first: a turn also moves its
   * conversation's list and its "may be missing content" mark.
   */
  const patchOf = (): SnapshotPatch => {
    // The patch is written field by field here; the contract's shape is readonly
    // because a published snapshot is, and this is the one place that assembles
    // it before it is published.
    const patch: Record<string, unknown> = {};
    const published = builder.get() as Readonly<Record<string, unknown>>;

    /** Put a field in the patch, unless every one of its rows is already there. */
    const keep = <V>(field: SnapshotMapField, candidate: ReadonlyMap<string, V>): void => {
      if (!sameMap(candidate, published[field] as ReadonlyMap<string, V>)) {
        patch[field] = candidate;
      }
    };

    /** Key rows by one of their own fields, keeping the order they arrived in. */
    const keyed = <T>(rows: Iterable<T>, key: (row: T) => string): Map<string, T> => {
      const held = new Map<string, T>();

      for (const row of rows) {
        held.set(key(row), row);
      }

      return held;
    };

    if (dirty.has("turns")) {
      // Keyed by ref, so the comparison sees one entry per turn.
      const held = new Map<string, TurnEntity>();

      for (const record of turns.turns()) {
        held.set(record.turnRef, publishedTurn(record));
      }

      keep("turns", held);

      // A turn that moved also moves its conversation's list.
      dirty.add("conversations");
    }

    if (dirty.has("blocks")) {
      keep(
        "blocks",
        keyed(blocks.blocks(), (entity) => entity.blockId),
      );
    }

    if (dirty.has("conversations")) {
      syncAllTurns();

      const held = new Map<string, ConversationEntity>();

      for (const [conversationId, entity] of conversations.map()) {
        held.set(conversationId, publishedConversation(entity));
      }

      keep("conversations", held);
    }

    if (dirty.has("agents")) {
      keep("agents", agents.map());
    }

    if (dirty.has("queues")) {
      keep(
        "queues",
        keyed(queues.queues(), (entity) => entity.conversationId),
      );
    }

    if (dirty.has("subagents")) {
      const held = new Map<string, readonly SubagentEntity[]>();

      for (const conversationId of subagentKeys) {
        held.set(conversationId, subagents.subagents(conversationId) ?? Object.freeze([]));
      }

      keep("subagents", held);
    }

    if (dirty.has("usage")) {
      keep("usage", usageEntities);
    }

    if (dirty.has("approvals")) {
      const held = new Map<string, ApprovalEntity[]>();

      // Bucketed by agent, because that is the key `entity.approvals` is asked
      // with - not by conversation. The badge counts waiting requests per
      // conversation, a different question that stays on its own path. Waiting
      // rows first, because a page draws the ones somebody still has to answer.
      for (const row of [...approvals.pending(), ...approvals.resolved()]) {
        const bucket = held.get(row.agentId);

        if (bucket === undefined) {
          held.set(row.agentId, [row]);
        } else {
          bucket.push(row);
        }
      }

      keep("approvals", held);
    }

    if (dirty.has("devices")) {
      keep("devices", devices);
    }

    // Every field above is set only when it holds a map; the optional members
    // are the shape's way of saying "not named", so the assembled value is a
    // patch even though the two spellings differ on whether a field may be
    // `undefined`.
    return patch as SnapshotPatch;
  };

  /**
   * Republish what moved and tell the subscriptions that read it. A publication
   * with nothing new is not a revision: no subscriber is woken.
   */
  const publish = (): boolean => {
    if (dirty.size === 0) {
      return false;
    }

    const before = builder.revision;
    const patch = patchOf();
    const fields = Object.keys(patch) as SnapshotMapField[];

    dirty.clear();

    if (fields.length === 0) {
      return false;
    }

    builder.next(patch);

    if (builder.revision === before) {
      return false;
    }

    // Only the watchers of what moved are told, and only after the revision they
    // would read has advanced: a frame stamped with a stale revision is dropped.
    const sent = subscriptions.notify(fields);

    // Every live subscription this publication did not have to answer: nothing it
    // reads moved. A change that touches one conversation must not cost a frame
    // per open tab, so the number of frames avoided is worth counting next to the
    // number sent.
    counts.coalesced += Math.max(0, subscriptions.stats().subscriptions - sent);

    return true;
  };

  return { publish };
}
