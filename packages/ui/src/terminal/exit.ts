/**
 * The two exits a terminal stroke takes on its way to a shell.
 *
 * Why there are exactly two, and no third
 *   Every byte the panel sends to a shell is produced here: one function for a
 *   keyboard stroke, one for a clipboard paste. That is a deliberate limit, not
 *   a tidiness preference. When two modules each assemble a terminal-input
 *   payload -- the keyboard in one place, the paste handler in another -- a test
 *   that proves "not a single byte is sent while the input method is composing"
 *   only has to spy on the one place it knows about, and the other place keeps
 *   sending. The suite goes green, the behaviour is still wrong, and nothing in
 *   the test report says so. A single producer per stroke kind means there is
 *   one call site to spy on per stroke kind, and a second producer is then a
 *   second call site rather than an unwritten assertion. Any new code that
 *   builds a terminal-input payload without going through one of these two
 *   functions is a defect even if it looks correct in isolation.
 *
 *   A rule that only review remembers is a rule that lasts until the reviewer is
 *   busy, so the capability is spelled exactly once here and a test scans every
 *   renderer source for a second spelling. Adding a producer therefore cannot be
 *   done quietly: it either names the capability -- and fails that scan -- or it
 *   invents a name for a wire the engine does not have.
 *
 * What stays upstream, on purpose
 *   The terminal emulator already owns key mapping and composition. It keeps
 *   uncommitted input in its own composition view, fires nothing while a
 *   composition is open, and fires `onData` once with the finished text. So this
 *   module does not translate key names into escape sequences and does not
 *   re-derive composition state, because a second implementation of either would
 *   be a second opinion about the same bytes. A caller hands over the payload it
 *   received plus the gesture flags; the module applies policy only -- which
 *   strokes produce no bytes at all, and the one stroke whose byte is fixed here
 *   rather than taken from the payload.
 *
 * Why the input is a plain record
 *   A `KeyboardEvent` cannot be constructed in a node test, so accepting one
 *   would put these rules out of reach of an assertion and into the reach of a
 *   review. {@link KeyStroke} is the narrow record a caller fills from whatever
 *   event it actually has.
 *
 * Pure: no DOM, no terminal instance, no clock, no I/O.
 */

/**
 * The wire capability these two functions are the only producers for.
 *
 * Declared here so the name is spelled in exactly one file. A module that wanted
 * to build its own payload would have to name the capability to send it as
 * something other than these two exits, and the name it would reach for is this
 * one -- which a test scans the renderer for. That turns "there is no third
 * producer" from a claim a reviewer has to verify by memory into a file that has
 * to be edited, and an edit here is a visible line in the diff.
 */
export const TERMINAL_INPUT_CAPABILITY = "terminal.input" as const;

/**
 * One keyboard stroke, described without a browser object.
 *
 * `key` is the key name the event spells and `data` is what the terminal
 * emulator's input path produced for the same stroke. Both are needed: `data` is
 * the bytes in the general case, `key` is the only way to recognise a gesture
 * whose whole point is that its bytes must not travel.
 */
export interface KeyStroke {
  /**
   * The key name, as a keyboard event spells it: `"a"`, `"C"`, `"Backspace"`,
   * `"ArrowUp"`, `"Escape"`.
   *
   * Only the chords below look at this; for every other stroke `data` carries
   * the decision.
   */
  readonly key: string;

  /**
   * The bytes the terminal emulator produced for this stroke, i.e. the payload of
   * the one data event it fires, verbatim and unsplit.
   *
   * Empty when it produced none: a modifier pressed on its own, a gesture the
   * emulator swallowed, a keystroke the input method consumed.
   *
   * This is passed through untouched for every stroke that is not named in a
   * rule below. In particular a single backspace arrives here as one sequence
   * and leaves as that same sequence, so one press is one deletion: splitting a
   * payload into per-byte writes would delete twice for some sequences and would
   * also make "no bytes were sent" impossible to assert per stroke.
   */
  readonly data: string;

  /** Control held. */
  readonly ctrlKey?: boolean;

  /** Shift held. */
  readonly shiftKey?: boolean;

  /** Alt held. */
  readonly altKey?: boolean;

  /** The platform's command key held. */
  readonly metaKey?: boolean;

  /**
   * The input method currently owns the input, sampled by the caller from its
   * composition state.
   *
   * The emulator itself already emits nothing while composing, so this flag is
   * not what implements composition support -- it is the assertion point that
   * makes the property testable, and the belt for a stroke that reaches us
   * anyway.
   */
  readonly isComposing?: boolean;
}

/**
 * The interrupt byte.
 *
 * Fixed here rather than taken from the caller's payload: the decision that a
 * stop gesture stops the foreground job is this module's, and a payload cannot
 * be allowed to disagree with it.
 */
const INTERRUPT = "\u0003";

/**
 * Translate one keyboard stroke into the bytes to send.
 *
 * The rules are ordered, and the order is the specification:
 *
 * 1. Control+C is an interrupt, always. Not "unless a selection exists" --
 *    a selection is not something this module can see, and that is the point:
 *    an implementation that checks for one can be talked into copying instead,
 *    and a shell that will not stop is worse than a copy that needs the menu.
 *    The exception to this rule is AltGr, which platforms report as Control+Alt
 *    and the emulator treats as a third-level shift that produces a character
 *    through the browser, never through its data event. Requiring Alt to be up
 *    keeps a layout whose AltGr+C types a character from interrupting instead.
 * 2. Control+Shift+C and Control+Shift+V produce nothing. They are the window's
 *    copy and paste gestures, and the panel's own clipboard handling owns them;
 *    sending the shell a stray byte for a copy is a visible defect.
 * 3. While the input method owns the input, nothing is produced.
 * 4. Everything else is the emulator's payload, untouched. An empty payload
 *    yields nothing rather than an empty write.
 *
 * The interrupt is checked before the composition rule, and it is the only rule
 * with that precedence. The reason is a race, not a preference: when a stop is
 * pressed mid-composition the emulator finalizes the composition and then emits
 * the interrupt, so by the time this byte exists the composition is over, while
 * the caller's flag may still be set for one more tick. Letting that stale flag
 * win would swallow exactly the byte the user pressed for, and the loss is
 * unrecoverable -- the process stays in the foreground.
 *
 * @param stroke the stroke, as the caller observed it
 * @returns the bytes to send, or `null` when this stroke sends none
 */
export function translateKey(stroke: KeyStroke): string | null {
  const key = stroke.key.toLowerCase();
  const ctrl = stroke.ctrlKey === true;
  const shift = stroke.shiftKey === true;
  const alt = stroke.altKey === true;
  const meta = stroke.metaKey === true;

  if (ctrl && !shift && !alt && key === "c") {
    return INTERRUPT;
  }

  if (shift && (ctrl || meta) && (key === "c" || key === "v")) {
    return null;
  }

  if (stroke.isComposing === true) {
    return null;
  }

  return stroke.data === "" ? null : stroke.data;
}

/**
 * What to do about a paste.
 *
 * A paste of several lines is the one gesture that can do something the user did
 * not ask for -- each newline submits a command -- so it asks first. The answer
 * is a value rather than a prompt: this module never shows a dialog, it reports
 * that one is needed and how many lines it is about.
 */
export type PasteDecision =
  | { readonly action: "send"; readonly data: string }
  | { readonly action: "ask"; readonly lines: number };

/** The line separator a shell's line discipline expects a submit to be. */
const CR = "\r";

/**
 * Translate pasted text into the bytes to send, or into a request to confirm.
 *
 * Line endings are normalized to a carriage return. This is the only transform
 * in the path, and it lives here for the same reason as everything else in this
 * file: a line pasted with a line feed only would not submit on most shells, so
 * somebody has to translate it, and that somebody must not be a second module
 * building its own payload.
 *
 * Line counting, decided and pinned by the tests
 *   Lines are the segments the text is split into by line breaks, after the
 *   normalization: breaks + 1. `"a\nb"` is 2 lines, and a trailing break adds an
 *   empty final segment, so `"a\nb\n"` is 3. The trailing segment counts on
 *   purpose: pasting it is what submits the line before it, and a confirmation
 *   that hides the submitting newline would understate what the paste does.
 *
 * A single-line paste never asks, and neither does an empty one -- it carries no
 * text to submit.
 *
 * @param text the pasted text, exactly as the clipboard delivered it
 * @param options `confirmed` is true once the user has answered the request
 *   this function returned for the same text
 * @returns the bytes to send, or the number of lines to confirm
 */
export function translatePaste(
  text: string,
  options: { readonly confirmed: boolean },
): PasteDecision {
  const data = text.replace(/\r\n|\r|\n/g, CR);

  if (data === "") {
    return { action: "send", data: "" };
  }

  const lines = data.split(CR).length;

  if (lines > 1 && options.confirmed !== true) {
    return { action: "ask", lines };
  }

  return { action: "send", data };
}
