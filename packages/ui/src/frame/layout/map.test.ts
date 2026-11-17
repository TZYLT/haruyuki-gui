import { describe, expect, it } from "vitest";

import type { LayoutDoc } from "@haruyuki/protocol";

import { docEquals, toDockview, toLayoutDoc } from "./map.js";

/** The smallest layout that still exercises a panel and a tab. */
function singlePanel(): LayoutDoc {
  return {
    version: 1,
    root: {
      type: "panel",
      id: "main",
      tabs: [{ tabId: "one", pageId: "conversation" }],
      activeTabId: "one",
    },
  };
}

/** Alternating splits (horizontal, vertical, horizontal), as dockview produces. */
function complexDoc(): LayoutDoc {
  return {
    version: 1,
    root: {
      type: "split",
      orientation: "horizontal",
      sizes: [0.62, 0.38],
      children: [
        {
          type: "split",
          orientation: "vertical",
          sizes: [0.55, 0.45],
          children: [
            {
              type: "split",
              orientation: "horizontal",
              sizes: [0.5, 0.5],
              children: [
                {
                  type: "panel",
                  id: "top-left",
                  tabs: [
                    { tabId: "conversation", pageId: "sample.conversation" },
                    { tabId: "future", pageId: "vendor.future", props: { seed: 7 } },
                    { tabId: "settings", pageId: "sample.settings" },
                  ],
                  activeTabId: "future",
                },
                { type: "panel", id: "top-right", tabs: [] },
              ],
            },
            {
              type: "panel",
              id: "bottom",
              tabs: [{ tabId: "settings-bottom", pageId: "sample.settings" }],
              activeTabId: "settings-bottom",
            },
          ],
        },
        {
          type: "panel",
          id: "right",
          tabs: [
            { tabId: "closed-future", pageId: "vendor.closed", hidden: true },
            { tabId: "settings-right", pageId: "sample.settings" },
          ],
          activeTabId: "settings-right",
        },
      ],
    },
    activePanelId: "top-left",
  };
}

describe("layout mapping", () => {
  it("maps a panel document to a leaf grid and back", () => {
    const doc = singlePanel();
    const { serialized } = toDockview(doc, { width: 800, height: 600 });
    const roundTrip = toLayoutDoc(serialized, doc);

    expect(roundTrip.root).toMatchObject({
      type: "panel",
      id: "main",
      tabs: [{ tabId: "one", pageId: "conversation" }],
    });
    expect(docEquals(roundTrip, doc)).toBe(true);
  });

  it("keeps the fixture pages, active tabs and reading order", () => {
    const doc = complexDoc();
    const { serialized } = toDockview(doc, { width: 1200, height: 800 });
    const roundTrip = toLayoutDoc(serialized, doc);

    expect(serialized.grid.orientation).toBe("HORIZONTAL");
    expect(Object.keys(serialized.panels)).toEqual(
      expect.arrayContaining(["conversation", "future", "settings"]),
    );

    const ids: string[] = [];
    const visit = (node: unknown): void => {
      const record = node as { type?: string; id?: string; children?: unknown[] };
      if (record.type === "panel" && record.id !== undefined) ids.push(record.id);
      for (const child of record.children ?? []) visit(child);
    };
    visit(roundTrip.root);

    expect(ids).toEqual(expect.arrayContaining(["top-left", "top-right", "bottom", "right"]));
    expect(docEquals(roundTrip, doc)).toBe(true);
  });

  it("does not put a hidden tab into the grid but keeps it in the document", () => {
    const doc = complexDoc();
    const { serialized, hidden } = toDockview(doc, { width: 1200, height: 800 });

    expect(hidden.map((entry) => entry.tab.tabId)).toContain("closed-future");
    expect(serialized.panels["closed-future"]).toBeUndefined();

    const roundTrip = toLayoutDoc(serialized, doc);
    const text = JSON.stringify(roundTrip);

    expect(text).toContain("closed-future");
    expect(text).toContain('"hidden":true');
  });

  it("keeps an empty panel node when its last tab is hidden", () => {
    const doc: LayoutDoc = {
      version: 1,
      root: {
        type: "split",
        orientation: "horizontal",
        children: [
          {
            type: "panel",
            id: "closed",
            tabs: [{ tabId: "gone", pageId: "unknown.page", hidden: true }],
          },
          {
            type: "panel",
            id: "main",
            tabs: [{ tabId: "open", pageId: "conversation" }],
          },
        ],
      },
    };

    const { serialized } = toDockview(doc, { width: 1000, height: 700 });
    const roundTrip = toLayoutDoc(serialized, doc);
    const text = JSON.stringify(roundTrip);

    expect(text).toContain('"id":"closed"');
    expect(text).toContain('"tabId":"gone"');
    expect(text).toContain('"hidden":true');
  });

  it("normalises fractions through dockview pixel sizes", () => {
    const doc = complexDoc();
    const { serialized } = toDockview(doc, { width: 1000, height: 600 });
    const roundTrip = toLayoutDoc(serialized, doc);

    const root = roundTrip.root;

    expect(root.type).toBe("split");
    if (root.type !== "split") return;

    expect(root.sizes?.[0]).toBeCloseTo(0.62, 2);
    expect(root.sizes?.[1]).toBeCloseTo(0.38, 2);
  });

  it("compares documents independent of object key order", () => {
    const a = singlePanel();
    const b: LayoutDoc = {
      version: 1,
      root: {
        activeTabId: "one",
        tabs: [{ pageId: "conversation", tabId: "one" }],
        id: "main",
        type: "panel",
      },
    };

    expect(docEquals(a, b)).toBe(true);
  });
});
