/**
 * The xterm stylesheet, as text, obtained without a filesystem.
 *
 * Why this is a module of its own, and why it has a comment this long
 *   It is the one line in this package whose meaning changes with the environment,
 *   and both of its two meanings are useful rather than accidental:
 *
 *   - under **Vite**, `?raw` is a first-class import suffix. It returns the file's
 *     whole text, inlined at build time. This is how the shipped renderer gets a
 *     stylesheet without the renderer process touching a disk.
 *   - under **vitest**, `?raw` resolves to the empty string. Measured, not
 *     assumed: it is the same behaviour `tokens/theme.ts` records for `?inline`,
 *     and the reason that module composes its CSS as a plain string instead.
 *
 *   The second is why the value cannot be trusted in a test, and the first is why
 *   it must not be replaced with a string constant. Leaving either half out of this
 *   comment would produce the exact defect this package has spent a night removing:
 *   a value that looks verified in the environment where it is checked and is
 *   different in the one where it is used.
 *
 * What keeps the empty case from reaching a user
 *   `createTerminalHost` refuses an empty stylesheet at construction, because
 *   xterm renders with no stylesheet at all -- the terminal constructs, opens,
 *   measures correctly, and the only wrong value is the composition overlay's
 *   position, so an input method's preedit text falls into the document flow. An
 *   empty string here therefore fails loudly in a test rather than quietly on a
 *   screen, and `stylesheet.test.ts` asserts exactly that pairing.
 *
 * Where the real value is verified
 *   `apps/desktop/scripts/terminal-probe.mjs`, which does have a filesystem and
 *   resolves the same file through `require.resolve`. It is the only place that
 *   can compare the built value against the file, so the built value is what it
 *   checks. A change that broke inlining would show up there and nowhere here.
 */

import xtermCss from "@xterm/xterm/css/xterm.css?raw";

/**
 * The xterm stylesheet.
 *
 * Empty under vitest, the file's text under Vite. Read the module comment before
 * asserting on this value: a test can only prove the empty case.
 */
export const TERMINAL_STYLESHEET: string = xtermCss;

/**
 * Whether this build actually inlined the stylesheet.
 *
 * Exposed so a host can decide between "use the inlined sheet" and "ask the shell
 * for one" without importing the string and testing it. It reports the value it
 * was built with -- it is not a probe, and it cannot become true at runtime.
 *
 * @returns true when the stylesheet arrived as text
 */
export function hasTerminalStylesheet(): boolean {
  return TERMINAL_STYLESHEET.trim() !== "";
}
