/**
 * The renderer's external frame store: the observable the React bindings read.
 *
 * Why this exists at all
 *   `FrameEntry` is a plain command-and-observe object, not the subscription
 *   primitive React can drive. `useSyncExternalStore` wants exactly three
 *   things -- a synchronous read, a subscribe function and a stable value --
 *   and this module is the smallest object that supplies them, hand-written so
 *   the renderer needs no state library (zero new dependencies).
 *
 * The reference-stability contract (the whole point of this file)
 *   `useSyncExternalStore` calls `getSnapshot` on *every* render and compares
 *   the result with the previous one using `Object.is`. `FrameEntry.snapshot()`
 *   deliberately returns a fresh object on every call, because the caller owns
 *   the result. Handing that straight to React would make every render look like
 *   a change, and React would re-render forever with
 *   "The result of getSnapshot should be cached to avoid an infinite loop".
 *   So this store caches one snapshot object and rebuilds it only when the entry
 *   reports a change: repeated reads between changes return the SAME reference.
 *   Anything that breaks that identity breaks every consumer, so it is asserted
 *   with `toBe` in the tests, not `toEqual`.
 *
 * Why the upstream subscription is created once, at construction
 *   Three behaviours depend on it, and none of them is available from a lazy
 *   per-listener design:
 *   1. the cache is invalidated by every change, including changes that arrive
 *      while nobody is subscribed -- otherwise the first render after mounting
 *      (which reads before the subscription effect runs) would see a stale
 *      snapshot;
 *   2. one change invalidates exactly once, so two subscribers that read during
 *      the same notification see the same object rather than one object each;
 *   3. the entry sees O(1) subscribers from this layer, not one per React
 *      component.
 *   `subscribe` therefore fans out locally instead of registering a wrapper per
 *   listener upstream. A store keeps its upstream subscription for its own
 *   lifetime; the store and the entry are created together for one bridge
 *   session, so when the session is dropped both are unreachable and collected
 *   together. There is no separate disposal to forget.
 *
 * What it deliberately does not do
 *   It does not filter, select or mutate. It does not decode frames and it does
 *   not answer the handshake -- those belong to `entry.ts`. Its whole output is
 *   the cached snapshot plus change notifications.
 */

import type { FrameEntry, FrameEntrySnapshot } from "./entry.js";

/**
 * The observable contract a React binding (or any other consumer) depends on.
 *
 * Deliberately the two members `useSyncExternalStore` needs and nothing else:
 * a smaller surface is what lets the cache live in exactly one place.
 */
export interface FrameStore {
  /**
   * Read the current snapshot.
   *
   * The returned object is stable: two calls with no intervening change return
   * the same reference. Callers must treat it as immutable -- the store keeps
   * handing out the same object -- which is what the frozen `FrameEntrySnapshot`
   * shape already implies.
   *
   * @returns the cached snapshot for the current state
   */
  getSnapshot(): FrameEntrySnapshot;

  /**
   * Observe changes.
   *
   * The listener is not called on subscription itself; read
   * {@link FrameStore.getSnapshot} for the current value. One notification per
   * entry change, delivered to every listener registered at that moment.
   *
   * @param listener called synchronously after a change, with no arguments
   * @returns a function that removes this listener; calling it twice is safe
   */
  subscribe(listener: () => void): () => void;
}

/**
 * Build a store over one frame entry.
 *
 * @param entry the receiver whose state this store exposes
 * @returns a store that starts on the entry's current state
 */
export function createFrameStore(entry: FrameEntry): FrameStore {
  /**
   * The cached snapshot, or `null` when the entry has changed since it was
   * built. `null` rather than a dirty flag so an unread change costs nothing
   * until somebody actually renders.
   */
  let cached: FrameEntrySnapshot | null = null;

  /** Consumers of this store, in subscription order. */
  const listeners = new Set<() => void>();

  // The single upstream subscription, established before any consumer exists so
  // the cache cannot go stale while the tree is unmounted (see the file note).
  entry.subscribe(() => {
    // Invalidate first: a listener that reads during notification must compute
    // the new snapshot, never see the old one.
    cached = null;

    // Iterate over a copy, like the entry does: a listener that unsubscribes
    // another one during a notification then cannot shorten the batch it is part
    // of. A throwing listener is contained per listener -- one consumer's bug
    // must not skip the rest, and the entry has no logging channel to report it.
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Contained by design; see above.
      }
    }
  });

  return {
    getSnapshot(): FrameEntrySnapshot {
      if (cached === null) {
        cached = entry.snapshot();
      }

      return cached;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);

      let subscribed = true;

      return () => {
        if (!subscribed) {
          return;
        }

        subscribed = false;
        listeners.delete(listener);
      };
    },
  };
}
