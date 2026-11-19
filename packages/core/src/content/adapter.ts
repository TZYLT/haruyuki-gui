/**
 * Live adaptation: the merger's changes become the content model's own shapes,
 * and one message's frames become blocks.
 *
 * Two things happen here and nowhere else:
 *
 * 1. **Translation.** `message.delta` becomes a `SourceDelta` and
 *    `message.final` becomes a `SourceMessage`. The delta keeps the upstream
 *    fields verbatim -- `text` is *this frame's* new text, `parts` is the
 *    message's whole part list so far -- because the assembler below depends on
 *    both meanings. A final message with no id gets a content key instead, so
 *    replaying the same payload names the same message.
 * 2. **Block orchestration.** One `MessageState` per message. A delta appends
 *    the frame's text and folds in the part positions it has not seen. The text
 *    is appended through the part positions when the frame's `text` is exactly
 *    the text of its new text parts (the real shape), so an image between two
 *    paragraphs makes the following paragraph open a new text block; a frame
 *    whose parts do not yet carry its text falls back to appending `text`
 *    first. Because both steps append to "the last block", the source order is
 *    preserved either way.
 *
 * Idempotence is part of the contract: the *same frame object* delivered twice
 * must not append its text twice. The guard deliberately compares object
 * identity only: two frames may legitimately carry the same text (a stream can
 * send the same character or space twice in a row), and the upstream merger
 * already removes re-delivered frames by their idempotency key. Comparing
 * content here would silently shorten real text.
 *
 * Nothing here reads a clock, generates randomness, touches the network or
 * decides what a tool, a reasoning segment or a notice means. Those live in
 * their own modules; this one only assembles text and parts.
 */

import type { Block, BlockId } from "@haruyuki/protocol";

import type { AssistantPart, MergerChange } from "../merge/types.js";
import { appendText, completeMessage as finishMessage, createMessageState } from "./blocks.js";
import { createFenceState } from "./fence.js";
import { appendParts, createPartsCursor, type PartsCursor } from "./parts.js";
import { contentKey, type MessageState, type SourceDelta, type SourceMessage } from "./types.js";

/** The upstream change that carries one fragment of an assistant message. */
export type MessageDeltaChange = Extract<MergerChange, { kind: "message.delta" }>;

/** The upstream change that carries a message the merger did not assemble. */
export type MessageFinalChange = Extract<MergerChange, { kind: "message.final" }>;

/** The last frame object one message state accepted, for the repeat guard. */
type FrameMemo = {
  readonly change: SourceDelta;
};

/** Repeat guard per message; a weak key so a released state costs nothing. */
const frames = new WeakMap<MessageState, FrameMemo>();

/** Part-position cursor per message. */
const cursors = new WeakMap<MessageState, PartsCursor>();

/**
 * Which speaker a message type belongs to.
 *
 * Live user messages carry no `role` field, and the history path uses its own
 * field, so the type is the one thing both paths have. Unknown types are
 * attributed to the system rather than guessed at.
 */
export function roleForMessageType(messageType: string): SourceMessage["role"] {
  switch (messageType) {
    case "user_message":
      return "user";
    case "assistant_message":
    case "reasoning_message":
    case "hidden_reasoning_message":
      return "assistant";
    case "tool_call_message":
    case "tool_return_message":
    case "approval_request_message":
    case "client_tool_start":
    case "client_tool_end":
      return "tool";
    default:
      return "system";
  }
}

/** Map one delta change onto the content model's delta shape, field for field. */
export function toSourceDelta(change: MessageDeltaChange): SourceDelta {
  return {
    messageId: change.messageId,
    runId: change.runId,
    text: change.text,
    parts: change.parts,
    first: change.first,
  };
}

/**
 * Map one final message onto a source message.
 *
 * A missing (or empty) message id is replaced by the payload's content key: the
 * same body always yields the same id, so a replayed page re-parses into the
 * same block ids instead of inventing new ones.
 */
export function toSourceMessage(change: MessageFinalChange): SourceMessage {
  return {
    id: messageIdOf(change),
    messageType: change.messageType,
    role: roleForMessageType(change.messageType),
    body: change.body,
    runId: change.runId,
    at: change.at,
  };
}

/** Start the in-flight state of one source message. */
export function createMessageStateFor(message: SourceMessage): MessageState {
  return createMessageState({
    id: message.id,
    messageType: message.messageType,
    role: message.role,
    runId: message.runId,
  });
}

/**
 * Start the in-flight state of a streamed assistant message.
 *
 * A delta is only ever produced for an assistant message, so the type and the
 * speaker are known without asking the caller; the run id comes from the frame.
 */
export function createDeltaState(change: SourceDelta): MessageState {
  return createMessageState({
    id: change.messageId,
    messageType: "assistant_message",
    role: "assistant",
    runId: change.runId,
  });
}

/**
 * Ingest one delta frame and return the blocks it created or changed.
 *
 * The frame's `text` is the text of the text parts it added -- that is how the
 * upstream assembler builds it -- so the part positions decide where the text
 * goes. When the two agree the text is appended by `appendParts`, in part
 * order; otherwise (a synthetic frame, or a frame whose parts lag behind its
 * text) the text is appended first and new text parts only mark their
 * position. The returned list is an upsert list -- never the whole message --
 * and an empty list when the frame was a repeat or carried nothing new.
 */
export function ingestDelta(state: MessageState, change: SourceDelta): readonly Block[] {
  if (isRepeatedFrame(state, change)) {
    return [];
  }

  const cursor = cursorFor(state);
  const partsCarryText = textFromNewParts(change.parts, cursor.seen) === change.text;
  const changed: Block[] = partsCarryText ? [] : [...appendText(state, change.text)];

  changed.push(...appendParts(state, change.parts, cursor, partsCarryText));
  frames.set(state, { change });

  return changed;
}

/**
 * Close a message: flush the tail line and mark text/code blocks complete.
 *
 * Forwarded from the text assembler so a caller has one place to look; calling
 * it twice returns an empty list.
 */
export function completeMessage(state: MessageState): readonly Block[] {
  return finishMessage(state);
}

/** The ids of the blocks a reset would remove, in source order. */
export function removedBlockIds(state: MessageState): readonly BlockId[] {
  return state.blocks.map((block) => block.id);
}

/**
 * Drop a message's blocks and assembly state.
 *
 * Returns the ids the consumer must remove. The next delta for the same message
 * starts over: ordinals restart at zero, so identical content rebuilds
 * identical ids.
 */
export function resetMessage(state: MessageState): readonly BlockId[] {
  const removed = removedBlockIds(state);

  state.blocks.length = 0;
  state.blockIndex.clear();
  state.ordinals.clear();
  state.fence = createFenceState();

  frames.delete(state);
  cursors.delete(state);

  return removed;
}

/**
 * Whether this frame is the very object this message accepted last.
 *
 * Identity is the only safe test. Content equality is not: a stream can send
 * the same character or space in two consecutive frames, and treating that as a
 * repeat would shorten the text. Re-delivered frames are the merger's problem,
 * not this layer's.
 */
function isRepeatedFrame(state: MessageState, change: SourceDelta): boolean {
  const memo = frames.get(state);
  return memo !== undefined && memo.change === change;
}

/** The part cursor of one message, created on first use. */
function cursorFor(state: MessageState): PartsCursor {
  const held = cursors.get(state);
  if (held !== undefined) {
    return held;
  }
  const created = createPartsCursor();
  cursors.set(state, created);
  return created;
}

/**
 * The text of the text parts this cursor has not handled yet.
 *
 * This is the text a real delta carries: the assembler adds its parts and
 * reports their text together. Empty when the frame added no text part.
 */
function textFromNewParts(parts: readonly AssistantPart[], seen: number): string {
  let text = "";

  for (let index = seen; index < parts.length; index += 1) {
    const part = parts[index];
    if (part !== undefined && part.type === "text" && typeof part.text === "string") {
      text += part.text;
    }
  }

  return text;
}

/**
 * A message's id, falling back to the payload's stable content key.
 *
 * The key covers the message type as well as the body: a page can hold the same
 * payload as a user message and as an assistant message, and those are two
 * messages, not one. `contentKey` sorts object keys, so the field order here
 * does not matter and a replay of the same pair names the same message.
 */
function messageIdOf(change: MessageFinalChange): string {
  const id = change.messageId;
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  return contentKey({ messageType: change.messageType, body: change.body });
}
