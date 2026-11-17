/**
 * Shapes shared by the reconnect layer.
 *
 * These are the types handed to the render layer and to the session store: the
 * banner reads {@link ReconnectStatus}, the progress line reads
 * {@link RecoveryStep}, and the grey "content may be missing" row reads
 * {@link ReplayGap}. Nothing here performs work; the state machine, the probe
 * and the recovery sequence all speak these shapes so that one consumer can be
 * written against all of them.
 *
 * Two rules the definitions encode, because they are easy to lose later:
 *
 * 1. **A gap says what is unknown, not what happened.** `range: null` means "no
 *    idea where the gap is"; `{ from: null, to: null }` means "there is a gap and
 *    neither end is pinned down". Collapsing the two would force the consumer to
 *    guess which one it is looking at.
 * 2. **`detectedAt` is when *we* noticed**, never when the gap happened. The two
 *    can be minutes apart, and only one of them is a fact we hold.
 */

/** Where an agent's connection is, as far as this process can tell. */
export type ReconnectState = "ready" | "reconnecting" | "replaying" | "degraded";

/** Why the last transition away from `ready` happened. */
export type ReconnectCause = "reset" | "silent" | "user-retry" | "endpoint-changed";

/** One agent's connection status, as rendered by the banner. */
export interface ReconnectStatus {
  readonly agentId: string;
  readonly state: ReconnectState;
  /** Which attempt this is, counting from 1; 0 while `ready`. */
  readonly attempt: number;
  readonly cause: ReconnectCause | null;
  /** When the current state was entered, ISO 8601. */
  readonly since: string;
  /**
   * How many approvals the current recovery left unresolved.
   *
   * This is an **inference**, not something the engine reports: it counts the
   * approvals that were pending when the connection dropped and did not come
   * back after the resync. The engine never says *why* one is gone, so the
   * caller must not render it as "expired".
   */
  readonly staleCount: number;
}

/** One step of the recovery sequence, reported as it completes. */
export type RecoveryStep =
  | { readonly step: "handshake"; readonly ok: boolean; readonly at: string }
  | {
      readonly step: "sync";
      readonly ok: boolean;
      readonly approvalsRecovered: number;
      readonly turnResumed: boolean;
      readonly at: string;
    }
  | {
      readonly step: "messages";
      readonly pages: number;
      readonly appended: number;
      readonly hasMore: boolean;
      readonly nextBefore: string | null;
      readonly at: string;
    }
  | {
      readonly step: "states";
      readonly covered: readonly ReplayStateKind[];
      readonly at: string;
    }
  | { readonly step: "replay"; readonly messages: number; readonly at: string };

/** The four state frames a resync can replay. */
export type ReplayStateKind = "device" | "queue" | "subagent" | "loop";

/** A message id as the engine spells it. */
export type MessageId = string;

/**
 * A gap in the replayed history, or a truncated stream.
 *
 * `at` is a position in our local message sequence (after which the gap starts),
 * not a frame counter; `null` says even that is unknown.
 */
export type ReplayGap =
  | {
      readonly kind: "history-gap";
      readonly at: MessageId | null;
      readonly range: null | { readonly from: MessageId | null; readonly to: MessageId | null };
      /** When we noticed, ISO 8601. */
      readonly detectedAt: string;
      /** When the gap is believed to have happened, when that can be bounded. */
      readonly gapWindow?: { readonly from: string; readonly to: string };
    }
  | {
      readonly kind: "stream-truncated";
      readonly at: MessageId | null;
      /** Always `null`: a half-streamed answer has no range to bound. */
      readonly range: null;
      readonly detectedAt: string;
    };

/** The state snapshot handed to the consumer in one replay. */
export interface ReplayStates {
  readonly device: unknown | null;
  readonly queue: unknown | null;
  readonly subagent: unknown | null;
  readonly loop: unknown | null;
}

/**
 * What a replay hands to the consumer.
 *
 * Implementations must not clear already-rendered content on `begin`: the
 * recovery is an addition plus a state overwrite, never a reset. `messages` is
 * called with items in ascending id order and may be called more than once;
 * `focus` carries the scroll intent the consumer resolves.
 */
export interface ReplaySink {
  begin(agentId: string): void;
  messages(agentId: string, items: readonly unknown[]): void;
  states(agentId: string, snapshot: ReplayStates): void;
  focus(agentId: string, intent: { readonly stickToBottom: boolean }): void;
  end(agentId: string, summary: { readonly appended: number; readonly hasMore: boolean }): void;
}
