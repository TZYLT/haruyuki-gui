/**
 * Tests for `./layout-validate`.
 *
 * The suite is organised the way the validator is read: the two signed samples
 * must be accepted byte-for-byte, unknown keys must survive the clone, the
 * structural rules must reject (and the code must say why), the four numeric
 * limits must reject at N+1 but accept N, and the soft repairs must *not*
 * reject. The boundary cases are the point: a limit tested only far above the
 * threshold would stay green if the comparison flipped from `>` to `>=`.
 *
 * The particular fixtures are read from `fixtures/layout/` by URL rather than
 * by cwd, and the validator is fed `unknown`, exactly as the store feeds it a
 * `JSON.parse` result.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  LayoutDoc,
  LayoutErrorCode,
  LayoutNode,
  LayoutPanel,
  LayoutSplit,
  LayoutTab,
} from "@haruyuki/protocol";
import { LAYOUT_DOC_VERSION, LAYOUT_LIMITS } from "@haruyuki/protocol";

import { validateLayoutDoc, type LayoutValidation } from "./layout-validate";

/** `packages/core/src/layout/` -> repo root, then the frozen sample directory. */
const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/layout/", import.meta.url));

/** The registry the signed samples are written against. */
const KNOWN_PAGE_IDS: ReadonlySet<string> = new Set(["sample.conversation", "sample.settings"]);

/** Read and parse one sample. Malformed fixtures are a test failure here. */
function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as unknown;
}

/** Build a panel with optional tabs and active tab. */
function panel(id: string, tabs: LayoutTab[] = [], activeTabId?: string): LayoutPanel {
  const node: LayoutPanel = { type: "panel", id, tabs };

  if (activeTabId !== undefined) {
    node.activeTabId = activeTabId;
  }

  return node;
}

/** Build a split, with sizes only when the case needs them. */
function split(children: LayoutNode[], sizes?: number[]): LayoutSplit {
  const node: LayoutSplit = { type: "split", orientation: "horizontal", children };

  if (sizes !== undefined) {
    node.sizes = sizes;
  }

  return node;
}

/** Build a complete document around a root node. */
function doc(root: LayoutNode): LayoutDoc {
  return { version: LAYOUT_DOC_VERSION, root };
}

/** A minimal valid document: one split, two panels, one tab each. */
function simpleDoc(): LayoutDoc {
  return doc(
    split([
      panel("left", [{ tabId: "a", pageId: "p" }]),
      panel("right", [{ tabId: "b", pageId: "q" }]),
    ]),
  );
}

/** Assert acceptance and return the narrowed success value. */
function accept(
  value: unknown,
  knownPageIds: ReadonlySet<string> = new Set<string>(),
): { doc: LayoutDoc; unknownPageIds: string[] } {
  const result = validateLayoutDoc(value, knownPageIds);

  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw new Error(`expected acceptance, got ${result.code}`);
  }

  return { doc: result.doc, unknownPageIds: result.unknownPageIds };
}

/** Assert rejection with an exact code and return the failure value. */
function reject(
  value: unknown,
  code: LayoutErrorCode,
  knownPageIds: ReadonlySet<string> = new Set<string>(),
): Extract<LayoutValidation, { ok: false }> {
  const result = validateLayoutDoc(value, knownPageIds);

  expect(result.ok).toBe(false);

  if (result.ok) {
    throw new Error("expected rejection");
  }

  expect(result.code).toBe(code);

  return result;
}

/** Treat a narrowed document as an open record, for reading unknown keys. */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Panels in document order. */
function panelsOf(root: LayoutNode): LayoutPanel[] {
  const panels: LayoutPanel[] = [];

  const walk = (node: LayoutNode): void => {
    if (node.type === "panel") {
      panels.push(node);
      return;
    }

    for (const child of node.children) {
      walk(child);
    }
  };

  walk(root);

  return panels;
}

/** The panel with `id`; every sample that needs one has it. */
function findPanel(root: LayoutNode, id: string): LayoutPanel {
  const found = panelsOf(root).find((panel) => panel.id === id);

  if (found === undefined) {
    throw new Error(`no panel ${id}`);
  }

  return found;
}

describe("signed fixtures", () => {
  it("accepts default.json and reports no unknown pages", () => {
    const fixture = readFixture("default.json");
    const { doc: validated, unknownPageIds } = accept(fixture, KNOWN_PAGE_IDS);

    expect(validated).toEqual(fixture);
    expect(unknownPageIds).toEqual([]);
  });

  it("accepts complex.json and reports the unknown pages in document order", () => {
    const fixture = readFixture("complex.json");
    const { doc: validated, unknownPageIds } = accept(fixture, KNOWN_PAGE_IDS);

    expect(validated).toEqual(fixture);
    // `vendor.closed` is hidden; it is still unknown and still listed (docs/36
    // section 4.3.9, the warning contract).
    expect(unknownPageIds).toEqual(["vendor.future", "vendor.closed"]);
  });

  it("accepts the complex shape: an empty panel and activePanelId on the middle panel", () => {
    const { doc: validated } = accept(readFixture("complex.json"), KNOWN_PAGE_IDS);
    const topRight = findPanel(validated.root, "top-right");

    // An empty panel is legal, and carrying no `activeTabId` is the right
    // `activeTabId` is the right shape for it: there is nothing to select.
    expect(topRight.tabs).toEqual([]);
    expect("activeTabId" in asRecord(topRight)).toBe(false);

    // `activePanelId` points at a middle panel, not the first one, and the
    // validator must leave a valid pointer exactly where it is.
    expect(validated.activePanelId).toBe("bottom");
  });

  it("keeps unknown keys at document, split, panel and tab level", () => {
    const { doc: validated } = accept(readFixture("complex.json"), KNOWN_PAGE_IDS);
    const root = validated.root;

    if (root.type !== "split") {
      throw new Error("the complex sample must have a split root");
    }

    const middle = asRecord(root.children[0]);
    const upper = asRecord((middle["children"] as LayoutNode[])[0]);
    const topLeft = findPanel(root, "top-left");

    expect(asRecord(validated)["x-doc"]).toBe("keep");
    expect(asRecord(root)["x-split"]).toBe("keep");
    expect(middle["x-split"]).toBe("keep");
    expect(upper["x-split"]).toBe("keep");
    expect(asRecord(topLeft)["x-panel"]).toBe("keep");
    expect(asRecord(topLeft.tabs[1])["x-tab"]).toBe("keep");
    expect(asRecord(asRecord(topLeft)["extras"])["widthHint"]).toBe(0.62);
    expect(asRecord(asRecord(root)["extras"])["locked"]).toBe(false);
    expect(asRecord(asRecord(topLeft.tabs[1])["props"])["seed"]).toBe(7);
  });

  it("returns a JSON clone, so a caller cannot mutate the input", () => {
    const fixture = readFixture("default.json");
    const { doc: validated } = accept(fixture, KNOWN_PAGE_IDS);

    findPanel(validated.root, "left").id = "mutated";

    expect(asRecord(asRecord(fixture)["root"])["children"]).toMatchObject([
      { id: "left", type: "panel" },
      { id: "right", type: "panel" },
    ]);
  });

  it("rejects the corrupt fixture: two panels reuse the id dup", () => {
    const result = reject(readFixture("corrupt.json"), "LAYOUT_INVALID");

    expect(result.detail).toContain("duplicate panel id");
  });
});

describe("structure", () => {
  it("rejects a duplicate panel id", () => {
    reject(
      doc(split([panel("same", [{ tabId: "a", pageId: "p" }]), panel("same", [])])),
      "LAYOUT_INVALID",
    );
  });

  it("rejects a duplicate tab id across panels", () => {
    reject(
      doc(
        split([
          panel("left", [{ tabId: "dup", pageId: "p" }]),
          panel("right", [{ tabId: "dup", pageId: "q" }]),
        ]),
      ),
      "LAYOUT_INVALID",
    );
  });

  it("rejects a split with one child", () => {
    reject(doc(split([panel("only", [])])), "LAYOUT_INVALID");
  });

  it("rejects a split with no children", () => {
    reject(doc(split([])), "LAYOUT_INVALID");
  });

  it("rejects an unknown node type", () => {
    reject({ version: LAYOUT_DOC_VERSION, root: { type: "grid", children: [] } }, "LAYOUT_INVALID");
  });

  it("rejects an unknown orientation", () => {
    reject(
      {
        version: LAYOUT_DOC_VERSION,
        root: { type: "split", orientation: "diagonal", children: [panel("a"), panel("b")] },
      },
      "LAYOUT_INVALID",
    );
  });

  it("rejects a missing root", () => {
    reject({ version: LAYOUT_DOC_VERSION }, "LAYOUT_INVALID");
  });

  it("rejects a root that is not an object", () => {
    reject({ version: LAYOUT_DOC_VERSION, root: [] }, "LAYOUT_INVALID");
  });

  it("rejects a sizes array longer than the children", () => {
    reject(doc(split([panel("a"), panel("b")], [0.5, 0.25, 0.25])), "LAYOUT_INVALID");
  });

  it("rejects a negative size", () => {
    reject(doc(split([panel("a"), panel("b")], [1.2, -0.2])), "LAYOUT_INVALID");
  });

  it("rejects a zero size", () => {
    reject(doc(split([panel("a"), panel("b")], [1, 0])), "LAYOUT_INVALID");
  });

  it("rejects a non-finite size", () => {
    reject(doc(split([panel("a"), panel("b")], [Number.NaN, 1])), "LAYOUT_INVALID");
    reject(doc(split([panel("a"), panel("b")], [Number.POSITIVE_INFINITY, 1])), "LAYOUT_INVALID");
  });

  it("rejects an empty panel id", () => {
    reject(doc(panel("")), "LAYOUT_INVALID");
  });

  it("rejects an empty tab id or page id", () => {
    reject(doc(panel("main", [{ tabId: "", pageId: "p" }])), "LAYOUT_INVALID");
    reject(doc(panel("main", [{ tabId: "a", pageId: "" }])), "LAYOUT_INVALID");
  });

  it("rejects a non-boolean hidden flag", () => {
    reject(
      doc(panel("main", [{ tabId: "a", pageId: "p", hidden: "yes" as unknown as boolean }])),
      "LAYOUT_INVALID",
    );
  });

  it("rejects a tab that is not an object", () => {
    reject(doc(panel("main", ["not-a-tab" as unknown as LayoutTab])), "LAYOUT_INVALID");
  });

  it("rejects a version other than 1", () => {
    reject({ version: 2, root: simpleDoc().root }, "LAYOUT_UNSUPPORTED_VERSION");
  });

  it("rejects a document with no version (the store substitutes it before this call)", () => {
    reject({ root: simpleDoc().root }, "LAYOUT_UNSUPPORTED_VERSION");
  });

  it("rejects a top level that is not an object", () => {
    reject([], "LAYOUT_CORRUPT");
    reject(null, "LAYOUT_CORRUPT");
    reject("layout", "LAYOUT_CORRUPT");
    reject(42, "LAYOUT_CORRUPT");
  });
});

describe("limits", () => {
  /** A chain of `levels` splits; the deepest panel sits at depth `levels + 1`. */
  function depthDoc(levels: number): LayoutDoc {
    let node: LayoutNode = panel("leaf");

    for (let index = levels - 1; index >= 0; index -= 1) {
      node = split([node, panel(`sibling-${String(index)}`)]);
    }

    return doc(node);
  }

  /** A root split holding `count` panels. */
  function panelsDoc(count: number): LayoutDoc {
    return doc(split(Array.from({ length: count }, (_, index) => panel(`p${String(index)}`))));
  }

  /** A root panel holding `count` tabs. */
  function tabsDoc(count: number): LayoutDoc {
    const tabs = Array.from({ length: count }, (_, index): LayoutTab => ({
      tabId: `t${String(index)}`,
      pageId: "p",
    }));

    return doc(panel("main", tabs));
  }

  it("accepts 32 levels and rejects 33", () => {
    const deepestAccepted = depthDoc(LAYOUT_LIMITS.maxDepth - 1);

    expect(validateLayoutDoc(deepestAccepted, KNOWN_PAGE_IDS).ok).toBe(true);
    reject(depthDoc(LAYOUT_LIMITS.maxDepth), "LAYOUT_TOO_LARGE");
  });

  it("accepts 256 panels and rejects 257", () => {
    expect(validateLayoutDoc(panelsDoc(LAYOUT_LIMITS.maxPanels), KNOWN_PAGE_IDS).ok).toBe(true);
    reject(panelsDoc(LAYOUT_LIMITS.maxPanels + 1), "LAYOUT_TOO_LARGE");
  });

  it("accepts 1024 tabs and rejects 1025", () => {
    expect(validateLayoutDoc(tabsDoc(LAYOUT_LIMITS.maxTabs), KNOWN_PAGE_IDS).ok).toBe(true);
    reject(tabsDoc(LAYOUT_LIMITS.maxTabs + 1), "LAYOUT_TOO_LARGE");
  });

  /** Pad a small valid document to an exact compact-JSON byte size. */
  function paddedDoc(bytes: number): Record<string, unknown> {
    const value = {
      version: LAYOUT_DOC_VERSION,
      root: panel("main", [{ tabId: "t", pageId: "p" }]),
      extras: { pad: "" },
    };
    const emptyBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const extras = asRecord(value.extras);

    extras["pad"] = "x".repeat(bytes - emptyBytes);

    return value;
  }

  it("accepts exactly 256 KiB and rejects one byte more", () => {
    const atLimit = paddedDoc(LAYOUT_LIMITS.maxBytes);

    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(LAYOUT_LIMITS.maxBytes);
    expect(validateLayoutDoc(atLimit, KNOWN_PAGE_IDS).ok).toBe(true);
    reject(paddedDoc(LAYOUT_LIMITS.maxBytes + 1), "LAYOUT_TOO_LARGE");
  });

  it("rejects a document that only exceeds the limit after active-id repair", () => {
    const panelId = "p".repeat(64);
    const value = {
      version: LAYOUT_DOC_VERSION,
      root: panel(panelId, [{ tabId: "t", pageId: "p" }]),
      activePanelId: "dangling",
      extras: { pad: "" },
    };
    const emptyBytes = Buffer.byteLength(JSON.stringify(value), "utf8");

    asRecord(value.extras)["pad"] = "x".repeat(LAYOUT_LIMITS.maxBytes - emptyBytes);

    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBe(LAYOUT_LIMITS.maxBytes);
    // Repairing `dangling` to the 64-byte panel id grows the document past the
    // write limit, so the repaired document is refused rather than returned.
    reject(value, "LAYOUT_TOO_LARGE");
  });
});

describe("unknown pages", () => {
  it("are not invalid, are deduplicated and keep first-seen order", () => {
    const value = doc(
      split([
        panel("left", [
          { tabId: "a", pageId: "vendor.one" },
          { tabId: "b", pageId: "sample.conversation" },
          { tabId: "c", pageId: "vendor.two" },
        ]),
        panel("right", [
          { tabId: "d", pageId: "vendor.one" },
          { tabId: "e", pageId: "vendor.hidden", hidden: true },
        ]),
      ]),
    );

    const { unknownPageIds } = accept(value, KNOWN_PAGE_IDS);

    expect(unknownPageIds).toEqual(["vendor.one", "vendor.two", "vendor.hidden"]);
  });

  it("treats every page as unknown when the registry is empty", () => {
    const { unknownPageIds } = accept(simpleDoc(), new Set<string>());

    expect(unknownPageIds).toEqual(["p", "q"]);
  });
});

describe("active selection soft repair", () => {
  it("repairs a dangling activePanelId to the first panel", () => {
    const value = simpleDoc();

    value.activePanelId = "missing";

    const { doc: validated } = accept(value, KNOWN_PAGE_IDS);

    expect(validated.activePanelId).toBe("left");
  });

  it("keeps a valid activePanelId", () => {
    const value = simpleDoc();

    value.activePanelId = "right";

    const { doc: validated } = accept(value, KNOWN_PAGE_IDS);

    expect(validated.activePanelId).toBe("right");
  });

  it("repairs a dangling activeTabId to the first tab", () => {
    const value = doc(
      split([
        panel(
          "left",
          [
            { tabId: "first", pageId: "p" },
            { tabId: "second", pageId: "q" },
          ],
          "gone",
        ),
        panel("right", []),
      ]),
    );

    const { doc: validated } = accept(value, KNOWN_PAGE_IDS);
    const children = asRecord(validated.root)["children"] as LayoutPanel[];

    expect(children[0]?.activeTabId).toBe("first");
  });

  it("removes activeTabId when the panel has no tabs", () => {
    const value = doc(panel("main", [], "gone"));
    const { doc: validated } = accept(value, KNOWN_PAGE_IDS);

    expect("activeTabId" in asRecord(validated.root)).toBe(false);
  });

  it("keeps a valid activeTabId", () => {
    const value = doc(
      panel(
        "main",
        [
          { tabId: "a", pageId: "p" },
          { tabId: "b", pageId: "q" },
        ],
        "b",
      ),
    );

    const { doc: validated } = accept(value, KNOWN_PAGE_IDS);

    expect(asRecord(validated.root)["activeTabId"]).toBe("b");
  });

  it("repairs a non-string activePanelId instead of rejecting the document", () => {
    const value = { version: LAYOUT_DOC_VERSION, root: simpleDoc().root, activePanelId: null };

    const { doc: validated } = accept(value, KNOWN_PAGE_IDS);

    expect(validated.activePanelId).toBe("left");
  });
});
