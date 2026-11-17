/**
 * Assembles the text of one assistant message out of the deltas the engine sends
 * for it.
 *
 * A delta is not a message: the engine streams a message in numbered pieces,
 * and a consumer that wants to render or measure one needs the pieces
 * concatenated in order. This module is the only place that knows which pieces
 * belong together, and it decides that with a key and a sequence number.
 *
 * The key is the author, the subagent context and the message id, together.
 * The message id alone is not unique: a recorded session has the same id on the
 * main line and inside a subagent, and merging those two would interleave two
 * different answers into one misleading message. A separator that no agent id
 * may contain keeps the three parts from running together.
 *
 * Ordering is `seq_id`, which starts at one and counts up. Two things can go
 * wrong, and each gets a different answer:
 *
 * - **A repeat.** A `seq_id` at or below the highest one already accepted is
 *   already in the text. Appending it again would duplicate a word, so it is
 *   refused with `null` rather than quietly dropped: the caller can count it.
 * - **A hole.** A `seq_id` beyond the next expected one means at least one delta
 *   never arrived. The text is still appended -- refusing it would lose the
 *   later text as well -- but the message is marked `incomplete` so the
 *   consumer can show that the answer may be missing a piece. The mark is
 *   sticky: a hole cannot be closed by a later frame.
 *
 * The one case that resets instead of appending is a `seq_id` of one while the
 * message already has text: the engine has started the message over, and the
 * only correct reading is that the previous text was provisional. The old text,
 * parts and sequence are discarded and the new run begins at one.
 *
 * The table is bounded, because a session can mention more messages than a
 * window will ever show. Recency is measured by use, not by the frame's arrival
 * time: a replayed frame carries an old timestamp but is very much in use, and
 * ordering eviction by the timestamp would throw it away first.
 *
 * No timers and no asynchronous work: the caller is the synchronous merge loop,
 * and assembling a delta is a string append plus a map lookup.
 */

import type { AssistantPart } from "./types.js";

/** One incoming piece of a streamed message. */
export type AssemblyInput = {
  /** Who said it; separates two authors that reuse a message id. */
  readonly authorAgentId: string | null;
  /** Subagent context; separates a subagent's message from the main line's. */
  readonly subagentId: string | null;
  readonly messageId: string;
  readonly runId: string | null;
  /** `delta.seq_id`: the position inside the message, starting at one. */
  readonly runSeq: number;
  /** The content parts this delta carries, in the engine's order. */
  readonly parts: readonly AssistantPart[];
  /** Arrival time, kept for the caller's diagnostics. */
  readonly at: number;
};

/** One assembled delta, as the message change carries it. */
export type AssemblyDelta = {
  readonly messageId: string;
  readonly runId: string | null;
  readonly runSeq: number;
  /** The text carried by this delta alone; the consumer appends it. */
  readonly text: string;
  /**
   * The message's parts so far, in order, after this delta.
   *
   * The whole message rather than just this delta's parts: a non-text part can
   * be revised across deltas, so a consumer replaces its part list with this
   * one instead of appending, and the last delta it sees always carries the
   * latest state.
   */
  readonly parts: readonly AssistantPart[];
  /** This is the message's first delta, or the first one after a restart. */
  readonly first: boolean;
  /** The message restarted from the beginning and the earlier text was discarded. */
  readonly reset: boolean;
  /** A `seq_id` hole was seen in this message at some point. */
  readonly incomplete: boolean;
};

/** The closing summary of a finished message. */
export type AssemblyComplete = {
  readonly messageId: string;
  readonly runId: string | null;
  /** Length of the assembled text; a hole means it is shorter than the answer. */
  readonly textLength: number;
  readonly incomplete: boolean;
};

/** Per-message assembly state. Never handed out; the caller gets copies. */
export type Assembler = {
  /** Accept one delta; `null` when its `seq_id` was already accepted. */
  push(input: AssemblyInput): AssemblyDelta | null;
  /** Finish a message, returning its size and dropping its state. */
  complete(
    authorAgentId: string | null,
    subagentId: string | null,
    messageId: string,
  ): AssemblyComplete | null;
  /** Drop a message's state without reporting anything. */
  forget(authorAgentId: string | null, subagentId: string | null, messageId: string): void;
  /** How many messages are currently being assembled. */
  size(): number;
  /** Forget every message. */
  clear(): void;
};

/** One message's state while it is being assembled. */
type Entry = {
  /** The text assembled so far. */
  text: string;
  /** The parts accepted so far, in arrival order. */
  parts: AssistantPart[];
  /** Highest `seq_id` accepted; `-1` before the first one. */
  maxSeq: number;
  /** Whether a hole was seen; sticky until the message restarts. */
  incomplete: boolean;
  /** Text of every accepted `seq_id`, so a re-pushed piece can be recognised. */
  seen: Map<number, string>;
  /** The run of the latest accepted delta. */
  runId: string | null;
};

/** The table's default bound, in messages. */
const DEFAULT_LIMIT = 512;

/** The separator between the three identity fields; no agent id contains it. */
const KEY_SEPARATOR = "\u0000";

/**
 * Build the table key.
 *
 * `join` turns a `null` author or subagent into an empty field. Agent ids are
 * non-empty when present (the envelope reader refuses `""`), so an empty field
 * can only mean "no author" and cannot collide with a real one.
 *
 * @param authorAgentId who said it
 * @param subagentId which subagent context
 * @param messageId the message id
 */
function keyOf(authorAgentId: string | null, subagentId: string | null, messageId: string): string {
  return [authorAgentId, subagentId, messageId].join(KEY_SEPARATOR);
}

/**
 * The text contributed by one delta's parts.
 *
 * Only `type: "text"` parts contribute. A tool call or a thinking block may
 * carry fields that look like text; concatenating them into the message would
 * put machine output in the answer the user is reading.
 *
 * @param parts this delta's parts
 */
function textOf(parts: readonly AssistantPart[]): string {
  let text = "";

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
    }
  }

  return text;
}

/**
 * Build an assembler.
 *
 * @param options `limit` bounds how many messages are assembled at once
 */
export function createAssembler(options: { limit?: number } = {}): Assembler {
  const requested = options.limit;
  const limit =
    requested !== undefined && Number.isSafeInteger(requested) && requested > 0
      ? requested
      : DEFAULT_LIMIT;

  const entries = new Map<string, Entry>();

  /** Move an entry to the most recently used position and enforce the bound. */
  const touch = (key: string, entry: Entry): void => {
    entries.delete(key);
    entries.set(key, entry);

    while (entries.size > limit) {
      const oldest = entries.keys().next();

      if (oldest.done) {
        return;
      }

      entries.delete(oldest.value);
    }
  };

  const fresh = (): Entry => ({
    text: "",
    parts: [],
    maxSeq: -1,
    incomplete: false,
    seen: new Map(),
    runId: null,
  });

  return {
    push(input) {
      // A `seq_id` that is not a count cannot be ordered. The frame classifier
      // refuses those before they get here, so this only protects the call.
      if (!Number.isSafeInteger(input.runSeq) || input.runSeq < 0) {
        return null;
      }

      const key = keyOf(input.authorAgentId, input.subagentId, input.messageId);
      const held = entries.get(key);

      let entry = held;
      let reset = false;
      let first = entry === undefined;
      const added = textOf(input.parts);

      if (entry === undefined) {
        entry = fresh();
      } else {
        const seenChunk = entry.seen.get(input.runSeq);

        if (seenChunk !== undefined) {
          // The same piece again. It is a repeat while the text is identical,
          // and a contradiction when it differs; neither may be appended, and
          // differing text is a fact the corner mark should carry.
          if (seenChunk !== added) {
            entry.incomplete = true;
          }

          touch(key, entry);

          return null;
        }

        if (input.runSeq === 1 && entry.parts.length > 0 && entry.maxSeq > 1) {
          // The message was being assembled from a later piece, so this one is
          // the engine starting over: the earlier text was partial and cannot
          // be kept in front of the new run. `parts`, not `text`, is the test:
          // a run may so far have carried only tool calls or thinking blocks,
          // and a text-only check would treat the restart as an old piece.
          entry = fresh();
          reset = true;
          first = true;
        } else if (input.runSeq <= entry.maxSeq) {
          // A piece below the highest one, never accepted. Appending it would
          // put it after text that came later, so it is dropped and the message
          // is marked as possibly missing a piece.
          entry.incomplete = true;
          touch(key, entry);

          return null;
        }
      }
      // Measured against the highest accepted `seq_id`, so a hole anywhere in
      // the past keeps the message incomplete. A message with nothing accepted
      // yet expects one: that is why the first delta of a message that starts at
      // a later number is already incomplete.
      const hole = input.runSeq > Math.max(1, entry.maxSeq + 1);

      entry.text += added;
      entry.parts.push(...input.parts);
      entry.seen.set(input.runSeq, added);
      entry.maxSeq = input.runSeq;
      entry.incomplete = entry.incomplete || hole;
      entry.runId = input.runId;

      touch(key, entry);

      return {
        messageId: input.messageId,
        runId: input.runId,
        runSeq: input.runSeq,
        text: added,
        // A copy: the entry keeps growing, and a delta the caller kept must not
        // change under it when a later delta arrives.
        parts: [...entry.parts],
        first,
        reset,
        incomplete: entry.incomplete,
      };
    },

    complete(authorAgentId, subagentId, messageId) {
      const key = keyOf(authorAgentId, subagentId, messageId);
      const entry = entries.get(key);

      if (entry === undefined) {
        return null;
      }

      entries.delete(key);

      return {
        messageId,
        runId: entry.runId,
        textLength: entry.text.length,
        incomplete: entry.incomplete,
      };
    },

    forget(authorAgentId, subagentId, messageId) {
      entries.delete(keyOf(authorAgentId, subagentId, messageId));
    },

    size() {
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}
