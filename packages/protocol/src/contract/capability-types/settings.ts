/**
 * Capability IO for the `settings` family.
 *
 * Two switches live here: experiment flags and the reflection switches. Both
 * answer with the full snapshot after the write, so the UI never guesses what
 * the engine accepted.
 */

import type {
  ExperimentId,
  ExperimentSnapshot,
  ReflectionMergeMode,
  ReflectionSettingsScope,
  ReflectionSettingsSnapshot,
  ReflectionTriggerMode,
} from "./engine-domain.js";

export type SettingsGetExperimentsInput = Record<never, never>;

export type SettingsGetReflectionInput = Record<never, never>;

export interface SettingsSetExperimentInput {
  readonly experiment_id: ExperimentId;
  readonly enabled: boolean;
}

/** The switch body accepted by `set_reflection` (`protocol_v2.ts:210-230`). */
export interface ReflectionSettingsPatch {
  readonly trigger: ReflectionTriggerMode;
  readonly step_count: number;
  /** F-03 switch; omitted keeps the current value. */
  readonly on_compaction?: boolean;
  /** F-03 switch; omitted keeps the current value. */
  readonly every_user_messages?: number;
  readonly delete_session_on_success?: boolean;
  readonly timeout_minutes?: number;
  /** @deprecated Retired by F-03; accepted and ignored. */
  readonly merge?: ReflectionMergeMode;
  /** @deprecated Retired by F-03; accepted and ignored. */
  readonly merge_instructions?: string;
}

export interface SettingsSetReflectionInput {
  readonly scope?: ReflectionSettingsScope;
  readonly settings: ReflectionSettingsPatch;
}

export interface SettingsGetExperimentsOutput {
  readonly experiments: readonly ExperimentSnapshot[];
}

export interface SettingsGetReflectionOutput {
  readonly reflection_settings: ReflectionSettingsSnapshot | null;
}

export interface SettingsSetExperimentOutput {
  readonly experiments: readonly ExperimentSnapshot[];
}

export interface SettingsSetReflectionOutput {
  readonly reflection_settings: ReflectionSettingsSnapshot | null;
  readonly scope: ReflectionSettingsScope;
}

export interface SettingsIo {
  readonly "settings.getExperiments": {
    readonly input: SettingsGetExperimentsInput;
    readonly output: SettingsGetExperimentsOutput;
  };
  readonly "settings.getReflection": {
    readonly input: SettingsGetReflectionInput;
    readonly output: SettingsGetReflectionOutput;
  };
  readonly "settings.setExperiment": {
    readonly input: SettingsSetExperimentInput;
    readonly output: SettingsSetExperimentOutput;
  };
  readonly "settings.setReflection": {
    readonly input: SettingsSetReflectionInput;
    readonly output: SettingsSetReflectionOutput;
  };
}
