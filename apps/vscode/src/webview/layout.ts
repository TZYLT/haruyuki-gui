/**
 * The webview's in-memory layout document.
 *
 * The panel keeps the document for the lifetime of one webview only: a reload
 * of the panel is a first run again, and the three-column default comes back.
 * Persistence is deliberately not part of this module -- the shell that reads
 * and writes the document on the extension side is a later work package, and a
 * half-wired save path here would make a reload restore a layout nobody wrote
 * on purpose.
 *
 * The shape is the frozen protocol document, not a local view model: the frame
 * maps it to dockview's grid through the shared UI layer, so a shell-side
 * document and this first-run document are the same thing by construction.
 * `toDockview` is authoritative about what it can consume, and the test next to
 * this file maps this document through it rather than trusting the shape.
 */

import type { LayoutDoc, LayoutPanel } from "@haruyuki/protocol";
import type { PageId } from "@haruyuki/ui";

/**
 * Page ids this document opens, typed against the frozen catalogue so a typo is
 * a compile error instead of an unknown page at runtime.
 */
const NAV_PAGE: PageId = "nav";
const CONVERSATION_PAGE: PageId = "conversation";
const TREE_PAGE: PageId = "tree";

/** Panel ids are local to this document and never cross a wire. */
const NAV_PANEL = "nav";
const MAIN_PANEL = "main";
const TREE_PANEL = "tree";

/** The three columns: a narrow left rail, the main area, a narrow right rail. */
const SIDE_SHARE = 0.2;
const MAIN_SHARE = 0.6;

/**
 * One panel holding one tab.
 *
 * The tab id and the page id are equal because there is exactly one instance of
 * each page here; the two diverge only when a page is opened twice.
 *
 * @param id the panel id
 * @param pageId the page the tab renders
 * @returns a panel node
 */
function singleTabPanel(id: string, pageId: PageId): LayoutPanel {
  return {
    type: "panel",
    id,
    tabs: [{ tabId: pageId, pageId }],
    activeTabId: pageId,
  };
}

/**
 * Build the first-run document.
 *
 * A fresh object on every call: the document is owned by the caller and mutated
 * only through `applyLayoutChange`, so two callers must never share one tree.
 *
 * @returns a three-column layout document
 */
export function createDefaultLayout(): LayoutDoc {
  return {
    version: 1,
    activePanelId: MAIN_PANEL,
    root: {
      type: "split",
      orientation: "horizontal",
      sizes: [SIDE_SHARE, MAIN_SHARE, SIDE_SHARE],
      children: [
        singleTabPanel(NAV_PANEL, NAV_PAGE),
        singleTabPanel(MAIN_PANEL, CONVERSATION_PAGE),
        singleTabPanel(TREE_PANEL, TREE_PAGE),
      ],
    },
  };
}

/** The document this panel is showing; `null` until something applied one. */
let current: LayoutDoc | null = null;

/**
 * The document to render now.
 *
 * Falls back to the default until the first change arrives, so a mount that
 * renders before any layout exists still shows a product and not an empty dock.
 *
 * @returns the current in-memory document
 */
export function readLayout(): LayoutDoc {
  current ??= createDefaultLayout();

  return current;
}

/**
 * Record a document the frame produced.
 *
 * Memory only, and the identity is kept: the frame compares the document it was
 * handed against the one it applied, so returning a copy would make every save
 * look like a foreign document and rebuild the grid.
 *
 * @param doc the document from `onLayoutChange`
 * @returns the same document, for the caller's state update
 */
export function applyLayoutChange(doc: LayoutDoc): LayoutDoc {
  current = doc;

  return doc;
}
