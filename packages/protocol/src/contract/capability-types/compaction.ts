/**
 * Capability IO for the `compaction` family.
 *
 * Compaction is a three-step picker: `prepare` returns a `prepare_id` plus the
 * preview, `commit` applies the chosen cut, `cancel` drops it. The preview type
 * lives in `engine-domain.ts` because `slash.exec` shares it.
 */

import type { MessageCompactParams } from "@letta-ai/letta-client/resources/agents/messages";

import type { CompactionTopicReport } from "./engine-domain.js";

export interface CompactionCancelInput {
  readonly conversation_id: string;
  readonly prepare_id: string;
}

export interface CompactionCommitInput {
  readonly conversation_id: string;
  readonly prepare_id: string;
  readonly block_index?: number;
}

export interface CompactionPrepareInput {
  readonly conversation_id: string;
  readonly body?: MessageCompactParams;
}

export interface CompactionCancelOutput {
  /** `false` when the id was unknown, expired or already consumed. */
  readonly cancelled: boolean;
}

export interface CompactionCommitOutput {
  readonly topic_report?: CompactionTopicReport | null;
}

export interface CompactionPrepareOutput {
  /** Per-conversation handle; `null` when preparation failed. */
  readonly prepare_id: string | null;
  readonly topic_report: CompactionTopicReport | null;
}

export interface CompactionIo {
  readonly "compaction.cancel": {
    readonly input: CompactionCancelInput;
    readonly output: CompactionCancelOutput;
  };
  readonly "compaction.commit": {
    readonly input: CompactionCommitInput;
    readonly output: CompactionCommitOutput;
  };
  readonly "compaction.prepare": {
    readonly input: CompactionPrepareInput;
    readonly output: CompactionPrepareOutput;
  };
}
