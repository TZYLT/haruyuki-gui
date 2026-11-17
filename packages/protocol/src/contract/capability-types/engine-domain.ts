/**
 * Engine-domain types transcribed from the engine 0.6.0 source.
 *
 * The engine is not a dependency of this repository, so types that live inside
 * its own source cannot be imported; they are copied here one level at a time
 * and mirrored by the transcription registry (`unknown-registry.md` lists every
 * spot where a sub-shape is deliberately left opaque).
 *
 * Two rules for this file:
 *
 * 1. Only types whose *definition* lives in the engine. SDK types
 *    (`AgentState`, `Conversation`, `Message`, `*Params`) are imported type-only
 *    where they are used, never copied here.
 * 2. Read-only shapes: the wire is read by consumers, never mutated.
 */

import type { AgentCreateParams } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  Conversation,
  ConversationCreateParams,
} from "@letta-ai/letta-client/resources/conversations/conversations";

/** Scope carried by runtime-scoped replies (`runtime-scope.ts`). */ export interface ConversationRuntimeScope {
  readonly agent_id: string | null;
  readonly conversation_id: string;
  readonly acting_user_id?: string;
}

/** Per-listener execution options (`runtime-execution-settings.ts`). */
export interface RuntimeExecutionSettings {
  readonly tools?: readonly string[];
  readonly preload_skills?: readonly string[];
  readonly allowed_tools: readonly string[];
  readonly disallowed_tools: readonly string[];
  readonly max_turns?: number;
  readonly parent_agent_id?: string;
  readonly agent_role?: "subagent";
  readonly transcript_path?: string;
  readonly memory_directory?: string;
  readonly disable_memory_guard: boolean;
}

/** Diagnostics-only client metadata sent to `runtime_start`. */
export interface RuntimeStartClientInfo {
  readonly name: string;
  readonly title?: string;
  readonly version?: string;
}

/** How `runtime_start` creates an agent when it has none (`runtime-start-protocol.ts`). */
export interface RuntimeStartCreateAgentOptions {
  readonly body: AgentCreateParams;
  readonly pin_global?: boolean;
  readonly memfs?: boolean;
}

/**
 * Agent-free conversation body (`backend/api/ephemeral-conversations.ts`).
 *
 * Left opaque on purpose: the engine's own shape is not part of the 0.6.0
 * protocol document and only the engine validates it. Registered in
 * `unknown-registry.md`.
 */
export type EphemeralConversationCreateBody = unknown;

export interface RuntimeStartCreateConversationOptions {
  readonly body?: Omit<ConversationCreateParams, "agent_id"> | EphemeralConversationCreateBody;
}

/** One controller-owned tool registered with a runtime (`external-tool-protocol.ts`). */
export interface ExternalToolDefinitionPayload {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly timeout_ms?: number;
  readonly auto_background?: boolean;
}

export interface RuntimeStartExternalToolsGroup {
  readonly scope_id?: string;
  readonly tools: readonly ExternalToolDefinitionPayload[];
}

/** Approval decision bodies accepted by the engine (`protocol_v2.ts:646-670`). */
export interface ApprovalResponseAllowDecision {
  readonly behavior: "allow";
  readonly message?: string;
  readonly updated_input?: Readonly<Record<string, unknown>> | null;
  readonly selected_permission_suggestion_ids?: readonly string[];
}

export interface ApprovalResponseDenyDecision {
  readonly behavior: "deny";
  readonly message: string;
}

export type ApprovalResponseDecision = ApprovalResponseAllowDecision | ApprovalResponseDenyDecision;

export type ApprovalResponseBody =
  | { readonly request_id: string; readonly decision: ApprovalResponseDecision }
  | { readonly request_id: string; readonly error: string };

/** Where a conversation came from (`conversation-provenance.ts`). */
export type ConversationOrigin = "reflection" | "dream" | "background" | "external" | "unknown";

export type ConversationContextMode = "inherited-context" | "inherited-history" | "standalone";

/**
 * Provenance attached to listed conversations.
 *
 * `reflection` / `dream` are run records defined by later engine features (F-03,
 * F-06) and left opaque here; registered in `unknown-registry.md`.
 */
export interface ConversationProvenance {
  readonly origin?: ConversationOrigin;
  readonly parent_conversation_id?: string | null;
  readonly context_mode?: ConversationContextMode;
  readonly inherited_message_count?: number | null;
  readonly inherited_through_message_id?: string | null;
  readonly reflection?: unknown;
  readonly dream?: unknown;
}

/** One row of `conversation_list` (`conversation-provenance.ts:79-85`). */
export interface ConversationListEntry extends Conversation, ConversationProvenance {
  readonly hidden?: boolean;
  readonly context_message_count?: number;
}
