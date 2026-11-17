/**
 * Keeping a terminal's contents across a refresh, and refusing to when doing so
 * would lie.
 *
 * Why this module refuses more often than it captures
 *   A restore writes absolute cursor movements, so it only reproduces what it
 *   captured when the grid is the same size and the bytes came from a terminal
 *   rather than from a binary file. Each of those is a real situation, and each
 *   has a different correct answer:
 *
 *   - a differently sized terminal: the text lands on the wrong cells. The caller
 *     has to choose between resizing and starting fresh, so the refusal is
 *     returned rather than hidden;
 *   - a buffer with nothing in it: the snapshot would restore an empty screen, and
 *     a stored blank would make "there is something to restore" true forever;
 *   - an enormous buffer: the shell printed something that is not text -- a `cat`
 *     of a binary, a runaway loop -- and restoring it repaints control bytes at
 *     the cost of the memory the renderer is trying to recover.
 *
 * Refusing is not a failure of the feature. The feature is "the user gets their
 * scrollback back", and a terminal showing a wall of control bytes is not that.
 *
 * Why "empty" is measured rather than compared to ""
 *   `SerializeAddon` returns `""` for a buffer that has never been written to, but
 *   it returns cursor-movement escapes for a buffer that only received blank
 *   lines: `"\r\n\r\n"` serializes to `ESC[2B`, "move down two lines". A module
 *   that compared the result to `""` would happily store that, and the snapshot
 *   would restore to a blank screen -- exactly the case this is meant to refuse.
 *   The escapes are stripped before deciding, so "nothing but whitespace and
 *   cursor movement" reads as empty.
 *
 * Why the cap is on bytes rather than on characters
 *   The budget is memory in the renderer, and a CJK buffer is three bytes per
 *   character. Counting `length` would admit a capture three times the advertised
 *   cap on exactly the terminals whose content is most expensive to hold.
 *
 * Pure apart from the injected addon and terminal: no DOM of its own, no timer,
 * no clock read beyond the timestamp the caller asks for.
 */

import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/xterm";

/**
 * The largest capture worth restoring: four megabytes of serialized text.
 *
 * A measured large capture (three thousand lines) was 0.57 MB, so this is several
 * times the realistic worst case. It is a limit, not a target: anything past it
 * came from a terminal whose output is not text.
 */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** One terminal's contents, with what is needed to know whether it can be put back. */
export interface TerminalSnapshot {
  /** The serialized buffer, as {@link SerializeAddon} produced it. */
  readonly serialized: string;

  /** The grid width it was captured from, in cells. */
  readonly cols: number;

  /** The grid height it was captured from, in cells. */
  readonly rows: number;

  /** When it was taken, as epoch milliseconds, so a caller can age it out. */
  readonly capturedAt: number;
}

/**
 * A capture's size in bytes, as the cap counts it.
 *
 * Exported because a caller deciding whether to keep a snapshot (and a test
 * asserting the cap) needs the same number this module branches on.
 *
 * @param snapshot the capture
 * @returns its serialized size in UTF-8 bytes
 */
export function snapshotBytes(snapshot: TerminalSnapshot): number {
  return new TextEncoder().encode(snapshot.serialized).length;
}

/**
 * Whether a serialization carries anything a user would miss.
 *
 * Cursor movement is not content: a terminal that only moved its cursor restores
 * to a blank screen, which is indistinguishable from not restoring at all. Every
 * CSI sequence and every C0/C1 control character is removed before deciding, so
 * what remains is the text.
 *
 * @param serialized the addon's output
 * @returns true when there is real text in it
 */
function hasContent(serialized: string): boolean {
  // CSI sequences first, then any remaining control characters. The order matters
  // only for readability: the second pattern would leave the parameters of a CSI
  // sequence behind as text ("2B" from ESC[2B) if it ran on its own.
  const withoutEscapes = serialized.replaceAll(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
  const withoutControls = withoutEscapes.replaceAll(/[\u0000-\u001F\u007F-\u009F]/g, "");

  return withoutControls.trim() !== "";
}

/**
 * Capture a terminal, or refuse to.
 *
 * @param addon the serialize addon, loaded on `term`
 * @param term the terminal to capture
 * @returns the capture, or `null` when there is nothing worth restoring
 */
export function captureSnapshot(addon: SerializeAddon, term: Terminal): TerminalSnapshot | null {
  const serialized = addon.serialize();

  if (!hasContent(serialized)) return null;

  const snapshot: TerminalSnapshot = {
    serialized,
    cols: term.cols,
    rows: term.rows,
    capturedAt: Date.now(),
  };

  // Measured after building the object so the cap applies to exactly the string
  // that would be stored -- not to an estimate of it.
  if (snapshotBytes(snapshot) > MAX_SNAPSHOT_BYTES) return null;

  return snapshot;
}

/**
 * Put a capture back into a terminal.
 *
 * Refuses when the grid size differs, because the capture positions its text in
 * absolute cells and a different grid puts it somewhere the user did not have it.
 * The refusal is a returned `false` rather than a throw or a silent skip: the
 * caller has to choose between resizing the terminal and starting a fresh shell,
 * and it cannot make that choice if it is told nothing.
 *
 * @param addon the serialize addon, loaded on `term`
 * @param term the terminal to write into
 * @param snapshot the capture to put back
 * @returns whether the capture was written
 */
export function restoreSnapshot(
  addon: SerializeAddon,
  term: Terminal,
  snapshot: TerminalSnapshot,
): boolean {
  // The addon is not used to write: `serialize` only reads. It is taken so that
  // both halves of this module have the same signature and a future addon-version
  // restore (which would need it) does not change every call site.
  void addon;

  if (term.cols !== snapshot.cols || term.rows !== snapshot.rows) return false;

  // Rejected here as well as at capture time, because a snapshot may arrive from
  // storage written by an older or newer build. A capture this module never made
  // is not automatically one it should write.
  if (snapshotBytes(snapshot) > MAX_SNAPSHOT_BYTES) return false;

  term.write(snapshot.serialized);

  return true;
}
