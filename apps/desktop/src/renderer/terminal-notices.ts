/**
 * The one place a dropped-bytes notice goes, so the panel and the bridge cannot
 * disagree about where a notice is shown.
 *
 * Why this exists rather than two callbacks
 *   `main.tsx` used to pass the same `console.info` closure twice -- once to the
 *   router and once to `createRendererBridge` -- and both were dead ends: nothing
 *   rendered. Replacing two console calls with two panel calls would keep the
 *   duplication and add a second copy of "which terminal is this about". So both
 *   producers hand their notice to this object, and the panel is the single
 *   subscriber.
 *
 * Why the buffer holds the latest notice only
 *   A notice is a gap in the output the user is looking at *now*. A queue would
 *   replay old gaps after the screen has moved on, which is worse than showing the
 *   newest one late. The counters keep the history that the buffer deliberately
 *   drops, so a diagnostic can still see how many arrived.
 *
 * Why it is a plain object and not React state
 *   A notice arrives on a bridge callback, outside React's render cycle and
 *   before the panel may have mounted. Making it a hook would lose every notice
 *   that arrived during the first frame; a subscriber list keeps them for whoever
 *   mounts next.
 */

import type { TerminalNotice } from "@haruyuki/ui";

/** What a subscriber is told: the newest notice, or nothing when it was consumed. */
export type TerminalNoticeListener = (notice: TerminalNotice | null) => void;

/** The surface both notice producers write to. */
export interface TerminalNoticeSink {
  /**
   * Record a dropped-bytes notice and hand it to every subscriber.
   *
   * @param notice the terminal and how many bytes were dropped
   */
  publish(notice: TerminalNotice): void;

  /**
   * Subscribe to notices.
   *
   * A late subscriber is given the pending notice immediately, so a panel that
   * mounts after a drop still renders the marker for it.
   *
   * @param listener called with each notice
   * @returns a function that unsubscribes
   */
  subscribe(listener: TerminalNoticeListener): () => void;

  /** How many notices have been published, for a diagnostic. */
  readonly published: number;
}

/**
 * Build the notice surface.
 *
 * Not exported: a second instance would be a surface the panel is not subscribed
 * to, which is exactly the failure this module exists to remove. Tests construct
 * their own through the exported factory below.
 *
 * @returns the sink the two producers write to
 */
function build(): TerminalNoticeSink {
  const listeners = new Set<TerminalNoticeListener>();
  let latest: TerminalNotice | null = null;
  let published = 0;

  return {
    publish(notice: TerminalNotice): void {
      published += 1;
      latest = notice;

      for (const listener of listeners) {
        listener(notice);
      }
    },

    subscribe(listener: TerminalNoticeListener): () => void {
      listeners.add(listener);

      // Handed over on subscribe rather than only on the next publish: the drop
      // may have happened while the panel was still mounting, and a marker the
      // user never sees is the same as no marker at all.
      if (latest !== null) {
        listener(latest);
      }

      return () => {
        listeners.delete(listener);
      };
    },

    get published(): number {
      return published;
    },
  };
}

/** The process-wide instance, because both producers live in this module's caller. */
export const terminalNotices: TerminalNoticeSink = build();

/**
 * Build an independent surface, for a test.
 *
 * Exported so a test does not have to publish into the process-wide one and
 * leave state behind for the next case.
 *
 * @returns a fresh sink
 */
export function createTerminalNotices(): TerminalNoticeSink {
  return build();
}
