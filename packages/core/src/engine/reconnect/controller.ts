/**
 * The shapes the reconnect layer is built from — contract only, no behaviour.
 *
 * This file exists so that the parts can be written at the same time without
 * inventing three different shapes. Everything here is an interface or a type:
 * the state machine, the pager, the approval ledger and the composition arrive in
 * their own modules and are wired together at the end. A contract with an
 * implementation attached gets copied; a contract on its own gets read.
 *
 * ## The split that matters: observation versus decision
 *
 * Every part of this layer either *observes* something or *decides* something,
 * and the two must not merge:
 *
 * - the transport watch reports that a socket closed;
 * - the probe reports that the peer stopped answering;
 * - the pager reports what the engine returned;
 * - the approval ledger reports which approvals did not come back.
 *
 * None of those decides to stop reconnecting, to drop content, or to show a
 * warning. **A probe verdict of `dead` is an observation, not a decision**: the
 * probe can be started again and keeps its verdict until a round trip succeeds.
 * "When do we give up" is decided here, by {@link ReconnectController}, and
 * nowhere else.
 */

import type { ChannelPool, Endpoint, WiringOptions } from "../client";
import type { ReconnectStatus, RecoveryStep, ReplayGap, ReplaySink, ReplayStates } from "./types";

/** Removes one subscription; idempotent. */
export type Unsubscribe = () => void;

/**
 * What the render layer is allowed to ask about an agent's connection.
 *
 * `canSend` is on the controller rather than being derived by each caller: a
 * second derivation is a second answer, and the day they disagree the interface
 * accepts a send it should refuse.
 */
export interface ReconnectController {
  status(agentId: string): ReconnectStatus;
  onStatus(listener: (status: ReconnectStatus) => void): Unsubscribe;
  onStep(listener: (agentId: string, step: RecoveryStep) => void): Unsubscribe;
  onGap(listener: (agentId: string, gap: ReplayGap) => void): Unsubscribe;
  /** The user pressed retry. A no-op while the agent is already `ready`. */
  retry(agentId: string): void;
  /** Whether a command may be sent right now. */
  canSend(agentId: string): boolean;
  dispose(): void;
}

/**
 * One page of history, exactly as the engine answered it.
 *
 * `hasMore` and `nextBefore` are two different facts and both are kept: a page
 * can report `hasMore: false` while still carrying a cursor, and a caller that
 * stops on a null cursor would ask for one page too many.
 */
export interface MessagePage {
  readonly messages: readonly unknown[];
  readonly nextBefore: string | null;
  readonly hasMore: boolean;
}

/** The outcome of asking for one page. */
export type PageResult =
  | { readonly ok: true; readonly page: MessagePage }
  | { readonly ok: false; readonly error: unknown };

/** Asks the engine for one page. The caller supplies the agent explicitly. */
export type PageFetcher = (args: {
  readonly agentId: string;
  readonly conversationId: string;
  readonly limit: number;
  readonly before: string | null;
}) => Promise<PageResult>;

/**
 * Reads history backwards from a cursor, one page at a time.
 *
 * It never loops on its own: how many pages a recovery is worth is a decision,
 * and decisions live in the controller.
 */
export interface MessagePager {
  page(args: {
    readonly agentId: string;
    readonly conversationId: string;
    readonly before: string | null;
    readonly limit?: number;
  }): Promise<PageResult>;
  /**
   * Whether older pages exist.
   *
   * Reading `hasMore` and not the cursor is deliberate: the engine has been
   * observed answering "no more" together with a non-null cursor, and a caller
   * that trusts the cursor pages forever.
   */
  hasOlder(page: MessagePage): boolean;
}

/** One approval that was waiting for the user when the connection dropped. */
export interface PendingApproval {
  readonly requestId: string;
  /** When we first saw it, ISO 8601. */
  readonly at: string;
}

/** What a resync left waiting. */
export interface ApprovalReconciliation {
  /** Still waiting: the engine pushed it again. */
  readonly pending: readonly PendingApproval[];
  /** Remembered as waiting, but not pushed again: it will not be answered. */
  readonly stale: readonly PendingApproval[];
}

/**
 * Tracks which approvals are waiting, and works out what a resync forgot.
 *
 * The engine never says why an approval stopped waiting — it could have timed
 * out, been answered elsewhere, or been gone before the drop — so this reports
 * "no longer waiting" rather than "expired", and the count is the only thing a
 * caller may render.
 */
export interface ApprovalLedger {
  /** Records an approval the engine asked about. Idempotent per id. */
  notePending(approval: PendingApproval): void;
  /** Records an approval the user answered. Idempotent per id. */
  noteResolved(requestId: string): void;
  /**
   * Works out what is still waiting after a resync pushed `reappeared`.
   *
   * Must be idempotent: a recovery that runs twice with the same set has to
   * produce the same answer, never a doubled count.
   */
  reconcile(reappeared: readonly string[]): ApprovalReconciliation;
  /** How many approvals are known to be waiting right now. */
  pendingCount(): number;
}

/**
 * Everything the composition is given from outside.
 *
 * `cursorOf` and `sink` are injectable because this layer does not own the
 * message list: the session store knows where the conversation stopped, and the
 * render layer knows how to append. A recovery with no cursor starts from the
 * newest page; a recovery with no sink still runs, it just has nowhere to hand
 * the result.
 */
export interface ReconnectDeps {
  /** The engine facade, read for its endpoint. */
  readonly source: { readonly endpoint: Endpoint | null };
  /** Opens one connection. Supplied by the watch so every socket is observed. */
  readonly factory: import("../client").ChannelFactory;
  /** Pulls a fresh process when the endpoint itself changed. */
  readonly restart?: (spec?: unknown) => Promise<unknown>;
  /** The clock and timers, injected so tests need no real time. */
  readonly clock: {
    now(): number;
    setTimer(fn: () => void, ms: number): Unsubscribe;
  };
  /** Where the conversation stopped, or `null` for a fresh one. */
  readonly cursorOf?: (agentId: string, conversationId: string) => string | null;
  /** Receives the replayed sequence. */
  readonly sink?: ReplaySink;
  /** Wiring options for the channels this pool opens. */
  readonly wiring?: WiringOptions;
}

/** What the composition hands back. */
export interface Reconnecting {
  readonly pool: ChannelPool;
  readonly reconnect: ReconnectController;
  /** Convenience for callers that only need the four state frames. */
  readonly states: (agentId: string) => ReplayStates;
}
