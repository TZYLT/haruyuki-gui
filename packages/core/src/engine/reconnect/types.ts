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

/**
 * Which state frames the replay actually carried.
 *
 * A list rather than an object with one key per kind, because the interesting
 * question is "did this arrive", and an object forces the caller to fill in the
 * kinds that did not. Filling them with `null` collapses three different things
 * -- "the engine had nothing", "the frame did not arrive" and "it was cleared" --
 * into one value, and a consumer cannot tell them apart afterwards.
 *
 * The values themselves do not travel here: the frames arrived on the connection
 * the consumer is already reading, so this only has to say which ones were part
 * of the replay.
 */
export type ReplayStates = readonly ReplayStateKind[];

/**
 * What a replay hands to the consumer.
 *
 * Implementations must not clear already-rendered content on `begin`: the
 * recovery is an addition plus a state overwrite, never a reset. `messages` is
 * called with items in ascending id order and may be called more than once;
 * `focus` carries the scroll intent the consumer resolves.
 *
 * The order is `begin`, then `messages` once per page, then `states`, then
 * `focus`, then `end`. Content before instruction: a consumer told where to
 * scroll before it has the rows would scroll to the wrong place.
 */
export interface ReplaySink {
  begin(agentId: string): void;
  messages(agentId: string, items: readonly unknown[]): void;
  states(agentId: string, arrived: ReplayStates): void;
  focus(agentId: string, intent: { readonly stickToBottom: boolean }): void;
  /**
   * The replay is over.
   *
   * `nextBefore` is the cursor the consumer needs to load older messages, and
   * `stopReason` says whether the replay reached the end of what it could read or
   * stopped for a reason of its own. Both were only reachable through the returned
   * outcome before, which a consumer that renders from the sink never sees.
   */
  end(
    agentId: string,
    summary: {
      readonly appended: number;
      readonly hasMore: boolean;
      readonly nextBefore: string | null;
      readonly stopReason: string;
    },
  ): void;
}
