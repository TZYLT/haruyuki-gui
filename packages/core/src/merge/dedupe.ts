/**
 * A bounded, least-recently-used membership table over id strings.
 *
 * The merger asks one question about every incoming frame -- "have I already
 * handled this id?" -- and a plain `Set` would answer it while growing without
 * limit: a long-running session sees millions of frames, and every id kept
 * forever is a leak the user pays for in memory and in GC pauses. Bounding the
 * table means an old id can be forgotten, and forgetting an id has exactly one
 * consequence: a reappearing frame is treated as new rather than as a repeat,
 * which is the same outcome as any other frame that arrived too late to be
 * placed.
 *
 * A `Map` gives recency for free. It iterates in insertion order, so deleting
 * and re-inserting a hit moves it to the back, and the front is always the
 * least recently used entry. That is why `seen()` is a write operation as well
 * as a read: without the refresh, a hot id would age out while a burst of
 * one-off ids pushed it toward eviction.
 *
 * No timers, no sizes in bytes, no TTL: the bound is a count, and the caller
 * decides what the count is. Synchronous throughout, because the caller is
 * synchronous.
 */

/** A fixed upper bound for the table when the caller does not pass one. */
const DEFAULT_LIMIT = 4096;

/** Membership table with bounded size and least-recently-used eviction. */
export type Dedupe = {
  /** Whether `id` is present; a hit also refreshes it to most recently used. */
  seen(id: string): boolean;
  /** Record `id`; adding an id that is already present refreshes it. */
  add(id: string): void;
  /** How many ids are currently remembered. */
  size(): number;
  /** Forget everything. */
  clear(): void;
};

/**
 * Build a bounded membership table.
 *
 * @param limit how many ids to remember; the least recently used is evicted
 *   once a new id would exceed it
 */
export function createDedupe(limit = DEFAULT_LIMIT): Dedupe {
  // A zero, negative or fractional bound would either evict the id that was just
  // added (making `add` a no-op) or leave the table with a fractional cap, so a
  // nonsense value is corrected rather than carried into every insertion.
  const bound = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  const entries = new Map<string, true>();

  /** Record `id` as the most recently used one. */
  const touch = (id: string): void => {
    entries.delete(id);
    entries.set(id, true);
  };

  return {
    seen(id) {
      if (!entries.has(id)) {
        return false;
      }

      touch(id);

      return true;
    },

    add(id) {
      touch(id);

      if (entries.size > bound) {
        // Insertion order is recency order here: the first key is the least
        // recently touched one. `done` is false only when the table is empty,
        // which the size check above already rules out, but reading it keeps
        // the eviction honest instead of asserting.
        const oldest = entries.keys().next();

        if (!oldest.done) {
          entries.delete(oldest.value);
        }
      }
    },

    size() {
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}
