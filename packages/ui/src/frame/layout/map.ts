/**
 * The bridge between the layout document and dockview's serialized grid.
 *
 * The layout store owns the document; dockview owns the pixels. This module is the only place
 * that knows both shapes, so a dockview upgrade or a document field changes
 * here rather than in the frame host or the store.
 *
 * The two shapes disagree in one important way: a layout document can nest a
 * split of either orientation, while dockview alternates orientation by depth
 * (a horizontal root has vertical children, and so on). Documents produced by
 * dockview already alternate; a document that repeats an orientation is
 * flattened into its parent, which keeps the reading order and the sizes.
 *
 * Hidden tabs are not sent to dockview: a hidden tab is a closed unknown page
 * that must survive a save, not a tab the user can see. They are merged back
 * from the previous document, including an empty panel node, because the layout store refuses
 * to drop a panel the user closed rather than deleted.
 */

import type { LayoutDoc, LayoutNode, LayoutPanel, LayoutTab } from "@haruyuki/protocol";

/** A grid leaf as dockview serializes it (structurally, so this module needs no dockview import). */
export type SerializedLeaf = {
  type: "leaf";
  data: { id: string; views: string[]; activeView?: string };
  size?: number;
};

/** A grid branch as dockview serializes it. */
export type SerializedBranch = {
  type: "branch";
  data: SerializedNode[];
  size?: number;
};

/** One serialized grid node. */
export type SerializedNode = SerializedLeaf | SerializedBranch;

/** The subset of `SerializedDockview` this module reads and writes. */
export type SerializedLayout = {
  grid: {
    root: SerializedNode;
    width: number;
    height: number;
    orientation: "HORIZONTAL" | "VERTICAL";
  };
  panels: Record<
    string,
    { id?: string; contentComponent?: string; params?: Record<string, unknown> }
  >;
  activeGroup?: string;
};

/** A tab that is present in the document but absent from the dockview grid. */
export interface HiddenTab {
  readonly panelId: string;
  readonly tab: LayoutTab;
}

/** What `toDockview` returns: the grid plus the tabs it deliberately left out. */
export interface DockviewLayout {
  readonly serialized: SerializedLayout;
  readonly hidden: HiddenTab[];
}

/** Grid sizes are relative pixels; a document only has fractions. */
const GRID_SIZE = 1000;

/** @param orientation a grid orientation @returns the opposite orientation */
function orthogonal(orientation: "HORIZONTAL" | "VERTICAL"): "HORIZONTAL" | "VERTICAL" {
  return orientation === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL";
}

/** @param node any layout node @returns whether it is a split */
function isSplit(node: LayoutNode): node is Extract<LayoutNode, { type: "split" }> {
  return node.type === "split";
}

/**
 * Build one grid node, flattening a repeated orientation into its parent.
 *
 * @param node the document node
 * @param orientation the orientation this depth must have
 * @param extent the pixel extent of the parent's main axis
 * @returns the serialized node
 */
function toGridNode(
  node: LayoutNode,
  orientation: "HORIZONTAL" | "VERTICAL",
  extent: number,
): SerializedNode {
  if (node.type === "panel") {
    return {
      type: "leaf",
      data: {
        id: node.id,
        views: node.tabs.filter((tab) => tab.hidden !== true).map((tab) => tab.tabId),
        ...(node.activeTabId === undefined ? {} : { activeView: node.activeTabId }),
      },
      size: extent,
    };
  }

  if (node.orientation === orientation.toLowerCase()) {
    const sizes = node.sizes ?? node.children.map(() => 1 / node.children.length);
    const children = node.children.flatMap((child, index) => {
      const childExtent = extent * (sizes[index] ?? 0);

      if (isSplit(child) && child.orientation.toLowerCase() === orientation.toLowerCase()) {
        return child.children.map((grandchild) =>
          toGridNode(grandchild, orthogonal(orientation), childExtent),
        );
      }

      return [toGridNode(child, orthogonal(orientation), childExtent)];
    });

    return { type: "branch", data: children, size: extent };
  }

  // A split whose orientation disagrees with its depth cannot be represented
  // directly. Recurse as the expected orientation; the parent flattens it.
  return {
    type: "branch",
    data: node.children.map((child) =>
      toGridNode(child, orthogonal(orientation), extent / node.children.length),
    ),
    size: extent,
  };
}

/** @param doc the layout document @param size the current grid extent @returns the grid and hidden tabs */
export function toDockview(
  doc: LayoutDoc,
  size: { width: number; height: number },
): DockviewLayout {
  const orientation: "HORIZONTAL" | "VERTICAL" =
    doc.root.type === "split"
      ? (doc.root.orientation.toUpperCase() as "HORIZONTAL" | "VERTICAL")
      : "HORIZONTAL";
  const extent = orientation === "HORIZONTAL" ? size.width : size.height;
  const root = toGridNode(doc.root, orientation, extent);
  const panels: Record<string, Record<string, unknown>> = {};
  const hidden: HiddenTab[] = [];

  const visit = (node: LayoutNode, panelId: string): void => {
    if (node.type === "panel") {
      for (const tab of node.tabs) {
        if (tab.hidden === true) {
          hidden.push({ panelId: node.id, tab });
          continue;
        }

        panels[tab.tabId] = {
          id: tab.tabId,
          contentComponent: "__page__",
          params: { pageId: tab.pageId, ...(tab.props ?? {}) },
        };
      }

      return;
    }

    for (const child of node.children) visit(child, panelId);
  };

  visit(doc.root, "");

  const serialized: SerializedLayout = {
    grid: {
      root,
      width: size.width,
      height: size.height,
      orientation,
    },
    panels,
    ...(doc.activePanelId === undefined ? {} : { activeGroup: doc.activePanelId }),
  };

  return { serialized, hidden };
}

/** @param node a grid node @returns whether it is a branch */
function isBranch(node: SerializedNode): node is Extract<SerializedNode, { type: "branch" }> {
  return node.type === "branch";
}

/**
 * Convert one grid node back into a document node.
 *
 * @param node the grid node
 * @param orientation the orientation this depth must have
 * @param panels the serialized panel state table
 * @returns the layout node
 */
function toDocNode(
  node: SerializedNode,
  orientation: "HORIZONTAL" | "VERTICAL",
  panels: SerializedLayout["panels"],
): LayoutNode {
  if (!isBranch(node)) {
    const views: string[] = Array.isArray(node.data) ? [] : node.data.views;
    const activeView: string | undefined = Array.isArray(node.data)
      ? undefined
      : node.data.activeView;
    const id: string = Array.isArray(node.data) ? "group" : node.data.id;
    const tabs: LayoutTab[] = views.map((tabId) => {
      const panel = panels[tabId] as Record<string, unknown> | undefined;
      const params = panel?.["params"] as Record<string, unknown> | undefined;
      const pageId = typeof params?.["pageId"] === "string" ? params["pageId"] : tabId;
      const props = { ...(params ?? {}) };
      delete props["pageId"];

      return {
        tabId,
        pageId,
        ...(Object.keys(props).length === 0 ? {} : { props }),
      };
    });

    const panel: LayoutPanel = { type: "panel", id, tabs };

    if (activeView !== undefined) panel.activeTabId = activeView;

    return panel;
  }

  const children = (node.data as SerializedNode[]).map((child) =>
    toDocNode(child, orthogonal(orientation), panels),
  );
  const sizes = (node.data as SerializedNode[]).map((child) => child.size ?? 1);
  const total = sizes.reduce((sum, size) => sum + size, 0);

  const split: LayoutNode = {
    type: "split",
    orientation: orientation.toLowerCase() as "horizontal" | "vertical",
    children,
  };

  if (total !== 0) split.sizes = sizes.map((size) => size / total);

  return split;
}

/** @param node a document node @returns its panels in reading order */
function panelsOf(node: LayoutNode): LayoutPanel[] {
  if (node.type === "panel") return [node];

  return node.children.flatMap(panelsOf);
}

/**
 * Convert a dockview grid back into a document, merging the previous hidden
 * tabs and the previous extras that still have a home.
 *
 * @param serialized the grid from `api.toJSON()`
 * @param previous the document the host last applied
 * @returns the document to save
 */
export function toLayoutDoc(serialized: SerializedLayout, previous: LayoutDoc): LayoutDoc {
  const orientation = serialized.grid.orientation;
  const next = toDocNode(serialized.grid.root, orientation, serialized.panels);
  const nextPanels = new Map(panelsOf(next).map((panel) => [panel.id, panel]));

  for (const panel of panelsOf(previous.root)) {
    const target = nextPanels.get(panel.id);

    if (target === undefined) {
      const hidden = panel.tabs.filter((tab) => tab.hidden === true);

      if (hidden.length > 0) {
        nextPanels.set(panel.id, { type: "panel", id: panel.id, tabs: hidden });
      }

      continue;
    }

    // Rebuild the tab order from the previous document: a hidden tab keeps its
    // slot instead of being appended, and a visible tab keeps the fresh state
    // from dockview.
    const fresh = new Map(target.tabs.map((tab) => [tab.tabId, tab]));
    const merged: LayoutTab[] = [];

    for (const tab of panel.tabs) {
      if (tab.hidden === true) {
        merged.push(tab);
        continue;
      }

      const current = fresh.get(tab.tabId);

      if (current !== undefined) {
        merged.push(current);
        fresh.delete(tab.tabId);
      }
    }

    merged.push(...fresh.values());
    target.tabs = merged;
  }

  const allPanels = [...nextPanels.values()];

  if (allPanels.length > 0 && next.type === "split") {
    // A panel whose every tab was hidden has no grid leaf; keep its node by
    // appending it to the root split. It is invisible, not deleted.
    const visibleIds = new Set(panelsOf(next).map((panel) => panel.id));

    for (const panel of nextPanels.values()) {
      if (!visibleIds.has(panel.id)) next.children.push(panel);
    }
  }

  const extras = previous.extras === undefined ? {} : { extras: previous.extras };
  const firstPanel = allPanels[0];
  const activePanel = allPanels.find((panel) => panel.id === serialized.activeGroup) ?? firstPanel;

  return {
    version: 1,
    root: next,
    ...(serialized.activeGroup === undefined || activePanel === undefined
      ? {}
      : { activePanelId: activePanel.id }),
    ...extras,
  };
}

/** @param value any value @returns a stable JSON string with sorted object keys */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }

  if (typeof value === "number")
    return Number.isFinite(value) ? String(Number(value.toFixed(6))) : "null";

  return JSON.stringify(value);
}

/** @param a a document @param b another document @returns whether they are equal modulo key order */
export function docEquals(a: LayoutDoc, b: LayoutDoc): boolean {
  return stable(a) === stable(b);
}
