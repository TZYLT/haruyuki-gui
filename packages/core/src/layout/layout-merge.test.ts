/**
 * Tests for `./layout-merge`.
 *
 * Two families:
 *
 * - the scan: `collectUnknownTabs` must find unknown tabs in document order,
 *   including hidden ones, and must never call a known page unknown;
 * - the merge: a dropped unknown tab comes back at its original panel and
 *   index, an orphaned one gets a recovery panel, a tab that is still present
 *   is left alone, and no input is mutated.
 *
 * The "restored" cases start from the signed `complex.json` fixture because it
 * already carries the three things that must survive: an unknown non-hidden
 * tab (`vendor.future`), an unknown hidden tab (`vendor.closed`), and unknown
 * keys at every level (`x-doc`, `x-split`, `x-panel`, `x-tab`, `extras`). The
 * dropped documents are built by filtering that fixture rather than written by
 * hand, so a future edit to the fixture cannot silently weaken the assertion.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  LayoutDoc,
  LayoutNode,
  LayoutPanel,
  LayoutSplit,
  LayoutTab,
} from "@haruyuki/protocol";

import { collectUnknownTabs, mergeUnknownTabs } from "./layout-merge";

/** `packages/core/src/layout/` -> repo root, then the frozen sample directory. */
const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/layout/", import.meta.url));

/** The registry the signed samples are written against. */
const KNOWN_PAGE_IDS: ReadonlySet<string> = new Set(["sample.conversation", "sample.settings"]);

/** Read and parse one sample. */
function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as unknown;
}

/** JSON deep clone, used to build a candidate without touching the fixture. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The signed complex sample, as a document. */
function complexDoc(): LayoutDoc {
  return clone(readFixture("complex.json")) as LayoutDoc;
}

/** Visit every panel in document order. */
function forEachPanel(node: LayoutNode, visit: (panel: LayoutPanel) => void): void {
  if (node.type === "panel") {
    visit(node);
    return;
  }

  for (const child of node.children) {
    forEachPanel(child, visit);
  }
}

/** The panel with `id`; the fixtures always have it. */
function panelWithId(doc: LayoutDoc, id: string): LayoutPanel {
  let found: LayoutPanel | null = null;

  forEachPanel(doc.root, (panel) => {
    if (panel.id === id) {
      found = panel;
    }
  });

  if (found === null) {
    throw new Error(`no panel ${id}`);
  }

  return found;
}

/** Narrow to a split, failing the test when the root is not one. */
function asSplit(node: LayoutNode): LayoutSplit {
  expect(node.type).toBe("split");

  if (node.type !== "split") {
    throw new Error("expected a split");
  }

  return node;
}

/** Narrow to a panel, failing the test when the root is not one. */
function asPanel(node: LayoutNode): LayoutPanel {
  expect(node.type).toBe("panel");

  if (node.type !== "panel") {
    throw new Error("expected a panel");
  }

  return node;
}

/** Tab ids of a panel, in order. */
function tabIds(panel: LayoutPanel): string[] {
  return panel.tabs.map((tab) => tab.tabId);
}

/** One tab by index; the fixtures always have it. */
function tabAt(panel: LayoutPanel, index: number): LayoutTab {
  const tab = panel.tabs[index];

  if (tab === undefined) {
    throw new Error(`no tab at index ${index}`);
  }

  return tab;
}

/** The complex document with the named tabs removed from wherever they were. */
function withoutTabs(doc: LayoutDoc, dropped: readonly string[]): LayoutDoc {
  const copy = clone(doc);
  const drop = new Set(dropped);

  forEachPanel(copy.root, (panel) => {
    panel.tabs = panel.tabs.filter((tab) => !drop.has(tab.tabId));
  });

  return copy;
}

describe("collectUnknownTabs", () => {
  it("reports the complex fixture's unknown tabs in document order, hidden included", () => {
    const refs = collectUnknownTabs(complexDoc(), KNOWN_PAGE_IDS);

    expect(refs.map((ref) => [ref.panelId, ref.tab.tabId, ref.tab.pageId, ref.index])).toEqual([
      ["top-left", "future", "vendor.future", 1],
      ["right", "closed-future", "vendor.closed", 0],
    ]);

    expect(refs[1]?.tab.hidden).toBe(true);
    expect(refs[0]?.tab.props).toEqual({ seed: 7 });
  });

  it("reports nothing when every page is known", () => {
    const refs = collectUnknownTabs(
      complexDoc(),
      new Set(["sample.conversation", "sample.settings", "vendor.future", "vendor.closed"]),
    );

    expect(refs).toEqual([]);
  });
});

describe("mergeUnknownTabs with the original panels still present", () => {
  it("restores both dropped unknown tabs at their original panels and indexes", () => {
    const current = complexDoc();
    const next = withoutTabs(current, ["future", "closed-future"]);

    const merged = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);

    expect(tabIds(panelWithId(merged, "top-left"))).toEqual(["conversation", "future", "settings"]);
    expect(tabIds(panelWithId(merged, "right"))).toEqual(["closed-future", "settings-right"]);
  });

  it("preserves hidden, props, extras and unknown keys on the restored tabs", () => {
    const current = complexDoc();
    const merged = mergeUnknownTabs(
      current,
      withoutTabs(current, ["future", "closed-future"]),
      KNOWN_PAGE_IDS,
    );

    const future = tabAt(panelWithId(merged, "top-left"), 1);
    const closed = tabAt(panelWithId(merged, "right"), 0);

    expect(future.props).toEqual({ seed: 7 });
    expect((future as unknown as Record<string, unknown>)["x-tab"]).toBe("keep");
    expect(closed.hidden).toBe(true);
    expect((merged as unknown as Record<string, unknown>)["x-doc"]).toBe("keep");
  });

  it("clamps an index when the panel is now shorter", () => {
    const current = complexDoc();
    // `conversation` and `future` are gone; only `settings` is left in the
    // top-left panel, so the restored index 1 is exactly the end.
    const next = withoutTabs(current, ["conversation", "future"]);
    const merged = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);

    expect(tabIds(panelWithId(merged, "top-left"))).toEqual(["settings", "future"]);
  });

  it("does not restore a known tab the renderer dropped", () => {
    const current = complexDoc();
    const next = withoutTabs(current, ["conversation"]);

    const merged = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);

    expect(tabIds(panelWithId(merged, "top-left"))).toEqual(["future", "settings"]);
  });
});

describe("mergeUnknownTabs when the original panel is gone", () => {
  it("wraps a root panel in a horizontal split and puts both orphans in one recovery panel", () => {
    const current = complexDoc();
    const next: LayoutDoc = {
      version: 1,
      root: {
        type: "panel",
        id: "main",
        tabs: [{ tabId: "settings", pageId: "sample.settings" }],
      },
    };

    const merged = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);
    const root = asSplit(merged.root);
    const recovery = asPanel(root.children[1] as LayoutNode);

    expect(root.orientation).toBe("horizontal");
    expect(root.sizes).toEqual([0.5, 0.5]);
    expect(asPanel(root.children[0] as LayoutNode).id).toBe("main");
    expect(recovery.id).toBe("recovered-1");
    expect(tabIds(recovery)).toEqual(["future", "closed-future"]);
    expect(tabAt(recovery, 1).hidden).toBe(true);
    expect(tabAt(recovery, 0).props).toEqual({ seed: 7 });
  });

  it("pushes a recovery panel into a split root that has no sizes", () => {
    const current = complexDoc();
    const next: LayoutDoc = {
      version: 1,
      root: {
        type: "split",
        orientation: "vertical",
        children: [
          { type: "panel", id: "main", tabs: [{ tabId: "settings", pageId: "sample.settings" }] },
          { type: "panel", id: "other", tabs: [] },
        ],
      },
    };

    const merged = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);
    const root = asSplit(merged.root);

    expect(root.children.map((child) => asPanel(child).id)).toEqual([
      "main",
      "other",
      "recovered-1",
    ]);
    expect(root.sizes).toBeUndefined();
    expect(tabIds(asPanel(root.children[2] as LayoutNode))).toEqual(["future", "closed-future"]);
  });

  it("normalizes sizes when pushing into a sized split root", () => {
    const current = complexDoc();
    const next: LayoutDoc = {
      version: 1,
      root: {
        type: "split",
        orientation: "horizontal",
        sizes: [0.7, 0.3],
        children: [
          { type: "panel", id: "main", tabs: [] },
          { type: "panel", id: "other", tabs: [] },
        ],
      },
    };

    const merged = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);
    const root = asSplit(merged.root);
    const sizes = root.sizes ?? [];

    expect(root.children).toHaveLength(3);
    expect(sizes).toHaveLength(3);

    for (const size of sizes) {
      expect(Number.isFinite(size)).toBe(true);
      expect(size).toBeGreaterThan(0);
    }

    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 10);
  });

  it("skips recovery ids the document already uses", () => {
    const current = complexDoc();
    const next: LayoutDoc = {
      version: 1,
      root: {
        type: "split",
        orientation: "horizontal",
        children: [
          { type: "panel", id: "main", tabs: [] },
          { type: "panel", id: "recovered-1", tabs: [] },
        ],
      },
    };

    const merged = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);
    const root = asSplit(merged.root);

    expect(root.children.map((child) => asPanel(child).id)).toEqual([
      "main",
      "recovered-1",
      "recovered-2",
    ]);
  });
});

describe("mergeUnknownTabs invariants", () => {
  it("leaves a document that still has every unknown tab untouched", () => {
    const current = complexDoc();
    const next = complexDoc();

    const merged = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);

    expect(merged).toEqual(next);
  });

  it("is idempotent: merging the merged document changes nothing", () => {
    const current = complexDoc();
    const next = withoutTabs(current, ["future", "closed-future"]);
    const once = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);
    const twice = mergeUnknownTabs(current, once, KNOWN_PAGE_IDS);

    expect(twice).toEqual(once);
  });

  it("does not create a second tab with an id the incoming document already has", () => {
    const current = complexDoc();
    const next = withoutTabs(current, ["future", "closed-future"]);

    // The renderer moved `future` into another panel; it must not be inserted
    // a second time next to its old panel's remaining tabs.
    panelWithId(next, "right").tabs.push({ tabId: "future", pageId: "vendor.future" });

    const merged = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);
    const ids: string[] = [];

    forEachPanel(merged.root, (panel) => {
      ids.push(...tabIds(panel));
    });

    expect(ids.filter((id) => id === "future")).toHaveLength(1);
    expect(tabIds(panelWithId(merged, "top-left"))).not.toContain("future");
    expect(tabIds(panelWithId(merged, "right"))).toContain("future");
  });

  it("keeps an unknown tab that only the incoming document has", () => {
    const current = complexDoc();
    const next = withoutTabs(current, ["future", "closed-future"]);

    panelWithId(next, "top-left").tabs.push({ tabId: "brand-new", pageId: "vendor.new" });

    const merged = mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);

    expect(tabIds(panelWithId(merged, "top-left"))).toContain("brand-new");
    expect(tabIds(panelWithId(merged, "top-left"))).toContain("future");
  });

  it("does not mutate either argument", () => {
    const current = complexDoc();
    const next = withoutTabs(current, ["future", "closed-future"]);
    const currentBefore = JSON.stringify(current);
    const nextBefore = JSON.stringify(next);

    mergeUnknownTabs(current, next, KNOWN_PAGE_IDS);

    expect(JSON.stringify(current)).toBe(currentBefore);
    expect(JSON.stringify(next)).toBe(nextBefore);
  });

  it("returns a document whose unknown keys survive at every level", () => {
    const current = complexDoc();
    const merged = mergeUnknownTabs(
      current,
      withoutTabs(current, ["future", "closed-future"]),
      KNOWN_PAGE_IDS,
    );
    const root = asSplit(merged.root);
    const middle = asSplit(root.children[0] as LayoutNode);
    const upper = asSplit(middle.children[0] as LayoutNode);
    const topLeft = asPanel(upper.children[0] as LayoutNode);

    expect((merged as unknown as Record<string, unknown>)["x-doc"]).toBe("keep");
    expect((root as unknown as Record<string, unknown>)["x-split"]).toBe("keep");
    expect((middle as unknown as Record<string, unknown>)["x-split"]).toBe("keep");
    expect((upper as unknown as Record<string, unknown>)["x-split"]).toBe("keep");
    expect((topLeft as unknown as Record<string, unknown>)["x-panel"]).toBe("keep");
  });
});
