/**
 * The two notes a turn table keeps beside its records: which turn a message
 * belongs to, and which turn a run ran in.
 *
 * A note is a convenience index, not the record itself: a subject whose note has
 * expired can no longer be traced back to a turn, which is what the query
 * answers `null` for. Refreshing a key keeps `Map` order meaningful - the oldest
 * note is evicted first, and re-noting a subject still in use pushes it back.
 * Every expiry is counted by the caller so the loss shows in a diagnostic
 * reading; resolving a ref to a record belongs to the table, which holds them.
 */

import { lineKeyOf } from "./turns-ref.js";

/** One bounded note table, keyed by conversation and subject. */
export interface NoteBook {
  /**
   * Note that a subject belongs to a turn.
   *
   * @param conversationId the conversation the subject arrived in
   * @param subjectId the message or run id
   * @param turnRef the turn that owns it
   */
  note(conversationId: string, subjectId: string, turnRef: string): void;
  /** The ref noted for this subject, or `undefined` when there is none. */
  refOf(conversationId: string, subjectId: string): string | undefined;
  /** Notes currently held. */
  size(): number;
}

/**
 * Build one bounded note table.
 *
 * @param bound how many notes are kept, oldest evicted first
 * @param onExpire called once per note that leaves the table at the bound
 */
export function createNoteBook(bound: number, onExpire: () => void): NoteBook {
  const notes = new Map<string, string>();

  return {
    note(conversationId, subjectId, turnRef) {
      const key = lineKeyOf(conversationId, subjectId);

      notes.delete(key);
      notes.set(key, turnRef);

      while (notes.size > bound) {
        const oldest = notes.keys().next();

        if (oldest.done === true) {
          break;
        }

        notes.delete(oldest.value);
        onExpire();
      }
    },

    refOf(conversationId, subjectId) {
      return notes.get(lineKeyOf(conversationId, subjectId));
    },

    size() {
      return notes.size;
    },
  };
}
