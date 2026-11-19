import { describe, expect, it } from "vitest";
import type { LayoutDoc } from "@haruyuki/protocol";

import { createPageRegistry } from "../registry.js";
import { conversationPage, navPage, treePage } from "../pages/index.js";
import { swapSidePanels } from "./sides.js";

/** @returns the sample registry */
function registry() {
  const result = createPageRegistry();
  result.register(navPage);
  result.register(conversationPage);
  result.register(treePage);

  return result;
}

const doc: LayoutDoc = {
  version: 1,
  root: {
    type: "split",
    orientation: "horizontal",
    children: [
      { type: "panel", id: "left", tabs: [{ tabId: "nav", pageId: "nav" }] },
      { type: "panel", id: "main", tabs: [{ tabId: "conversation", pageId: "conversation" }] },
      { type: "panel", id: "right", tabs: [{ tabId: "tree", pageId: "tree" }] },
    ],
  },
};

describe("swapSidePanels", () => {
  it("swaps the tabs of the left and right groups and keeps their ids", () => {
    const next = swapSidePanels(doc, registry());

    expect(next).not.toBeNull();
    const root = next?.root;

    expect(root?.type).toBe("split");
    if (root?.type !== "split") return;

    expect(root.children[0]).toMatchObject({ id: "left", tabs: [{ pageId: "tree" }] });
    expect(root.children[2]).toMatchObject({ id: "right", tabs: [{ pageId: "nav" }] });
  });

  it("returns null when a side has no page", () => {
    const onlyMain: LayoutDoc = {
      version: 1,
      root: { type: "panel", id: "main", tabs: [{ tabId: "c", pageId: "conversation" }] },
    };

    expect(swapSidePanels(onlyMain, registry())).toBeNull();
  });
});
