/**
 * Hidden-tab document surgery.
 *
 * A tab the user closes because this build cannot render it is not deleted: the
 * layout document keeps it with `hidden: true` so a later build that registers
 * the page shows it again (`59` section 4.4, `60` section 3.4). Dockview has no
 * "hidden tab", so the frame has to push that bit into the document itself, and
 * `toLayoutDoc` needs the document it is merging against to *already* carry the
 * flag -- otherwise the tab is simply gone from the next save.
 *
 * Keeping the edit a pure function here rather than inline in `AppFrame` means
 * the rule can be tested without a dock, and the frame keeps reading as
 * orchestration instead of tree surgery.
 */

import type { LayoutDoc, LayoutNode } from "@haruyuki/protocol";

/** Accumulator threaded through one walk; a box because the walk is recursive. */
interface Found {
  matched: boolean;
}

/**
 * Mark one tab hidden, leaving every other tab and panel untouched.
 *
 * @param node the node to rewrite
 * @param tabId the tab to hide
 * @param found set when the tab was present and visible
 * @returns the rewritten node, sharing the untouched subtrees
 */
function hideInNode(node: LayoutNode, tabId: string, found: Found): LayoutNode {
  if (node.type === "panel") {
    const target = node.tabs.find((tab) => tab.tabId === tabId);

    if (target === undefined || target.hidden === true) return node;

    found.matched = true;

    return {
      ...node,
      tabs: node.tabs.map((tab) => (tab.tabId === tabId ? { ...tab, hidden: true } : tab)),
    };
  }

  return { ...node, children: node.children.map((child) => hideInNode(child, tabId, found)) };
}

/**
 * Mark a tab hidden in the document.
 *
 * @param doc the document the frame last applied
 * @param tabId the tab to hide
 * @returns a document with `hidden: true` on that tab, or `null` when the tab is
 *   not in the document (an instance that was never saved, for example)
 */
export function hideTab(doc: LayoutDoc, tabId: string): LayoutDoc | null {
  const found: Found = { matched: false };
  const root = hideInNode(doc.root, tabId, found);

  return found.matched ? { ...doc, root } : null;
}

/**
 * Count the tabs the document is keeping hidden.
 *
 * The frame shows a banner for these: a hidden tab has no other on-screen trace,
 * and a user who sees a page vanish deserves to know it is recoverable.
 *
 * @param doc a layout document
 * @returns how many tabs carry `hidden: true`
 */
export function hiddenTabCount(doc: LayoutDoc): number {
  let total = 0;

  const visit = (node: LayoutNode): void => {
    if (node.type === "panel") {
      for (const tab of node.tabs) {
        if (tab.hidden === true) total += 1;
      }

      return;
    }

    for (const child of node.children) visit(child);
  };

  visit(doc.root);

  return total;
}

/**
 * Reset to a document while carrying forward tabs the current build cannot own.
 *
 * "Reset layout" returns the user to the default arrangement, but it must not
 * delete an unknown page's data or a tab the user closed as unknown: those tabs
 * are the only record that the page existed. They are appended to the first
 * panel of the default document; `hidden` stays as it was.
 *
 * @param next the fresh document
 * @param previous the document being replaced
 * @param isUnknown whether a page id is unknown to this build
 * @returns `next` with the preserved tabs appended, or `next` unchanged
 */
export function preserveResetTabs(
  next: LayoutDoc,
  previous: LayoutDoc,
  isUnknown: (pageId: string) => boolean,
): LayoutDoc {
  const preserved = new Map<string, { tabId: string; pageId: string; hidden?: boolean }>();

  const visit = (node: LayoutNode): void => {
    if (node.type === "panel") {
      for (const tab of node.tabs) {
        if (tab.hidden === true || isUnknown(tab.pageId)) {
          preserved.set(tab.tabId, {
            tabId: tab.tabId,
            pageId: tab.pageId,
            ...(tab.hidden === true ? { hidden: true } : {}),
          });
        }
      }

      return;
    }

    for (const child of node.children) visit(child);
  };

  visit(previous.root);

  if (preserved.size === 0) return next;

  const append = (node: LayoutNode): LayoutNode => {
    if (node.type === "panel") {
      const known = new Set(node.tabs.map((tab) => tab.tabId));
      const additions = [...preserved.values()].filter((tab) => !known.has(tab.tabId));

      return additions.length === 0 ? node : { ...node, tabs: [...node.tabs, ...additions] };
    }

    let done = false;
    const children = node.children.map((child) => {
      if (done) return child;

      const result = append(child);
      done = JSON.stringify(result) !== JSON.stringify(child);

      return result;
    });

    return { ...node, children };
  };

  return { ...next, root: append(next.root) };
}
