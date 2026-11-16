/**
 * Unknown-tab preservation on save , against the sections 4.3.3-4.3.5 and
 * 4.3.9; docs/35 section 4.3, invariant INV-19).
 *
 * The problem this module solves
 *   The renderer only knows the pages it can render, so when it round-trips a
 *   document it may drop a tab whose page this build does not have -- an
 *   extension was disabled, or the document came from a newer build. Saving
 *   that document unchanged would silently delete the user's tab, and a later
 *   build would never get it back. So the store validates the incoming document
 *   and then lets this module put every unknown tab that went missing back.
 *
 * Where a tab goes back to
 *   First choice is where it was: the same panel id, at the same index (clamped
 *   to the panel's current length, because the rest of the panel may have
 *   changed). When that panel no longer exists -- the user closed the panel
 *   that held it, or the renderer collapsed the split -- the tab has no home in
 *   the incoming tree, so a *recovery panel* is created: the smallest free
 *   `recovered-<n>` id, appended as a new child of the root. Recovered tabs go
 *   into it in scan order, because an original index says nothing about a panel
 *   that did not contain them. Appending rather than prepending keeps the
 *   user's existing panels where they are; a root panel is wrapped in a
 *   horizontal split so the document still has a root node of the expected
 *   shape.
 *
 * Why the whole document is JSON-cloned
 *   `mergeUnknownTabs` must not mutate either argument: the caller keeps the
 *   current authoritative document until the save succeeds. The clone is also
 *   what preserves unknown keys at every level (invariant I-3): nothing is
 *   rebuilt from known fields, only the tabs array of the target panel is
 *   touched. The document is JSON by contract (the validator refuses anything
 *   else), so a JSON round trip is the exact copy the store is going to write.
 *
 * Hidden is preserved, never interpreted
 *   A hidden unknown tab (`hidden: true`) is an unknown panel the user closed.
 *   It is still part of the document and is still restored if the renderer
 *   drops it; this module has no opinion beyond copying
 *   the flag, `props`, `extras` and any key it has never seen.
 *
 * Collect order
 *   `collectUnknownTabs` walks the tree depth-first and yields tabs in document
 *   order, so a caller that displays or logs the list sees the same order the
 *   renderer does, and merge reinsertion is deterministic.
 */

import type {
  LayoutDoc,
  LayoutNode,
  LayoutPanel,
  LayoutSplit,
  LayoutTab,
} from "@haruyuki/protocol";

/** One unknown tab: the tab itself, the panel it lives in, and its index. */
export type UnknownTabRef = {
  /** The tab as it appears in the scanned document; not a copy. */
  tab: LayoutTab;
  /** The id of the panel that contained it. */
  panelId: string;
  /** Its index in that panel's `tabs` array. */
  index: number;
};

/** A JSON deep copy: the document is JSON by contract (see the header). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Visit every panel in document (depth-first) order. */
function forEachPanel(node: LayoutNode, visit: (panel: LayoutPanel) => void): void {
  if (node.type === "panel") {
    visit(node);
    return;
  }

  for (const child of node.children) {
    forEachPanel(child, visit);
  }
}

/** Panel ids are unique in a validated document; first wins regardless. */
function indexPanels(doc: LayoutDoc): Map<string, LayoutPanel> {
  const index = new Map<string, LayoutPanel>();

  forEachPanel(doc.root, (panel) => {
    if (!index.has(panel.id)) {
      index.set(panel.id, panel);
    }
  });

  return index;
}

/** Every tab id in the document, so a restore never makes a duplicate. */
function collectTabIds(doc: LayoutDoc): Set<string> {
  const ids = new Set<string>();

  forEachPanel(doc.root, (panel) => {
    for (const tab of panel.tabs) {
      ids.add(tab.tabId);
    }
  });

  return ids;
}

/**
 * The unknown tabs of `doc`, in document order, hidden ones included.
 *
 * This is the scan half of preservation: the store runs it over the
 * document it just read (often a corrupt-but-parseable one being replaced by
 * the default) to find what has to be preserved. `knownPageIds` is the caller's
 * registry; a `pageId` missing from it is unknown, never an error.
 */
export function collectUnknownTabs(
  doc: LayoutDoc,
  knownPageIds: ReadonlySet<string>,
): UnknownTabRef[] {
  const unknown: UnknownTabRef[] = [];

  forEachPanel(doc.root, (panel) => {
    panel.tabs.forEach((tab, index) => {
      if (!knownPageIds.has(tab.pageId)) {
        unknown.push({ tab, panelId: panel.id, index });
      }
    });
  });

  return unknown;
}

/**
 * Put back every unknown tab of `current` that `next` dropped.
 *
 * Returns a new document; neither argument is mutated. A tab is identified by
 * `tabId`, so an unknown tab the incoming document still has is left exactly
 * where the renderer chose to put it -- the user may have moved or hidden it,
 * and that is a legitimate change. Only a tab that disappeared comes back.
 *
 * @param current the authoritative document before the save
 * @param next the validated candidate document from the renderer
 * @param knownPageIds the caller's page registry, used to find the unknown tabs
 */
export function mergeUnknownTabs(
  current: LayoutDoc,
  next: LayoutDoc,
  knownPageIds: ReadonlySet<string>,
): LayoutDoc {
  const merged = cloneJson(next);
  const panels = indexPanels(merged);
  const tabIds = collectTabIds(merged);

  /** The recovery panel for this merge, created on the first orphan. */
  let recovery: LayoutPanel | null = null;

  for (const { tab, panelId, index } of collectUnknownTabs(current, knownPageIds)) {
    if (tabIds.has(tab.tabId)) {
      continue;
    }

    const original = panels.get(panelId);
    let target: LayoutPanel;
    let at: number;

    if (original === undefined) {
      recovery ??= createRecoveryPanel(merged);
      target = recovery;
      // The original index is meaningless in a panel that did not exist there;
      // appended in scan order, the recovered tabs keep document order.
      at = target.tabs.length;
    } else {
      target = original;
      at = Math.max(0, Math.min(index, target.tabs.length));
    }

    target.tabs.splice(at, 0, cloneJson(tab));
    tabIds.add(tab.tabId);
  }

  return merged;
}

/**
 * Append a recovery panel to the root and return it.
 *
 * A panel root is wrapped in a horizontal split with equal sizes, which keeps
 * the document valid (a root split needs at least two children) and gives the
 * recovered tabs a visible half. A split root gets one more child; when the
 * split carries `sizes`, the new child receives the current average weight and
 * the whole array is normalized back to 1 so the renderer's proportion math
 * keeps working.
 */
function createRecoveryPanel(doc: LayoutDoc): LayoutPanel {
  const panel: LayoutPanel = {
    type: "panel",
    id: nextRecoveryPanelId(doc),
    tabs: [],
  };

  if (doc.root.type === "panel") {
    const root: LayoutNode = doc.root;

    doc.root = {
      type: "split",
      orientation: "horizontal",
      children: [root, panel],
      sizes: [0.5, 0.5],
    };

    return panel;
  }

  const split: LayoutSplit = doc.root;

  split.children.push(panel);

  if (split.sizes !== undefined) {
    const weights = [...split.sizes];

    weights.push(
      weights.length === 0 ? 1 : weights.reduce((sum, weight) => sum + weight, 0) / weights.length,
    );

    const total = weights.reduce((sum, weight) => sum + weight, 0);

    split.sizes = weights.map((weight) => weight / total);
  }

  return panel;
}

/** The smallest `recovered-<n>` id that the document does not already use. */
function nextRecoveryPanelId(doc: LayoutDoc): string {
  const used = new Set<string>();

  forEachPanel(doc.root, (panel) => {
    used.add(panel.id);
  });

  let counter = 1;

  while (used.has(`recovered-${String(counter)}`)) {
    counter += 1;
  }

  return `recovered-${String(counter)}`;
}
