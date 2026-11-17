/**
 * Capability IO for the `model` family.
 *
 * `model.update` answers with the fields it applied; the payload itself
 * (`UpdateModelPayload`) is transcribed below because the engine defines it and
 * it has no SDK counterpart.
 */

/** One catalog row (`protocol_v2.ts:1450-1470`). */
export interface ListModelsEntry {
  readonly id: string;
  readonly handle: string;
  readonly label: string;
  readonly description: string;
  readonly isDefault?: boolean;
  readonly isFeatured?: boolean;
  readonly free?: boolean;
  readonly supportsStructuredOutputs?: boolean;
  readonly updateArgs?: Readonly<Record<string, unknown>>;
}

/** Effort override accepted by `model.update`; `null` restores the default. */
export type ReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;

/** `UpdateModelPayload` (`protocol_v2.ts:1477-1492`). */
export interface ModelUpdatePayload {
  readonly model_id?: string;
  readonly model_handle?: string;
  readonly reasoning_effort?: ReasoningEffort;
}

export interface ModelListInput {
  readonly force?: boolean;
}

export interface ModelUpdateInput {
  readonly payload: ModelUpdatePayload;
}

export interface ModelListOutput {
  readonly entries: readonly ListModelsEntry[];
  /** Handles from the API; `null` means lookup failed, absent means old server. */
  readonly available_handles?: readonly string[] | null;
  /** BYOK provider name → base provider (e.g. `lc-anthropic` → `anthropic`). */
  readonly byok_provider_aliases?: Readonly<Record<string, string>>;
}

export interface ModelUpdateOutput {
  readonly applied_to?: "agent" | "conversation";
  readonly model_id?: string;
  readonly model_handle?: string;
  readonly model_settings?: Readonly<Record<string, unknown>> | null;
}

export interface ModelIo {
  readonly "model.list": { readonly input: ModelListInput; readonly output: ModelListOutput };
  readonly "model.update": { readonly input: ModelUpdateInput; readonly output: ModelUpdateOutput };
}
