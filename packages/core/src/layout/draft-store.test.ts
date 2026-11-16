/**
 * Tests for the per-conversation draft store (`send.ts`; docs/36 section 7
 * renderer-recovery-sequence/main-crash-record/-; docs/35 section 6.8).
 *
 * The store is exercised against a real `mkdtemp` directory and the real
 * `createNodeLayoutFs` for everything the contract says about files: the missing
 * file, the reopen, the corruption backup, the 10 MiB `stat` guard, the two
 * shell keys. Two things are deliberately tested against an in-memory `LayoutFs`
 * instead: a write failure (a real filesystem cannot be made to fail on demand)
 * and the 10 MiB serialised-size eviction (the same ~11 MiB of text without
 * rewriting 20 MB of disk). That split is the point of the injectable `LayoutFs`
 * not a shortcut around the real adapter.
 *
 * The clock is injected wherever a test depends on `updatedAt` order, because
 * eviction is defined by that timestamp and a real clock would make the order a
 * race.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DRAFT_EVICTED_LOG, DRAFT_LIMITS, createDraftStore } from "./draft-store";
import type { DraftStore, DraftStoreOptions } from "./draft-store";
import { createNodeLayoutFs } from "./layout-fs";
import type { LayoutFs } from "./layout-fs";
import { draftPath } from "./layout-paths";

const USER_DATA = "engine-home";
const ISO_EARLY = "2026-01-01T00:00:00.000Z";
const ISO_LATE = "2026-01-02T00:00:00.000Z";

let root: string;
let draftsPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "haruyuki-draft-"));
  draftsPath = draftPath(join(root, USER_DATA), "desktop");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface LogEntry {
  code: string;
  detail: Record<string, unknown> | undefined;
}

/** Capture what the store logs so a test can assert the reason code, not prose. */
function createLog(): {
  entries: LogEntry[];
  log: (code: string, detail?: Record<string, unknown>) => void;
} {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(code, detail) {
      entries.push({ code, detail });
    },
  };
}

function open(
  overrides: Partial<Pick<DraftStoreOptions, "clock" | "log" | "fs" | "draftsPath">> = {},
): DraftStore {
  return createDraftStore({
    fs: overrides.fs ?? createNodeLayoutFs(),
    draftsPath: overrides.draftsPath ?? draftsPath,
    ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  });
}

/** Write a seed file as the previous version of the store would have. */
async function seed(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function draftEntries(raw: Record<string, unknown>): Record<string, { text: string }> {
  return raw.drafts as Record<string, { text: string }>;
}

function backupNames(names: string[]): string[] {
  return names.filter((name) => name.startsWith("drafts-desktop.corrupt-"));
}

/** A `LayoutFs` in memory, with a switch that makes writes fail. */
function createMemoryFs(initial: Record<string, string> = {}): {
  fs: LayoutFs;
  files: Map<string, string>;
  failWrites(flag: boolean): void;
} {
  const files = new Map<string, string>(Object.entries(initial));
  let failing = false;
  const fail = (): Error => Object.assign(new Error("injected write failure"), { code: "EIO" });
  return {
    files,
    failWrites(flag) {
      failing = flag;
    },
    fs: {
      async readFile(path) {
        return files.get(path) ?? null;
      },
      async writeFile(path, data) {
        if (failing) throw fail();
        files.set(path, data);
      },
      async rename(from, to) {
        if (failing) throw fail();
        const data = files.get(from);
        if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        files.delete(from);
        files.set(to, data);
      },
      async copyFile(from, to) {
        const data = files.get(from);
        if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        files.set(to, data);
      },
      async mkdir() {
        // Paths are keys; directories have no separate existence in memory.
      },
      async unlink(path) {
        if (!files.delete(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      async readdir(path) {
        const names: string[] = [];
        for (const file of files.keys()) {
          if (dirname(file) === path) names.push(basename(file));
        }
        return names;
      },
      async stat(path) {
        const data = files.get(path);
        return data === undefined ? null : { size: Buffer.byteLength(data, "utf8") };
      },
    },
  };
}

describe("createDraftStore", () => {
  it("answers null before the first save and creates the file on demand", async () => {
    const store = open();
    await expect(store.loadDraft("c1")).resolves.toBeNull();

    await expect(store.saveDraft("c1", "草稿一")).resolves.toEqual({ ok: true });

    const raw = await readJson(draftsPath);
    expect(raw.version).toBe(1);
    expect(draftEntries(raw).c1).toEqual({
      text: "草稿一",
      updatedAt: expect.any(String),
    });
  });

  it("keeps conversations apart, clears one and leaves the other", async () => {
    const store = open();
    await store.saveDraft("c1", "甲");
    await store.saveDraft("c2", "乙");

    await expect(store.loadDraft("c1")).resolves.toBe("甲");
    await expect(store.loadDraft("c2")).resolves.toBe("乙");
    await expect(store.loadDraft("absent")).resolves.toBeNull();

    await expect(store.clearDraft("c1")).resolves.toEqual({ ok: true });
    await expect(store.loadDraft("c1")).resolves.toBeNull();
    await expect(store.loadDraft("c2")).resolves.toBe("乙");
    // Clearing an absent conversation is a success, and does not touch c2.
    await expect(store.clearDraft("c1")).resolves.toEqual({ ok: true });
    await expect(store.loadDraft("c2")).resolves.toBe("乙");
  });

  it("survives a reopen: the ack means the bytes are already on disk", async () => {
    const first = open();
    await first.saveDraft("c1", "甲");
    await first.saveDraft("c2", "乙");
    await first.flush();
    await first.close();

    // No flush was needed before the raw file read: save writes immediately.
    const raw = await readJson(draftsPath);
    expect(Object.keys(draftEntries(raw)).sort()).toEqual(["c1", "c2"]);

    const reopened = open();
    await expect(reopened.loadDraft("c1")).resolves.toBe("甲");
    await expect(reopened.loadDraft("c2")).resolves.toBe("乙");
  });

  it("flushes and closes without losing the last write", async () => {
    const store = open();
    await store.saveDraft("c1", "甲");
    await store.flush();
    await store.close();
    await store.close(); // idempotent
    await store.flush(); // still a no-op after close

    // close() drains; it does not delete or truncate anything.
    const raw = await readJson(draftsPath);
    expect(draftEntries(raw).c1?.text).toBe("甲");
    await expect(open().loadDraft("c1")).resolves.toBe("甲");
  });

  it("rejects text above 1 MiB without writing it", async () => {
    const store = open();
    await store.saveDraft("c1", "small");
    const oversized = "x".repeat(DRAFT_LIMITS.maxEntryBytes + 1);

    await expect(store.saveDraft("c1", oversized)).resolves.toEqual({
      ok: false,
      code: "DRAFT_TOO_LARGE",
    });
    await expect(store.loadDraft("c1")).resolves.toBe("small");
    expect(await readJson(draftsPath)).toMatchObject({
      drafts: { c1: { text: "small" } },
    });

    // Exactly the limit is allowed: the rule is about text bytes, not a margin.
    const exact = "y".repeat(DRAFT_LIMITS.maxEntryBytes);
    await expect(store.saveDraft("c1", exact)).resolves.toEqual({ ok: true });
    await expect(store.loadDraft("c1")).resolves.toBe(exact);
  });

  it("backs up an unparseable file, starts empty and stays writable", async () => {
    await mkdir(dirname(draftsPath), { recursive: true });
    await writeFile(draftsPath, "{", "utf8");
    const { entries, log } = createLog();

    const store = open({ log });
    await expect(store.loadDraft("c1")).resolves.toBeNull();
    expect(entries).toContainEqual({
      code: "DRAFT_INVALID",
      detail: { phase: "load", step: "parse", backup: true },
    });

    const backups = backupNames(await readdir(dirname(draftsPath)));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dirname(draftsPath), backups[0] ?? ""), "utf8")).toBe("{");

    // A corrupt file is not a read-only file: the next save replaces it.
    await expect(store.saveDraft("c1", "新草稿")).resolves.toEqual({ ok: true });
    const reopened = open();
    await expect(reopened.loadDraft("c1")).resolves.toBe("新草稿");
  });

  it("backs up a file above 10 MiB without parsing it, then starts empty", async () => {
    const size = DRAFT_LIMITS.maxFileBytes + 1;
    await mkdir(dirname(draftsPath), { recursive: true });
    await writeFile(draftsPath, "x".repeat(size), "utf8");
    const { entries, log } = createLog();

    const store = open({ log });
    await expect(store.loadDraft("c1")).resolves.toBeNull();
    expect(entries.map((entry) => entry.code)).toContain("DRAFT_TOO_LARGE");
    // The guard runs before JSON.parse: the detail names the stat step only.
    expect(entries.at(-1)?.detail).toMatchObject({ step: "stat", bytes: size });

    const backups = backupNames(await readdir(dirname(draftsPath)));
    expect(backups).toHaveLength(1);
    await expect(stat(join(dirname(draftsPath), backups[0] ?? ""))).resolves.toMatchObject({
      size,
    });

    await expect(store.saveDraft("c1", "after")).resolves.toEqual({ ok: true });
    await expect(open().loadDraft("c1")).resolves.toBe("after");
  });

  it("drops a single bad entry and keeps the rest", async () => {
    await seed(draftsPath, {
      version: 1,
      drafts: {
        good: { text: "保留", updatedAt: ISO_EARLY },
        noText: { text: 5, updatedAt: ISO_EARLY },
        badDate: { text: "无时间", updatedAt: "not-a-date" },
      },
    });
    const { entries, log } = createLog();

    const store = open({ log });
    await expect(store.loadDraft("good")).resolves.toBe("保留");
    await expect(store.loadDraft("noText")).resolves.toBeNull();
    await expect(store.loadDraft("badDate")).resolves.toBeNull();
    expect(entries).toContainEqual({
      code: "DRAFT_INVALID",
      detail: { phase: "load", step: "entry", dropped: 2 },
    });

    // One bad entry is not a corrupt file, so there is nothing to back up.
    expect(backupNames(await readdir(dirname(draftsPath)))).toEqual([]);
    await expect(store.saveDraft("fresh", "新")).resolves.toEqual({ ok: true });
    const raw = await readJson(draftsPath);
    expect(Object.keys(draftEntries(raw)).sort()).toEqual(["fresh", "good"]);
  });

  it("preserves unknown file-level keys and rewrites entries as text+updatedAt", async () => {
    await seed(draftsPath, {
      version: 1,
      drafts: { c1: { text: "甲", updatedAt: ISO_EARLY, note: "not part of the entry" } },
      "x-file": { keep: true },
      extras: { a: 1 },
    });

    const store = open();
    await expect(store.saveDraft("c2", "乙")).resolves.toEqual({ ok: true });

    const raw = await readJson(draftsPath);
    expect(raw.version).toBe(1);
    expect(raw["x-file"]).toEqual({ keep: true });
    expect(raw.extras).toEqual({ a: 1 });
    // Entry keys are exactly the two the schema names; the smuggled `note` is gone.
    expect(Object.keys(draftEntries(raw).c1 ?? {}).sort()).toEqual(["text", "updatedAt"]);
    expect(draftEntries(raw).c2?.text).toBe("乙");
  });

  it("refuses to overwrite a newer version and leaves the bytes alone", async () => {
    const future = JSON.stringify({
      version: 2,
      drafts: { c1: { text: "未来的草稿", updatedAt: ISO_LATE } },
    });
    await mkdir(dirname(draftsPath), { recursive: true });
    await writeFile(draftsPath, future, "utf8");
    const { entries, log } = createLog();

    const store = open({ log });
    await expect(store.loadDraft("c1")).resolves.toBeNull();
    await expect(store.saveDraft("c1", "本版写入")).resolves.toEqual({
      ok: false,
      code: "DRAFT_INVALID",
    });
    await expect(store.clearDraft("c1")).resolves.toEqual({
      ok: false,
      code: "DRAFT_INVALID",
    });

    expect(await readFile(draftsPath, "utf8")).toBe(future);
    expect(backupNames(await readdir(dirname(draftsPath)))).toEqual([]);
    expect(entries.map((entry) => entry.code)).toContain("DRAFT_INVALID");
  });

  it("keeps the two shell files independent", async () => {
    const desktopPath = draftPath(join(root, USER_DATA), "desktop");
    const vscodePath = draftPath(join(root, USER_DATA), "vscode");
    const desktop = open({ draftsPath: desktopPath });
    const vscode = open({ draftsPath: vscodePath });

    await desktop.saveDraft("c1", "桌面壳的草稿");
    await vscode.saveDraft("c1", "VSCode 壳的草稿");

    await expect(desktop.loadDraft("c1")).resolves.toBe("桌面壳的草稿");
    await expect(vscode.loadDraft("c1")).resolves.toBe("VSCode 壳的草稿");
    expect(await readFile(desktopPath, "utf8")).not.toBe(await readFile(vscodePath, "utf8"));

    await desktop.clearDraft("c1");
    await expect(desktop.loadDraft("c1")).resolves.toBeNull();
    await expect(vscode.loadDraft("c1")).resolves.toBe("VSCode 壳的草稿");
  });

  it("evicts the oldest conversation when a write would exceed 1000 entries", async () => {
    const seeded: Record<string, { text: string; updatedAt: string }> = {};
    for (let index = 0; index < DRAFT_LIMITS.maxEntries; index += 1) {
      seeded[`c${index}`] = {
        text: `draft-${index}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
      };
    }
    await seed(draftsPath, { version: 1, drafts: seeded });
    const { entries, log } = createLog();
    const store = open({ clock: () => new Date(Date.UTC(2026, 1, 1)), log });

    await expect(store.saveDraft("fresh", "最新")).resolves.toEqual({ ok: true });

    const raw = await readJson(draftsPath);
    const kept = draftEntries(raw);
    expect(Object.keys(kept)).toHaveLength(DRAFT_LIMITS.maxEntries);
    expect(kept.c0).toBeUndefined(); // the oldest updatedAt went first
    expect(kept.c1?.text).toBe("draft-1");
    expect(kept.fresh?.text).toBe("最新");
    expect(entries).toContainEqual({
      code: DRAFT_EVICTED_LOG,
      detail: { phase: "save", evicted: 1, entries: DRAFT_LIMITS.maxEntries },
    });
  });

  it("evicts by updatedAt when the serialised file would exceed 10 MiB", async () => {
    const big = "a".repeat(1_000_000);
    const seeded: Record<string, { text: string; updatedAt: string }> = {};
    for (let index = 1; index <= 10; index += 1) {
      seeded[`c${index}`] = {
        text: big,
        updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
      };
    }
    const { fs, files } = createMemoryFs({
      [draftsPath]: JSON.stringify({ version: 1, drafts: seeded }),
    });
    const { entries, log } = createLog();
    const store = open({ fs, clock: () => new Date(Date.UTC(2026, 1, 1)), log });

    await expect(store.saveDraft("fresh", big)).resolves.toEqual({ ok: true });

    const written = files.get(draftsPath) ?? "";
    expect(Buffer.byteLength(written, "utf8")).toBeLessThanOrEqual(DRAFT_LIMITS.maxFileBytes);
    const kept = draftEntries(JSON.parse(written) as Record<string, unknown>);
    expect(kept.c1).toBeUndefined(); // oldest first
    expect(kept.c2?.text).toBe(big);
    expect(kept.fresh?.text).toBe(big);
    expect(entries.some((entry) => entry.code === DRAFT_EVICTED_LOG)).toBe(true);
  });

  it("reports a write failure and keeps the previous draft", async () => {
    const { fs, files, failWrites } = createMemoryFs();
    const { entries, log } = createLog();
    const store = open({ fs, log });
    await expect(store.saveDraft("c1", "旧草稿")).resolves.toEqual({ ok: true });

    failWrites(true);
    await expect(store.saveDraft("c1", "新草稿")).resolves.toEqual({
      ok: false,
      code: "DRAFT_IO_ERROR",
    });
    failWrites(false);

    // Memory did not advance, and the file still holds the last good version.
    await expect(store.loadDraft("c1")).resolves.toBe("旧草稿");
    expect(JSON.parse(files.get(draftsPath) ?? "")).toMatchObject({
      drafts: { c1: { text: "旧草稿" } },
    });
    expect(entries.map((entry) => entry.code)).toContain("DRAFT_IO_ERROR");
  });
});
