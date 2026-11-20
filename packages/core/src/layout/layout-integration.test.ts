/**
 * End-to-end integration for the layout store.
 *
 * This file is the end-to-end acceptance script for the store's file contract:
 * every case below names the behaviour it covers, and each runs the real store
 * over a real `node:fs/promises` adapter against a disposable `mkdtemp`
 * directory. The only place an injected filesystem appears is the atomic-write
 * failure, because a rename that dies mid-save cannot be produced on demand.
 *
 * The precondition test in this file (fixtures readable, unparseable throws) is
 * kept first: if the frozen samples ever move, that fails instead of presenting
 * a confusing store error.
 *
 * What this file does NOT prove
 *   Rendering, drag-and-drop, the 800 ms channel window and the draft file
 *   belong to other modules and their own tests. This file owns the store's
 *   file contract end to end: load outcomes, backups, unknown-tab preservation,
 *   shell isolation and the version guard.
 *
 * Fixtures are addressed through `import.meta.url`, not `process.cwd()`, and
 * all mutable state lives under `tmpdir()/haruyuki-layout-integration-*`.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LayoutDoc, LayoutPanel, LayoutSplit, LayoutTab } from "@haruyuki/protocol";
import { LAYOUT_DOC_VERSION } from "@haruyuki/protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createNodeLayoutFs } from "./layout-fs";
import type { LayoutFs } from "./layout-fs";
import { backupPrefix, layoutDir, layoutPath } from "./layout-paths";
import type { LayoutShell } from "./layout-paths";
import { createLayoutStore } from "./layout-store";
import type { LayoutLoadResult, LayoutStore, LayoutStoreOptions } from "./layout-store";
import { validateLayoutDoc } from "./layout-validate";
import type { LayoutValidation } from "./layout-validate";

const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/layout/", import.meta.url));

/** The page registry the fixtures are written against; `pageId` is opaque to core. */
const KNOWN: ReadonlySet<string> = new Set(["sample.conversation", "sample.settings"]);

/** The two fixtures that are required to load as `ok`. */
const DEFAULT_FIXTURE = "default.json";
const COMPLEX_FIXTURE = "complex.json";
const CORRUPT_FIXTURE = "corrupt.json";
const UNPARSEABLE_FIXTURE = "unparseable.json";

let root: string;
let defaultDoc: LayoutDoc;

beforeAll(async () => {
  defaultDoc = JSON.parse(await readFixtureText(DEFAULT_FIXTURE)) as LayoutDoc;
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "haruyuki-layout-integration-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readFixtureText(name: string): Promise<string> {
  return readFile(join(FIXTURE_DIR, name), "utf8");
}

/** Parse a fixture as an untrusted value; validation and the store decide its fate. */
async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFixtureText(name)) as unknown;
}

/** Put `text` at a shell's layout key, creating `layout/` first. */
async function seed(shell: LayoutShell, text: string): Promise<void> {
  await mkdir(layoutDir(root), { recursive: true });
  await writeFile(layoutPath(root, shell), text, "utf8");
}

function targetOf(shell: LayoutShell): string {
  return layoutPath(root, shell);
}

async function readTarget(shell: LayoutShell): Promise<string> {
  return readFile(targetOf(shell), "utf8");
}

/** Corruption backups of one shell, oldest name first (names are timestamp-ordered). */
async function backupsOf(shell: LayoutShell): Promise<string[]> {
  const names = await readdir(layoutDir(root));
  return names.filter((name) => name.startsWith(backupPrefix(shell)) && name.endsWith(".json"));
}

async function firstBackup(shell: LayoutShell): Promise<string> {
  const [name] = await backupsOf(shell);

  if (name === undefined) {
    throw new Error(`expected a ${backupPrefix(shell)}* backup in ${layoutDir(root)}`);
  }

  return join(layoutDir(root), name);
}

/** A clock that advances one second per call, so two backups cannot collide. */
function steppingClock(start = "2026-11-16T21:30:24.000Z"): () => Date {
  let offset = 0;
  const base = Date.parse(start);

  return () => {
    const now = new Date(base + offset * 1000);
    offset += 1;
    return now;
  };
}

/** Build a store for one shell; every option is overridable. */
function makeStore(
  options: Partial<LayoutStoreOptions> & { shell?: LayoutShell } = {},
): LayoutStore {
  const { shell = "desktop", ...overrides } = options;

  return createLayoutStore({
    fs: createNodeLayoutFs(),
    layoutPath: targetOf(shell),
    defaultDoc,
    knownPageIds: KNOWN,
    clock: steppingClock(),
    ...overrides,
  });
}

/** Narrow a load result to the success arm, failing loudly otherwise. */
function loaded(result: LayoutLoadResult): Extract<LayoutLoadResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected a loaded document, got ${result.code}`);
  }

  return result;
}

/** Narrow a validation result to the success arm. */
function accepted(result: LayoutValidation): Extract<LayoutValidation, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected a valid document, got ${result.code}: ${result.detail ?? ""}`);
  }

  return result;
}

/** Narrow a validation result to the failure arm. */
function rejected(result: LayoutValidation): Extract<LayoutValidation, { ok: false }> {
  if (result.ok) {
    throw new Error("expected the validator to refuse the document");
  }

  return result;
}

function assertPanel(node: unknown): asserts node is LayoutPanel {
  const type = (node as { type?: unknown } | null)?.type;

  if (type !== "panel") {
    throw new Error(`expected a panel node, got ${String(type)}`);
  }
}

function assertSplit(node: unknown): asserts node is LayoutSplit {
  const type = (node as { type?: unknown } | null)?.type;

  if (type !== "split") {
    throw new Error(`expected a split node, got ${String(type)}`);
  }
}

/** Panels in document order. */
function panelsOf(doc: LayoutDoc): LayoutPanel[] {
  const panels: LayoutPanel[] = [];

  const visit = (node: LayoutDoc["root"]): void => {
    if (node.type === "panel") {
      panels.push(node);
      return;
    }

    for (const child of node.children) visit(child);
  };

  visit(doc.root);

  return panels;
}

/** One panel by id; a missing panel is a test bug, not a soft case. */
function panelById(doc: LayoutDoc, id: string): LayoutPanel {
  const panel = panelsOf(doc).find((candidate) => candidate.id === id);

  if (panel === undefined) {
    throw new Error(
      `expected panel "${id}" in [${panelsOf(doc)
        .map((p) => p.id)
        .join(", ")}]`,
    );
  }

  return panel;
}

/** Tabs in document order, hidden ones included: a closed unknown tab is still present. */
function tabsOf(doc: LayoutDoc): LayoutTab[] {
  return panelsOf(doc).flatMap((panel) => panel.tabs);
}

function tabIdsOf(panel: LayoutPanel): string[] {
  return panel.tabs.map((tab) => tab.tabId);
}

function sumSizes(split: LayoutSplit): number {
  return (split.sizes ?? []).reduce((sum, size) => sum + size, 0);
}

/** A JSON deep copy; documents are JSON by contract. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("layout integration", () => {
  it("precondition: all four frozen samples are readable and unparseable.json is not JSON", async () => {
    for (const name of [DEFAULT_FIXTURE, COMPLEX_FIXTURE, CORRUPT_FIXTURE, UNPARSEABLE_FIXTURE]) {
      expect((await readFixtureText(name)).length).toBeGreaterThan(0);
    }

    expect(() => JSON.parse("")).toThrow(SyntaxError);
  });

  it("default.json loads as ok, writable, version 1, revision 0", async () => {
    const text = await readFixtureText(DEFAULT_FIXTURE);
    await seed("desktop", text);

    const store = makeStore();
    const result = loaded(await store.load());

    expect(result.outcome).toBe("ok");
    expect(result.writable).toBe(true);
    expect(result.foundVersion).toBe(1);
    expect(result.unknownPageIds).toEqual([]);
    expect(result.doc).toEqual(defaultDoc);
    expect(store.getRevision()).toBe(0);
    expect(store.isWritable()).toBe(true);
    expect(store.getStatus()).toEqual({
      outcome: "ok",
      writable: true,
      foundVersion: 1,
      unknownPageIds: [],
    });

    // A clean load does not touch the file on disk.
    expect(await readTarget("desktop")).toBe(text);

    // The sample is the minimal legal shape: one split, two panels, one tab each.
    assertSplit(result.doc.root);
    expect(result.doc.root.orientation).toBe("horizontal");
    expect(result.doc.root.children).toHaveLength(2);
    expect(result.doc.root.sizes).toEqual([0.6, 0.4]);
    expect(sumSizes(result.doc.root)).toBeCloseTo(1, 10);
    expect(panelsOf(result.doc).map((panel) => panel.id)).toEqual(["left", "right"]);
  });

  it("complex.json loads, saves and reloads without losing nested layout, unknown pages or extras", async () => {
    const text = await readFixtureText(COMPLEX_FIXTURE);
    await seed("desktop", text);

    const store = makeStore();
    const first = loaded(await store.load());

    expect(first.outcome).toBe("ok");
    expect(first.writable).toBe(true);
    expect(first.foundVersion).toBe(1);
    expect(first.unknownPageIds).toEqual(["vendor.future", "vendor.closed"]);
    expect(store.getRevision()).toBe(0);

    // Three nested levels: root horizontal -> left vertical -> top horizontal.
    assertSplit(first.doc.root);
    expect(first.doc.root.orientation).toBe("horizontal");
    expect(first.doc.root.sizes).toEqual([0.62, 0.38]);
    expect(sumSizes(first.doc.root)).toBeCloseTo(1, 10);
    expect(first.doc.root.extras).toEqual({ locked: false });

    const [leftColumnNode, rightNode] = first.doc.root.children;
    assertSplit(leftColumnNode);
    expect(leftColumnNode.orientation).toBe("vertical");
    expect(leftColumnNode.sizes).toEqual([0.55, 0.45]);
    expect(sumSizes(leftColumnNode)).toBeCloseTo(1, 10);

    const [topRowNode, bottomNode] = leftColumnNode.children;
    assertSplit(topRowNode);
    expect(topRowNode.orientation).toBe("horizontal");
    expect(topRowNode.sizes).toEqual([0.5, 0.5]);
    expect(sumSizes(topRowNode)).toBeCloseTo(1, 10);

    const [topLeftNode, topRightNode] = topRowNode.children;
    assertPanel(topLeftNode);
    expect(topLeftNode.id).toBe("top-left");
    expect(tabIdsOf(topLeftNode)).toEqual(["conversation", "future", "settings"]);
    expect(topLeftNode.activeTabId).toBe("future");
    expect(topLeftNode.extras).toEqual({ widthHint: 0.62 });

    // An empty panel is legal, and it has no active tab pointer.
    assertPanel(topRightNode);
    expect(topRightNode.id).toBe("top-right");
    expect(topRightNode.tabs).toEqual([]);
    expect(topRightNode.activeTabId).toBeUndefined();

    assertPanel(bottomNode);
    expect(bottomNode.id).toBe("bottom");
    expect(tabIdsOf(bottomNode)).toEqual(["settings-bottom"]);

    assertPanel(rightNode);
    expect(rightNode.id).toBe("right");
    expect(tabIdsOf(rightNode)).toEqual(["closed-future", "settings-right"]);

    // Extra keys at every level, as the save/load contract requires.
    expect((first.doc as unknown as Record<string, unknown>)["x-doc"]).toBe("keep");
    expect((first.doc.root as unknown as Record<string, unknown>)["x-split"]).toBe("keep");
    expect((topLeftNode as unknown as Record<string, unknown>)["x-panel"]).toBe("keep");
    const futureTab = topLeftNode.tabs.find((tab) => tab.tabId === "future");
    expect(futureTab?.props).toEqual({ seed: 7 });
    expect((futureTab as unknown as Record<string, unknown>)["x-tab"]).toBe("keep");

    // Save the document unchanged: a revision advance, and the file is written.
    const saved = await store.save(first.doc);
    expect(saved).toEqual({ ok: true, revision: 1 });
    expect(store.getRevision()).toBe(1);

    const onDisk = JSON.parse(await readTarget("desktop")) as LayoutDoc;
    expect(onDisk).toEqual(first.doc);

    // Reload through a fresh store: the written document is accepted as-is and
    // every field it carried survives.
    const reloaded = loaded(await makeStore().load());
    expect(reloaded.outcome).toBe("ok");
    expect(reloaded.doc).toEqual(first.doc);
    expect(reloaded.unknownPageIds).toEqual(["vendor.future", "vendor.closed"]);
    assertSplit(reloaded.doc.root);
    expect(reloaded.doc.root.sizes).toEqual([0.62, 0.38]);
    expect(reloaded.doc.extras).toEqual({ schemaNote: "C4 sample" });
    expect(panelById(reloaded.doc, "right").tabs[0]?.hidden).toBe(true);
  });

  it("corrupt.json falls back, backs up, leaves the bytes and recovers vendor.future", async () => {
    const text = await readFixtureText(CORRUPT_FIXTURE);
    await seed("desktop", text);

    const store = makeStore();
    const result = loaded(await store.load());

    expect(result.outcome).toBe("fell-back-to-default");
    expect(result.writable).toBe(true);
    expect(result.foundVersion).toBe(1);
    expect(result.unknownPageIds).toEqual(["vendor.future"]);

    // The default panels are the fallback shape; the unknown tab arrives in a
    // recovery panel whose id is looked up by shape, not by index.
    const panelIds = panelsOf(result.doc).map((panel) => panel.id);
    expect(panelIds).toContain("left");
    expect(panelIds).toContain("right");

    const recovery = panelsOf(result.doc).find((panel) => /^recovered-\d+$/.test(panel.id));
    expect(recovery).toBeDefined();
    const recoveredPages = recovery?.tabs.map((tab) => tab.pageId) ?? [];
    expect(recoveredPages).toContain("vendor.future");

    // Load never touches the target file.
    expect(await readTarget("desktop")).toBe(text);

    // The original bytes are preserved in a single corruption backup.
    const backupFile = await firstBackup("desktop");
    expect(await readFile(backupFile, "utf8")).toBe(text);
    expect(await backupsOf("desktop")).toHaveLength(1);

    // A recoverable corruption stays writable: the next save writes a valid
    // document over the bad file.
    const saved = await store.save(result.doc);
    expect(saved.ok).toBe(true);
    expect(store.getRevision()).toBe(1);

    const reloaded = loaded(await makeStore().load());
    expect(reloaded.outcome).toBe("ok");
    expect(reloaded.doc).toEqual(result.doc);
  });

  it("a save that drops unknown tabs merges them back at their original position", async () => {
    await seed("desktop", await readFixtureText(COMPLEX_FIXTURE));

    const store = makeStore();
    const current = loaded(await store.load());
    expect(current.unknownPageIds).toEqual(["vendor.future", "vendor.closed"]);

    // The renderer does what a build without the extension would do: it drops
    // both unknown tabs.
    const next = clone(current.doc);
    const topLeft = panelById(next, "top-left");
    topLeft.tabs = topLeft.tabs.filter((tab) => tab.tabId !== "future");
    const right = panelById(next, "right");
    right.tabs = right.tabs.filter((tab) => tab.tabId !== "closed-future");

    const saved = await store.save(next);
    expect(saved).toEqual({ ok: true, revision: 1 });

    // The merge keeps them at the panel and index they had; the hidden flag and
    // page props travel with the tab.
    const reloaded = loaded(await makeStore().load());
    expect(reloaded.outcome).toBe("ok");
    expect(tabIdsOf(panelById(reloaded.doc, "top-left"))).toEqual([
      "conversation",
      "future",
      "settings",
    ]);
    expect(tabIdsOf(panelById(reloaded.doc, "right"))).toEqual(["closed-future", "settings-right"]);

    const futureTab = panelById(reloaded.doc, "top-left").tabs.find(
      (tab) => tab.tabId === "future",
    );
    expect(futureTab?.pageId).toBe("vendor.future");
    expect(futureTab?.props).toEqual({ seed: 7 });

    const closedFuture = panelById(reloaded.doc, "right").tabs.find(
      (tab) => tab.tabId === "closed-future",
    );
    expect(closedFuture?.hidden).toBe(true);
    expect(reloaded.unknownPageIds).toEqual(["vendor.future", "vendor.closed"]);
  });

  it("a version 2 file is read-only and save refuses without touching the bytes", async () => {
    const futureDoc = { ...(clone(defaultDoc) as unknown as Record<string, unknown>), version: 2 };
    const text = JSON.stringify(futureDoc);
    await seed("desktop", text);

    const store = makeStore();
    const result = loaded(await store.load());

    expect(result.outcome).toBe("unsupported-version");
    expect(result.writable).toBe(false);
    expect(result.foundVersion).toBe(2);
    expect(result.doc).toEqual(defaultDoc);
    expect(store.isWritable()).toBe(false);

    const saved = await store.save(defaultDoc);
    expect(saved).toEqual({ ok: false, code: "LAYOUT_UNSUPPORTED_VERSION" });
    expect(store.getRevision()).toBe(0);

    // Neither load nor the refused save rewrites a newer document: it may be
    // the only copy a newer build can read.
    expect(await readTarget("desktop")).toBe(text);
  });

  it("the two shells read the same schema but write separate files", async () => {
    const text = await readFixtureText(COMPLEX_FIXTURE);
    await seed("desktop", text);
    await seed("vscode", text);

    const desktopStore = makeStore({ shell: "desktop" });
    const vscodeStore = makeStore({ shell: "vscode" });

    const desktop = loaded(await desktopStore.load());
    const vscode = loaded(await vscodeStore.load());

    // One schema, two readable copies, identical interpretation.
    expect(desktop.outcome).toBe("ok");
    expect(vscode.outcome).toBe("ok");
    expect(desktop.doc).toEqual(vscode.doc);
    expect(desktop.unknownPageIds).toEqual(["vendor.future", "vendor.closed"]);
    expect(vscode.unknownPageIds).toEqual(desktop.unknownPageIds);

    const vscodeBytesBefore = await readTarget("vscode");

    const changed = clone(desktop.doc);
    changed.activePanelId = "top-left";
    expect(await desktopStore.save(changed)).toEqual({ ok: true, revision: 1 });

    // A desktop write cannot reach the vscode file.
    expect(await readTarget("vscode")).toBe(vscodeBytesBefore);

    const desktopBytesAfter = await readTarget("desktop");
    expect(await vscodeStore.save(vscode.doc)).toEqual({ ok: true, revision: 1 });
    expect(await readTarget("desktop")).toBe(desktopBytesAfter);

    const desktopReloaded = loaded(await makeStore({ shell: "desktop" }).load());
    const vscodeReloaded = loaded(await makeStore({ shell: "vscode" }).load());
    expect(desktopReloaded.doc.activePanelId).toBe("top-left");
    expect(vscodeReloaded.doc.activePanelId).toBe("bottom");

    const files = await readdir(layoutDir(root));
    expect(files.sort()).toEqual(["desktop.json", "vscode.json"]);
  });

  it("a failed rename leaves the old file readable, the revision unchanged and no temp file", async () => {
    const text = await readFixtureText(DEFAULT_FIXTURE);
    await seed("desktop", text);

    const failingFs = failingRenameFs();
    const store = makeStore({ fs: failingFs });
    const loadResult = loaded(await store.load());

    const saved = await store.save(loadResult.doc);
    expect(saved).toEqual({ ok: false, code: "LAYOUT_IO_ERROR" });
    expect(store.getRevision()).toBe(0);
    // The store keeps describing the file that is still on disk.
    expect(store.getDoc()).toEqual(loadResult.doc);

    // The target is the old, complete document -- never half of the new one.
    expect(await readTarget("desktop")).toBe(text);
    expect(() => JSON.parse(text)).not.toThrow();

    const leftovers = (await readdir(layoutDir(root))).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);

    // The next store with a working filesystem still loads the old document.
    expect(loaded(await makeStore().load()).doc).toEqual(defaultDoc);
  });

  it("structural defects are refused with a code, not repaired", async () => {
    const corrupt = await readFixture(CORRUPT_FIXTURE);

    // The frozen sample: a repeated panel id is the structural violation.
    const duplicate = rejected(validateLayoutDoc(corrupt, KNOWN));
    expect(duplicate.code).toBe("LAYOUT_INVALID");
    expect(duplicate.detail ?? "").toContain("duplicate panel id");

    const oneChild = rejected(
      validateLayoutDoc(
        {
          version: LAYOUT_DOC_VERSION,
          root: {
            type: "split",
            orientation: "horizontal",
            children: [{ type: "panel", id: "only", tabs: [] }],
          },
        },
        KNOWN,
      ),
    );
    expect(oneChild.code).toBe("LAYOUT_INVALID");

    const duplicateTab = rejected(
      validateLayoutDoc(
        {
          version: LAYOUT_DOC_VERSION,
          root: {
            type: "split",
            orientation: "horizontal",
            children: [
              {
                type: "panel",
                id: "a",
                tabs: [{ tabId: "same", pageId: "sample.conversation" }],
              },
              { type: "panel", id: "b", tabs: [{ tabId: "same", pageId: "sample.settings" }] },
            ],
          },
        },
        KNOWN,
      ),
    );
    expect(duplicateTab.code).toBe("LAYOUT_INVALID");

    const wrongOrientation = rejected(
      validateLayoutDoc(
        {
          version: LAYOUT_DOC_VERSION,
          root: {
            type: "split",
            orientation: "diagonal",
            children: [
              { type: "panel", id: "a", tabs: [] },
              { type: "panel", id: "b", tabs: [] },
            ],
          },
        },
        KNOWN,
      ),
    );
    expect(wrongOrientation.code).toBe("LAYOUT_INVALID");

    // Sizes: one per child, finite and positive.
    const sizesMismatch = rejected(
      validateLayoutDoc(
        {
          version: LAYOUT_DOC_VERSION,
          root: {
            type: "split",
            orientation: "horizontal",
            sizes: [0.5],
            children: [
              { type: "panel", id: "a", tabs: [] },
              { type: "panel", id: "b", tabs: [] },
            ],
          },
        },
        KNOWN,
      ),
    );
    expect(sizesMismatch.code).toBe("LAYOUT_INVALID");

    const negativeSize = rejected(
      validateLayoutDoc(
        {
          version: LAYOUT_DOC_VERSION,
          root: {
            type: "split",
            orientation: "horizontal",
            sizes: [1.5, -0.5],
            children: [
              { type: "panel", id: "a", tabs: [] },
              { type: "panel", id: "b", tabs: [] },
            ],
          },
        },
        KNOWN,
      ),
    );
    expect(negativeSize.code).toBe("LAYOUT_INVALID");

    // Limits: depth 32 is accepted, one more level is not.
    expect(validateLayoutDoc(nestedSplitDoc(31), KNOWN).ok).toBe(true);
    const tooDeep = rejected(validateLayoutDoc(nestedSplitDoc(32), KNOWN));
    expect(tooDeep.code).toBe("LAYOUT_TOO_LARGE");

    const tooManyPanels = rejected(
      validateLayoutDoc(
        {
          version: LAYOUT_DOC_VERSION,
          root: {
            type: "split",
            orientation: "horizontal",
            children: Array.from({ length: 257 }, (_, index) => ({
              type: "panel",
              id: `panel-${String(index)}`,
              tabs: [],
            })),
          },
        },
        KNOWN,
      ),
    );
    expect(tooManyPanels.code).toBe("LAYOUT_TOO_LARGE");

    const tooManyTabs = rejected(
      validateLayoutDoc(
        {
          version: LAYOUT_DOC_VERSION,
          root: {
            type: "panel",
            id: "big",
            tabs: Array.from({ length: 1025 }, (_, index) => ({
              tabId: `tab-${String(index)}`,
              pageId: "sample.conversation",
            })),
          },
        },
        KNOWN,
      ),
    );
    expect(tooManyTabs.code).toBe("LAYOUT_TOO_LARGE");

    // The 256 KiB ceiling is measured on the compact JSON the store would write.
    const oversized = rejected(
      validateLayoutDoc(
        {
          version: LAYOUT_DOC_VERSION,
          root: {
            type: "panel",
            id: "big",
            tabs: [
              {
                tabId: "tab",
                pageId: "sample.conversation",
                props: { blob: "x".repeat(300 * 1024) },
              },
            ],
          },
        },
        KNOWN,
      ),
    );
    expect(oversized.code).toBe("LAYOUT_TOO_LARGE");

    // A non-object, or a version this build does not write.
    expect(rejected(validateLayoutDoc(null, KNOWN)).code).toBe("LAYOUT_CORRUPT");
    expect(rejected(validateLayoutDoc([], KNOWN)).code).toBe("LAYOUT_CORRUPT");
    expect(
      rejected(validateLayoutDoc({ ...(clone(defaultDoc) as object), version: 2 }, KNOWN)).code,
    ).toBe("LAYOUT_UNSUPPORTED_VERSION");
  });

  it("unknown fields at doc, split, panel and tab level survive validation", async () => {
    const complex = await readFixture(COMPLEX_FIXTURE);
    const fixtureResult = accepted(validateLayoutDoc(complex, KNOWN));

    // The validator clones instead of rebuilding, so the whole sample is
    // identical after a pass -- including every `x-*` key and `extras` bag.
    expect(fixtureResult.doc).toEqual(complex);
    expect((fixtureResult.doc as unknown as Record<string, unknown>)["x-doc"]).toBe("keep");
    expect((fixtureResult.doc.root as unknown as Record<string, unknown>)["x-split"]).toBe("keep");

    const synthetic = {
      version: LAYOUT_DOC_VERSION,
      "x-doc": { future: true },
      root: {
        type: "split",
        orientation: "horizontal",
        sizes: [0.5, 0.5],
        "x-split": [1, 2, 3],
        children: [
          {
            type: "panel",
            id: "p1",
            "x-panel": "keep",
            tabs: [
              {
                tabId: "t1",
                pageId: "sample.conversation",
                "x-tab": { nested: ["a", "b"] },
              },
            ],
          },
          { type: "panel", id: "p2", tabs: [] },
        ],
      },
    };

    const syntheticResult = accepted(validateLayoutDoc(synthetic, KNOWN));
    expect(syntheticResult.doc).toEqual(synthetic);
  });

  it("unknown page ids are reported, never treated as invalid", async () => {
    const doc = {
      version: LAYOUT_DOC_VERSION,
      root: {
        type: "split",
        orientation: "vertical",
        children: [
          {
            type: "panel",
            id: "a",
            tabs: [
              { tabId: "t1", pageId: "vendor.unknown" },
              { tabId: "t2", pageId: "vendor.other" },
              { tabId: "t3", pageId: "vendor.unknown" },
            ],
          },
          {
            type: "panel",
            id: "b",
            tabs: [{ tabId: "t4", pageId: "vendor.hidden", hidden: true }],
          },
        ],
      },
    };

    const result = accepted(validateLayoutDoc(doc, KNOWN));
    expect(result.unknownPageIds).toEqual(["vendor.unknown", "vendor.other", "vendor.hidden"]);

    // The exact set difference: a document whose pages are all known reports
    // nothing unknown; an empty registry reports every page.
    expect(accepted(validateLayoutDoc(defaultDoc, KNOWN)).unknownPageIds).toEqual([]);
    const emptyRegistry = accepted(validateLayoutDoc(defaultDoc, new Set<string>()));
    expect(new Set(emptyRegistry.unknownPageIds)).toEqual(
      new Set(tabsOf(emptyRegistry.doc).map((tab) => tab.pageId)),
    );
  });

  it("a hidden unknown tab persists, and is merged back even when a save omits it", async () => {
    await seed("desktop", await readFixtureText(COMPLEX_FIXTURE));

    const store = makeStore();
    const current = loaded(await store.load());

    // Move the hidden unknown tab into the empty panel: still hidden, still one.
    const withMovedHidden = clone(current.doc);
    const right = panelById(withMovedHidden, "right");
    const hiddenTab = right.tabs.find((tab) => tab.tabId === "closed-future");
    if (hiddenTab === undefined) throw new Error("expected closed-future in the right panel");
    right.tabs = right.tabs.filter((tab) => tab.tabId !== "closed-future");
    panelById(withMovedHidden, "top-right").tabs.push(hiddenTab);

    expect(await store.save(withMovedHidden)).toEqual({ ok: true, revision: 1 });

    const moved = loaded(await makeStore().load());
    expect(tabIdsOf(panelById(moved.doc, "top-right"))).toEqual(["closed-future"]);
    expect(panelById(moved.doc, "top-right").tabs[0]?.hidden).toBe(true);
    expect(moved.unknownPageIds).toEqual(["vendor.future", "vendor.closed"]);

    // Now omit it entirely. The merge puts it back with its hidden flag intact,
    // and no duplicate tab id appears.
    const withoutHidden = clone(moved.doc);
    const topRight = panelById(withoutHidden, "top-right");
    topRight.tabs = topRight.tabs.filter((tab) => tab.tabId !== "closed-future");

    expect(await store.save(withoutHidden)).toEqual({ ok: true, revision: 2 });

    const reloaded = loaded(await makeStore().load());
    const matches = tabsOf(reloaded.doc).filter((tab) => tab.tabId === "closed-future");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.hidden).toBe(true);
    expect(matches[0]?.pageId).toBe("vendor.closed");
    expect(reloaded.unknownPageIds).toContain("vendor.closed");
  });

  it("unparseable.json is corrupt, backed up, still writable, and stays untouched by load", async () => {
    const text = await readFixtureText(UNPARSEABLE_FIXTURE);
    await seed("desktop", text);

    const store = makeStore();
    const result = loaded(await store.load());

    expect(result.outcome).toBe("corrupt");
    expect(result.writable).toBe(true);
    expect(result.foundVersion).toBeNull();
    expect(result.doc).toEqual(defaultDoc);

    // Load does not rewrite the file it could not read, and the
    // bytes are copied aside so the user can inspect them.
    expect(await readTarget("desktop")).toBe(text);
    expect(await readFile(await firstBackup("desktop"), "utf8")).toBe(text);
    expect(await backupsOf("desktop")).toHaveLength(1);

    // The next intentional save is how the layout comes back.
    expect(await store.save(result.doc)).toEqual({ ok: true, revision: 1 });

    const reloaded = loaded(await makeStore().load());
    expect(reloaded.outcome).toBe("ok");
    expect(reloaded.doc).toEqual(defaultDoc);
    expect(JSON.parse(await readTarget("desktop"))).toEqual(defaultDoc);
  });
});

/**
 * A valid document one level deeper or shallower, used to pin the depth cap.
 *
 * The root is at depth 1, so `levels` nested splits put the innermost panel at
 * `levels + 1`.
 */
function nestedSplitDoc(levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: "panel", id: "deep-0", tabs: [] };

  for (let level = 1; level <= levels; level += 1) {
    node = {
      type: "split",
      orientation: "horizontal",
      children: [node, { type: "panel", id: `deep-${String(level)}`, tabs: [] }],
    };
  }

  return { version: LAYOUT_DOC_VERSION, root: node };
}

/**
 * The real adapter with one operation broken: `rename` fails the way a dead
 * volume or a locked target would. `writeFile` and `unlink` still run, which is
 * what makes "the temp file is cleaned up" observable.
 */
function failingRenameFs(): LayoutFs {
  const real = createNodeLayoutFs();

  return {
    readFile: (path) => real.readFile(path),
    writeFile: (path, data) => real.writeFile(path, data),
    rename: async () => {
      throw Object.assign(new Error("simulated rename failure"), { code: "EIO" });
    },
    copyFile: (from, to) => real.copyFile(from, to),
    mkdir: (path) => real.mkdir(path),
    unlink: (path) => real.unlink(path),
    readdir: (path) => real.readdir(path),
    stat: (path) => real.stat(path),
  };
}
