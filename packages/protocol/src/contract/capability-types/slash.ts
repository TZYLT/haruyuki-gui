/**
 * Capability IO for the `slash` family.
 *
 * `slash.exec` runs one entry of the engine's command table and returns its
 * text output. A local `/compact` also returns the topic preview — the same
 * `CompactionTopicReport` the compaction family uses, transcribed once.
 */

import type { CompactionTopicReport } from "./engine-domain.js";

export interface SlashExecInput {
  readonly command_id: string;
  readonly args?: string;
}

export interface SlashExecOutput {
  readonly output: string;
  /** Present only for a local `/compact` (F-04). */
  readonly topic_report?: CompactionTopicReport;
}

export interface SlashIo {
  readonly "slash.exec": { readonly input: SlashExecInput; readonly output: SlashExecOutput };
}
