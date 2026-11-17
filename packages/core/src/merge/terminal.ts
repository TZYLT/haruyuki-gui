/**
 * Terminal output: one engine `terminal_output` event becomes the fixed-size
 * slices the bridge's stream channel carries.
 *
 * Two things are load-bearing here.
 *
 * 1. **The cut is on a code point, never on a byte.** A 8192-byte window can
 *    land inside a three-byte character or a four-byte emoji; both halves are
 *    then invalid UTF-8, and a decoder replaces the broken bytes with U+FFFD.
 *    That is not a delay, it is text that is gone from the screen. So a slice
 *    holds at most 8192 bytes and is allowed to be shorter whenever the next
 *    character would cross the line.
 * 2. **`seq` stays 0.** The bridge's sender owns the global sequence and
 *    renumbers every frame as it goes out, so a number assigned here would only
 *    be overwritten -- and a merge-time counter would not be global anyway.
 *
 * The engine types are matched exactly: `terminal_spawned` and
 * `terminal_exited` are lifecycle notices, not bytes, and slicing them would
 * produce an empty terminal.
 */

import type { Frame } from "@haruyuki/protocol";

import { asRecord, readString } from "./envelope.js";
import type { EnvelopeFacts } from "./envelope.js";
import { TERM_SLICE_BYTES } from "./types.js";

/** One `term.output` body, as the stream channel defines it. */
export type TerminalSliceBody = {
  readonly terminal_id: string;
  readonly slice: number;
  readonly slices: number;
  readonly offset: number;
  readonly bytes: number;
  readonly final: boolean;
  readonly text: string;
};

/** One piece of the payload, measured in UTF-8 bytes. */
type TextPiece = {
  readonly text: string;
  readonly bytes: number;
  readonly offset: number;
};

/**
 * Cut text into pieces of at most {@link TERM_SLICE_BYTES} bytes without
 * splitting a code point.
 *
 * `for...of` walks code points rather than UTF-16 units, so a surrogate pair is
 * one step and its four bytes are counted once; that is what keeps an emoji
 * from being cut between its two halves.
 *
 * @param text the complete payload
 * @returns pieces in order, with cumulative byte offsets
 */
function sliceByBytes(text: string): readonly TextPiece[] {
  const pieces: TextPiece[] = [];

  let offset = 0;
  let current = "";
  let currentBytes = 0;

  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");

    // `currentBytes > 0` is always true for a character that would overflow,
    // but stating it keeps the invariant local: a piece is never empty.
    if (currentBytes > 0 && currentBytes + bytes > TERM_SLICE_BYTES) {
      pieces.push({ text: current, bytes: currentBytes, offset });
      offset += currentBytes;
      current = "";
      currentBytes = 0;
    }

    current += character;
    currentBytes += bytes;
  }

  if (currentBytes > 0) {
    pieces.push({ text: current, bytes: currentBytes, offset });
  }

  return pieces;
}

/**
 * Build the frames for one terminal output event.
 *
 * @param type the engine event type
 * @param raw the engine payload; `terminal_id` and `data` are required
 * @param facts the frame's envelope facts, unused by design: a terminal frame
 *   carries no identity or ordering, and the sender supplies both on the way
 *   out, so reading them here would only invite a second source of truth
 * @returns one frame per slice, or none when the payload is missing a field;
 *   the caller counts "none" as a dropped event
 */
export function terminalFramesOf(
  type: string,
  raw: unknown,
  facts: EnvelopeFacts,
): readonly Frame<"term.output">[] {
  if (type !== "terminal_output") {
    return [];
  }

  const record = asRecord(raw);
  const terminalId = readString(record?.["terminal_id"]);
  const data = record?.["data"];

  // An empty `data` is not a frame: a stream that sends empty slices would make
  // the renderer acknowledge bytes that do not exist.
  if (terminalId === null || typeof data !== "string" || data === "") {
    return [];
  }

  const pieces = sliceByBytes(data);

  return pieces.map((piece, index) => {
    const body: TerminalSliceBody = {
      terminal_id: terminalId,
      slice: index,
      slices: pieces.length,
      offset: piece.offset,
      bytes: piece.bytes,
      final: index === pieces.length - 1,
      text: piece.text,
    };

    const frame: Frame<"term.output"> = {
      v: 1,
      ch: "stream",
      seq: 0,
      t: "term.output",
      body,
    };

    return frame;
  });
}
