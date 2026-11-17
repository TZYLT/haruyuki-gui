/**
 * Capability IO for the `usage` family.
 *
 * `usage.aggregate` folds ledger rows into totals plus per-run buckets;
 * `usage.chatgpt` reads the subscription windows, which is a different shape on
 * purpose (windows and credits, not tokens).
 */

import type {
  ChatGPTUsageReadErrorPayload,
  ChatGPTUsageReadTarget,
  ChatGPTUsageSnapshotPayload,
  UsageAggregateRun,
  UsageAggregateTotals,
} from "./engine-domain.js";

export interface UsageAggregateInput {
  readonly agent_id: string;
  readonly from?: string;
  readonly run_id?: string;
  readonly session_id?: string;
  readonly to?: string;
}

export interface UsageChatgptInput {
  readonly target: ChatGPTUsageReadTarget;
  readonly provider_name?: string;
  readonly force_refresh?: boolean;
}

export interface UsageAggregateOutput {
  /** Totals over every row that matched the filters (not just `runs`). */
  readonly totals: UsageAggregateTotals;
  /** Per-run buckets; empty when no filter names runs. */
  readonly runs: readonly UsageAggregateRun[];
}

export interface UsageChatgptOutput {
  readonly target: ChatGPTUsageReadTarget;
  readonly usage?: ChatGPTUsageSnapshotPayload;
  readonly error?: ChatGPTUsageReadErrorPayload;
}

export interface UsageIo {
  readonly "usage.aggregate": {
    readonly input: UsageAggregateInput;
    readonly output: UsageAggregateOutput;
  };
  readonly "usage.chatgpt": {
    readonly input: UsageChatgptInput;
    readonly output: UsageChatgptOutput;
  };
}
