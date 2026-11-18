/**
 * Block assembly for one message's prose: text and fenced code.
 *
 * This module owns the per-message counters and the positional ids, and nothing
 * else. It hands the running text to the fence scanner, turns the scanner's
 * segments into `text` and `code` blocks, and keeps the block array in source
 * order. A caller (the model facade) decides when a delta arrives and when a
 * message is over; it never has to think about fences, ordinals or positions.
 *
 * Public surface, so a later adapter can wire to it without guessing:
 *
 *   createMessageState(message: MessageIdentity): MessageState
 *     Starts the in-flight state of one message, with an empty fence scanner.
 *
 *   appendText(state: MessageState, text: string): readonly Block[]
 *     Appends one delta's text. Returns only the blocks this call created or
 *     changed -- an upsert list, never the whole message -- in first-change
 *     order. Text without a newline yet returns an empty list: it is buffered
 *     inside the fence state so a partial fence is never shown as prose.
 *
 *   flushPendingText(state: MessageState): readonly Block[]
 *     Flushes the tail line that has no newline yet, without closing the
 *     message: `completeMessage` minus the status change. A caller that has to
 *     place a non-text block calls this first, so the prose that preceded it
 *     keeps its place in the source order. Idempotent.
 *
 *   completeMessage(state: MessageState): readonly Block[]
 *     Flushes the tail line and marks every still-`streaming` text/code block
 *     `complete`. An unterminated code block keeps `closed:false`; it does not
 *     revert to prose. Returns the blocks it changed; calling it twice returns
 *     an empty list.
 *
 * The rules this module enforces:
 *
 * - ids are `blockIdFor(messageId, type, ordinal)`, and `text`/`code` keep their
 *   own counters, both starting at zero;
 * - an updated block replaces its old object at the same array position, so a
 *   consumer can upsert by id and keep the original order;
 * - a delta only ever touches the block it is still writing; finished blocks are
 *   not re-sent;
 * - text is stored verbatim, with `flavor: "markdown"`; code keeps the raw
 *   `info` string and its own `closed` flag;
 * - no language detection, no HTML, no escaping, no clock, no randomness.
 */

import type { Block, BlockId, BlockRole, CodeBlock, TextBlock } from "@haruyuki/protocol";

import { blockIdFor, type MessageState } from "./types.js";
import { createFenceState, feedFence, finishFence, type FenceSegment } from "./fence.js";

/** The identity fields one message contributes to every block it produces. */
export type MessageIdentity = {
  readonly id: string;
  readonly messageType: string;
  readonly role: BlockRole;
  readonly runId: string | null;
};

/**
 * Build the in-flight state of one message.
 *
 * The ordinals and the position table start empty, so the first text block of
 * every message is `…:text:0` regardless of how many messages came before it.
 */
export function createMessageState(message: MessageIdentity): MessageState {
  return {
    messageId: message.id,
    messageType: message.messageType,
    role: message.role,
    runId: message.runId,
    blocks: [],
    blockIndex: new Map<BlockId, number>(),
    ordinals: new Map(),
    fence: createFenceState(),
  };
}

/**
 * Append one piece of a message's text.
 *
 * The fence scanner is the only authority on where a code block starts and
 * ends; this function only mirrors its segments into blocks. Returns the blocks
 * that changed, or an empty list when the fragment was a partial line that the
 * scanner is still holding.
 */
export function appendText(state: MessageState, text: string): readonly Block[] {
  if (text.length === 0) {
    return [];
  }

  return applySegments(state, feedFence(state.fence, text));
}

/**
 * Flush the tail line that has no newline yet, without closing the message.
 *
 * Prose only becomes a block once its newline arrives; the tail of the running
 * text waits inside the fence scanner. A caller that is about to append a
 * non-text block has to flush that tail first, otherwise the part would be
 * pushed before prose that precedes it in the source and the live order would
 * disagree with a whole-message parse. This is `completeMessage`'s first step
 * on its own: the flushed blocks stay `streaming`, because the message is not
 * over. An empty tail returns an empty list, and calling it twice returns an
 * empty list the second time.
 */
export function flushPendingText(state: MessageState): readonly Block[] {
  return applySegments(state, finishFence(state.fence));
}

/**
 * Close a message: flush the unterminated tail line, then mark every streaming
 * text/code block complete.
 *
 * Code that never saw a closer stays `closed:false`, which is how a surface can
 * tell "the author stopped" from "the fence closed"; its `status` is still
 * `complete` because the message is over. Idempotent.
 */
export function completeMessage(state: MessageState): readonly Block[] {
  const changed = new Map<BlockId, Block>();
  for (const block of flushPendingText(state)) {
    changed.set(block.id, block);
  }

  for (let index = 0; index < state.blocks.length; index += 1) {
    const block = state.blocks[index];
    if (block === undefined) {
      continue;
    }
    if (block.type !== "text" && block.type !== "code") {
      continue;
    }
    if (block.status === "complete") {
      continue;
    }
    const complete = { ...block, status: "complete" as const };
    state.blocks[index] = complete;
    changed.set(complete.id, complete);
  }

  return [...changed.values()];
}

/**
 * Mirror one batch of scanner segments into blocks.
 *
 * Each segment either extends the block being written or starts a new one.
 * Because the scanner reports in source order, "the last block" is always the
 * one a segment refers to: a text segment after a closer lands on a code block
 * and therefore starts a new text block, which is exactly the source order.
 * Changes are collected by id and returned once, so a block touched twice in
 * one call is reported in its final shape.
 */
function applySegments(state: MessageState, segments: readonly FenceSegment[]): readonly Block[] {
  const changed = new Map<BlockId, Block>();

  for (const segment of segments) {
    switch (segment.kind) {
      case "text": {
        const current = lastBlock(state);
        if (current !== undefined && current.type === "text") {
          const next: TextBlock = { ...current, text: current.text + segment.text };
          changed.set(next.id, replaceBlock(state, next));
        } else {
          const next = createTextBlock(state, segment.text);
          changed.set(next.id, pushBlock(state, next));
        }
        break;
      }
      case "code-open": {
        const next = createCodeBlock(state, segment.info);
        changed.set(next.id, pushBlock(state, next));
        break;
      }
      case "code-text": {
        const current = lastBlock(state);
        if (current !== undefined && current.type === "code") {
          const next: CodeBlock = { ...current, text: current.text + segment.text };
          changed.set(next.id, replaceBlock(state, next));
        } else {
          // The scanner is inside a fence but no block is open: recover a code
          // block from the fence state rather than folding code into prose.
          const opened = createCodeBlock(state, state.fence.info);
          const next: CodeBlock = { ...opened, text: segment.text };
          changed.set(next.id, pushBlock(state, next));
        }
        break;
      }
      case "code-close": {
        const current = lastBlock(state);
        if (current !== undefined && current.type === "code" && !current.closed) {
          const next: CodeBlock = { ...current, closed: true };
          changed.set(next.id, replaceBlock(state, next));
        }
        break;
      }
    }
  }

  return [...changed.values()];
}

/** The last block in source order, or `undefined` for a fresh message. */
function lastBlock(state: MessageState): Block | undefined {
  return state.blocks.length === 0 ? undefined : state.blocks[state.blocks.length - 1];
}

/** Append a new block and record its position. */
function pushBlock(state: MessageState, block: Block): Block {
  state.blockIndex.set(block.id, state.blocks.length);
  state.blocks.push(block);
  return block;
}

/** Replace a block at its first position, keeping the array order. */
function replaceBlock(state: MessageState, block: Block): Block {
  const index = state.blockIndex.get(block.id);
  if (index === undefined || state.blocks[index] === undefined) {
    // A missing position is not something this module produces; the defensive
    // branch keeps the block visible instead of dropping its text.
    return pushBlock(state, block);
  }
  state.blocks[index] = block;
  return block;
}

/** Take the next ordinal for one block type and count it up. */
function nextOrdinal(state: MessageState, type: "text" | "code"): number {
  const ordinal = state.ordinals.get(type) ?? 0;
  state.ordinals.set(type, ordinal + 1);
  return ordinal;
}

/** Create a streaming text block for the message. */
function createTextBlock(state: MessageState, text: string): TextBlock {
  return {
    id: blockIdFor(state.messageId, "text", nextOrdinal(state, "text")),
    messageId: state.messageId,
    runId: state.runId,
    role: state.role,
    type: "text",
    text,
    flavor: "markdown",
    status: "streaming",
  };
}

/** Create an empty, streaming code block with the opener's raw info string. */
function createCodeBlock(state: MessageState, info: string): CodeBlock {
  return {
    id: blockIdFor(state.messageId, "code", nextOrdinal(state, "code")),
    messageId: state.messageId,
    runId: state.runId,
    role: state.role,
    type: "code",
    text: "",
    info,
    closed: false,
    status: "streaming",
  };
}
