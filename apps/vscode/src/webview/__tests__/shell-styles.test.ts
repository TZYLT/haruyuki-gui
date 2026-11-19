/** @vitest-environment jsdom */
/**
 * The shell stylesheet the webview needs, checked as a contract.
 *
 * jsdom does not lay anything out, so there is no assertion in this file that
 * could watch the dock gain its height. What can be checked is the rule that
 * gives the document a height in the first place: the frame is a `flex: 1 1
 * auto` item, so a root with no height collapses it to its content, and the
 * symptom of that is specific -- the side rails, which draw tabs, stay visible
 * while the dock area is zero high and its pages never appear.
 *
 * A source assertion is the honest level here. It fails the moment the rule is
 * deleted, which is the failure this file exists to catch.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const STYLESHEET = path.join(import.meta.dirname, "..", "shell.css");

/** The rules, whitespace-collapsed so the assertions survive reformatting. */
function rules(): string {
  return readFileSync(STYLESHEET, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ");
}

describe("the shell stylesheet", () => {
  it("gives the root the full height the frame expects to inherit", () => {
    const css = rules();

    expect(css).toContain("#root { display: flex; flex-direction: column; height: 100%;");
  });

  it("takes the document's height from the window, not from its content", () => {
    const css = rules();

    expect(css).toContain("html, body { height: 100%;");
  });

  it("sets no colour of its own, because the palette is the tokens'", () => {
    const css = rules();

    // A colour here would be a second palette that the theme switch cannot
    // reach: the frame maps every surface through dockview's variables.
    expect(css).not.toMatch(/(?:^|[ ;])color:/);
    expect(css).not.toMatch(/background(?:-color)?:/);
  });
});
