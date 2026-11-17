/**
 * Tests for the stylesheet module, whose value is environment-dependent.
 *
 * What this file can and cannot prove
 *   Under vitest, `?raw` resolves to the empty string. So the only fact this file
 *   can establish is the empty case -- and it establishes it in the form that
 *   matters: the value is empty *and* the host refuses it. That pairing is the
 *   whole safety story for a test environment. A test that asserted "the
 *   stylesheet is non-empty" would fail here and pass in the build, which is the
 *   direction that teaches nobody anything.
 *
 *   The real value cannot be checked from here. It is checked by
 *   `apps/desktop/scripts/terminal-probe.mjs`, which reads the same file through
 *   `require.resolve` and lives outside the renderer's constraints. That split is
 *   stated in the module under test as well, because a reader of one file is not
 *   obliged to read the other.
 *
 * Why the empty assertion is written as a measurement rather than an expectation
 *   If a future change made `?raw` work under vitest -- a config change, a plugin,
 *   a vitest upgrade -- this file should fail rather than silently start passing
 *   for a different reason. The failure message says which environment assumption
 *   moved.
 */

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { createTerminalHost } from "./host.js";
import { hasTerminalStylesheet, TERMINAL_STYLESHEET } from "./stylesheet.js";

describe("the stylesheet as vitest sees it", () => {
  it("is the empty string, because `?raw` is a bundler feature and vitest is not that bundler", () => {
    // The measurement this package already records for `?inline` in
    // `tokens/theme.ts`. Written as an equality rather than a truthiness check so
    // the failure says "the environment changed" instead of "something is wrong".
    expect(TERMINAL_STYLESHEET).toBe("");
  });

  it("reports itself as not inlined, so a host asks the shell instead of mounting with nothing", () => {
    expect(hasTerminalStylesheet()).toBe(false);
  });

  it("is rejected by the host at construction, because an empty sheet renders a terminal that looks right and is not", () => {
    // The failure the guard exists for: xterm constructs, opens, loads an addon and
    // measures correctly with no stylesheet, and the composition overlay lands in
    // the document flow. Nothing throws. So the refusal has to happen here.
    // A plain `Error`, not a `RangeError`: the host states that in its own
    // contract, and asserting a subclass here would break the day it is tightened
    // to one -- which is a change of severity, not of behaviour.
    expect(() => createTerminalHost({ css: TERMINAL_STYLESHEET })).toThrow(/empty stylesheet/);
  });

  it("accepts a sheet that arrived some other way, because the host is not the one that inlined it", () => {
    // The shell may read `xterm.css` itself and pass the text; that path must keep
    // working, or the only way to mount a terminal would be this module.
    const host = createTerminalHost({ css: ".xterm-screen { position: relative; }" });

    expect(host.isOpen).toBe(false);
  });
});
