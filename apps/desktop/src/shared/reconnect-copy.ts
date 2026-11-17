/**
 * Which words a reconnect puts on the screen.
 *
 * The mapping lives in `shared/` for the same reason the shell error table does:
 * the layer that knows the state and the layer that draws it must not each decide
 * what the state is called. This module names the key; the catalogue owns the text.
 *
 * Two rules shape the wording, and both are about not saying more than is known:
 *
 * - **No promises about time.** A reconnect has no deadline, and a sentence that
 *   says "shortly" will outlive its truth the first time an engine stays down.
 * - **The stale count is a fact about approvals, not about the network.** "N
 *   approvals expired while offline" is what was observed; saying why the
 *   connection dropped would be an invented cause.
 */

import type { ReconnectStatus } from "@haruyuki/core";

/**
 * The three things a reconnect can say, each with the key that says it.
 *
 * Written as an explicit table -- rather than a union of string literals returned
 * by `switch` -- because the i18n gate counts a key as used when it appears as
 * `t("…")`, `labelKey=` or `key: "…"`. A table is the shape the gate can read, and
 * it is also the shape a translator can hand to a review.
 */
export const RECONNECT_COPY = {
  reconnecting: { key: "component.reconnect.reconnecting" },
  staleApprovals: { key: "component.reconnect.staleApprovals" },
  olderAvailable: { key: "component.reconnect.olderAvailable" },
} as const;

/** A message key the catalogue is expected to define. */
export type ReconnectMessageKey = (typeof RECONNECT_COPY)[keyof typeof RECONNECT_COPY]["key"];

/**
 * The key for the current status, or `null` when there is nothing to say.
 *
 * `ready` returns `null` on purpose: a banner that is still mounted after a
 * successful reconnect has to disappear, and "null means nothing to draw" is a
 * clearer contract than a key whose text is empty.
 */
export function reconnectStatusKey(status: ReconnectStatus): ReconnectMessageKey | null {
  switch (status.state) {
    case "reconnecting":
    case "replaying":
      return RECONNECT_COPY.reconnecting.key;
    case "degraded":
      // Still the same sentence: from the outside, "we are trying" is true in both
      // states, and the count is what tells the user something was lost.
      return status.staleCount > 0
        ? RECONNECT_COPY.staleApprovals.key
        : RECONNECT_COPY.reconnecting.key;
    default:
      return null;
  }
}

/** Whether the history end has more to fetch, and therefore something to offer. */
export function olderMessagesKey(hasMore: boolean): ReconnectMessageKey | null {
  return hasMore ? RECONNECT_COPY.olderAvailable.key : null;
}
