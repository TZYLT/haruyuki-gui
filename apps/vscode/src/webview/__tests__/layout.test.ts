/** @vitest-environment jsdom */
/**
 * The first-run document.
 *
 * The point of these tests is the seam, not the numbers: the document has to be
 * something the shared frame can actually consume, so it is mapped through
 * `toDockview` rather than compared against a hand-written object. A document
 * that merely *looks* right and produces no grid would render an empty panel.
 */

import { describe, expect, it } from "vitest";
import type { LayoutNode, LayoutPanel } from "@haruyuki/protocol";
import { PAGE_IDS, toDockview } from "@haruyuki/ui";

import { applyLayoutChange, createDefaultLayout, readLayout } from "../layout.js";

/**
 * Every panel in reading order.
 *
 * @param node a document node
 * @returns the panels below it, this one included
 */
function panels(node: LayoutNode): LayoutPanel[] {
  if (node.type === "panel") return [node];

  return node.children.flatMap(panels);
}

describe("createDefaultLayout", () => {
  it("opens the three columns the webview is built around", () => {
    const doc = createDefaultLayout();

    expect(panels(doc.root).map((panel) => panel.id)).toEqual(["nav", "main", "tree"]);
    expect(doc.root).toMatchObject({ type: "split", orientation: "horizontal" });
    expect(doc.activePanelId).toBe("main");
  });

  it("uses only frozen page ids, each on exactly one tab", () => {
    const known = new Set<string>(PAGE_IDS);
    const tabs = panels(createDefaultLayout().root).flatMap((panel) => panel.tabs);

    expect(tabs).toHaveLength(3);

    for (const tab of tabs) {
      expect(known.has(tab.pageId)).toBe(true);
    }

    expect(tabs.map((tab) => tab.pageId)).toEqual(["nav", "conversation", "tree"]);
  });

  it("hides nothing: a first run has no closed page to carry forward", () => {
    const tabs = panels(createDefaultLayout().root).flatMap((panel) => panel.tabs);

    expect(tabs.filter((tab) => tab.hidden === true)).toEqual([]);
  });

  it("is consumable by the frame: three leaves, one per column, and no hidden tab", () => {
    const { serialized, hidden } = toDockview(createDefaultLayout(), { width: 1600, height: 900 });
    const root = serialized.grid.root;

    expect(hidden).toEqual([]);
    expect(root.type).toBe("branch");

    if (root.type !== "branch") throw new Error("the default layout must be a split");

    expect(root.data.map((node) => (node.type === "leaf" ? node.data.id : "branch"))).toEqual([
      "nav",
      "main",
      "tree",
    ]);
    expect(Object.keys(serialized.panels).sort()).toEqual(["conversation", "nav", "tree"]);
  });

  it("returns a fresh tree, so a caller cannot mutate the next caller's default", () => {
    const first = createDefaultLayout();
    const second = createDefaultLayout();

    expect(first).not.toBe(second);
    expect(first.root).not.toBe(second.root);
  });
});

describe("applyLayoutChange", () => {
  it("returns the document it was handed, so the frame can compare by identity", () => {
    const doc = createDefaultLayout();

    expect(applyLayoutChange(doc)).toBe(doc);
    expect(readLayout()).toBe(doc);
  });

  it("replaces the document instead of merging into it", () => {
    const closed = createDefaultLayout();
    const root = closed.root;

    if (root.type !== "split") throw new Error("the default layout must be a split");

    const first = root.children[0];

    if (first === undefined || first.type !== "panel") throw new Error("expected a panel");
    first.tabs = [];

    applyLayoutChange(closed);

    expect(readLayout()).toBe(closed);
    expect(panels(readLayout().root)[0]?.tabs).toEqual([]);
  });
});
