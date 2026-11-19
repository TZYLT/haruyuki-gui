/**
 * Non-text content parts: images, and everything this layer does not recognise.
 *
 * Prose is assembled by `blocks.ts`, because it has to be re-scanned for fences
 * as it grows. A non-text part is the opposite: it arrives whole, it never
 * grows, and it keeps the place where it first appeared. This module owns
 * exactly that -- turning an image part into an `image` block, any other
 * non-text part into an `unknown` block, and remembering which part position
 * produced which block so a later revision replaces that block instead of
 * adding a second one.
 *
 * The rules it enforces:
 *
 * - ids are `blockIdFor(messageId, type, ordinal)`; `image` and `unknown` count
 *   separately and their ordinals only ever go up;
 * - a text part at a position not seen yet appends its text to the prose (when
 *   the caller opts in), in part order, so `[text, image, text]` produces the
 *   same block order as a one-shot parse instead of folding the trailing text
 *   into the first block;
 * - a new block is appended at the current end, so parts stay in source order
 *   and prose that arrives after a part starts a new text block (the text
 *   assembler writes into "the last block", and the last block is now a part);
 * - prose still buffered in the fence scanner is flushed before that append, so
 *   a part never jumps ahead of an un-newlined line that precedes it;
 * - a part already seen is replaced in place under the same id; a revision
 *   never moves or duplicates it;
 * - an assistant message's `reasoning` part produces no block: the same
 *   thinking arrives as its own reasoning message, and a block here would show
 *   it twice; the position is still recorded so later positions stay stable;
 * - an image is not decoded, resized or copied: `source` is the part's own
 *   base64 or url payload, and `alt` is the author's text when there is one;
 * - anything else keeps its payload verbatim as `raw`; a payload too odd to
 *   classify stays visible as `unknown` rather than being dropped.
 *
 * The caller passes the message's *cumulative* part list, the same list the
 * upstream assembly publishes each frame. Positions are therefore stable: the
 * cursor only has to remember which positions it has already handled.
 *
 * A caller whose frame also carries the frame's own `text` can opt in to
 * appending new text positions with `appendNewText: true`; the live adapter
 * does that when the frame's `text` is exactly the text of its new text parts.
 * The default records text positions without appending their text, because a
 * caller that appended the delta's text first (the history path and direct
 * builder tests do the equivalent) must not append it a second time.
 */

import type { Block, BlockId, ImageBlock, ImageSource, UnknownBlock } from "@haruyuki/protocol";

import type { AssistantPart } from "../merge/types.js";
import { appendText, flushPendingText } from "./blocks.js";
import { blockIdFor, type MessageState } from "./types.js";

/** One part position that produced a block. */
export type PartSlot = {
  readonly blockId: BlockId;
  /** The part object the block was built from; a new object is a revision. */
  readonly part: AssistantPart;
};

/**
 * What one message has seen of its cumulative part list.
 *
 * A text part records `null`: its text was appended to the prose when the
 * position was first seen (if the caller opted in), and the block it lands in
 * is the text assembler's decision (continuing the current block or opening one
 * after a part). Reasoning also records `null`, but its text is never appended:
 * the thinking arrives as its own reasoning message. Every other position
 * records the block it produced.
 */
export type PartsCursor = {
  /** How many positions have been handled; always `slots.length`. */
  seen: number;
  slots: (PartSlot | null)[];
};

/** Start a cursor for a message that has not seen any part yet. */
export function createPartsCursor(): PartsCursor {
  return { seen: 0, slots: [] };
}

/**
 * Fold one frame's cumulative part list into the message's blocks.
 *
 * Only the positions this cursor has not handled become new blocks; a position
 * seen before either keeps its block (`slot.part === part`, the usual case
 * because the upstream list reuses part objects) or is rebuilt under the same
 * id. A new `text` position records its slot; when `appendNewText` is on it
 * also appends its text to the prose in source order, so the part order decides
 * the block order. Returns the blocks that changed, in first-change order.
 */
export function appendParts(
  state: MessageState,
  parts: readonly AssistantPart[],
  cursor: PartsCursor,
  appendNewText = false,
): readonly Block[] {
  // A list shorter than the positions already handled means the message
  // restarted without a reset. The stale tail is dropped and the positions that
  // remain are treated as revisions, so a restart updates blocks in place
  // instead of appending a second copy of every part.
  if (parts.length < cursor.seen) {
    cursor.slots.length = parts.length;
    cursor.seen = parts.length;
  }

  const changed = new Map<BlockId, Block>();

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) {
      continue;
    }

    if (part.type === "text") {
      // A new text position contributes prose here, in the order it appears in
      // the part list. The delta's `text` is the same text for a real frame,
      // but a frame may also carry an image between two text parts; appending
      // the text here is what keeps `[text, image, text]` in that order.
      if (index >= cursor.seen) {
        cursor.slots[index] = null;
        if (appendNewText && typeof part.text === "string") {
          for (const block of appendText(state, part.text)) {
            changed.set(block.id, block);
          }
        }
      }
      continue;
    }

    if (part.type === "reasoning") {
      // Reasoning arrives as its own reasoning message, so a block built here
      // would show it twice. The position is still recorded so later positions
      // stay dense and reasoning does not consume an unknown ordinal.
      if (index >= cursor.seen) {
        cursor.slots[index] = null;
      }
      continue;
    }

    const slot = cursor.slots[index] ?? null;

    if (index < cursor.seen && slot !== null) {
      if (slot.part === part) {
        continue;
      }
      const next = rebuildBlock(state, part, slot.blockId);
      cursor.slots[index] = { blockId: next.id, part };
      changed.set(next.id, replaceBlock(state, next));
      continue;
    }

    // A new position, or a position that used to hold prose. A block cannot
    // take prose's place without reordering, so it is appended like a new part.
    //
    // Prose whose last line has no newline yet is still buffered in the fence
    // scanner, so it is not in `state.blocks` and a part pushed now would land
    // ahead of it. Flush that tail first and report it too: the result is then
    // the same block order a whole-message parse produces. A revision never
    // needs this -- it replaces a block in place and flushes nothing.
    for (const flushed of flushPendingText(state)) {
      changed.set(flushed.id, flushed);
    }
    const block = buildBlock(state, part);
    cursor.slots[index] = { blockId: block.id, part };
    changed.set(block.id, pushBlock(state, block));
  }

  if (parts.length > cursor.seen) {
    cursor.seen = parts.length;
  }

  return [...changed.values()];
}

/** The default media type when an image payload does not name one. */
const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/**
 * Build a block for a part that has no block yet.
 *
 * An image part whose payload names neither a url nor base64 data cannot become
 * an `image` block (there would be nothing for a surface to load); it degrades
 * to `unknown` so the payload stays visible instead of disappearing.
 */
function buildBlock(state: MessageState, part: AssistantPart): Block {
  if (part.type === "image") {
    const source = imageSourceOf(part);
    if (source !== null) {
      const id = blockIdFor(state.messageId, "image", nextOrdinal(state, "image"));
      return makeImageBlock(state, part, source, id);
    }
  }
  const id = blockIdFor(state.messageId, "unknown", nextOrdinal(state, "unknown"));
  return makeUnknownBlock(state, part, id);
}

/** Rebuild a block under the id its part position already owns. */
function rebuildBlock(state: MessageState, part: AssistantPart, id: BlockId): Block {
  if (part.type === "image") {
    const source = imageSourceOf(part);
    if (source !== null) {
      return makeImageBlock(state, part, source, id);
    }
  }
  return makeUnknownBlock(state, part, id);
}

/** Create a streaming image block from a part's own payload. */
function makeImageBlock(
  state: MessageState,
  part: AssistantPart,
  source: ImageSource,
  id: BlockId,
): ImageBlock {
  return {
    id,
    messageId: state.messageId,
    runId: state.runId,
    role: state.role,
    type: "image",
    source,
    alt: altOf(part),
  };
}

/** Create an unknown block that keeps the part object untouched. */
function makeUnknownBlock(state: MessageState, part: AssistantPart, id: BlockId): UnknownBlock {
  return {
    id,
    messageId: state.messageId,
    runId: state.runId,
    role: state.role,
    type: "unknown",
    rawType: rawTypeOf(part),
    raw: part,
  };
}

/** Take the next ordinal for one part type and count it up. */
function nextOrdinal(state: MessageState, type: "image" | "unknown"): number {
  const ordinal = state.ordinals.get(type) ?? 0;
  state.ordinals.set(type, ordinal + 1);
  return ordinal;
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
    // branch keeps the payload visible instead of dropping it.
    return pushBlock(state, block);
  }
  state.blocks[index] = block;
  return block;
}

/** The author's text for an image, from `alt` first and `text` second. */
function altOf(part: AssistantPart): string | null {
  const alt = readString(part["alt"]);
  if (alt !== null) {
    return alt;
  }
  return readString(part["text"]);
}

/** The part's own type name, or a marker when it is missing. */
function rawTypeOf(part: AssistantPart): string {
  return typeof part.type === "string" && part.type.length > 0 ? part.type : "untyped";
}

/**
 * Read an image payload without touching the bytes.
 *
 * The engine may nest the payload under `source` (the usual shape) or put it on
 * the part itself; both are accepted. A named kind wins over field sniffing, so
 * a payload that carries both a url and data is not misread.
 */
function imageSourceOf(part: AssistantPart): ImageSource | null {
  const nested = asRecord(part["source"]);
  if (nested !== null) {
    const fromNested = sourceFrom(nested);
    if (fromNested !== null) {
      return fromNested;
    }
  }
  return sourceFrom(part);
}

function sourceFrom(record: Record<string, unknown>): ImageSource | null {
  const kind = readNonEmptyString(record["type"]) ?? readNonEmptyString(record["kind"]);
  const url = readNonEmptyString(record["url"]);
  const data = readNonEmptyString(record["data"]);

  if (kind === "url") {
    return url === null ? null : { kind: "url", url };
  }
  if (kind === "base64") {
    return data === null ? null : { kind: "base64", mediaType: mediaTypeOf(record), data };
  }
  if (url !== null) {
    return { kind: "url", url };
  }
  if (data !== null) {
    return { kind: "base64", mediaType: mediaTypeOf(record), data };
  }
  return null;
}

function mediaTypeOf(record: Record<string, unknown>): string {
  return (
    readNonEmptyString(record["media_type"]) ??
    readNonEmptyString(record["mediaType"]) ??
    DEFAULT_MEDIA_TYPE
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
