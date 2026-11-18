/**
 * Owning one xterm instance: its stylesheet, its lifetime, and the container it
 * mounts into.
 *
 * Why this module exists
 *   Constructing a `Terminal` is three lines and none of them are the hard part.
 *   The hard part is that xterm renders *correctly* with no stylesheet at all:
 *   it constructs, `open` succeeds, an addon loads, `fit` returns the right
 *   columns and rows. The only value that differs is the computed `position` of
 *   the composition overlay, which sits at `static` instead of `absolute` -- so
 *   an input method's preedit text falls into the document flow under the
 *   terminal. Nothing throws and nothing logs. Owning the stylesheet next to the
 *   instance is what makes that failure impossible to commit.
 *
 * Why the stylesheet arrives as a string
 *   This package runs in the renderer, and it may not import a Node builtin, so
 *   it cannot read `xterm.css` off disk. That is not a limitation to work around
 *   by pretending a bundler will inline it: `?raw` and a plain `.css` import both
 *   resolve to the empty string under this package's test and build setup, and an
 *   empty string is exactly the invisible failure described above. So the caller
 *   -- which is the shell, and which does have a filesystem -- reads the file and
 *   hands the text over. An empty string is rejected at construction rather than
 *   shipped to the screen.
 *
 * Why the stylesheet is installed by element id
 *   A terminal panel is unmounted and remounted as the user switches panes, and
 *   the usual React cleanup story does not help: the stylesheet belongs to the
 *   document, not to the container the component owns. Installing one `<style>`
 *   per mount grows the sheet with every switch, and a thousand copies of the
 *   same rule is a page that renders correctly and is slow for no reason. The id
 *   makes the second install a no-op.
 *
 * Why a disposed instance is never reopened
 *   `dispose()` removes the terminal's own DOM but leaves `element` pointing at
 *   the detached node, and `open()` on a disposed instance does not throw -- it
 *   silently mounts nothing. Reusing the object therefore produces a blank panel
 *   with no error anywhere. This module hands out one instance per host and
 *   refuses to resurrect it.
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

/** A terminal's size in cells. */
export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

/** The `<style>` element this module owns, so installation stays idempotent. */
const STYLE_ELEMENT_ID = "haruyuki-ui-xterm";

/**
 * The name of the stylesheet's source, for the error an empty one raises.
 *
 * Spelled out because "css is empty" is a message that leads nowhere: the
 * realistic cause is a loader that returned `""` for a file that exists, and
 * naming the file points at it.
 */
const STYLESHEET_HINT = "xterm.css";

/** What {@link createTerminalHost} needs from its caller. */
export interface TerminalHostOptions {
  /**
   * The xterm stylesheet, as text.
   *
   * Read by the shell, because the renderer may not touch the filesystem. Passed
   * as text rather than as a URL because this package has no CSS loader, so a
   * URL would have to be fetched and would then arrive asynchronously -- after
   * `open`, which is one frame too late for the composition overlay.
   */
  readonly css: string;

  /** The document to install the stylesheet into. Defaults to the ambient one. */
  readonly doc?: Document;

  /** Font size in pixels for the terminal's own options. Defaults to 13. */
  readonly fontSize?: number;

  /** Columns for the initial size. Defaults to 80. */
  readonly cols?: number;

  /** Rows for the initial size. Defaults to 24. */
  readonly rows?: number;

  /** Scrollback length in lines. Defaults to 1000. */
  readonly scrollback?: number;
}

/** One terminal instance and the element it is mounted in. */
export interface TerminalHost {
  /** The instance. The same object for the lifetime of this host. */
  readonly terminal: Terminal;

  /**
   * Mount the terminal into `container` and make sure the stylesheet is present.
   *
   * Idempotent for this host: calling it again on the same container is a no-op
   * rather than a second mount. That matters because a React effect can run more
   * than once for reasons the component does not control (a fast refresh, a
   * re-render with a new container ref object pointing at the same node), and a
   * second mount would put two live terminals in one box.
   *
   * @param container the element the terminal paints into
   */
  open(container: HTMLElement): void;

  /**
   * Whether {@link open} has mounted this terminal.
   *
   * Exposed so a caller can decide without catching an exception: after
   * {@link dispose} this is false and cannot become true again.
   */
  readonly isOpen: boolean;

  /**
   * Recompute the terminal's cell grid from its container's current box.
   *
   * Separate from `open` because the two answer different questions: `open` is
   * "paint into this node", this is "how big is it now". A caller drives it from
   * wherever it learns the box changed, and gets `null` when there is no mounted
   * container to measure.
   *
   * The addon needs a laid-out box. Under jsdom (and under any real window
   * before first layout) `clientWidth` is 0, `fit()` declines to answer rather
   * than writing `cols: 0`, and this returns `null` -- reporting a zero grid as
   * a measurement is how a terminal ends up one column wide.
   *
   * @returns the measured size, or null when nothing can be measured
   */
  measure(): TerminalDimensions | null;

  /**
   * Tear the terminal down and release its DOM.
   *
   * Idempotent. The instance is not reusable afterwards -- a host is built per
   * mounted panel, and a remount builds a new one.
   */
  dispose(): void;
}

/**
 * Install the xterm stylesheet into a document, once.
 *
 * Idempotent by element id rather than by a module-level flag: two shells on one
 * page, or a hot reload that keeps the document but drops the module, would
 * defeat a boolean while the element survives it.
 *
 * An empty (or whitespace-only) sheet is rejected. It is not a defensive check
 * for a value that cannot happen -- it is the exact value a CSS loader returns
 * when it does not understand the import, and the resulting terminal is invisible
 * in a way no assertion in the suite would notice.
 *
 * @param css the stylesheet text, from the caller's own read of `xterm.css`
 * @param doc the document to install into, defaults to the ambient one
 * @returns the style element holding the sheet
 * @throws Error when `css` is empty, or when there is no document to install into
 */
export function installTerminalStyles(css: string, doc?: Document): HTMLStyleElement {
  if (css.trim() === "") {
    throw new Error(
      `installTerminalStyles received an empty stylesheet; read ${STYLESHEET_HINT} in the shell and pass its text`,
    );
  }

  const target = doc ?? globalThis.document;

  if (target === undefined) {
    throw new Error("installTerminalStyles needs a Document; none was passed and none is ambient");
  }

  const existing = target.getElementById(STYLE_ELEMENT_ID);

  if (existing !== null) {
    return existing as HTMLStyleElement;
  }

  const style = target.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = css;
  target.head.append(style);

  return style;
}

/**
 * Read back the stylesheet element if it is installed.
 *
 * @param doc the document to look in, defaults to the ambient one
 * @returns the element, or `null` when no sheet is installed
 */
export function terminalStylesElement(doc?: Document): HTMLStyleElement | null {
  const target = doc ?? globalThis.document;

  return target === undefined
    ? null
    : (target.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null);
}

/**
 * Create the owner of one terminal instance.
 *
 * The stylesheet is installed here rather than in {@link TerminalHost.open} so
 * that a call with an empty sheet fails before anything is constructed: a caller
 * that catches the error has not half-mounted a panel.
 *
 * @param options the stylesheet, the document, and the terminal's own options
 * @returns a host whose terminal is created but not yet mounted
 * @throws Error when `css` is empty, or when there is no document to install into
 */
export function createTerminalHost(options: TerminalHostOptions): TerminalHost {
  const doc = options.doc ?? globalThis.document;

  installTerminalStyles(options.css, doc);

  const terminal = new Terminal({
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    scrollback: options.scrollback ?? 1000,
    fontSize: options.fontSize ?? 13,
  });

  /** The container this host mounted into; `null` before {@link open}. */
  let container: HTMLElement | null = null;

  /** Loaded lazily: a fit needs a laid-out box, and a host may never get one. */
  let fit: FitAddon | null = null;

  /** Set once {@link TerminalHost.dispose} has run, so the host cannot be reused. */
  let disposed = false;

  const host: TerminalHost = {
    terminal,

    get isOpen(): boolean {
      return container !== null;
    },

    open(target: HTMLElement): void {
      if (disposed) {
        throw new Error(
          "this terminal host was disposed; build a new host for this mount instead of reopening a released instance",
        );
      }

      // A second `open` is a no-op rather than a throw: the caller is a React
      // effect, and "the effect ran twice for the same container" is a normal
      // thing that must not surface as a crash in the panel.
      if (container === target) return;

      // A *different* container is a real mistake, because it would leave the
      // first one holding a live terminal that nothing can reach.
      if (container !== null) {
        throw new Error(
          "this terminal host is already mounted in another container; dispose it before mounting elsewhere",
        );
      }

      container = target;
      terminal.open(target);
    },

    measure(): TerminalDimensions | null {
      if (disposed || container === null) return null;

      // `fit()` writes the grid onto the instance and reaches the parent box
      // through internals that only exist after `open`, hence the guard above.
      // `proposeDimensions` is the addon's own "what would a fit produce", so
      // asking it first means a container with no layout never reaches `fit`.
      if (fit === null) {
        fit = new FitAddon();
        fit.activate(terminal);
      }

      const proposed = fit.proposeDimensions();

      if (proposed === undefined || proposed.cols <= 0 || proposed.rows <= 0) {
        return null;
      }

      fit.fit();

      return { cols: terminal.cols, rows: terminal.rows };
    },

    dispose(): void {
      if (disposed) return;

      disposed = true;
      container = null;
      fit?.dispose();
      fit = null;
      terminal.dispose();
    },
  };

  return host;
}
