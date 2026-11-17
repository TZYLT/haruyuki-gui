/**
 * The frozen shapes handed downstream: one stable change, one usage snapshot,
 * one statistics record, and the merger's own options and signature.
 *
 * Nothing here knows how a frame is read; that lives in `envelope.ts`,
 * `order.ts` and `project.ts`. Two rules make this file load-bearing:
 *
 * 1. **Every field is readonly.** A change is an announcement of something that
 *    already happened, so nobody downstream may edit it; the "read-only borrow"
 *    contract is enforced here by the type, and a runtime check covers the case
 *    where an implementation reuses an object.
 * 2. **The three agent-level fields never collapse.** `authorAgentId` answers
 *    "who said it", `runtimeAgentId` answers "which connection carried it" and
 *    `subagentId` answers "which subagent context". In the recorded subagent
 *    session, 106 `stream_delta` frames share only 4 message ids, so keying on
 *    the id alone (or on the connection alone) collides.
 */

import type { Frame } from "@haruyuki/protocol";

/** One content part of an assistant message, exactly as the engine sent it. */
export type AssistantPart = {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
};

/** Fields every change carries: who, where, when. */
export type ChangeBase = {
  /**
   * Who said it: `delta.agent_id ?? delta.session_id ?? runtime.agent_id`.
   * `null` for a passthrough frame that carries no identity at all.
   */
  readonly authorAgentId: string | null;
  /** Which connection carried it: `msg.runtime.agent_id`. */
  readonly runtimeAgentId: string; /** Subagent context: `msg.subagent_id`; `null` on the main line. */
  readonly subagentId: string | null;
  /** `runtime.conversation_id`; falls back to the merger's default. */
  readonly conversationId: string;
  /** Arrival time (the B2 frame's `at`, not the engine's `emitted_at`). */
  readonly at: number;
};

/** One stable change. The merger guarantees one per input, ordering, and latest-state. */
export type MergerChange = ChangeBase &
  (
    | {
        readonly kind: "message.delta";
        readonly messageId: string;
        readonly runId: string | null;
        /** `delta.seq_id`: the message-local order. */
        readonly runSeq: number;
        readonly text: string;
        readonly parts: readonly AssistantPart[];
        readonly first: boolean;
      }
    | {
        readonly kind: "message.final";
        readonly messageId: string | null;
        readonly runId: string | null;
        readonly messageType: string;
        readonly body: unknown;
      }
    | {
        readonly kind: "message.complete";
        readonly messageId: string;
        readonly runId: string | null;
        readonly textLength: number;
        /** True when the assembly saw a `runSeq` gap or an unresolved event gap. */
        readonly incomplete: boolean;
      }
    | {
        readonly kind: "message.reset";
        readonly messageId: string;
        readonly runId: string | null;
        /** Only one reason exists today: the engine re-sent the message from the start. */
        readonly reason: "resend-from-start";
      }
    | {
        readonly kind: "turn.stopped";
        readonly runId: string | null;
        readonly turnId: string | null;
        readonly stopReason: string;
      }
    | {
        readonly kind: "turn.finished";
        readonly turnId: string;
        readonly runId: string | null;
        readonly stopReason: string;
        readonly usage: UsageSnapshot | null;
        /** The corner-mark flag: this turn may be missing content. */
        readonly incomplete: boolean;
      }
    | {
        readonly kind: "state.loop" | "state.device" | "state.queue" | "state.subagents";
        /** The engine payload, untouched; `update_queue` keeps `removed` inside it. */
        readonly value: unknown;
      }
    | {
        readonly kind: "approval.requested";
        readonly requestId: string;
        readonly body: unknown;
      }
    | {
        readonly kind: "usage.reported";
        readonly runId: string | null;
        readonly usage: UsageSnapshot;
      }
    | {
        readonly kind: "passthrough";
        readonly type: string;
        readonly raw: unknown;
      }
  );

/**
 * Token accounting as the engine reports it. Every field is optional because
 * `usage_statistics` frames carry different subsets; a missing field is not
 * zero (on the cost page, "0" and "not reported" are different facts).
 */
export type UsageSnapshot = {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly contextTokens?: number;
  readonly contextSystemTokens?: number;
  readonly contextMessagesTokens?: number;
  readonly contextToolsTokens?: number;
  readonly costUsd?: number;
  readonly costInputUsd?: number;
  readonly costOutputUsd?: number;
  readonly costCacheReadUsd?: number;
  readonly costCacheWriteUsd?: number;
};

/** The reconnect path's closed set; no `reconnect:` prefix, because every value is a reconnect. */
export type ResetReason = "silent" | "user-retry" | "endpoint-changed" | "reconnect-reset";

/** Bounded counters. Read-only; the merger owns the writable side. */
export type MergeCounters = {
  readonly orderedFrames: number;
  readonly unorderedFrames: number;
  readonly duplicates: number;
  readonly late: number;
  readonly gaps: number;
  readonly missingFrames: number;
  readonly unknownTypes: number;
  readonly passthroughFrames: number;
  readonly incompleteMessages: number;
  readonly incompleteTurns: number;
  readonly rebaselines: number;
  readonly terminalDropped: number;
  readonly lastGapAt: number | null;
  readonly lastGapFrom: number | null;
  readonly lastGapTo: number | null;
  readonly lastRebaselineAt: number | null;
};

/** `MergeCounters` plus the last reset, which the reconnect path reads for its own diagnostics. */
export type MergeStats = MergeCounters & {
  readonly resetAt: number | null;
  readonly resetReason: ResetReason | null;
};

/** Options for {@link EventMerger}. */
export type EventMergerOptions = {
  /** The channel's agent (one connection per agent). */
  readonly agentId: string;
  /** Conversation used when a frame carries no `runtime.conversation_id`. */
  readonly defaultConversationId?: string;
  /** Bounds of the three tables; defaults are {@link MERGE_LIMITS}. */
  readonly limits?: {
    readonly dedupe?: number;
    readonly assembling?: number;
    readonly stats?: number;
  };
  /** Terminal-frame sink; the shell forwards to its bridge sender. */
  readonly onFrame?: (frame: Frame<"term.output">) => void;
};

/** The merger's public surface. */
export type EventMerger = {
  /** Ingest one frame; returns the changes it produced. Never throws. */
  ingest(frame: import("../engine/client/index.js").EngineEventFrame): readonly MergerChange[];
  /** Subscribe to changes produced from now on; synchronous. Returns an idempotent unsubscribe. */
  subscribe(callback: (change: MergerChange) => void): () => void;
  /** Read-only statistics snapshot. */
  stats(): MergeStats;
  /** Connection-boundary reset; never asks anyone to clear the screen. */
  reset(reason: ResetReason): void;
  /** Highest contiguous `event_seq` delivered, or `null` before any sequenced frame. */
  watermark(): number | null;
};

/** Default bounds for the three tables. */
export const MERGE_LIMITS = {
  dedupe: 4096,
  assembling: 512,
  stats: 64,
} as const;

/** Reorder buffer capacity (frames), not milliseconds: the merger owns no timer. */
export const REORDER_CAPACITY = 256;

/** Consecutive stale frames that trigger the fallback rebaseline. */
export const REBASELINE_THRESHOLD = 32;

/** Fixed terminal slice size, matching the `term.output` contract. */
export const TERM_SLICE_BYTES = 8192;
