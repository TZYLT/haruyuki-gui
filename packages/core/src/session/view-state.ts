/**
 * Per-tab view state: one bounded, in-memory table of scroll anchors and
 * collapsed groups.
 *
 * A tab remembers where the reader was and which groups they collapsed, so
 * switching away and coming back lands in the same place. That memory belongs to
 * the tab instance, never to the conversation: two tabs showing one conversation
 * are two independent places, and a table keyed by the conversation would make
 * them share a single position and overwrite each other. This module cannot tell
 * one key string from another, so the key choice belongs to the caller and is
 * pinned by the tests next to this file.
 *
 * Three properties, and nothing else:
 *
 * - In memory only. No path, no file, no serialisation, no cross-process
 *   sharing. A restarted run starts empty, which is the ruling rather than an
 *   omission, and a tab that closes is released by its owner.
 * - Bounded. A missing release must not grow the table for the life of the
 *   process, so the table evicts by itself once a new entry would exceed the
 *   bound. Every eviction is counted, so a leak shows up in a diagnostic reading
 *   instead of staying invisible.
 * - Least recently used first. Recency is `Map` insertion order: a hit is
 *   deleted and re-inserted, so the first key is always the least recently used
 *   one. A read refreshes it too -- a tab being looked at is a tab in use, and a
 *   burst of one-off tabs must not age it out.
 *
 * The table keeps the value it was given and hands the same reference back. It
 * does not clone, merge or rewrite a `ViewState`: the shape is readonly by
 * contract, and a second copy here would invite a second rule about which copy
 * is authoritative.
 */

import type { ViewState } from "@haruyuki/protocol";

/** How many tab instances are remembered when the caller names no bound. */
export const VIEW_STATE_LIMIT = 64;

/**
 * The table the session store exposes as its three view-state methods.
 *
 * Keyed by the caller's identity string -- the tab instance id in this product.
 * A value is `null` when the tab has no memory yet, which is an ordinary state,
 * not an error.
 */
export interface ViewStateStore {
  /** The remembered state for `instanceId`, or `null`. A hit counts as a use. */
  get(instanceId: string): ViewState | null;
  /** Remember `state` for `instanceId`; an existing entry is updated and refreshed. */
  set(instanceId: string, state: ViewState): void;
  /** Forget `instanceId`; unknown ids are a no-op. Called when a tab closes. */
  release(instanceId: string): void;
  /** How many tab instances are currently remembered. */
  readonly size: number;
  /** How many entries have been evicted since this table was created, for diagnostics. */
  readonly evicted: number;
}

/**
 * Build a view state table.
 *
 * @param maxEntries the upper bound; a value that is not a positive integer is
 *   corrected to {@link VIEW_STATE_LIMIT} rather than carried into every write,
 *   because the caller reads it from configuration and a table that evicts the
 *   entry it just stored would be worse than the default bound.
 */
export function createViewStateStore(maxEntries: number = VIEW_STATE_LIMIT): ViewStateStore {
  const bound = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : VIEW_STATE_LIMIT;

  // Insertion order is recency order here: every write deletes before it sets,
  // and every read re-inserts, so the front key is the least recently used one.
  const entries = new Map<string, ViewState>();
  let evicted = 0;

  return {
    get(instanceId) {
      const state = entries.get(instanceId);

      if (state === undefined) {
        return null;
      }

      // Refresh: without this, a tab that is being read while a burst of
      // one-off tabs arrives would be pushed toward eviction by its own reads.
      entries.delete(instanceId);
      entries.set(instanceId, state);

      return state;
    },

    set(instanceId, state) {
      // Delete before set: `Map#set` on a present key keeps the old position,
      // so an update would otherwise stay the next eviction candidate.
      entries.delete(instanceId);
      entries.set(instanceId, state);

      while (entries.size > bound) {
        // Reading the first key keeps the eviction honest instead of asserting a
        // size that the loop already proves is above the bound.
        const oldest = entries.keys().next();

        if (oldest.done === true) {
          break;
        }

        entries.delete(oldest.value);
        evicted += 1;
      }
    },

    release(instanceId) {
      entries.delete(instanceId);
    },

    get size() {
      return entries.size;
    },

    get evicted() {
      return evicted;
    },
  };
}
