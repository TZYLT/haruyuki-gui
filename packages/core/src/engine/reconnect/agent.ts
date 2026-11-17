/**
 * One agent's reconnect layer, assembled.
 *
 * Every part under this directory is testable on its own, and that is exactly why
 * this file exists: individually correct parts can still be wired wrongly, and the
 * wiring is where "the socket closed" has to become "a recovery ran, a banner says
 * so, and the sequence ended in a state the caller can act on".
 *
 * The composition is given its ports rather than building them, so a test can
 * drive a whole reconnect without an engine, a socket or a process. It owns the
 * order of events and nothing else:
 *
 *   transport closes -> the state machine says reconnecting -> recovery runs
 *   -> each step is reported -> continuity is judged on the page we got
 *   -> the final state is ready, or degraded when the window ran out
 */

import type { ApprovalLedger, PageResult, Unsubscribe } from "./controller";
import type { TransportWatch } from "./watcher";
import type {
  ReconnectCause,
  ReconnectStatus,
  RecoveryStep,
  ReplayGap,
  ReplaySink,
  ReplayStateKind,
} from "./types";
import { createLedger } from "./approvals";
import { detectHistoryGap } from "./gaps";
import { runRecovery } from "./recovery";
import type { RecoveryOutcome, SyncOutcome } from "./recovery";
import { createStateMachine } from "./state-machine";
import type { StateClock } from "./state-machine";

/** What the caller supplies. Everything network-shaped is a port. */
export interface ReconnectAgentOptions {
  readonly agentId: string;
  /** Injected so tests walk the reconnect window without waiting for it. */
  readonly clock: StateClock;
  /** The watch this layer listens to. */
  readonly watch: TransportWatch;
  /** One resync. The caller owns the flags and the wire shape. */
  readonly sync: () => Promise<SyncOutcome>;
  /** One page of history. */
  readonly page: (args: {
    readonly before: string | null;
    readonly limit: number;
  }) => Promise<PageResult>;
  /** Remembers approvals; a fresh ledger is created when omitted. */
  readonly ledger?: ApprovalLedger;
  /** Receives the replayed sequence. Omitted means the recovery still runs. */
  readonly sink?: ReplaySink;
  /** Where our local conversation stopped, for continuity checking. */
  readonly cursor?: () => string | null;
  /**
   * Where the reader was when the connection dropped: `true` means the newest
   * message was in view.
   *
   * The view owns scroll position, so it owns this answer; the layer only carries
   * it across the gap. When nobody answers, the reader is kept with the newest
   * message, because a jump to the newest is recoverable and a jump away from it
   * looks like the conversation was replaced.
   */
  readonly scrollIntent?: () => boolean;
  readonly degradedAfterMs?: number;
  readonly maxPages?: number;
  readonly pageLimit?: number;
}

/**
 * One agent's controller.
 *
 * Deliberately not the pool-level `ReconnectController`: that one takes an agent
 * id on every call because it speaks for many agents, while everything here is
 * already scoped to one. Extending it would force every caller to pass back the
 * id it just used to find this object.
 */
export interface ReconnectAgent {
  status(): ReconnectStatus;
  canSend(): boolean;
  onStatus(listener: (status: ReconnectStatus) => void): Unsubscribe;
  onStep(listener: (agentId: string, step: RecoveryStep) => void): Unsubscribe;
  onGap(listener: (agentId: string, gap: ReplayGap) => void): Unsubscribe;
  /** The user pressed retry. A no-op unless the layer is degraded. */
  retry(): void;
  /** Runs one recovery now. Exposed for the retry button and for tests. */
  recover(): Promise<RecoveryOutcome>;
  /** Stops listening to the watch and to its own status. */
  dispose(): void;
}

/**
 * The id of a replayed message, or `null` when the value is not one.
 *
 * A replayed page is `unknown[]`, and the only thing that makes an id usable for
 * continuity is that it is a string. Coercing instead would manufacture ids the
 * engine never sent: `{ id: null }` would become the literal `"null"` and could
 * then be matched against a cursor, and `{ id: 42 }` would become `"42"` and could
 * never match the string cursor it should have matched. A message with no usable
 * id is left out of the continuity comparison rather than counted as a position.
 */
const idOf = (message: unknown): string | null => {
  if (typeof message !== "object" || message === null) return null;
  if (!("id" in message)) return null;

  const id = message.id;
  return typeof id === "string" && id !== "" ? id : null;
};

export function createReconnectAgent(options: ReconnectAgentOptions): ReconnectAgent {
  const { agentId, clock, watch } = options;
  const ledger = options.ledger ?? createLedger();
  const now = (): string => new Date(clock.now()).toISOString();

  const statusListeners = new Set<(status: ReconnectStatus) => void>();
  const stepListeners = new Set<(agentId: string, step: RecoveryStep) => void>();
  const gapListeners = new Set<(agentId: string, gap: ReplayGap) => void>();

  const machine = createStateMachine({
    agentId,
    clock,
    ...(options.degradedAfterMs === undefined ? {} : { degradedAfterMs: options.degradedAfterMs }),
    onChange: (status) => {
      for (const listener of [...statusListeners]) listener(status);
    },
  });

  // The ids of the oldest page read, which is the only page that can join what we
  // had to what came back. Kept here rather than inside the sequence because the
  // pager reports pages, not joins.
  let oldestPageIds: readonly string[] = [];

  const page: ReconnectAgentOptions["page"] = async (args) => {
    const result = await options.page(args);
    if (result.ok && Array.isArray(result.page.messages)) {
      const items: readonly unknown[] = result.page.messages;
      oldestPageIds = items.map(idOf).filter((id): id is string => id !== null);
      // Handed over as it arrives rather than at the end: a consumer that renders
      // from the sink would otherwise be told how many rows came without ever
      // receiving one.
      options.sink?.messages(agentId, items);
    }
    return result;
  };

  const report = (step: RecoveryStep): void => {
    for (const listener of [...stepListeners]) listener(agentId, step);
  };

  async function recover(): Promise<RecoveryOutcome> {
    machine.recoveryStarted();
    oldestPageIds = [];
    options.sink?.begin(agentId);

    let outcome: RecoveryOutcome;
    try {
      outcome = await runRecovery(
        {
          sync: options.sync,
          page,
          ledger,
          now,
          ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
          ...(options.pageLimit === undefined ? {} : { pageLimit: options.pageLimit }),
        },
        report,
      );
    } catch (error) {
      machine.recoveryFailed();
      throw error;
    }

    // The count travels with the status, so the banner and the row that explains
    // it cannot disagree.
    machine.noteStale(outcome.staleCount);

    if (options.sink !== undefined) {
      // Continuity is judged against where we stopped, and only when a page came
      // back: an empty answer proves nothing about a gap.
      if (oldestPageIds.length > 0) {
        const gap = detectHistoryGap({
          cursor: options.cursor?.() ?? null,
          replayed: oldestPageIds,
          hasMore: outcome.hasMore,
          detectedAt: now(),
        });
        if (gap !== null) {
          for (const listener of [...gapListeners]) listener(agentId, gap);
        }
      }
      options.sink.states(agentId, outcome.states);
      // The scroll intent travels with the replay, not before it: the consumer
      // needs the new content first and the instruction second.
      options.sink.focus(agentId, { stickToBottom: options.scrollIntent?.() ?? true });
      options.sink.end(agentId, {
        appended: outcome.appended,
        hasMore: outcome.hasMore,
        nextBefore: outcome.nextBefore,
        stopReason: outcome.stopReason,
      });
    }

    machine.recoveryFinished();
    return outcome;
  }

  const offClose = watch.onClose((closedAgentId) => {
    if (closedAgentId !== agentId) return;
    machine.transportClosed("reset");
    // The close is the only signal that a recovery is owed, so it is started
    // here -- but one microtask later, so "reconnecting" is observable. Starting
    // it inline would make the layer jump from ready to replaying within a single
    // tick, and a banner that never renders "reconnecting" may as well not have
    // that state.
    //
    // One microtask means "after the current synchronous block", not "next frame":
    // a listener subscribed in the same block sees all three states, while a
    // listener that subscribes later is not promised the first two. That is the
    // whole guarantee, and it is enough -- rendering subscribers are attached when
    // the view is created, not when a socket closes.
    //
    // A failure is already recorded as a status; rethrowing it would surface as an
    // unhandled rejection nobody can act on.
    queueMicrotask(() => {
      void recover().catch(() => {});
    });
  });

  return {
    status: () => machine.status(),
    canSend: () => machine.canSend(),
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onStep(listener) {
      stepListeners.add(listener);
      return () => stepListeners.delete(listener);
    },
    onGap(listener) {
      gapListeners.add(listener);
      return () => gapListeners.delete(listener);
    },
    retry() {
      const wasDegraded = machine.status().state === "degraded";
      machine.retry();
      if (!wasDegraded) return;
      // Deferred for the same reason the close handler defers: the retry has to
      // be observable as "reconnecting" before the sequence takes over, otherwise
      // pressing the button looks like nothing happened.
      queueMicrotask(() => {
        void recover().catch(() => {});
      });
    },
    recover,
    dispose() {
      offClose();
      machine.dispose();
      statusListeners.clear();
      stepListeners.clear();
      gapListeners.clear();
    },
  };
}

/** The four state kinds, so a caller can name them without a string literal. */
export const STATE_KINDS: readonly ReplayStateKind[] = ["device", "queue", "subagent", "loop"];

/** Re-exported so a caller does not have to reach into the types module. */
export type { ReconnectCause };
