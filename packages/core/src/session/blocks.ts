/**
 * Where a content update's blocks land: the table of blocks, each attached to
 * the turn it belongs to.
 *
 * A block arrives as a producer's plain data record, together with the id it is
 * known by and the two facts that can place it: the run that produced it and the
 * message it came from. This module does three things and no more:
 *
 * 1. **Places** the block on a turn. Which turn that is gets decided in exactly
 *    one place - the turn table - and this module only asks. It keeps no second
 *    notion of attribution: two rules for "whose turn is this" would eventually
 *    disagree, and the disagreement would show up as one message's blocks filed
 *    under two different turns.
 * 2. **Replaces** by block id. A second upsert for the same id swaps the object
 *    and leaves it where it first appeared, because a page renders the blocks in
 *    table order and a replaced block that moved to the end would jump under the
 *    reader's cursor.
 * 3. **Never loses content.** A block whose run and message are both unknown is
 *    still kept, under {@link ORPHAN_TURN_REF}, and counted: a block at the end
 *    of the conversation is a rendering problem, a dropped block is lost text.
 *
 * The block's own shape belongs to the producer. This module stores the record
 * as given - it reads two fields to place it and never rewrites, reorders or
 * interprets the rest.
 *
 * Nothing here throws. The caller is a socket callback, so unreadable input
 * costs one counted skip and never the session.
 */

import type { BlockEntity, SessionStore } from "@haruyuki/protocol";

import type { TurnRecord } from "./turns.js";

/**
 * The two questions this module asks the turn table.
 *
 * Narrower than the turn table on purpose: a block layer needs to know which
 * turn a run or a message belongs to, and nothing else about turns. Depending on
 * the whole table would mean carrying every member of it - and every future one -
 * to use two of them.
 */
export interface TurnLookup {
  /** The turn a run belongs to, or `null` when the table never saw that run. */
  turnOfRun(conversationId: string, runId: string): TurnRecord | null;
  /** The turn a message belongs to, or `null` when the table never saw that message. */
  turnOfMessage(conversationId: string, messageId: string): TurnRecord | null;
}

/**
 * The turn ref a block is filed under when nothing places it.
 *
 * A literal, not a real turn: a page that renders by turn must special-case it
 * and draw these blocks last. It is a value in the table rather than a separate
 * list so that "everything the producer sent" is answerable with one map.
 */
export const ORPHAN_TURN_REF = "orphan";

/** How many blocks the table keeps when the caller names no bound. */
export const BLOCK_TABLE_LIMIT = 4096;

/**
 * One content update.
 *
 * Taken from the store's own signature rather than restated: the shape is
 * currently inline in the protocol because the producing side is a separate
 * item still in flight, and a private copy here would be a second source of
 * truth that drifts silently. The name is deliberately not exported - the
 * block model belongs to its producer, and the day it lands this module imports
 * it instead.
 */
type ContentUpdate = Parameters<SessionStore["ingestContent"]>[1];

/** Read-only counters for diagnostics. Nothing here is rendered. */
export type BlockTableStats = {
  /** Blocks currently held, orphans included. */
  readonly blocks: number;
  /** Distinct turns that own at least one block. */
  readonly turns: number;
  /** Blocks placed under {@link ORPHAN_TURN_REF}. */
  readonly orphanBlocks: number;
  /** Upserts that replaced a block already in the table. */
  readonly replaced: number;
  /** Blocks dropped by a remove list. */
  readonly removed: number;
  /** Entries that could not be read at all; counted, then skipped. */
  readonly dropped: number;
  /** Blocks evicted to stay inside the bound. */
  readonly evicted: number;
};

/** What the table is built from. */
export type BlockTableOptions = {
  /** The turn table to ask; the caller owns it and outlives this one. */
  readonly turns: TurnLookup;
  /** Maximum blocks kept; the oldest one is evicted first. */
  readonly limit?: number;
};

/** The table one session store keeps for its blocks. */
export interface BlockTable {
  /** Take one content update. Synchronous, never throws. */
  ingestContent(conversationId: string, update: ContentUpdate): void;
  /** One block by its id, or `null`. */
  get(blockId: string): BlockEntity | null;
  /** Every block, in table order: the order a page renders them in. */
  blocks(): readonly BlockEntity[];
  /** The ids alone, in table order. */
  blockIds(): readonly string[];
  /** A copy of the counters; later changes do not alter it. */
  stats(): BlockTableStats;
}

/** A non-empty string, or `null`. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The string entries of a candidate list; empty when there is no list. */
function readStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => readString(item) !== null)
    : [];
}

/** A bound that a caller may pass: a positive integer, or the default. */
function readBound(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** A plain record, or `null` for a primitive or an array. */
function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * The id a block is known by.
 *
 * Both names are accepted because two producers name it differently, and taking
 * only one would silently orphan half the blocks of the other.
 *
 * @param block one candidate upsert
 */
function blockIdOf(block: Readonly<Record<string, unknown>>): string | null {
  return readString(block["blockId"]) ?? readString(block["id"]);
}

/**
 * Build a block table.
 *
 * @param options the turn lookup to ask, and the bound for the table
 */
export function createBlockTable(options: BlockTableOptions): BlockTable {
  const { turns } = options;
  const bound = readBound(options.limit, BLOCK_TABLE_LIMIT);

  /** Blocks by id, in the order they first appeared: that order is the render order. */
  const entries = new Map<string, BlockEntity>();

  const counts = {
    orphanBlocks: 0,
    replaced: 0,
    removed: 0,
    dropped: 0,
    evicted: 0,
  };

  /**
   * The turn a block belongs to.
   *
   * The run it names is asked first, because that is the producer's own and the
   * most precise attribution; then the message it came from. When neither is
   * known the block is filed under {@link ORPHAN_TURN_REF} rather than dropped.
   *
   * @param conversationId the conversation the update belongs to
   * @param block the upsert being placed
   * @param update the update, read for its message when the block names none
   */
  const resolveTurnRef = (
    conversationId: string,
    block: Readonly<Record<string, unknown>>,
    update: ContentUpdate,
  ): string => {
    const runId = readString(block["runId"]);

    if (runId !== null) {
      const record = turns.turnOfRun(conversationId, runId);

      if (record !== null) {
        return record.turnRef;
      }
    }

    const messageId = readString(block["messageId"]) ?? readString(update?.messageId);

    if (messageId !== null) {
      const record = turns.turnOfMessage(conversationId, messageId);

      if (record !== null) {
        return record.turnRef;
      }
    }

    return ORPHAN_TURN_REF;
  };

  /** Evict the oldest blocks until the table fits. */
  const enforceBound = (): void => {
    while (entries.size > bound) {
      const oldest = entries.keys().next();

      if (oldest.done === true) {
        break;
      }

      entries.delete(oldest.value);
      counts.evicted += 1;
    }
  };

  return {
    ingestContent(conversationId, update) {
      const conversation = readString(conversationId);

      if (conversation === null) {
        counts.dropped += 1;

        return;
      }

      const removes = readStrings(update?.removes);

      for (const blockId of removes) {
        if (entries.delete(blockId)) {
          counts.removed += 1;
        }
      }

      const upserts = Array.isArray(update?.upserts) ? update.upserts : [];

      for (const candidate of upserts) {
        const record = readRecord(candidate);
        const blockId = record === null ? null : blockIdOf(record);

        if (record === null || blockId === null) {
          counts.dropped += 1;

          continue;
        }

        const turnRef = resolveTurnRef(conversation, record, update);

        const entity: BlockEntity = Object.freeze({
          blockId,
          turnRef,
          messageId: readString(record["messageId"]) ?? readString(update?.messageId),
          runId: readString(record["runId"]),
          // The producer's record, as given: this layer reads it and never
          // rewrites it, so a change upstream needs no change here.
          block: record,
        });

        // Counted once per distinct orphan id: re-feeding the same block does not
        // make the loss bigger, and a counter that grows on a retry would read
        // like more content went astray than actually did.
        if (turnRef === ORPHAN_TURN_REF && !entries.has(blockId)) {
          counts.orphanBlocks += 1;
        }

        if (entries.has(blockId)) {
          counts.replaced += 1;
        }

        // Set on a present key keeps the position it already had, which is the
        // contract: a replacement replaces the object, not the place.
        entries.set(blockId, entity);
      }

      enforceBound();
    },

    get(blockId) {
      return entries.get(blockId) ?? null;
    },

    blocks() {
      return [...entries.values()];
    },

    blockIds() {
      return [...entries.keys()];
    },

    stats() {
      const all = [...entries.values()];
      const owners = new Set(all.map((entity) => entity.turnRef));

      return Object.freeze({
        blocks: all.length,
        turns: owners.size,
        orphanBlocks: counts.orphanBlocks,
        replaced: counts.replaced,
        removed: counts.removed,
        dropped: counts.dropped,
        evicted: counts.evicted,
      });
    },
  };
}
