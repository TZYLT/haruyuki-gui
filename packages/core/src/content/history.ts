/**
 * History pages: one finished page of messages becomes one ordered block list.
 *
 * The live path assembles a message from many deltas and keeps state between
 * them; a history page is already whole. This module keeps no state between
 * calls: it normalises each entry, dispatches on its type, and pairs tool calls
 * only within the page it was given.
 *
 * History deliberately shares the live path's pieces: assistant prose goes
 * through the same fence scanner and text/code builder, non-text parts through
 * the same image/unknown builder, tool messages through the same state machine
 * (which is how a result seen before its call becomes an orphan instead of a
 * dropped payload), and every block leaves through the same JSON sanitiser.
 *
 * What differs: blocks are always `complete`, reasoning fragments aggregate
 * inside one page, and a call split across pages leaves an `incomplete` block on
 * the first page and an `orphan` block on the next -- pages never pair.
 *
 * Everything is synchronous and side-effect free: no clock, no randomness, no
 * I/O, and a malformed entry degrades instead of throwing.
 */

import type { Block, BlockId, ErrorBlock, NoticeBlock, TextBlock } from "@haruyuki/protocol";

import type { AssistantPart } from "../merge/types.js";
import { createMessageStateFor, roleForMessageType } from "./adapter.js";
import { appendText, completeMessage } from "./blocks.js";
import { parseUserContent, type NoticeSpan, type TaskNotificationSpan } from "./notice.js";
import { appendParts, createPartsCursor } from "./parts.js";
import { createReasoningAggregator, ingestReasoning } from "./reasoning.js";
import { sanitizeBlock } from "./sanitize.js";
import { createToolTable, incompleteAll, ingestToolMessage } from "./tools.js";
import { blockIdFor, contentKey, type MessageState, type SourceMessage } from "./types.js";

/** Mutable output of one page: blocks in source order, plus their positions. */
type Page = {
  readonly blocks: Block[];
  readonly index: Map<BlockId, number>;
};

/**
 * Messages whose payload is consumed by the tool state machine. A response
 * carries no block of its own: a decision is not a call.
 */
const TOOL_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "tool_call_message",
  "tool_return_message",
  "approval_request_message",
  "approval_response_message",
]);

/**
 * Parse one page of history.
 *
 * Order is source order, then content order inside each message. A tool call
 * keeps the position of the message that first mentioned it; its result updates
 * the block without moving it. Calling this twice with the same page returns
 * equal blocks, and the next page starts from scratch.
 */
export function parseHistoryPage(messages: readonly SourceMessage[]): readonly Block[] {
  const page: Page = { blocks: [], index: new Map() };
  const tools = createToolTable();
  const reasoning = createReasoningAggregator();

  for (const value of messages) {
    const message = normalizeMessage(value);
    if (message === null) {
      continue;
    }

    switch (message.messageType) {
      case "user_message":
        appendAll(page, parseUser(message));
        break;
      case "assistant_message":
        appendAll(page, parseAssistant(message));
        break;
      case "reasoning_message": {
        const update = ingestReasoning(reasoning, message);
        if (update !== null) {
          put(page, update.block);
        }
        break;
      }
      case "hidden_reasoning_message":
        // Agent-only thinking: it must not surface as a reasoning block.
        break;
      case "error_message":
        put(page, parseError(message));
        break;
      default:
        if (TOOL_MESSAGE_TYPES.has(message.messageType)) {
          for (const update of ingestToolMessage(tools, message)) {
            put(page, update.block);
          }
        } else {
          put(page, parseUnknown(message));
        }
        break;
    }
  }

  // A page is finished by definition: a call left open by the page must not
  // keep showing an in-progress card. Replacing the block in place keeps both
  // its id and its first-seen position.
  for (const update of incompleteAll(tools)) {
    put(page, update.block);
  }

  return page.blocks.map(sanitizeBlock);
}

/**
 * Normalise one history entry. Callers hand in `SourceMessage`s, but a loaded
 * page is a `message.list` entry: the type is `message_type`, content sits on
 * the entry itself, and run and date are engine fields. Accepting both shapes
 * keeps the public type honest while any history source can be fed in. A
 * non-object entry is refused; an empty object still becomes an unknown block.
 */
function normalizeMessage(value: unknown): SourceMessage | null {
  const outer = recordOf(value);
  if (outer === null) {
    return null;
  }

  // When the caller already wrapped the entry, the payload is `body`; when the
  // page was passed through as-is, the entry is its own payload.
  const body = outer.body === undefined ? outer : outer.body;
  const inner = recordOf(body) ?? outer;

  const messageType =
    textOf(outer.messageType) ?? textOf(inner.message_type) ?? textOf(outer.message_type) ?? "";
  const role = roleOf(outer.role) ?? roleOf(inner.role) ?? roleForMessageType(messageType);

  return {
    id: textOf(outer.id) ?? textOf(inner.id) ?? contentKey(value),
    messageType,
    role,
    body,
    runId: textOf(inner.run_id) ?? textOf(outer.runId) ?? textOf(outer.run_id),
    at: timeOf(outer.at) ?? timeOf(inner.date) ?? timeOf(outer.date),
  };
}

/**
 * The content payload of a message. History entries carry `content`; a body
 * already reduced to the raw text of the message is accepted too, because
 * treating it as "no content" would hide a whole message.
 */
function contentOf(message: SourceMessage): unknown {
  if (typeof message.body === "string") {
    return message.body;
  }
  const record = recordOf(message.body);
  return record === null ? undefined : record.content;
}

/**
 * Lay out one user message.
 *
 * A string is cleaned as a whole. An array is walked in part order so an image
 * keeps its place between two paragraphs: adjacent text parts accumulate into
 * one string and are cleaned once, with no separator inserted at the boundary,
 * and every other part flushes that prose before taking its own place. An
 * object naming a string `type` is handled as a one-part array. Any other
 * non-empty payload becomes a visible `unknown` block instead of vanishing.
 */
function parseUser(message: SourceMessage): readonly Block[] {
  const state = createMessageStateFor(message);
  const content = contentOf(message);

  if (typeof content === "string") {
    appendUserSpans(state, parseUserContent(content));
    return state.blocks;
  }

  if (!Array.isArray(content)) {
    const record = recordOf(content);
    if (record !== null && typeof record.type === "string") {
      appendSingleUserPart(state, content, record.type, record.text);
      return state.blocks;
    }
    return content === null || content === undefined ? state.blocks : [unknownBlock(message)];
  }

  let pending = "";

  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }
    const text = pending;
    pending = "";
    appendUserSpans(state, parseUserContent(text));
  };

  for (const part of content) {
    if (typeof part === "string") {
      pending += part;
      continue;
    }

    const record = recordOf(part);
    if (record === null) {
      continue;
    }

    if (record.type === "text") {
      if (typeof record.text === "string") {
        pending += record.text;
      }
      continue;
    }

    // The prose run ends here; the non-text part keeps its place in the message.
    flush();
    appendParts(state, [part as AssistantPart], createPartsCursor());
  }

  flush();
  return state.blocks;
}

/** Append the one part an object-shaped `content` names, like a one-item array. */
function appendSingleUserPart(
  state: MessageState,
  part: unknown,
  type: string,
  text: unknown,
): void {
  if (type === "text") {
    if (typeof text === "string") {
      appendUserSpans(state, parseUserContent(text));
    }
    return;
  }
  appendParts(state, [part as AssistantPart], createPartsCursor());
}

/**
 * Lay out one assistant message with the live path's fence scanner.
 *
 * A text part is appended to the running prose, not turned into a block, so a
 * fence may start in one part and close in another. Before a non-text part the
 * buffered prose is flushed, keeping a paragraph ahead of the image that
 * follows it. Reasoning parts are skipped: the same thinking arrives as its own
 * reasoning message, and a block here would show it twice.
 */
function parseAssistant(message: SourceMessage): readonly Block[] {
  const state = createMessageStateFor(message);
  const content = contentOf(message);

  if (typeof content === "string") {
    appendText(state, content);
    completeMessage(state);
    return state.blocks;
  }

  if (!Array.isArray(content)) {
    const record = recordOf(content);
    if (record !== null && typeof record.type === "string") {
      appendSingleAssistantPart(state, content, record.type, record.text);
      return state.blocks;
    }
    return content === null || content === undefined ? state.blocks : [unknownBlock(message)];
  }

  for (const part of content) {
    if (typeof part === "string") {
      appendText(state, part);
      continue;
    }

    const record = recordOf(part);
    if (record === null) {
      continue;
    }

    if (record.type === "text") {
      if (typeof record.text === "string") {
        appendText(state, record.text);
      }
      continue;
    }

    if (record.type === "reasoning") {
      continue;
    }

    // Flush the tail line so the part lands after the prose that preceded it.
    completeMessage(state);
    appendParts(state, [part as AssistantPart], createPartsCursor());
  }

  completeMessage(state);
  return state.blocks;
}

/** Append the one part an object-shaped assistant `content` names. */
function appendSingleAssistantPart(
  state: MessageState,
  part: unknown,
  type: string,
  text: unknown,
): void {
  if (type === "text") {
    if (typeof text === "string") {
      appendText(state, text);
    }
    completeMessage(state);
    return;
  }
  if (type === "reasoning") {
    // The same thinking arrives as its own reasoning message; showing it here
    // would duplicate it.
    return;
  }

  // Flush the tail line so the part lands after the prose that preceded it.
  completeMessage(state);
  appendParts(state, [part as AssistantPart], createPartsCursor());
}

/** Append the spans a user text part produced, in order. */
function appendUserSpans(state: MessageState, spans: readonly NoticeSpan[]): void {
  for (const span of spans) {
    if (span.kind === "notice") {
      putState(state, userNoticeBlock(state, span));
    } else {
      putState(state, userTextBlock(state, span.text));
    }
  }
}

/**
 * Build one user text block. History is complete by definition, so unlike the
 * streaming builder this writes `status: "complete"` and never touches the
 * fence scanner: fenced Markdown in a user message stays as written.
 */
function userTextBlock(state: MessageState, text: string): TextBlock {
  return {
    id: blockIdFor(state.messageId, "text", nextOrdinal(state, "text")),
    messageId: state.messageId,
    runId: state.runId,
    role: state.role,
    type: "text",
    text,
    flavor: "markdown",
    status: "complete",
  };
}

/** Build one task notification block for a user message. */
function userNoticeBlock(state: MessageState, span: TaskNotificationSpan): NoticeBlock {
  return {
    id: blockIdFor(state.messageId, "notice", nextOrdinal(state, "notice")),
    messageId: state.messageId,
    runId: state.runId,
    role: state.role,
    type: "notice",
    category: "task-notification",
    title: span.title,
    text: span.text,
  };
}

/** Build the block for a message type this version does not understand. */
function parseUnknown(message: SourceMessage): Block {
  return unknownBlock(message);
}

/**
 * Build the visible placeholder for a payload that cannot be shown as prose.
 * `rawType` is the declared message type, or `untyped` when the entry names
 * none.
 */
function unknownBlock(message: SourceMessage): Block {
  return {
    id: blockIdFor(message.id, "unknown", 0),
    messageId: message.id,
    runId: message.runId,
    role: message.role,
    type: "unknown",
    rawType: message.messageType.length > 0 ? message.messageType : "untyped",
    raw: message.body,
  };
}

/**
 * Build the block for an error message. The engine puts the readable text in
 * `message` and the class in `error_type`; a malformed body contributes what
 * can still be recognised, and no wording is invented when a field is absent.
 */
function parseError(message: SourceMessage): ErrorBlock {
  const body = recordOf(message.body) ?? {};
  const nested = recordOf(body.error) ?? {};

  return {
    id: blockIdFor(message.id, "error", 0),
    messageId: message.id,
    runId: message.runId,
    role: message.role,
    type: "error",
    message: textOf(body.message) ?? textOf(nested.message) ?? "",
    errorType: textOf(body.error_type) ?? textOf(body.errorType) ?? textOf(nested.type),
    detail:
      textOf(body.detail) ??
      textOf(body.description) ??
      textOf(nested.detail) ??
      textOf(body.stack),
  };
}

/** Append every block of one message to the page, preserving their order. */
function appendAll(page: Page, blocks: readonly Block[]): void {
  for (const block of blocks) {
    put(page, block);
  }
}

/** Add a block at the end, or replace it in place when its id is already known. */
function put(page: Page, block: Block): void {
  const existing = page.index.get(block.id);
  if (existing !== undefined) {
    page.blocks[existing] = block;
    return;
  }
  page.index.set(block.id, page.blocks.length);
  page.blocks.push(block);
}

/** Push a block into one message's own ordered list. */
function putState(state: MessageState, block: Block): void {
  state.blockIndex.set(block.id, state.blocks.length);
  state.blocks.push(block);
}

/** Take the next ordinal for one block type and count it up. */
function nextOrdinal(state: MessageState, type: "text" | "notice"): number {
  const ordinal = state.ordinals.get(type) ?? 0;
  state.ordinals.set(type, ordinal + 1);
  return ordinal;
}

/** Accept a role name, or `null` for anything else. */
function roleOf(value: unknown): SourceMessage["role"] | null {
  if (value === "user" || value === "assistant" || value === "tool" || value === "system") {
    return value;
  }
  return null;
}

/** A non-empty string, or `null`. */
function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read a millisecond timestamp.
 *
 * History dates are ISO strings and arrival times are already numbers; both are
 * accepted. An unparseable date is `null`, never a stand-in clock reading.
 */
function timeOf(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** A plain object, or `null` for arrays and primitives. */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
