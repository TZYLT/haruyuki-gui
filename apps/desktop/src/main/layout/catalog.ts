/**
 * The shell's page catalogue and first-run layout.
 *
 * The renderer owns the page implementations; the main process needs only the
 * ids, because C4 has to tell "unknown page" from "invalid document" before a
 * renderer exists. Keeping the list here means a layout written by an older
 * build still resolves its ids on the next start; the values are frozen in
 * `@haruyuki/protocol`, so this is a copy of a contract, not a second source of
 * truth.
 *
 * The default document is the first-run three-column arrangement: navigation
 * on the left, conversation in the main area, file tree on the right. It is
 * deliberately small -- a user's first drag is what makes it theirs.
 */

import { LAYOUT_DOC_VERSION } from "@haruyuki/protocol";
import type { LayoutDoc } from "@haruyuki/protocol";

/** Every page id the layout contract defines, including pages the default layout omits. */
export const PAGE_IDS: ReadonlySet<string> = new Set([
  "nav",
  "conversation",
  "memory",
  "tree",
  "viewer",
  "context",
  "concurrency",
  "terminal",
  "settings",
  "topics",
]);

/** The first-run layout: nav | conversation | tree. */
export const DEFAULT_LAYOUT: LayoutDoc = {
  version: LAYOUT_DOC_VERSION,
  activePanelId: "main",
  root: {
    type: "split",
    orientation: "horizontal",
    sizes: [0.2, 0.6, 0.2],
    children: [
      {
        type: "panel",
        id: "nav",
        tabs: [{ tabId: "nav", pageId: "nav" }],
        activeTabId: "nav",
      },
      {
        type: "panel",
        id: "main",
        tabs: [{ tabId: "conversation", pageId: "conversation" }],
        activeTabId: "conversation",
      },
      {
        type: "panel",
        id: "tree",
        tabs: [{ tabId: "tree", pageId: "tree" }],
        activeTabId: "tree",
      },
    ],
  },
};
