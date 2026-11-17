/**
 * The sequence that runs between "a socket is open again" and "the user may
 * type again".
 *
 * Five steps, in an order that is not arbitrary:
 *
 * 1. **resync** — one request; the engine answers with the states it holds for
 *    this connection and with the approvals that are still waiting. The caller
 *    has already told it to forget the previous connection's sequence numbers, so
 *    the answer is not mistaken for late frames.
 * 2. **reconcile** — the approvals that were waiting before, minus the ones the
 *    resync pushed, are the ones nobody will ever answer. That subtraction is the
 *    only place the count comes from.
 * 3. **history** — pages backwards from the newest message until the engine says
 *    there is nothing older (or until the caller's page budget runs out).
 * 4. **states** — the four state frames, handed over as a snapshot; the consumer
 *    overwrites its view, it never clears it first.
 * 5. **done** — a summary, and only then is a command allowed again.
 *
 * What this module deliberately does not do: it does not clear anything, does not
 * decide how many pages are "enough" beyond the budget passed in, and does not
 * tell the user anything. It reports steps and returns facts.
 */

import type { ApprovalLedger, MessagePage, PageResult } from "./controller";
import type { ReconnectState, RecoveryStep, ReplayStateKind } from "./types";

/** What a resync handed back. */
export interface SyncOutcome {
  /** Approval ids that are still waiting. Their absence from here is the stale set. */
  readonly approvals: readonly string[];
  /** Which state frames arrived; a missing one is visible, not silently filled in. */
  readonly states: readonly ReplayStateKind[];
}

/** Everything the sequence needs from outside. */
export interface RecoveryPorts {
  /** One resync request. The caller decides which flags to send. */
  readonly sync: () => Promise<SyncOutcome>;
  /** One page of history, newest first when `before` is `null`. */
  readonly page: (args: {
    readonly before: string | null;
    readonly limit: number;
  }) => Promise<PageResult>;
  /** Remembers what was waiting and works out what a resync forgot. */
  readonly ledger: ApprovalLedger;
  /** Stamp for anything that records when we noticed something. */
  readonly now: () => string;
  /**
   * How many pages of history one recovery may read. Defaults to 3.
   *
   * A budget rather than "until the beginning": with a long conversation the
   * honest choice is a bounded catch-up plus a visible "older messages exist"
   * fact, not a recovery that takes minutes.
   */
  readonly maxPages?: number;
  /** Page size handed to the engine. Defaults to 50, the value the corpus was recorded with. */
  readonly pageLimit?: number;
}

/** Why the sequence stopped, because "finished" and "gave up" render differently. */
export type RecoveryStopReason = "complete" | "page-budget" | "sync-failed" | "history-failed";

/** What the caller gets back. */
export interface RecoveryOutcome {
  readonly approvalsRecovered: number;
  /** Approvals that were waiting before and were not pushed again. An inference. */
  readonly staleCount: number;
  /** The state frames that actually arrived. */
  readonly states: readonly ReplayStateKind[];
  readonly pages: number;
  readonly appended: number;
  readonly hasMore: boolean;
  readonly nextBefore: string | null;
  readonly stopReason: RecoveryStopReason;
  readonly steps: readonly RecoveryStep[];
}

const DEFAULT_MAX_PAGES = 3;
const DEFAULT_PAGE_LIMIT = 50;

/**
 * Run the sequence once.
 *
 * Steps are reported as they complete through `onStep`; the returned outcome is
 * the same information plus the reason it stopped. A failure in the resync stops
 * the sequence immediately — the rest of it would be acting on a view that is
 * known to be incomplete.
 */
export async function runRecovery(
  ports: RecoveryPorts,
  onStep?: (step: RecoveryStep) => void,
): Promise<RecoveryOutcome> {
  const maxPages = ports.maxPages ?? DEFAULT_MAX_PAGES;
  const pageLimit = ports.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const steps: RecoveryStep[] = [];

  const report = (step: RecoveryStep): void => {
    steps.push(step);
    onStep?.(step);
  };

  // 1. resync -----------------------------------------------------------------
  const sync = await ports.sync();
  report({
    step: "sync",
    ok: true,
    approvalsRecovered: sync.approvals.length,
    // Resuming an interrupted turn is not something a resync can promise; it is
    // reported as false rather than guessed from frames that did not arrive.
    turnResumed: false,
    at: ports.now(),
  });

  // 2. reconcile --------------------------------------------------------------
  const reconciliation = ports.ledger.reconcile(sync.approvals);

  // 3. history ----------------------------------------------------------------
  let pages = 0;
  let appended = 0;
  let hasMore = false;
  let nextBefore: string | null = null;
  let stopReason: RecoveryStopReason = "complete";

  for (; pages < maxPages;) {
    const result = await ports.page({ before: nextBefore, limit: pageLimit });

    if (!result.ok) {
      stopReason = "history-failed";
      break;
    }

    pages += 1;
    appended += result.page.messages.length;
    hasMore = result.page.hasMore;
    nextBefore = result.page.nextBefore;

    report({
      step: "messages",
      pages,
      appended,
      hasMore,
      nextBefore,
      at: ports.now(),
    });

    // The end of the list is `hasMore === false`; the cursor is a separate fact
    // and the engine has been seen returning one on the last page.
    if (!hasMore) break;
    if (pages === maxPages) stopReason = "page-budget";
  }

  // 4. states -----------------------------------------------------------------
  report({ step: "states", covered: sync.states, at: ports.now() });

  // 5. done -------------------------------------------------------------------
  return {
    approvalsRecovered: sync.approvals.length,
    staleCount: reconciliation.stale.length,
    states: sync.states,
    pages,
    appended,
    hasMore,
    nextBefore,
    stopReason,
    steps,
  };
}

/** The state after a successful recovery: usable, and nothing left to retry. */
export function recoveredState(): ReconnectState {
  return "ready";
}

/** Helper for callers that only need the page the engine sends back. */
export type { MessagePage };
