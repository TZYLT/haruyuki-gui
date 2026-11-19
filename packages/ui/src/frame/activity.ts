/**
 * The per-tab activity store.
 *
 * Deliberately outside React: a streaming terminal updates its tab many times a
 * second, and routing that through the frame's state would re-render every tab
 * in the group. A tab subscribes to its own id; the frame never re-renders for a
 * badge.
 */

import type { PageActivity } from "./types.js";

/** One tab's current activity. */
export type ActivityState = PageActivity;

/** What the frame and its tabs share. */
export interface ActivityStore {
  get(tabId: string): ActivityState;
  set(tabId: string, update: Partial<ActivityState>): void;
  clearUnread(tabId: string): void;
  subscribe(tabId: string, listener: () => void): () => void;
}

/** The empty state every unknown tab starts from. */
const EMPTY: ActivityState = { streaming: false, approvals: 0, unread: 0 };

/** Create an activity store with no tabs. */
export function createActivityStore(): ActivityStore {
  const states = new Map<string, ActivityState>();
  const listeners = new Map<string, Set<() => void>>();

  const emit = (tabId: string): void => {
    for (const listener of listeners.get(tabId) ?? []) listener();
  };

  return {
    get(tabId) {
      return states.get(tabId) ?? EMPTY;
    },
    set(tabId, update) {
      const current = states.get(tabId) ?? EMPTY;
      const next = { ...current, ...update };

      if (
        next.streaming === current.streaming &&
        next.approvals === current.approvals &&
        next.unread === current.unread
      ) {
        return;
      }

      states.set(tabId, next);
      emit(tabId);
    },
    clearUnread(tabId) {
      const current = states.get(tabId);

      if (current === undefined || current.unread === 0) return;

      states.set(tabId, { ...current, unread: 0 });
      emit(tabId);
    },
    subscribe(tabId, listener) {
      const set = listeners.get(tabId) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(tabId, set);

      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(tabId);
      };
    },
  };
}

/** @param activity one tab's state @returns the badge text, or null for none */
export function badgeText(activity: ActivityState): string | null {
  if (activity.approvals > 0) return String(Math.min(activity.approvals, 99));

  if (activity.streaming) return "…";

  if (activity.unread > 0) return String(Math.min(activity.unread, 99));

  return null;
}
