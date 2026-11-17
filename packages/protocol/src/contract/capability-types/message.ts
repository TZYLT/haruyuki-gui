/**
 * Capability IO for the `message` family.
 *
 * `message.send` is the product's core action: its wire is `input` and its
 * acknowledgement is `input_accepted` (the one reply whose suffix is not
 * `_response`). Sending is `answered`; the turn itself continues as frames.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message, MessageListParams } from "@letta-ai/letta-client/resources/agents/messages";

import type { ApprovalResponseBody } from "./engine-domain.js";

/** One message to create; the client id lets a UI reconcile its optimistic row. */
export type CreateMessagePayload = MessageCreate & {
  readonly client_message_id?: string;
};

/** What `message.send` accepts (`protocol_v2.ts:679-710`). */
export type InputPayload =
  | {
      readonly kind: "create_message";
      readonly messages: readonly CreateMessagePayload[];
      readonly image_failure_mode?: "strict" | "drop";
      readonly client_tool_allowlist?: readonly string[];
    }
  | ({ readonly kind: "approval_response" } & ApprovalResponseBody);

export interface MessageAbortInput {
  readonly run_id?: string | null;
}

export interface MessageListInput {
  readonly conversation_id: string;
  readonly query?: MessageListParams;
}

export interface MessageSendInput {
  readonly payload: InputPayload;
}

export interface MessageAbortOutput {
  /** True when an active turn or pending approval was interrupted. */
  readonly aborted: boolean;
}

export interface MessageListOutput {
  readonly messages: readonly Message[];
  /** Oldest message id, for loading older history. */
  readonly next_before: string | null;
  readonly has_more: boolean;
}

export type MessageSendOutput = {
  readonly accepted: boolean;
  readonly disposition?: "started" | "queued";
};

export interface MessageIo {
  readonly "message.abort": {
    readonly input: MessageAbortInput;
    readonly output: MessageAbortOutput;
  };
  readonly "message.list": { readonly input: MessageListInput; readonly output: MessageListOutput };
  readonly "message.send": { readonly input: MessageSendInput; readonly output: MessageSendOutput };
}
