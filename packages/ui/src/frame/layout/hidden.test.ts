/**
 * Hidden-tab document surgery.
 *
 * The frame patches the document before it closes an unregistered page's panel,
 * so these tests pin the two properties that patch depends on: the tab survives
 * with `hidden: true`, and nothing else in the document moves.
 */

import { describe, expect, it } from "vitest";
import type { LayoutDoc } from "@haruyuki/protocol";

import { hiddenTabCount, hideTab } from "./hidden.js";

/** @returns a document with a left rail, a main panel and a hidden tab already in it */
function doc(): LayoutDoc {
  return {
    version: 1,
    root: {
      type: "split",
      orientation: "horizontal",
      children: [
        {
          type: "panel",
          id: "nav",
          tabs: [{ tabId: "nav", pageId: "nav" }],
        },
        {
          type: "panel",
          id: "main",
          tabs: [
            { tabId: "conversation", pageId: "conversation" },
            { tabId: "mystery", pageId: "mystery" },
          ],
          activeTabId: "conversation",
        },
      ],
    },
    activePanelId: "main",
  };
}

describe("hideTab", () => {
  it("marks the tab hidden and leaves every other tab in place", () => {
    const next = hideTab(doc(), "mystery");

    expect(next).not.toBeNull();
    const root = next?.root;

    expect(root?.type).toBe("split");

    if (root?.type !== "split") return;

    const main = root.children[1];

    expect(main?.type).toBe("panel");

    if (main?.type !== "panel") return;

    expect(main.tabs).toEqual([
      { tabId: "conversation", pageId: "conversation" },
      { tabId: "mystery", pageId: "mystery", hidden: true },
    ]);
    expect(main.activeTabId).toBe("conversation");
  });

  it("shares the untouched subtrees instead of cloning the document", () => {
    const before = doc();
    const next = hideTab(before, "mystery");

    expect(next).not.toBe(before);

    if (next?.root.type !== "split" || before.root.type !== "split") return;

    // The left rail is unrelated, so the same node object should come back.
    expect(next.root.children[0]).toBe(before.root.children[0]);
  });

  it("returns null when the tab is absent or already hidden", () => {
    expect(hideTab(doc(), "nope")).toBeNull();

    const hidden = hideTab(doc(), "mystery");

    expect(hidden).not.toBeNull();
    expect(hideTab(hidden as LayoutDoc, "mystery")).toBeNull();
  });
});

describe("hiddenTabCount", () => {
  it("counts hidden tabs across the whole tree", () => {
    expect(hiddenTabCount(doc())).toBe(0);

    const next = hideTab(doc(), "mystery");

    expect(hiddenTabCount(next as LayoutDoc)).toBe(1);
  });
});
