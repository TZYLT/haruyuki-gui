/**
 * Tests for the layout store: the load ladder and the save path.
 *
 * The acceptance criteria in docs/35 section 5.1 are what these cases encode,
 * so each block names the V-* it covers:
 *
 *   - the default fixture loads as `ok`
 *   - the complex fixture round-trips without losing unknown tabs or extras
 *   - the corrupt fixture falls back to the default, keeps its unknown tab in a
 *         in a recovery panel, backs the original bytes up, and does not touch
 *         the file during `load`
 *   - an unknown tab the renderer dropped is merged back, never silently lost
 *   - a newer version is read-only and `save` refuses instead of downgrading
 *   - a failed rename leaves the old file readable and the revision unchanged
 *   - an oversized candidate is refused without writing
 *   - an unparseable file is backed up, falls back, and becomes writable
 *
 * Real `node:fs/promises` runs against a disposable `mkdtemp` directory for
 * every normal path. Only the failure paths (read error, rename failure) use an
 * in-memory `LayoutFs`, because those states cannot be produced on demand on a
 * real filesystem -- injection exists for exactly this.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LayoutDoc } from "@haruyuki/protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createNodeLayoutFs } from "./layout-fs";
import type { LayoutFs } from "./layout-fs";
import { createLayoutStore } from "./layout-store";
import type { LayoutLoadResult, LayoutStore } from "./layout-store";

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/layout/", import.meta.url));

/** The pages this build knows; everything else in a fixture is unknown. */
const KNOWN = new Set(["sample.conversation", "sample.settings"]);

let root: string;
let defaultDoc: LayoutDoc;

beforeAll(async () => {
  defaultDoc = JSON.parse(await readFile(join(FIXTURES, "default.json"), "utf8")) as LayoutDoc;
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "haruyuki-layout-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function layoutDirectory(): string {
  return join(root, "layout");
}

function targetPath(): string {
  return join(layoutDirectory(), "desktop.json");
}

async function readFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES, name), "utf8");
}

/** Put `text` at the layout key, creating `layout/` first. */
async function seedFile(text: string): Promise<void> {
  await mkdir(layoutDirectory(), { recursive: true });
  await writeFile(targetPath(), text, "utf8");
}

/** A clock that advances one second per call, so backups get distinct names. */
function steppingClock(start = "2026-11-16T21:30:24.000Z"): () => Date {
  let offset = 0;
  const base = Date.parse(start);
  return () => {
    const now = new Date(base + offset * 1000);
    offset += 1;
    return now;
  };
}

function makeStore(overrides: Partial<Parameters<typeof createLayoutStore>[0]> = {}): LayoutStore {
  return createLayoutStore({
    fs: createNodeLayoutFs(),
    layoutPath: targetPath(),
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

async function backups(): Promise<string[]> {
  try {
    const names = await readdir(layoutDirectory());
    return names.filter((name) => name.startsWith("desktop.corrupt-")).sort();
  } catch {
    return [];
  }
}

/** Panel nodes in document order; tests need to find the recovery panel. */
function panelsOf(
  doc: LayoutDoc,
): Array<{ id: string; tabs: Array<{ tabId: string; pageId: string }> }> {
  const panels: Array<{ id: string; tabs: Array<{ tabId: string; pageId: string }> }> = [];

  const visit = (node: { type: string }): void => {
    if (node.type === "panel") {
      const panel = node as unknown as LayoutDoc["root"];
      panels.push(
        panel as unknown as { id: string; tabs: Array<{ tabId: string; pageId: string }> },
      );
      return;
    }

    for (const child of (node as unknown as { children: Array<{ type: string }> }).children) {
      visit(child);
    }
  };

  visit(doc.root);

  return panels;
}

/** The mutable panel node `id`, so a test can drop a tab the way a renderer would. */
function findPanel(doc: LayoutDoc, id: string): { id: string; tabs: Array<{ tabId: string }> } {
  const visit = (
    node: LayoutDoc["root"],
  ): { id: string; tabs: Array<{ tabId: string }> } | null => {
    if (node.type === "panel") {
      return node.id === id
        ? (node as unknown as { id: string; tabs: Array<{ tabId: string }> })
        : null;
    }

    for (const child of node.children) {
      const hit = visit(child);

      if (hit !== null) {
        return hit;
      }
    }

    return null;
  };

  const panel = visit(doc.root);

  if (panel === null) {
    throw new Error(`test document has no panel ${id}`);
  }

  return panel;
}

/**
 * A nested document with unique ids, unknown pages and unknown keys at every
 * level.
 *
 * Built here rather than read from `fixtures/layout/complex.json` because the
 * store's contract is about behaviour, not about one fixture's exact tree; the
 * signed fixture is exercised by the integration suite. `tabId` is globally
 * unique by contract, so the bottom settings tab is `settings-bottom`.
 */
function complexDoc(): LayoutDoc {
  return {
    version: 1,
    root: {
      type: "split",
      orientation: "horizontal",
      children: [
        {
          type: "split",
          orientation: "vertical",
          children: [
            {
              type: "split",
              orientation: "horizontal",
              children: [
                {
                  type: "panel",
                  id: "top-left",
                  tabs: [
                    { tabId: "conversation", pageId: "sample.conversation" },
                    {
                      tabId: "future",
                      pageId: "vendor.future",
                      props: { seed: 7 },
                      extras: { "x-tab": "keep" },
                    },
                    { tabId: "settings", pageId: "sample.settings" },
                  ],
                  activeTabId: "future",
                  extras: { widthHint: 0.62, "x-panel": "keep" },
                },
                { type: "panel", id: "top-right", tabs: [] },
              ],
              sizes: [0.5, 0.5],
              extras: { "x-split": "keep" },
            },
            {
              type: "panel",
              id: "bottom",
              tabs: [{ tabId: "settings-bottom", pageId: "sample.settings" }],
              activeTabId: "settings-bottom",
            },
          ],
          sizes: [0.55, 0.45],
          extras: { "x-split": "keep" },
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
      sizes: [0.62, 0.38],
      extras: { locked: false, "x-split": "keep" },
    },
    activePanelId: "bottom",
    extras: { schemaNote: "C4 sample", "x-doc": "keep" },
  };
}

describe("load: normal files", () => {
  it("treats a missing file as the first run (default, writable, no version)", async () => {
    const result = loaded(await makeStore().load());

    expect(result.outcome).toBe("default");
    expect(result.writable).toBe(true);
    expect(result.foundVersion).toBeNull();
    expect(result.unknownPageIds).toEqual([]);
    expect(result.doc).toEqual(defaultDoc);

    // load must not create the file: the first save does that.
    await expect(stat(targetPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads the default fixture as ok", async () => {
    await seedFile(await readFixture("default.json"));

    const result = loaded(await makeStore().load());

    expect(result.outcome).toBe("ok");
    expect(result.writable).toBe(true);
    expect(result.foundVersion).toBe(1);
    expect(result.doc.version).toBe(1);
    expect(result.doc.root).toMatchObject({
      type: "split",
      orientation: "horizontal",
      sizes: [0.6, 0.4],
    });
    expect(panelsOf(result.doc).map((panel) => panel.id)).toEqual(["left", "right"]);
    expect(result.unknownPageIds).toEqual([]);
  });

  it("treats a missing version as v1 and stays writable", async () => {
    const withoutVersion = JSON.parse(await readFixture("default.json")) as Record<string, unknown>;
    delete withoutVersion["version"];
    await seedFile(JSON.stringify(withoutVersion));

    const result = loaded(await makeStore().load());

    expect(result.outcome).toBe("ok");
    expect(result.foundVersion).toBeNull();
    expect(result.writable).toBe(true);
    expect(result.doc.version).toBe(1);
  });

  it("loads a nested document and lists unknown pages in document order", async () => {
    await seedFile(JSON.stringify(complexDoc()));

    const result = loaded(await makeStore().load());

    expect(result.outcome).toBe("ok");
    expect(result.writable).toBe(true);
    expect(result.foundVersion).toBe(1);
    expect(result.unknownPageIds).toEqual(["vendor.future", "vendor.closed"]);
    expect(result.doc.extras).toEqual({ schemaNote: "C4 sample", "x-doc": "keep" });
    expect(result.doc.root).toMatchObject({
      type: "split",
      orientation: "horizontal",
      sizes: [0.62, 0.38],
    });
  });
});

describe("load: corrupt or unreadable files", () => {
  it("falls back on a parseable but invalid file, keeps its unknown tab", async () => {
    const original = await readFixture("corrupt.json");
    await seedFile(original);

    const store = makeStore();
    const result = loaded(await store.load());

    expect(result.outcome).toBe("fell-back-to-default");
    expect(result.writable).toBe(true);
    expect(result.foundVersion).toBe(1);
    expect(result.unknownPageIds).toEqual(["vendor.future"]);

    // The default document, extended with a recovery panel holding the tab.
    const panels = panelsOf(result.doc);
    expect(panels[0]?.id).toBe("left");
    const recovered = panels.find((panel) => panel.id.startsWith("recovered-"));
    expect(recovered).toBeDefined();
    expect(recovered?.tabs.map((tab) => tab.pageId)).toEqual(["vendor.future"]);

    // Load backs up but never rewrites the target.
    expect(await readFile(targetPath(), "utf8")).toBe(original);
    const names = await backups();
    expect(names).toHaveLength(1);
    expect(await readFile(join(layoutDirectory(), names[0] as string), "utf8")).toBe(original);
  });

  it("falls back on an unparseable file, backs it up and stays writable", async () => {
    await seedFile("{\n");

    const store = makeStore();
    const result = loaded(await store.load());

    expect(result.outcome).toBe("corrupt");
    expect(result.writable).toBe(true);
    expect(result.foundVersion).toBeNull();
    expect(result.doc).toEqual(defaultDoc);
    expect(await readFile(targetPath(), "utf8")).toBe("{\n");
    expect(await backups()).toHaveLength(1);

    // The next intentional save is how the file comes back.
    const saved = await store.save(defaultDoc);
    expect(saved).toEqual({ ok: true, revision: 1 });
    expect(JSON.parse(await readFile(targetPath(), "utf8"))).toEqual(defaultDoc);
  });

  it("refuses to read or overwrite a newer version", async () => {
    const newer = JSON.stringify({ version: 2, root: { type: "panel", id: "future", tabs: [] } });
    await seedFile(newer);

    const store = makeStore();
    const result = loaded(await store.load());

    expect(result.outcome).toBe("unsupported-version");
    expect(result.writable).toBe(false);
    expect(result.foundVersion).toBe(2);
    expect(result.doc).toEqual(defaultDoc);
    expect(store.isWritable()).toBe(false);

    const saved = await store.save(defaultDoc);
    expect(saved).toEqual({ ok: false, code: "LAYOUT_UNSUPPORTED_VERSION" });
    expect(await readFile(targetPath(), "utf8")).toBe(newer);
  });

  it("becomes read-only after a read error and refuses to save over the unknown file", async () => {
    const original = await readFixture("default.json");
    const fake = createFakeFs({ [targetPath()]: original }, { read: true });

    const store = makeStore({ fs: fake.fs });
    const result = loaded(await store.load());

    expect(result.outcome).toBe("read-error");
    expect(result.writable).toBe(false);
    expect(result.foundVersion).toBeNull();
    expect(await store.save(defaultDoc)).toEqual({ ok: false, code: "LAYOUT_IO_ERROR" });
    expect(fake.files.get(targetPath())).toBe(original);
  });

  it("treats an oversized file as corrupt without reading it", async () => {
    const oversized = "x".repeat(1024 * 1024 + 1);
    await seedFile(oversized);

    const result = loaded(await makeStore().load());

    expect(result.outcome).toBe("corrupt");
    expect(result.writable).toBe(true);
    expect(result.doc).toEqual(defaultDoc);
    expect(await backups()).toHaveLength(1);
    // Bytes are copied, never rewritten.
    await expect(stat(targetPath())).resolves.toMatchObject({ size: oversized.length });
  });

  it("keeps only the newest three backups", async () => {
    const original = await readFixture("corrupt.json");
    await seedFile(original);

    // One clock shared by the four stores, so every backup gets a new name.
    const clock = steppingClock();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      loaded(await makeStore({ clock }).load());
    }

    const names = await backups();
    expect(names).toHaveLength(3);
    // The first (oldest) timestamp was pruned; the last three survive.
    expect(names[0]).toContain("21-30-25-000Z");
    expect(names[2]).toContain("21-30-27-000Z");
  });
});

describe("save", () => {
  it("merges back an unknown tab the renderer dropped", async () => {
    await seedFile(JSON.stringify(complexDoc()));

    const store = makeStore();
    const load = loaded(await store.load());
    expect(load.unknownPageIds).toEqual(["vendor.future", "vendor.closed"]);

    // Simulate a renderer that only knows its own pages: it drops the unknown
    // tab from its panel but keeps everything else (including hidden).
    const next = structuredClone(load.doc);
    const topLeft = findPanel(next, "top-left");
    topLeft.tabs.splice(
      topLeft.tabs.findIndex((tab) => tab.tabId === "future"),
      1,
    );

    const saved = await store.save(next);
    expect(saved).toEqual({ ok: true, revision: 1 });

    const onDisk = JSON.parse(await readFile(targetPath(), "utf8")) as LayoutDoc;
    const panelIds = panelsOf(onDisk).flatMap((panel) => panel.tabs.map((tab) => tab.tabId));
    expect(panelIds).toContain("future");
    expect(panelIds).toContain("closed-future");
    // Restored where it was: the same panel, the same index.
    expect(findPanel(onDisk, "top-left").tabs.map((tab) => tab.tabId)).toEqual([
      "conversation",
      "future",
      "settings",
    ]);

    // A fresh store sees both unknown pages, so the save did not lose them.
    const reloaded = loaded(await makeStore().load());
    expect(reloaded.unknownPageIds).toEqual(["vendor.future", "vendor.closed"]);
  });

  it("advances the revision only on a completed write", async () => {
    await seedFile(await readFixture("default.json"));
    const store = makeStore();
    loaded(await store.load());

    const first = structuredClone(store.getDoc());
    first.extras = { step: 1 };
    expect(await store.save(first)).toEqual({ ok: true, revision: 1 });
    expect(store.getRevision()).toBe(1);

    const second = structuredClone(store.getDoc());
    second.extras = { step: 2 };
    expect(await store.save(second)).toEqual({ ok: true, revision: 2 });
    expect(store.getRevision()).toBe(2);

    const onDisk = JSON.parse(await readFile(targetPath(), "utf8")) as LayoutDoc;
    expect(onDisk.extras).toEqual({ step: 2 });
    expect(await readFile(targetPath(), "utf8")).toBe(`${JSON.stringify(onDisk)}\n`);
  });

  it("keeps the old file readable and the revision unchanged when rename fails", async () => {
    const original = await readFixture("default.json");
    const fake = createFakeFs({ [targetPath()]: original }, { rename: true });

    const store = makeStore({ fs: fake.fs });
    const before = loaded(await store.load());
    const candidate = structuredClone(before.doc);
    candidate.extras = { replaced: true };

    expect(await store.save(candidate)).toEqual({ ok: false, code: "LAYOUT_IO_ERROR" });

    // Old file intact, no temporary left behind, store still describes old doc.
    expect(fake.files.get(targetPath())).toBe(original);
    expect([...fake.files.keys()].filter((path) => path.includes(".tmp-"))).toEqual([]);
    expect(store.getRevision()).toBe(0);
    expect(store.getDoc().extras).toBeUndefined();
  });

  it("rejects a 300 KiB document as too large without writing", async () => {
    const store = makeStore();
    loaded(await store.load());

    const huge: LayoutDoc = {
      version: 1,
      root: {
        type: "panel",
        id: "main",
        tabs: [
          {
            tabId: "big",
            pageId: "sample.conversation",
            props: { blob: "x".repeat(300 * 1024) },
          },
        ],
      },
    };

    expect(await store.save(huge)).toMatchObject({ ok: false, code: "LAYOUT_TOO_LARGE" });
    expect(store.getRevision()).toBe(0);
    await expect(stat(targetPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a save before load()", async () => {
    expect(await makeStore().save(defaultDoc)).toEqual({
      ok: false,
      code: "LAYOUT_INVALID",
      detail: "save() before load()",
    });
  });

  it("hands out clones so a caller cannot mutate the authoritative document", async () => {
    await seedFile(await readFixture("default.json"));
    const store = makeStore();
    loaded(await store.load());

    const copy = store.getDoc();
    findPanel(copy, "left").tabs.push({ tabId: "intruder" });

    expect(
      panelsOf(store.getDoc())
        .find((panel) => panel.id === "left")
        ?.tabs.map((tab) => tab.tabId),
    ).toEqual(["conversation"]);
    expect(store.getStatus().unknownPageIds).toEqual([]);
  });

  it("keeps the two shells' files independent", async () => {
    const desktopPath = targetPath();
    const vscodePath = join(layoutDirectory(), "vscode.json");
    const desktop = makeStore({ layoutPath: desktopPath });
    const vscode = makeStore({ layoutPath: vscodePath });

    loaded(await desktop.load());
    loaded(await vscode.load());

    const desktopDoc = structuredClone(desktop.getDoc());
    desktopDoc.extras = { shell: "desktop" };
    const vscodeDoc = structuredClone(vscode.getDoc());
    vscodeDoc.extras = { shell: "vscode" };

    expect(await desktop.save(desktopDoc)).toEqual({ ok: true, revision: 1 });
    expect(await vscode.save(vscodeDoc)).toEqual({ ok: true, revision: 1 });

    expect(JSON.parse(await readFile(desktopPath, "utf8")).extras).toEqual({ shell: "desktop" });
    expect(JSON.parse(await readFile(vscodePath, "utf8")).extras).toEqual({ shell: "vscode" });
  });
});

describe("default document", () => {
  it("reports LAYOUT_NO_DEFAULT when the caller supplied an invalid default", async () => {
    const store = makeStore({
      defaultDoc: {
        version: 1,
        root: { type: "split", orientation: "horizontal", children: [] },
      } as unknown as LayoutDoc,
    });

    expect(await store.load()).toEqual({ ok: false, code: "LAYOUT_NO_DEFAULT" });
  });
});

type Failure = "write" | "rename" | "copy" | "unlink" | "readdir" | "read" | "stat";

/** In-memory `LayoutFs` with per-operation failure injection. */
function createFakeFs(
  seed: Record<string, string> = {},
  failures: Partial<Record<Failure, boolean>> = {},
): { fs: LayoutFs; files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  const failure = (code: string, operation: string): Error =>
    Object.assign(new Error(`${operation} failed`), { code });

  const fs: LayoutFs = {
    async readFile(path) {
      if (failures.read) throw failure("EIO", "read");
      return files.get(path) ?? null;
    },
    async writeFile(path, data) {
      if (failures.write) throw failure("EIO", "write");
      files.set(path, data);
    },
    async rename(from, to) {
      if (failures.rename) throw failure("EPERM", "rename");
      const data = files.get(from);
      if (data === undefined) throw failure("ENOENT", "rename");
      files.set(to, data);
      files.delete(from);
    },
    async copyFile(from, to) {
      if (failures.copy) throw failure("EIO", "copy");
      const data = files.get(from);
      if (data === undefined) throw failure("ENOENT", "copy");
      files.set(to, data);
    },
    async mkdir() {},
    async unlink(path) {
      if (failures.unlink) throw failure("EPERM", "unlink");
      if (!files.delete(path)) throw failure("ENOENT", "unlink");
    },
    async readdir(dir) {
      if (failures.readdir) throw failure("ENOTDIR", "readdir");
      return [...files.keys()]
        .filter((path) => dirname(path) === dir)
        .map((path) => path.slice(dir.length + 1));
    },
    async stat(path) {
      if (failures.stat) throw failure("EIO", "stat");
      const data = files.get(path);
      return data === undefined ? null : { size: Buffer.byteLength(data, "utf8") };
    },
  };

  return { fs, files };
}
