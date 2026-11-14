/**
 * React bindings for the external frame store.
 *
 * Why `useSyncExternalStore` and not `useState` plus an effect
 *   The store is outside React and can change between the render and the
 *   effect that would subscribe. That is exactly the tearing/`useEffect`
 *   problem `useSyncExternalStore` exists to solve: React reads the store
 *   during render, subscribes after commit, and re-reads on notification, so a
 *   change that lands in the gap is never missed. Anything self-rolled here
 *   would have to reimplement that, badly.
 *
 * Why a server snapshot is provided
 *   `useSyncExternalStore`'s third argument is required whenever the tree is
 *   rendered by `react-dom/server`. Without it React throws "Missing
 *   getServerSnapshot, which is required for server-rendered content" -- and
 *   this renderer package is a *library*: its consumers decide whether a tree
 *   is server-rendered or hydrated. A component test that calls
 *   `renderToString`, or a host that pre-renders a shell, would hit that error
 *   for a reason that has nothing to do with this store.
 *
 *   Providing it is correct rather than merely convenient, because the snapshot
 *   is plain data with no browser-only source: it is the cache the store already
 *   holds, and the frame entry does not advance while a server render is in
 *   progress. So the server read is the same read. The one caveat, stated so it
 *   is not discovered later: the store must not be driven *during* the server
 *   render, or the markup would describe a state the client cannot reproduce and
 *   hydration would mismatch -- driving it is the host's job, and it happens
 *   after mount, not inside a render pass.
 *
 * What these hooks do not do
 *   They do not own the store, create it, or dispose of it: one store belongs to
 *   one bridge session, and its lifetime is the session's. A hook that created
 *   its own store per component would give every component a private copy of the
 *   state, which is the defect the whole layer exists to avoid.
 */

import { useSyncExternalStore } from "react";

import type { FrameChannel } from "@haruyuki/protocol";

import type { FrameEntrySnapshot } from "./entry.js";
import type { FrameStore } from "./store.js";

/**
 * Subscribe to the whole snapshot.
 *
 * Returns the store's snapshot object -- the same reference until something
 * actually changed -- so a component re-renders once per change and not once
 * per render. Comparing the result with `===` to decide whether to do work is
 * therefore meaningful, which is not true of `entry.snapshot()`.
 *
 * @param store the session's frame store
 * @returns the current snapshot, stable between changes
 */
export function useFrameSnapshot(store: FrameStore): FrameEntrySnapshot {
  return useSyncExternalStore<FrameEntrySnapshot>(
    // `store.subscribe` is stable for the lifetime of one store and does not
    // depend on `this`, so passing it directly keeps React from unsubscribing
    // and resubscribing on every render.
    store.subscribe,
    store.getSnapshot,
    // Same read: see the note at the top of the file for why this is sound.
    store.getSnapshot,
  );
}

/**
 * Subscribe to one channel's frame count.
 *
 * The selector returns a number, so React compares snapshots by value: a change
 * on another channel produces the same number and does not re-render this
 * consumer. That is the difference between this hook and
 * {@link useFrameSnapshot}, which re-renders on any change.
 *
 * @param store the session's frame store
 * @param channel the channel whose counter is observed
 * @returns how many frames this entry has accepted on that channel
 */
export function useFrameChannel(store: FrameStore, channel: FrameChannel): number {
  return useSyncExternalStore<number>(
    store.subscribe,
    () => store.getSnapshot().perChannel[channel],
    () => store.getSnapshot().perChannel[channel],
  );
}
