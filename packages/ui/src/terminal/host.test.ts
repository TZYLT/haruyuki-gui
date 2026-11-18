/**
 * Tests for the terminal host.
 *
 * The subject is not "does xterm work". It is three failures that produce no
 * error message anywhere, and each one gets an assertion because none of them
 * can be caught by reading the code:
 *
 * 1. **A missing stylesheet changes exactly one computed value.** The terminal
 *    constructs, opens, loads an addon and measures correctly; the composition
 *    overlay is simply `static` instead of `absolute`, and an input method's
 *    preedit lands in the document flow. Asserted as a before/after pair,
 *    because only-after would pass on a machine where the sheet came from
 *    somewhere else and only-before would pass while the panel was still broken.
 *
 * 2. **An empty stylesheet is accepted by the browser.** It is the value a CSS
 *    loader returns when it does not understand the import, so it has to fail at
 *    construction instead of reaching the screen.
 *
 * 3. **A remount must not produce a second instance.** Unmounting and remounting
 *    a panel is routine, and a second live terminal in one container is two
 *    renderers fighting over one box with nothing in the log to say so.
 *
 * Why the stylesheet is a fixture rather than the real `xterm.css`
 *   This package is the renderer and may not import a Node builtin, so the test
 *   cannot read the file either -- the boundary rule covers test files as well as
 *   product code. Nor can it import the CSS: under this package's build and test
 *   setup both `?raw` and a plain `.css` import resolve to the empty string, which
 *   is the very failure #2 exists to catch, so a test that relied on them would
 *   pass while asserting nothing.
 *
 *   The fixture below is therefore a **minimal subset**: the two rules whose
 *   computed values are asserted. The real stylesheet is supplied by the shell
 *   and is verified against a real terminal by
 *   `apps/desktop/scripts/terminal-probe.mjs`, which does have a filesystem.
 *   Using the subset here is deliberate: if this file used the real sheet, a
 *   regression in the shell's reading of it would still leave these tests green.
 *
 * jsdom gaps are filled rather than worked around: it has no layout engine, so
 * `matchMedia` is absent and xterm queries it in `open` (it throws
 * `this._parentWindow.matchMedia is not a function` without the stub). Its
 * unimplemented `getContext` prints a notice; that is noise from jsdom's canvas,
 * not a failure of the terminal.
 */

// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTerminalHost, installTerminalStyles, terminalStylesElement } from "./host.js";

/**
 * The two rules whose computed values the tests assert.
 *
 * `.xterm-screen` is what makes the terminal's own box a positioned ancestor;
 * `.composition-view` is the overlay whose `position` is the observable
 * difference between "the stylesheet arrived" and "it did not".
 */
const MINIMAL_STYLESHEET = `
.xterm-screen {
  position: relative;
}
.xterm .composition-view {
  display: none;
  position: absolute;
  white-space: nowrap;
  z-index: 1;
}
.xterm .composition-view.active {
  display: block;
}
`;

/** The style elements a test installed, so a failed assertion does not leak them. */
const installed: HTMLStyleElement[] = [];

/**
 * @param css the sheet to install
 * @returns the style element
 */
function install(css: string): HTMLStyleElement {
  const style = installTerminalStyles(css, document);
  installed.push(style);

  return style;
}

/**
 * @param container the element the terminal painted into
 * @returns the computed position of the composition overlay
 */
function overlayPosition(container: HTMLElement): string {
  const overlay = container.querySelector(".composition-view");

  if (overlay === null) throw new Error("the terminal rendered no composition overlay");

  return getComputedStyle(overlay).position;
}

/**
 * @returns a container attached to the document, which xterm requires
 */
function mountPoint(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);

  return container;
}

beforeEach(() => {
  // jsdom does not implement `matchMedia`, and xterm asks it for the device pixel
  // ratio while opening. Without this stub `open` throws instead of mounting, so
  // the stub is what makes the rest of the file possible rather than a nicety.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  // Remove by id as well as by the tracked list: `createTerminalHost` installs a
  // sheet without going through the helper above, and a leaked sheet makes the
  // "installed into the document it was given" assertion pass for the wrong
  // reason on the next test that runs.
  for (const style of installed.splice(0)) style.remove();
  terminalStylesElement(document)?.remove();
  document.body.replaceChildren();
});

describe("stylesheet installation", () => {
  it("inserts one style element and reuses it on a second call", () => {
    // Two `<style>` elements with the same rules is not a rendering bug -- the
    // cascade resolves it the same way -- which is why it survives review and
    // grows with every remount instead.
    const first = install(MINIMAL_STYLESHEET);
    const second = install(MINIMAL_STYLESHEET);

    expect(second).toBe(first);
    expect(document.querySelectorAll(`#${first.id}`).length).toBe(1);
  });

  it("carries the sheet it was given, so an empty one cannot pass as installed", () => {
    const style = install(MINIMAL_STYLESHEET);

    expect(style.textContent).toContain(".composition-view");
  });

  it("exposes the installed element back to the caller", () => {
    const style = install(MINIMAL_STYLESHEET);

    expect(terminalStylesElement(document)).toBe(style);
  });

  it("returns null when no sheet is installed", () => {
    document.getElementById("haruyuki-ui-xterm")?.remove();

    expect(terminalStylesElement(document)).toBeNull();
  });

  it("rejects an empty sheet instead of installing it", () => {
    // The value a CSS loader returns for an import it does not understand. An
    // installed empty sheet is indistinguishable from no sheet at all, so it has
    // to fail where the mistake was made rather than where it shows up.
    expect(() => installTerminalStyles("", document)).toThrow(/empty stylesheet/);
    expect(() => installTerminalStyles("   \n\t ", document)).toThrow(/empty stylesheet/);
    expect(terminalStylesElement(document)).toBeNull();
  });

  it("rejects an empty sheet even when one is already installed", () => {
    // Otherwise the guard would be skipped by the idempotency path, and a caller
    // would be told its empty string was fine because a sheet already existed.
    install(MINIMAL_STYLESHEET);

    expect(() => installTerminalStyles("", document)).toThrow(/empty stylesheet/);
  });
});

describe("the stylesheet is load-bearing", () => {
  it("positions the composition overlay, and only does so once a sheet is present", () => {
    // The before/after pair. `open` succeeds on both sides of this assertion:
    // there is no error, no warning, and no difference in `cols`/`rows`. The
    // computed position is the whole difference.
    const container = mountPoint();
    const terminal = new Terminal({ cols: 40, rows: 10 });

    terminal.open(container);

    expect(overlayPosition(container)).toBe("static");

    install(MINIMAL_STYLESHEET);

    expect(overlayPosition(container)).toBe("absolute");

    terminal.dispose();
  });

  it("positions the overlay for a terminal opened after installation", () => {
    // The realistic order. Asserted too because a sheet that only affects an
    // already-open terminal would be a sheet applied by re-render, not by mount.
    install(MINIMAL_STYLESHEET);

    const container = mountPoint();
    const terminal = new Terminal({ cols: 40, rows: 10 });

    terminal.open(container);

    expect(overlayPosition(container)).toBe("absolute");

    terminal.dispose();
  });

  it("stops positioning the overlay when the sheet is removed", () => {
    // Proves the value comes from the sheet rather than from xterm's inline
    // style or a jsdom default, which is what a test that only checked the
    // installed state would happily accept.
    const style = install(MINIMAL_STYLESHEET);
    const container = mountPoint();
    const terminal = new Terminal({ cols: 40, rows: 10 });

    terminal.open(container);
    expect(overlayPosition(container)).toBe("absolute");

    style.remove();

    expect(overlayPosition(container)).toBe("static");

    terminal.dispose();
  });
});

describe("createTerminalHost", () => {
  it("installs the stylesheet before it mounts anything", () => {
    const container = mountPoint();
    const host = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });

    host.open(container);

    expect(overlayPosition(container)).toBe("absolute");

    host.dispose();
  });

  it("rejects an empty stylesheet without mounting a terminal", () => {
    // The half-mounted panel is the state worth avoiding: a caller that catches
    // this error must not be left holding a live terminal with no stylesheet.
    expect(() => createTerminalHost({ css: "", doc: document })).toThrow(/empty stylesheet/);
    expect(document.querySelectorAll(".terminal").length).toBe(0);
  });

  it("mounts one element into the container", () => {
    const container = mountPoint();
    const host = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });

    host.open(container);

    expect(container.querySelectorAll(".terminal").length).toBe(1);
    expect(host.isOpen).toBe(true);
    expect(host.terminal.element).toBeDefined();

    host.dispose();
  });

  it("ignores a second open on the same container", () => {
    // A React effect can run twice for the same node. Two live terminals in one
    // box is the failure this prevents; the no-op is what makes it possible to
    // write the effect without a guard of its own.
    const container = mountPoint();
    const host = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });

    host.open(container);
    host.open(container);

    expect(container.querySelectorAll(".terminal").length).toBe(1);

    host.dispose();
  });

  it("refuses to mount a second container while the first is live", () => {
    // Silently moving would strand a live terminal in the first container, with
    // nothing able to reach it from this host.
    const first = mountPoint();
    const second = mountPoint();
    const host = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });

    host.open(first);

    expect(() => host.open(second)).toThrow(/already mounted/);

    host.dispose();
  });

  it("releases the container and can dispose twice", () => {
    const container = mountPoint();
    const host = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });

    host.open(container);
    host.dispose();

    expect(host.isOpen).toBe(false);
    expect(container.querySelectorAll(".terminal").length).toBe(0);

    // Idempotent: a cleanup path that runs twice (unmount, then a host-side
    // teardown) must not throw, or the second path reports a failure that is not
    // one and hides whatever the first path did.
    host.dispose();
    expect(host.isOpen).toBe(false);
  });

  it("refuses to reopen a disposed host", () => {
    // `Terminal.open` after `dispose` does not throw; it silently mounts
    // nothing, so a reused host is a blank panel with no error in the log.
    const container = mountPoint();
    const host = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });

    host.open(container);
    host.dispose();

    expect(() => host.open(container)).toThrow(/disposed/);
    expect(container.querySelectorAll(".terminal").length).toBe(0);
  });

  it("does not leave a second instance behind across a remount", () => {
    // The property the whole package is named for. Asserted on the live instance
    // count in the document, because "a new host was built" is correct and "two
    // terminals are rendering" is not; only the DOM can tell them apart.
    const first = mountPoint();
    const firstHost = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });
    firstHost.open(first);
    const firstInstance = firstHost.terminal;

    firstHost.dispose();
    first.remove();

    const second = mountPoint();
    const secondHost = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });
    secondHost.open(second);

    expect(document.querySelectorAll(".terminal").length).toBe(1);
    expect(second.querySelectorAll(".terminal").length).toBe(1);
    expect(secondHost.terminal).not.toBe(firstInstance);

    secondHost.dispose();
  });

  it("keeps the stylesheet through a remount instead of installing a second copy", () => {
    // The two halves interfere: a host that installed its own sheet per mount
    // would pass the instance-count test above while growing the document.
    const firstHost = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });
    const first = mountPoint();
    firstHost.open(first);
    firstHost.dispose();
    first.remove();

    const secondHost = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });
    const second = mountPoint();
    secondHost.open(second);

    expect(document.querySelectorAll("#haruyuki-ui-xterm").length).toBe(1);

    secondHost.dispose();
  });

  it("installs into the document it was given rather than the ambient one", () => {
    // The host may render into a different document (a webview inside an editor),
    // and a sheet installed into the wrong one is invisible.
    const other = document.implementation.createHTMLDocument("other");

    const host = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: other });

    expect(terminalStylesElement(other)).not.toBeNull();
    expect(terminalStylesElement(document)).toBeNull();

    host.dispose();
  });

  it("reports no measurement before it is mounted", () => {
    // The engine asks for a size as soon as the panel exists, so this is not a
    // defensive branch: `fit()` reaches the parent box through internals that
    // are only built by `open`, and a `null` here is what stops a resize for an
    // unmounted panel from being sent as `cols: 0`.
    const host = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });

    expect(host.measure()).toBeNull();

    host.dispose();
  });

  it("reports no measurement after it is disposed", () => {
    // The observer is disconnected on the same tick as the unmount, but a
    // callback already queued still runs; a disposed host answering with a size
    // would resize a session that no longer has a panel.
    const container = mountPoint();
    const host = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });

    host.open(container);
    host.dispose();

    expect(host.measure()).toBeNull();
  });

  it("declines to measure a container with no layout", () => {
    // jsdom has no layout engine, so every box here is 0x0. That is the same
    // situation as a real window before first paint, and the point is what the
    // host does with it: `fit` would propose zero columns, and applying that
    // would ask the engine for a terminal with no columns at all. A `null`
    // answer is the difference between "could not measure" and "measured zero".
    const container = mountPoint();
    const host = createTerminalHost({ css: MINIMAL_STYLESHEET, doc: document });

    host.open(container);

    expect(host.measure()).toBeNull();
    // And the grid it already had is untouched -- a failed measurement must not
    // write anything onto the instance.
    expect(host.terminal.cols).toBe(80);
    expect(host.terminal.rows).toBe(24);

    host.dispose();
  });

  it("passes its own options to the terminal", () => {
    const host = createTerminalHost({
      css: MINIMAL_STYLESHEET,
      doc: document,
      cols: 100,
      rows: 30,
    });

    expect(host.terminal.cols).toBe(100);
    expect(host.terminal.rows).toBe(30);

    host.dispose();
  });
});
