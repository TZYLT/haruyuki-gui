/**
 * Capability IO for the `agent` family.
 *
 * Inputs are derived from `snapshot.commands[].fields` minus the envelope
 * (`type`, `request_id`, `runtime`). The param objects themselves are SDK types
 * and are imported type-only: re-declaring them would be a second shape that
 * silently drifts when the engine's letta client moves.
 *
 * Outputs are transcribed from the engine's response interfaces, one level
 * deep; `AgentState` is the SDK's own type, so it is imported rather than copied.
 */

import type {
  AgentCreateParams,
  AgentListParams,
  AgentState,
  AgentUpdateParams,
} from "@letta-ai/letta-client/resources/agents/agents";

export interface AgentCreateInput {
  readonly body: AgentCreateParams;
}

export interface AgentCreatePresetInput {
  readonly model?: string;
  readonly personality: "memo" | "tutorial" | "blank" | "linus" | "kawaii";
  readonly pin_global?: boolean;
  readonly tags?: readonly string[];
}

export interface AgentDeleteInput {
  readonly agent_id: string;
}

export interface AgentGetInput {
  readonly agent_id: string;
}

export interface AgentListInput {
  readonly query?: AgentListParams;
}

export interface AgentSecretApplyInput {
  readonly agent_id: string;
  readonly set: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
}

export interface AgentSecretListInput {
  readonly agent_id: string;
}

export interface AgentUpdateInput {
  readonly agent_id: string;
  readonly body: AgentUpdateParams;
}

/** One secret entry as `secret_list` returns it (plaintext, engine-side). */
export interface AgentSecretEntry {
  readonly key: string;
  readonly value: string;
}

export interface AgentCreateOutput {
  readonly agent: AgentState | null;
}

export interface AgentCreatePresetOutput {
  readonly agent_id?: string;
  readonly name?: string;
  readonly model?: string;
}

export interface AgentDeleteOutput {
  readonly agent_id: string;
}

export interface AgentGetOutput {
  readonly agent: AgentState | null;
}

export interface AgentListOutput {
  readonly agents: readonly AgentState[];
}

export interface AgentSecretApplyOutput {
  /** Sorted secret names after the apply; empty on failure. */
  readonly names: readonly string[];
}

export interface AgentSecretListOutput {
  /** Sorted entries; empty on failure. */
  readonly secrets: readonly AgentSecretEntry[];
}

export interface AgentUpdateOutput {
  readonly agent: AgentState | null;
}

export interface AgentIo {
  readonly "agent.create": { readonly input: AgentCreateInput; readonly output: AgentCreateOutput };
  readonly "agent.createPreset": {
    readonly input: AgentCreatePresetInput;
    readonly output: AgentCreatePresetOutput;
  };
  readonly "agent.delete": { readonly input: AgentDeleteInput; readonly output: AgentDeleteOutput };
  readonly "agent.get": { readonly input: AgentGetInput; readonly output: AgentGetOutput };
  readonly "agent.list": { readonly input: AgentListInput; readonly output: AgentListOutput };
  readonly "agent.secretApply": {
    readonly input: AgentSecretApplyInput;
    readonly output: AgentSecretApplyOutput;
  };
  readonly "agent.secretList": {
    readonly input: AgentSecretListInput;
    readonly output: AgentSecretListOutput;
  };
  readonly "agent.update": { readonly input: AgentUpdateInput; readonly output: AgentUpdateOutput };
}
