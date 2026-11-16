/**
 * The session seam: who, if anyone, can hand the bundle a conversation.
 *
 * The bundle knows how to redact and truncate a conversation, but not where one
 * lives. That is deliberate: conversation storage belongs to E1/E2, and a
 * diagnostic collector that reached into a store would be a second owner of the
 * thing it is supposed to observe. This module is the one registration point, so
 * "include session content" can be implemented and tested before the first
 * conversation store exists (`RD-06`).
 *
 * The shell as shipped has no source registered. That is not a failure: the
 * panel says "no active session", and an export that asks for content writes an
 * explicit empty placeholder rather than pretending the feature is broken.
 *
 * A source is a process-wide singleton because the main process is one process
 * and an export is one moment; a test resets it so a fake cannot leak into the
 * next file.
 */

import type { SessionDiagnosticsSource } from "../../shared/diagnostics.js";

export type { SessionDiagnosticsSource } from "../../shared/diagnostics.js";

/** How many messages a snapshot may carry. */
export const DEFAULT_SESSION_MESSAGE_LIMIT = 200;

/** What a reader gets: the newest messages, already copied. */
export interface ActiveSessionSnapshot {
  readonly conversationId: string | null;
  readonly messages: readonly unknown[];
}

/** The registered source, if any. Reassigned only through the functions below. */
let source: SessionDiagnosticsSource | null = null;

/**
 * Register the active-session source, or clear it with `null`.
 *
 * Last writer wins on purpose: two stores cannot both be "the" conversation for
 * a bundle, and silently keeping the first would make the export depend on
 * module load order.
 *
 * @param next the source, or `null` to clear
 */
export function setSessionDiagnosticsSource(next: SessionDiagnosticsSource | null): void {
  source = next;
}

/** The registered source, for the panel's "session available" flag. */
export function getSessionDiagnosticsSource(): SessionDiagnosticsSource | null {
  return source;
}

/**
 * Read the active session, truncated to its newest `limit` messages.
 *
 * Never mutates the source: the messages are copied into a fresh array before
 * anything is sliced, because the caller (`collect.ts`) may redact them and the
 * live conversation must not change underneath the UI.
 *
 * A source that throws is treated as "no session". An export exists to report a
 * failure that already happened, and a broken store must not replace that report
 * with a second, unrelated one.
 *
 * @param limit how many of the newest messages to keep; defaults to 200
 * @returns the snapshot, or `null` when no source is registered or it has none
 */
export function readActiveSession(
  limit: number = DEFAULT_SESSION_MESSAGE_LIMIT,
): ActiveSessionSnapshot | null {
  if (source === null) return null;

  let snapshot: ReturnType<SessionDiagnosticsSource["getActiveSession"]>;

  try {
    snapshot = source.getActiveSession();
  } catch {
    return null;
  }

  if (snapshot === null || typeof snapshot !== "object") return null;
  if (!Array.isArray(snapshot.messages)) return null;

  const keep = Math.max(0, Math.floor(limit));
  // `slice(-0)` would keep everything, and a caller asking for no messages means
  // no messages: an explicit branch, not an off-by-one to explain later.
  const messages = keep === 0 ? [] : snapshot.messages.slice(-keep);

  return {
    conversationId: typeof snapshot.conversationId === "string" ? snapshot.conversationId : null,
    messages,
  };
}

/**
 * Clear the registration.
 *
 * For tests, and for a store that unloads. Production never needs it: the
 * process exits before the source would become invalid.
 */
export function resetSessionDiagnosticsSource(): void {
  source = null;
}
