/**
 * Remembers the approvals that were waiting when the connection dropped, and
 * works out which of them a resync no longer pushes.
 *
 * The engine never says why an approval stopped waiting: it may have timed out,
 * been answered on another surface, or already have been gone before the drop.
 * So this ledger reports "no longer waiting", never "expired", and a caller may
 * render the set and its count but not a reason nobody observed.
 *
 * Four properties the tests are built around, because each broken one is a bug a
 * user can see:
 *
 * 1. **One entry per request.** Noting the same id twice keeps the first stamp.
 *    The stamp is when the approval was first seen waiting; a re-push or a poll
 *    that overwrote it would move that moment and reorder anything built on it.
 * 2. **A resolution is final.** Resolving forgets the entry, so an approval the
 *    user already answered is never reported as waiting or stale afterwards.
 * 3. **Reconciling is idempotent.** A recovery can be retried and a resync can
 *    run twice over the same set. The answer depends only on what is remembered
 *    and what was pushed, so the second call reports the same single stale
 *    approval -- not zero, and not two.
 * 4. **Reconciling decides nothing on its own.** It does not forget what it
 *    reported as stale: a later reconcile against a different set has to see the
 *    same history. Only a resolution removes an entry.
 *
 * Idempotency is arranged by caching the last answer under a key built from the
 * pushed ids plus a generation number for the remembered set, rather than by
 * remembering what was already reported. A "what did I already say" list would
 * make the second call depend on the first, and that coupling is what turns one
 * stale approval into two when the resync retries.
 */

import type { ApprovalLedger, ApprovalReconciliation, PendingApproval } from "./controller";

export interface LedgerOptions {
  /** Clock for stamps the caller does not supply; defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
}

/** The stamp a caller who left one out gets: the real time, in UTC. */
const defaultNow = (): string => new Date().toISOString();

/**
 * A key that is equal for two calls exactly when they ask the same question.
 *
 * The pushed ids are sorted so the order the engine happened to push them in
 * cannot split the cache, and a NUL separator keeps `["a b"]` and `["a", "b"]`
 * apart where a space would not. The generation covers the other half of the
 * question: which approvals were remembered when the answer was computed.
 */
function cacheKey(generation: number, pushed: ReadonlySet<string>): string {
  return `${generation}\u0000${[...pushed].sort().join("\u0000")}`;
}

export function createLedger(options: LedgerOptions = {}): ApprovalLedger {
  const now = options.now ?? defaultNow;

  /**
   * Everything remembered as waiting, keyed by request id.
   *
   * Insertion order is the order of first noting, and that is the order both
   * result lists keep: a caller rendering "still waiting" next to "no longer
   * waiting" should see each list in the order the approvals arrived.
   */
  const waiting = new Map<string, PendingApproval>();

  /**
   * Ids the last reconcile found the engine no longer pushing.
   *
   * Kept apart from `waiting` because the two questions differ: what we remember
   * has to survive a reconcile (a later set still sees the same history), while
   * "how many are waiting" must not count an approval the resync dropped. A new
   * push of the same id clears its mark, because the engine asking again means it
   * is waiting again.
   */
  let notWaiting = new Set<string>();

  /** Changes whenever an entry is added or removed; part of the cache key. */
  let generation = 0;
  let cached: { readonly key: string; readonly value: ApprovalReconciliation } | null = null;

  function changed(): void {
    generation += 1;
    // Dropping the cached entry is what makes a stale answer impossible to serve
    // once the remembered set has moved on.
    cached = null;
  }

  function notePending(approval: PendingApproval): void {
    // First stamp wins, so noting an id that is already remembered adds no entry
    // and keeps the original stamp. The one thing it can change is the "no longer
    // waiting" mark: the engine asking again about an approval the last resync
    // dropped means it is waiting again.
    if (waiting.has(approval.requestId)) {
      if (notWaiting.delete(approval.requestId)) {
        changed();
      }
      return;
    }
    // The type says the caller supplies `at`, but a plain-JavaScript caller can
    // leave it out; that is the only case the injected clock exists for, and
    // only then is a new object built. A supplied stamp is stored as the object
    // that carried it, so a reconcile hands back the very instance a caller is
    // holding and it can compare, cache or render that entry by identity.
    const remembered: PendingApproval = approval.at
      ? approval
      : { requestId: approval.requestId, at: now() };
    waiting.set(approval.requestId, remembered);
    notWaiting.delete(approval.requestId);
    changed();
  }

  function noteResolved(requestId: string): void {
    // Deleting instead of keeping a tombstone: "remembered" and "waiting" are the
    // same thing here, and a tombstone would have to be filtered out of every
    // answer rather than never entering one.
    if (!waiting.delete(requestId)) return;
    notWaiting.delete(requestId);
    changed();
  }

  function reconcile(reappeared: readonly string[]): ApprovalReconciliation {
    // A set, so an id the engine pushed twice is still one approval: the doubled
    // row a user would notice is exactly what a per-occurrence count produces.
    const pushed = new Set(reappeared);
    const key = cacheKey(generation, pushed);
    if (cached !== null && cached.key === key) return cached.value;

    const pending: PendingApproval[] = [];
    const stale: PendingApproval[] = [];
    for (const approval of waiting.values()) {
      if (pushed.has(approval.requestId)) pending.push(approval);
      else stale.push(approval);
    }

    // Frozen because the answer is shared: the next identical query hands this
    // same object back, and a caller that appended to one of these arrays would
    // otherwise be editing the cache.
    const value: ApprovalReconciliation = Object.freeze({
      pending: Object.freeze(pending),
      stale: Object.freeze(stale),
    });
    cached = { key, value };
    // This reconcile is the newest statement about who is waiting, so its stale
    // list replaces the mark rather than adding to it.
    notWaiting = new Set(stale.map((approval) => approval.requestId));
    return value;
  }

  return {
    notePending,
    noteResolved,
    reconcile,
    // Remembered minus the ones the last reconcile found the engine no longer
    // pushing: the count a caller renders, not the size of the memory.
    pendingCount: () => waiting.size - notWaiting.size,
  };
}
