/**
 * The reconnect state of one agent, and the only place that decides anything.
 *
 * Everything else in this layer reports: the watch says a socket closed, the
 * probe says the peer stopped answering, the pager says what the engine
 * returned. This machine turns those reports into the four states a banner can
 * render, counts the attempts, and owns the two decisions that must not be
 * spread around:
 *
 * - **when to stop trying.** Retrying forever looks identical to a fast
 *   recovery from the outside, and a user watching a spinner cannot tell the
 *   difference between "almost back" and "never coming back". After a bounded
 *   window the machine reports `degraded`, where reading still works and sending
 *   does not.
 * - **whether a command may be sent.** A second derivation of this answer
 *   somewhere else is a second answer, and the day they disagree the interface
 *   accepts a send it should refuse.
 *
 * Time is injected. The window is measured from the moment the connection was
 * lost, not from the last attempt, so a slow attempt cannot extend it silently.
 */

import type { ReconnectCause, ReconnectState, ReconnectStatus } from "./types";

/** The clock this machine needs; the same shape the rest of the layer takes. */
export interface StateClock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

export interface StateMachineOptions {
  readonly agentId: string;
  readonly clock: StateClock;
  /**
   * How long the machine keeps reporting `reconnecting` before it gives up and
   * calls the connection degraded. Defaults to 12 s, deliberately inside the
   * 10-15 s window a user was promised: shorter would abandon recoveries that
   * were about to succeed, longer would keep the reader staring at a banner that
   * is no longer true.
   */
  readonly degradedAfterMs?: number;
  readonly onChange?: (status: ReconnectStatus) => void;
}

/** The states plus the inputs that move between them. */
export interface AgentStateMachine {
  status(): ReconnectStatus;
  canSend(): boolean;
  /** The socket closed. `cause` says how we found out, not what to do about it. */
  transportClosed(cause: Extract<ReconnectCause, "reset" | "silent">): void;
  /** The endpoint itself changed, so the old connection is not coming back. */
  endpointChanged(): void;
  /** The user pressed retry while degraded. */
  retry(): void;
  /** A connection exists and the recovery sequence is starting. */
  recoveryStarted(): void;
  /**
   * Records how many approvals the recovery left unanswered.
   *
   * Passed in rather than derived here: the reconciliation knows what came back,
   * this machine only carries the number to the render layer.
   */
  noteStale(count: number): void;
  /** The sequence finished: the connection is usable again. */
  recoveryFinished(): void;
  /** The sequence could not finish: back to trying. */
  recoveryFailed(): void;
  /** Drops the timer. Safe twice. */
  dispose(): void;
}

const DEFAULT_DEGRADED_AFTER_MS = 12_000;

const toIso = (at: number): string => new Date(at).toISOString();

export function createStateMachine(options: StateMachineOptions): AgentStateMachine {
  const { agentId, clock, onChange } = options;
  const windowMs = options.degradedAfterMs ?? DEFAULT_DEGRADED_AFTER_MS;

  let state: ReconnectState = "ready";
  let attempt = 0;
  let cause: ReconnectCause | null = null;
  let since = clock.now();
  let staleCount = 0;
  let deadline: number | null = null;
  let cancelDeadline: (() => void) | null = null;
  let disposed = false;

  const status = (): ReconnectStatus => ({
    agentId,
    state,
    attempt,
    cause,
    since: toIso(since),
    staleCount,
  });

  function clearDeadline(): void {
    cancelDeadline?.();
    cancelDeadline = null;
    deadline = null;
  }

  function armDeadline(): void {
    clearDeadline();
    deadline = clock.now() + windowMs;
    cancelDeadline = clock.setTimer(() => {
      cancelDeadline = null;
      // The window measures "time without a usable connection". Replaying counts:
      // a resync that never answers leaves the layer no better off than one that
      // never connected, and a banner stuck on "replaying" is a lie about
      // progress.
      if (!disposed && (state === "reconnecting" || state === "replaying")) {
        transition("degraded", cause);
      }
    }, windowMs);
  }

  function transition(next: ReconnectState, nextCause: ReconnectCause | null): void {
    const changed = state !== next || cause !== nextCause;
    state = next;
    cause = nextCause;
    since = clock.now();
    if (next === "ready") {
      attempt = 0;
      clearDeadline();
    }
    if (changed) {
      onChange?.(status());
    }
  }

  /** Starts (or restarts) the reconnect window for a freshly lost connection. */
  function beginReconnect(nextCause: ReconnectCause): void {
    attempt = 1;
    transition("reconnecting", nextCause);
    armDeadline();
  }

  return {
    status,
    canSend: () => state === "ready",

    transportClosed(nextCause) {
      if (disposed) return;
      // A close while degraded is not new information: the connection was
      // already lost and the user has been told. Only a retry leaves that state.
      if (state === "degraded") return;
      beginReconnect(nextCause);
    },

    endpointChanged() {
      if (disposed || state === "degraded") return;
      beginReconnect("endpoint-changed");
    },

    retry() {
      if (disposed || state !== "degraded") return;
      beginReconnect("user-retry");
    },

    recoveryStarted() {
      if (disposed) return;
      if (state === "reconnecting") {
        transition("replaying", cause);
      }
    },

    noteStale(count: number) {
      if (disposed || count === staleCount) return;
      staleCount = count;
      onChange?.(status());
    },

    recoveryFinished() {
      if (disposed) return;
      if (state === "replaying") {
        transition("ready", null);
      }
    },

    recoveryFailed() {
      if (disposed) return;
      if (state !== "reconnecting" && state !== "replaying") return;
      attempt += 1;
      // The window is measured from the moment the connection was lost, so a
      // failed attempt does not buy more time.
      if (deadline !== null && clock.now() >= deadline) {
        transition("degraded", cause);
        return;
      }
      transition("reconnecting", cause);
    },

    dispose() {
      disposed = true;
      clearDeadline();
    },
  };
}
