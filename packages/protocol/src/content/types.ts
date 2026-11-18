/**
 * Content blocks: the stable shape a conversation is described with.
 *
 * A block is plain data. It never carries a renderer, a parser, a timestamp
 * or a store handle: the model that produces blocks owns the in-flight state,
 * the store owns the turns, and a surface decides how to draw one. Keeping the
 * union this narrow is what lets three consumers (the desktop shell, the VS Code
 * webview and the future export path) agree without sharing an implementation.
 *
 * Every block carries the same five identity fields:
 *
 * - `id` is derived from the source message and the block's position in it, so
 *   replaying the same conversation produces the same ids;
 * - `messageId` names the source message the block was read from; for reasoning
 *   it is the parent assistant message, for a tool call the message that first
 *   mentioned the call;
 * - `runId` is the run that produced the message, or `null` for history pages;
 * - `role` is the speaker the surface should attribute the block to.
 *
 * There is deliberately no `turnId` here. A turn is a conversation-store
 * concept; a block does not know which turn it will be filed under.
 */

/** Stable identifier of one block; equal only for the same source content. */
export type BlockId = string;

/** Speaker a block is attributed to. */
export type BlockRole = "user" | "assistant" | "tool" | "system";

/** Fields every block shares. */
export interface BlockBase {
  readonly id: BlockId;
  readonly messageId: string;
  readonly runId: string | null;
  readonly role: BlockRole;
}

/** Lifecycle of a block that grows while a message streams. */
export type BlockStatus = "streaming" | "complete";

/**
 * Assistant or user prose.
 *
 * `flavor` is a promise about the text, not a request to render it: the text
 * is Markdown as written. A surface may render it as plain text and stay
 * correct; it must not assume the block was sanitised into HTML.
 */
export interface TextBlock extends BlockBase {
  readonly type: "text";
  readonly text: string;
  readonly flavor: "markdown";
  readonly status: BlockStatus;
}

/**
 * A fenced code block split out of prose.
 *
 * `info` is the raw text after the opening fence (`ts`, `ts title=a.ts`,
 * empty). No language detection and no alias normalisation happens here: the
 * surface decides what to highlight from the same string the author wrote.
 * `closed` records whether a closing fence was seen, which is different from
 * `status`: an unterminated fence is still a complete block once the message
 * is complete.
 */
export interface CodeBlock extends BlockBase {
  readonly type: "code";
  readonly text: string;
  readonly info: string;
  readonly closed: boolean;
  readonly status: BlockStatus;
}

/** Where an image's bytes come from; never decoded by this layer. */
export type ImageSource =
  | { readonly kind: "base64"; readonly mediaType: string; readonly data: string }
  | { readonly kind: "url"; readonly url: string };

/** An image part of a message. `alt` is the author's text when present. */
export interface ImageBlock extends BlockBase {
  readonly type: "image";
  readonly source: ImageSource;
  readonly alt: string | null;
}

/**
 * Tool call lifecycle.
 *
 * `awaiting_approval` is the only state entered from an approval request;
 * `running` covers both a streamed call and a client-side start; `success` and
 * `error` are terminal and are only reached from the final return, never from
 * the client-side end marker; `incomplete` is assigned when a turn finishes
 * while the call is still open.
 */
export type ToolStatus = "awaiting_approval" | "running" | "success" | "error" | "incomplete";

/**
 * One tool call, keyed by `toolCallId`.
 *
 * All messages that mention the same call collapse into one block: the
 * arguments are assembled from fragments, the result is overwritten by the
 * final return, and the block keeps the position where the call first
 * appeared. `argumentsText` is the raw assembled string, which is not promised
 * to be valid JSON. `orphan` marks a result whose call was never seen in the
 * same page or message; such a block keeps its output instead of being dropped.
 */
export interface ToolCallBlock extends BlockBase {
  readonly type: "tool_call";
  readonly toolCallId: string;
  readonly name: string | null;
  readonly argumentsText: string;
  readonly result: unknown;
  readonly status: ToolStatus;
  readonly orphan: boolean;
}

/**
 * A reasoning segment.
 *
 * The text is the provider's reasoning as it arrived, ordered by the provider's
 * own sequence. A surface may collapse it; the shape does not say how.
 */
export interface ReasoningBlock extends BlockBase {
  readonly type: "reasoning";
  readonly text: string;
}

/**
 * A system-side note attached to a conversation, separated from user prose.
 *
 * `task-notification` notes are extracted from user messages (their result is
 * not part of what the user typed); `system` notes are reserved for sources
 * that are neither task notifications nor ordinary messages. `title` is the
 * notification summary when one was present.
 */
export interface NoticeBlock extends BlockBase {
  readonly type: "notice";
  readonly category: "task-notification" | "system";
  readonly title: string | null;
  readonly text: string;
}

/** A message that reported an error rather than content. */
export interface ErrorBlock extends BlockBase {
  readonly type: "error";
  readonly message: string;
  readonly errorType: string | null;
  readonly detail: string | null;
}

/**
 * Content this layer does not understand, preserved instead of refused.
 *
 * `rawType` is the original message or part type, so a surface can still label
 * it, and `raw` is the original payload cleaned to the JSON subset. A future
 * version may teach the model a new type without invalidating stored blocks.
 */
export interface UnknownBlock extends BlockBase {
  readonly type: "unknown";
  readonly rawType: string;
  readonly raw: unknown;
}

/** Every block a conversation can contain. */
export type Block =
  | TextBlock
  | CodeBlock
  | ImageBlock
  | ToolCallBlock
  | ReasoningBlock
  | NoticeBlock
  | ErrorBlock
  | UnknownBlock;

/** Block types by discriminator, for consumers that switch on `type`. */
export type BlockType = Block["type"];

/**
 * One batch of block changes for a single source message.
 *
 * `upserts` replaces a block with the same `id` in place (same array position,
 * new object), which is how a streamed message updates without reordering.
 * `removes` is only used when a message is reset and its blocks must disappear.
 * The message id at the top level is the one the store files the batch under;
 * per-block ids remain authoritative for updates.
 */
export interface ContentUpdate {
  readonly messageId: string;
  readonly upserts: readonly Block[];
  readonly removes: readonly BlockId[];
}
