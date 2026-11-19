/**
 * Swap the two side panels without touching their tabs.
 *
 * A side swap is a position change, not a page move: the left group keeps its id
 * and receives the right group's tabs, and the right group receives the left's.
 * Keeping the ids stable means dockview's group identity (and the `activeGroup`
 * in the document) survives the swap.
 */

import type { LayoutDoc, LayoutNode, LayoutPanel } from "@haruyuki/protocol";

import type { PageRegistry } from "../types.js";

/** @param node a document node @param visit called for every panel */
function walk(node: LayoutNode, visit: (panel: LayoutPanel) => void): void {
  if (node.type === "panel") {
    visit(node);
    return;
  }

  for (const child of node.children) walk(child, visit);
}

/** @param panel a panel @param registry the page registry @returns its side, if any tab names one */
function sideOf(panel: LayoutPanel, registry: PageRegistry): "left" | "right" | null {
  for (const tab of panel.tabs) {
    const side = registry.get(tab.pageId)?.defaultSide;

    if (side === "left" || side === "right") return side;
  }

  return null;
}

/**
 * Swap the first left-side panel with the first right-side panel.
 *
 * @param doc the current document
 * @param registry page definitions, used to find the side of a panel
 * @returns a new document, or null when there is nothing to swap
 */
export function swapSidePanels(doc: LayoutDoc, registry: PageRegistry): LayoutDoc | null {
  let left: LayoutPanel | null = null;
  let right: LayoutPanel | null = null;

  walk(doc.root, (panel) => {
    const side = sideOf(panel, registry);

    if (side === "left" && left === null) left = panel;
    if (side === "right" && right === null) right = panel;
  });

  if (left === null || right === null) return null;

  const leftPanel: LayoutPanel = left;
  const rightPanel: LayoutPanel = right;

  const replace = (node: LayoutNode): LayoutNode => {
    if (node.type === "panel") {
      if (node.id === leftPanel.id) {
        return { ...rightPanel, id: leftPanel.id };
      }

      if (node.id === rightPanel.id) {
        return { ...leftPanel, id: rightPanel.id };
      }

      return node;
    }

    return { ...node, children: node.children.map(replace) };
  };

  return { ...doc, root: replace(doc.root) };
}
