/**
 * Receiving a drop: the handler that sits behind `DROPPED_FILES_CHANNEL`.
 *
 * Extracted from `main.ts` for two reasons, in this order.
 *
 * **It is a unit.** What arrives on the channel is untrusted data -- the sender is the
 * renderer -- and it has to be validated, then turned into an authorisation, then answered.
 * That is a decision procedure, and it belongs next to `validateDroppedPayload` rather than
 * inline in a startup function that also builds windows and registers protocols.
 *
 * **`main.ts` reached the file-size limit.** Adding this back inline pushed it past 1000
 * lines, which the repository refuses. Splitting by responsibility was the answer the gate
 * asks for; splitting to satisfy a counter would have been the wrong reason, so the first
 * paragraph is the real one.
 *
 * What stays in `main.ts` is one line: `ipcMain.handle(DROPPED_FILES_CHANNEL, ...)` bound
 * to this factory, because registering a channel is startup wiring and belongs with the
 * other registrations.
 */

import type { DroppedFileReport } from "../shared/bridge.js";

import { validateDroppedPayload } from "./dropped-files.js";

/** What a handled drop answers back to whoever sent it. */
export interface DropAnswer {
  readonly entries: readonly { name: string; path?: string }[];
  readonly acceptedCount: number;
}

/** What this module needs from the shell, injected so it can be tested without Electron. */
export interface DropHandlerDeps {
  /** Add paths to the set the media channel may serve. */
  readonly acceptPaths: (paths: readonly string[]) => void;
  /** Record a rejection. Absent when there is no logger yet. */
  readonly warn?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * Build the handler for one drop.
 *
 * @param deps the shell's accept and log functions
 * @returns a function taking whatever arrived on the channel
 */
export function createDropHandler(deps: DropHandlerDeps): (payload: unknown) => DropAnswer {
  return (payload: unknown): DropAnswer => {
    const report = validateDroppedPayload(payload);

    if (report === null) {
      deps.warn?.("drop.rejected", { detail: "payload did not match {name, path}[]" });

      // A value rather than a throw: the caller classifies it, the same way every other
      // refusal in this item is a value rather than an exception.
      return { acceptedCount: 0, entries: [] };
    }

    // The readable set grows by what the user just dropped on the window. A real
    // authorisation: the gesture is the user's own, and the alternative -- asking them to
    // also pick it from a dialog -- would be asking twice for one decision.
    //
    // Entries with no path contribute nothing here. They are still reported back, because
    // "we saw it but could not locate it" is information the page may want to show.
    const accepted = report.entries.flatMap((entry) =>
      entry.path === undefined ? [] : [entry.path],
    );

    if (accepted.length > 0) deps.acceptPaths(accepted);

    return {
      entries: report.entries,
      // A count rather than a boolean: "2 of 3 were usable" tells a caller what to say,
      // where `ok: true` would claim more than happened.
      acceptedCount: accepted.length,
    };
  };
}
