/**
 * The renderer's first-run document.
 *
 * The main process owns the authoritative copy and sends it through
 * `layout.snapshot`/`layout.state`; this constant only fills the first paint, so
 * the frame has three panels before the bridge answers. The ids match the layout contract.
 */

import type { LayoutDoc } from "@haruyuki/protocol";

export const DEFAULT_LAYOUT: LayoutDoc = {
  version: 1,
  activePanelId: "main",
  root: {
    type: "split",
    orientation: "horizontal",
    sizes: [0.2, 0.6, 0.2],
    children: [
      { type: "panel", id: "nav", tabs: [{ tabId: "nav", pageId: "nav" }], activeTabId: "nav" },
      {
        type: "panel",
        id: "main",
        tabs: [{ tabId: "conversation", pageId: "conversation" }],
        activeTabId: "conversation",
      },
      { type: "panel", id: "tree", tabs: [{ tabId: "tree", pageId: "tree" }], activeTabId: "tree" },
    ],
  },
};
