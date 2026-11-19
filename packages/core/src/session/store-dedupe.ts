/**
 * Duplicate suppression: what a change was, and whether it was already folded.
 *
 * A reconnect re-sends the tail of the stream, and a frame in it must not be
 * folded twice: the turn table would allocate a second ref and the badge would
 * count the same turn again. The fingerprint is built from the change itself,
 * not from anything the folds assign, because a turn ref is allocated per pass -
 * the second replay would hand the same frame a different one.
 *
 * The table is bounded by {@link DEDUPE_TURN_LIMIT} and maintained only here:
 * a session that never reconnects would otherwise hold one entry per frame.
 */

import { DEDUPE_TURN_LIMIT, readText, readTime } from "./store-types.js";

/** Separates the parts of a suppression key; a NUL cannot appear in an id. */
const KEY_SEPARATOR = "\u0000";

/** The fields of a change that a replay reproduces exactly. */
const FINGERPRINT_FIELDS = [
  "turnId",
  "runId",
  "messageId",
  "requestId",
  "type",
  "subagentId",
  "runSeq",
] as const;

/** The suppression table, and the bound that keeps it finite. */
export interface DedupeTable {
  /** Whether this change was already folded; remembers it when it was not. */
  isDuplicate(key: string): boolean;

  /** How many keys are held; the diagnostics reading counts them. */
  readonly size: number;
}

/**
 * Build one suppression table.
 *
 * @returns the table, whose insertion order is its eviction order
 */
export function createDedupeTable(): DedupeTable {
  /** The changes already folded; insertion order is the eviction order. */
  const folded = new Map<string, true>();

  /** Whether this change was already folded; remembers it when it was not. */
  const isDuplicate = (key: string): boolean => {
    if (folded.has(key)) {
      // Refresh the position: the newest changes are the ones a replay repeats.
      folded.delete(key);
      folded.set(key, true);

      return true;
    }

    folded.set(key, true);

    while (folded.size > DEDUPE_TURN_LIMIT) {
      const oldest = folded.keys().next();

      if (oldest.done === true) {
        break;
      }

      folded.delete(oldest.value);
    }

    return false;
  };

  return {
    isDuplicate,

    get size(): number {
      return folded.size;
    },
  };
}

/**
 * What a change was, in a form a replay reproduces exactly.
 *
 * Built from the change, not from anything the folds assign: a turn ref is
 * allocated per pass, so the second replay would hand the same frame a different
 * ref, and a turn closed without its terminal frame carries no id at all. The
 * arrival time is the one coordinate a replay keeps; paired with the kind and the
 * ids, it keeps two turns that reuse a run id apart.
 */
function fingerprintOf(change: Readonly<Record<string, unknown>>): string | null {
  const kind = readText(change["kind"]);
  const at = readTime(change["at"]);

  if (kind === null || at === null) {
    return null;
  }

  const parts: string[] = [kind, readText(change["conversationId"]) ?? "", String(at)];

  for (const field of FINGERPRINT_FIELDS) {
    const raw = change[field];

    if (typeof raw === "string" || (typeof raw === "number" && Number.isFinite(raw))) {
      parts.push(`${field}=${String(raw)}`);
    }
  }

  // The reason is part of the identity as well: a turn can be closed twice in one
  // conversation, and only the reason tells the two closes apart from each other.
  const stopReason = readText(change["stopReason"]);

  if (stopReason !== null) {
    parts.push(`stop=${stopReason}`);
  }

  return parts.join(KEY_SEPARATOR);
}

export { fingerprintOf };
