/**
 * Capability IO for the `conversation` family.
 *
 * `conversation.switch` is `runtime_start`: the biggest input in the set. Its
 * `runtime` (scope) and `request_id` are envelope and stay out of the body.
 */

import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  Conversation,
  ConversationCreateParams,
  ConversationListParams,
  ConversationRecompileParams,
  ConversationUpdateParams,
} from "@letta-ai/letta-client/resources/conversations/conversations";

import type {
  ConversationListEntry,
  ConversationRuntimeScope,
  RuntimeExecutionSettings,
  RuntimeStartClientInfo,
  RuntimeStartCreateAgentOptions,
  RuntimeStartCreateConversationOptions,
  RuntimeStartExternalToolsGroup,
} from "./engine-domain.js";
import type { DevicePermissionMode } from "./device.js";

/** `conversation_list` accepts the SDK's list params plus the hidden filters. */
export type ConversationListQuery = ConversationListParams & {
  readonly include_hidden?: boolean;
  readonly hidden_only?: boolean;
};

/** A fork caller's body (`conversation-fork-protocol.ts`). */
export interface ConversationForkBody {
  readonly agent_id?: string | null;
  readonly hidden?: boolean;
  readonly message_id?: string;
}

/** Skill source roots the engine knows (`runtime-start-protocol.ts`). */
export type SkillSource = "bundled" | "global" | "agent" | "project";

export interface ConversationCreateInput {
  readonly body: ConversationCreateParams;
}

export interface ConversationDeleteInput {
  readonly conversation_id: string;
}

export interface ConversationForkInput {
  readonly conversation_id: string;
  readonly acting_user_id?: string;
  readonly body?: ConversationForkBody;
}

export interface ConversationGetInput {
  readonly conversation_id: string;
}

export interface ConversationListInput {
  readonly query?: ConversationListQuery;
}

export interface ConversationRecompileInput {
  readonly conversation_id: string;
  readonly body?: ConversationRecompileParams;
}

/** `conversation.switch` = `runtime_start` (`runtime-start-protocol.ts:20-52`). */
export interface ConversationSwitchInput {
  readonly agent_id?: string;
  readonly conversation_id?: string;
  readonly conversation_source_tags?: readonly string[];
  readonly create_agent?: RuntimeStartCreateAgentOptions;
  readonly create_conversation?: RuntimeStartCreateConversationOptions;
  readonly cwd?: string | null;
  readonly execution_settings?: RuntimeExecutionSettings;
  readonly external_tools?: readonly RuntimeStartExternalToolsGroup[];
  readonly force_device_status?: boolean;
  readonly mode?: DevicePermissionMode;
  readonly preserve_skill_sources?: boolean;
  readonly recover_approvals?: boolean;
  readonly skill_sources?: readonly SkillSource[];
  readonly wait_for_replay?: boolean;
  readonly workspace_sandbox?: {
    readonly root: string;
    readonly isolation_root: string;
  };
  readonly client_info?: RuntimeStartClientInfo;
}

/** `conversation.sync` carries only the scope (envelope), so its body is empty. */
export type ConversationSyncInput = Record<never, never>;

export interface ConversationUpdateInput {
  readonly conversation_id: string;
  readonly body: ConversationUpdateParams;
}

export interface ConversationCreateOutput {
  readonly conversation: Conversation | null;
}

export interface ConversationDeleteOutput {
  readonly conversation_id: string;
}

export interface ConversationForkOutput {
  readonly conversation: { readonly id: string } | null;
}

export interface ConversationGetOutput {
  readonly conversation: Conversation | null;
}

export interface ConversationListOutput {
  readonly conversations: readonly ConversationListEntry[];
}

export interface ConversationRecompileOutput {
  readonly result: string | null;
}

export interface ConversationSwitchOutput {
  readonly runtime: ConversationRuntimeScope | null;
  readonly agent: AgentState | null;
  readonly conversation: Conversation | null;
  /** Present only when this listener applied the requested execution options. */
  readonly execution_settings?: RuntimeExecutionSettings;
  readonly created: {
    readonly agent: boolean;
    readonly conversation: boolean;
  };
}

/** `sync_response` carries no domain payload beyond the envelope. */
export type ConversationSyncOutput = Record<never, never>;

export interface ConversationUpdateOutput {
  readonly conversation: Conversation | null;
}

export interface ConversationIo {
  readonly "conversation.create": {
    readonly input: ConversationCreateInput;
    readonly output: ConversationCreateOutput;
  };
  readonly "conversation.delete": {
    readonly input: ConversationDeleteInput;
    readonly output: ConversationDeleteOutput;
  };
  readonly "conversation.fork": {
    readonly input: ConversationForkInput;
    readonly output: ConversationForkOutput;
  };
  readonly "conversation.get": {
    readonly input: ConversationGetInput;
    readonly output: ConversationGetOutput;
  };
  readonly "conversation.list": {
    readonly input: ConversationListInput;
    readonly output: ConversationListOutput;
  };
  readonly "conversation.recompile": {
    readonly input: ConversationRecompileInput;
    readonly output: ConversationRecompileOutput;
  };
  readonly "conversation.switch": {
    readonly input: ConversationSwitchInput;
    readonly output: ConversationSwitchOutput;
  };
  readonly "conversation.sync": {
    readonly input: ConversationSyncInput;
    readonly output: ConversationSyncOutput;
  };
  readonly "conversation.update": {
    readonly input: ConversationUpdateInput;
    readonly output: ConversationUpdateOutput;
  };
}
