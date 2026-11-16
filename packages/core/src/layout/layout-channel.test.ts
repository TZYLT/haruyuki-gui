/**
 * Tests for the layout channel (the wiring/contract; docs/36 sections 3.6, 4.3.7, 4.3.13;
 * docs/35 section 6.6).
 *
 * Every case runs against an in-memory pipe -- `send` collects frames, the
 * stores are a controllable stub -- which is the transport-neutrality
 * shortcut. The save-window cases use vitest fake timers through the default
 * scheduler, because a real 800 ms sleep in a unit test is a bug of its own; the
 * end-to-end case at the bottom uses a real store, a real draft store and a real
 * temporary directory, because the frame body and the write have to be seen on
 * the production path at least once.
 *
 * What each block pins down:
 *
 *   - one `layout.snapshot` bulk frame, body `{...status, revision, items:[doc]}`,
 *     no `page` fields and no invented `seq`;
 *   - ten changes in one window are one `store.save`, last document wins;
 *   - a later request does not restart the window;
 *   - a stale `baseRevision` is refused at call time and again after the save it
 *     waited for, without a second write;
 *   - a throwing `send` never rolls back a durable save;
 *   - a failed or throwing `store.save` answers instead of stranding the caller;
 *   - draft get/set/clear delegate, and are not throttled;
 *   - `flush` and `close` write the open window exactly once.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Frame,
  LayoutDoc,
  LayoutSaveAck,
  LayoutSnapshotBody,
  LayoutStatus,
} from "@haruyuki/protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDraftStore } from "./draft-store";
import type { DraftStore } from "./draft-store";
import { createNodeLayoutFs } from "./layout-fs";
import { LAYOUT_SAVE_WINDOW_MS, createLayoutChannel } from "./layout-channel";
import type { LayoutChannel } from "./layout-channel";
import { draftPath, layoutPath } from "./layout-paths";
import { createLayoutStore } from "./layout-store";
import type { LayoutSaveResult, LayoutStore } from "./layout-store";

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/layout/", import.meta.url));
const KNOWN = new Set(["sample.conversation", "sample.settings"]);
const USER_DATA = "engine-home";

const OK_STATUS: LayoutStatus = {
  outcome: "ok",
  writable: true,
  foundVersion: 1,
  unknownPageIds: [],
};

/** A minimal valid document; the channel never validates, the store does. */
function tabDoc(tabId: string): LayoutDoc {
  return {
    version: 1,
    root: { type: "panel", id: "p1", tabs: [{ tabId, pageId: "sample.conversation" }] },
  };
}

interface FakeStore {
  store: LayoutStore;
  state: { doc: LayoutDoc; revision: number; status: LayoutStatus };
  saved: LayoutDoc[];
  setSave(next: (doc: LayoutDoc) => Promise<LayoutSaveResult>): void;
}

/**
 * A structural `LayoutStore` stub: the channel only calls these nine methods,
 * and this is what lets a test freeze `save` in flight or make it fail.
 */
function createFakeStore(
  init: { revision?: number; status?: LayoutStatus; doc?: LayoutDoc } = {},
): FakeStore {
  const state = {
    doc: init.doc ?? tabDoc("tab-1"),
    revision: init.revision ?? 0,
    status: init.status ?? OK_STATUS,
  };
  const saved: LayoutDoc[] = [];
  // The real store adopts the merged document on a successful write, so a
  // snapshot published after a save must show the new document, not the old one.
  let saveImpl: (doc: LayoutDoc) => Promise<LayoutSaveResult> = async (next) => {
    state.doc = next;
    state.revision += 1;
    return { ok: true, revision: state.revision };
  };

  const store: LayoutStore = {
    async load() {
      return {
        ok: true,
        doc: state.doc,
        outcome: state.status.outcome,
        writable: state.status.writable,
        foundVersion: state.status.foundVersion,
        unknownPageIds: [...state.status.unknownPageIds],
      };
    },
    async save(next) {
      saved.push(next);
      return saveImpl(next);
    },
    validate(value) {
      return { ok: true, doc: value as LayoutDoc, unknownPageIds: [] };
    },
    getDoc() {
      return structuredClone(state.doc);
    },
    getRevision() {
      return state.revision;
    },
    isWritable() {
      return state.status.writable;
    },
    getStatus() {
      return { ...state.status, unknownPageIds: [...state.status.unknownPageIds] };
    },
    async flush() {},
    async close() {},
  };

  return {
    store,
    state,
    saved,
    setSave(next) {
      saveImpl = next;
    },
  };
}

/** A draft store that keeps its text in a map; the real one is used separately. */
function createFakeDraftStore(): { store: DraftStore; drafts: Map<string, string> } {
  const drafts = new Map<string, string>();
  return {
    drafts,
    store: {
      async loadDraft(conversationId) {
        return drafts.get(conversationId) ?? null;
      },
      async saveDraft(conversationId, text) {
        drafts.set(conversationId, text);
        return { ok: true };
      },
      async clearDraft(conversationId) {
        drafts.delete(conversationId);
        return { ok: true };
      },
      async flush() {},
      async close() {},
    },
  };
}

function collector(): { frames: Frame[]; send: (frame: Frame) => void } {
  const frames: Frame[] = [];
  return {
    frames,
    send(frame) {
      frames.push(frame);
    },
  };
}

interface LogEntry {
  code: string;
  detail: Record<string, unknown> | undefined;
}

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

function bodyOf(frame: Frame | undefined): LayoutSnapshotBody {
  return frame?.body as LayoutSnapshotBody;
}

let root: string;
let defaultDoc: LayoutDoc;

beforeAll(async () => {
  defaultDoc = JSON.parse(await readFile(join(FIXTURES, "default.json"), "utf8")) as LayoutDoc;
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "haruyuki-layout-channel-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("publish", () => {
  it("sends one layout.snapshot bulk frame with status, revision and one item", () => {
    const fake = createFakeStore({
      revision: 3,
      status: { ...OK_STATUS, unknownPageIds: ["vendor.future"] },
    });
    const { frames, send } = collector();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send,
    });

    channel.publish();

    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame).toMatchObject({ v: 1, ch: "bulk", seq: 0, t: "layout.snapshot" });
    // The C5 sender mints the three page fields; producing them here would fork
    // the paging contract.
    expect(frame !== undefined && "page" in frame).toBe(false);
    expect(bodyOf(frame)).toEqual({
      outcome: "ok",
      writable: true,
      foundVersion: 1,
      unknownPageIds: ["vendor.future"],
      revision: 3,
      items: [fake.store.getDoc()],
    });
  });

  it("logs a throwing send and does not throw at the caller", () => {
    const fake = createFakeStore();
    const { entries, log } = createLog();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send() {
        throw new Error("transport down");
      },
      log,
    });

    expect(() => channel.publish()).not.toThrow();
    expect(entries).toContainEqual({
      code: "LAYOUT_IO_ERROR",
      detail: { phase: "publish", step: "send" },
    });
  });
});

describe("handleState", () => {
  it("replies with the current status, revision and document", () => {
    const fake = createFakeStore({ revision: 2 });
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send: collector().send,
    });

    const state = channel.handleState();

    expect(state).toEqual({ ...OK_STATUS, revision: 2, doc: fake.store.getDoc() });
    // A caller mutating the reply must not reach the store's document.
    expect(state.doc).not.toBe(fake.store.getDoc());
  });
});

describe("handleSave", () => {
  it("coalesces ten requests into one write: last document wins", async () => {
    vi.useFakeTimers();
    const fake = createFakeStore();
    const { frames, send } = collector();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send,
    });

    const acks: Promise<LayoutSaveAck>[] = [];
    for (let index = 1; index <= 10; index += 1) {
      acks.push(channel.handleSave({ baseRevision: 0, doc: tabDoc(`tab-${index}`) }));
    }
    expect(fake.saved).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_WINDOW_MS - 1);
    expect(fake.saved).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.saved).toHaveLength(1);
    expect(fake.saved[0]).toEqual(tabDoc("tab-10"));

    const results = await Promise.all(acks);
    expect(results).toHaveLength(10);
    expect(results.every((ack) => ack.ok)).toBe(true);
    expect(results.at(-1)).toEqual({ ok: true, revision: 1 });

    // One snapshot after the write, carrying the written document and revision.
    expect(frames).toHaveLength(1);
    expect(bodyOf(frames[0]).revision).toBe(1);
    expect(bodyOf(frames[0]).items).toEqual([tabDoc("tab-10")]);
  });

  it("does not restart the window when a later request arrives", async () => {
    vi.useFakeTimers();
    const fake = createFakeStore();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send: collector().send,
    });

    const first = channel.handleSave({ baseRevision: 0, doc: tabDoc("tab-1") });
    await vi.advanceTimersByTimeAsync(700);
    const second = channel.handleSave({ baseRevision: 0, doc: tabDoc("tab-2") });
    await vi.advanceTimersByTimeAsync(99);
    expect(fake.saved).toHaveLength(0);

    // 800 ms after the FIRST request, not 700 + 800.
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.saved).toEqual([tabDoc("tab-2")]);
    await expect(first).resolves.toEqual({ ok: true, revision: 1 });
    await expect(second).resolves.toEqual({ ok: true, revision: 1 });
  });

  it("refuses a stale baseRevision at call time and publishes the current snapshot", async () => {
    const fake = createFakeStore({ revision: 4 });
    const { frames, send } = collector();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send,
    });

    const ack = await channel.handleSave({ baseRevision: 3, doc: tabDoc("tab-9") });

    expect(ack).toEqual({ ok: false, code: "LAYOUT_REVISION_STALE", revision: 4 });
    expect(frames).toHaveLength(1);
    expect(bodyOf(frames[0]).revision).toBe(4);
    expect(bodyOf(frames[0]).items).toEqual([fake.store.getDoc()]);

    // Nothing was queued: a flush must not write the stale document.
    await channel.flush();
    expect(fake.saved).toHaveLength(0);
  });

  it("re-checks after the save in flight and refuses the queued batch (4.3.13)", async () => {
    vi.useFakeTimers();
    const fake = createFakeStore();
    let release: (result: LayoutSaveResult) => void = () => undefined;
    fake.setSave(
      () =>
        new Promise<LayoutSaveResult>((resolve) => {
          release = resolve;
        }),
    );
    const { frames, send } = collector();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send,
    });

    const first = channel.handleSave({ baseRevision: 0, doc: tabDoc("tab-1") });
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_WINDOW_MS);
    expect(fake.saved).toHaveLength(1); // the write is now in flight

    // A second change arrives while that write is in flight, still based on 0.
    const second = channel.handleSave({ baseRevision: 0, doc: tabDoc("tab-2") });
    await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_WINDOW_MS);

    // The first write completes and advances the revision: the second is stale.
    fake.state.revision = 1;
    fake.state.doc = tabDoc("tab-1");
    release({ ok: true, revision: 1 });

    await expect(first).resolves.toEqual({ ok: true, revision: 1 });
    await expect(second).resolves.toEqual({
      ok: false,
      code: "LAYOUT_REVISION_STALE",
      revision: 1,
    });
    // Saves are serialized: the queued batch never reached the store.
    expect(fake.saved).toHaveLength(1);
    // A success snapshot plus the snapshot that re-bases the renderer.
    expect(frames).toHaveLength(2);
    expect(bodyOf(frames[1]).revision).toBe(1);
  });

  it("keeps the ack ok when send throws after a successful save", async () => {
    const fake = createFakeStore();
    const { entries, log } = createLog();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send() {
        throw new Error("transport down");
      },
      log,
    });

    const ack = channel.handleSave({ baseRevision: 0, doc: tabDoc("tab-1") });
    await channel.flush();

    await expect(ack).resolves.toEqual({ ok: true, revision: 1 });
    expect(fake.saved).toHaveLength(1);
    expect(entries).toContainEqual({
      code: "LAYOUT_IO_ERROR",
      detail: { phase: "publish", step: "send" },
    });
  });

  it("answers with the store's code when the write fails", async () => {
    const fake = createFakeStore();
    fake.setSave(async () => ({ ok: false, code: "LAYOUT_INVALID" }));
    const { frames, send } = collector();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send,
    });

    const ack = channel.handleSave({ baseRevision: 0, doc: tabDoc("tab-1") });
    await channel.flush();

    await expect(ack).resolves.toEqual({
      ok: false,
      code: "LAYOUT_INVALID",
      revision: 0,
    });
    expect(frames).toHaveLength(0); // nothing changed, so nothing to publish
  });

  it("answers instead of stranding the caller when store.save throws", async () => {
    const fake = createFakeStore();
    fake.setSave(async () => {
      throw new Error("unexpected");
    });
    const { entries, log } = createLog();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send: collector().send,
      log,
    });

    const ack = channel.handleSave({ baseRevision: 0, doc: tabDoc("tab-1") });
    await channel.flush();

    await expect(ack).resolves.toEqual({
      ok: false,
      code: "LAYOUT_IO_ERROR",
      revision: 0,
    });
    expect(entries).toContainEqual({
      code: "LAYOUT_IO_ERROR",
      detail: { phase: "save", step: "throw" },
    });
  });
});

describe("drafts", () => {
  it("delegates get/set/clear to the draft store, one conversation at a time", async () => {
    const fake = createFakeStore();
    const real = createDraftStore({
      fs: createNodeLayoutFs(),
      draftsPath: draftPath(join(root, USER_DATA), "desktop"),
    });
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: real,
      send: collector().send,
    });

    await expect(channel.handleDraftSet("c1", "甲")).resolves.toEqual({ ok: true });
    await expect(channel.handleDraftSet("c2", "乙")).resolves.toEqual({ ok: true });
    await expect(channel.handleDraftGet("c1")).resolves.toEqual({ text: "甲" });
    await expect(channel.handleDraftGet("c2")).resolves.toEqual({ text: "乙" });

    await expect(channel.handleDraftClear("c1")).resolves.toEqual({ ok: true });
    await expect(channel.handleDraftGet("c1")).resolves.toEqual({ text: null });
    await expect(channel.handleDraftGet("c2")).resolves.toEqual({ text: "乙" });
  });
});

describe("flush and close", () => {
  it("writes the open window immediately and does it only once", async () => {
    const fake = createFakeStore();
    const { frames, send } = collector();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send,
    });

    const first = channel.handleSave({ baseRevision: 0, doc: tabDoc("tab-1") });
    const second = channel.handleSave({ baseRevision: 0, doc: tabDoc("tab-2") });
    await channel.flush();

    await expect(first).resolves.toEqual({ ok: true, revision: 1 });
    await expect(second).resolves.toEqual({ ok: true, revision: 1 });
    expect(fake.saved).toEqual([tabDoc("tab-2")]);
    expect(frames).toHaveLength(1);

    // A second flush has nothing left to write.
    await channel.flush();
    expect(fake.saved).toHaveLength(1);
  });

  it("close flushes the pending window, then refuses later saves", async () => {
    const fake = createFakeStore();
    const { frames, send } = collector();
    const channel = createLayoutChannel({
      store: fake.store,
      draftStore: createFakeDraftStore().store,
      send,
    });

    const ack = channel.handleSave({ baseRevision: 0, doc: tabDoc("tab-1") });
    await channel.close();

    await expect(ack).resolves.toEqual({ ok: true, revision: 1 });
    expect(fake.saved).toHaveLength(1);
    expect(frames).toHaveLength(1);

    // A late save must not arm a timer the owner already shut down.
    await expect(channel.handleSave({ baseRevision: 1, doc: tabDoc("tab-2") })).resolves.toEqual({
      ok: false,
      code: "LAYOUT_IO_ERROR",
      revision: 1,
    });
    await channel.close(); // idempotent
    expect(fake.saved).toHaveLength(1);
  });
});

describe("end to end over a real store", () => {
  it("publishes the loaded document and persists one coalesced save", async () => {
    const fs = createNodeLayoutFs();
    const userData = join(root, USER_DATA);
    const store = createLayoutStore({
      fs,
      layoutPath: layoutPath(userData, "desktop"),
      defaultDoc,
      knownPageIds: KNOWN,
    });
    await expect(store.load()).resolves.toMatchObject({ ok: true });

    const drafts = createDraftStore({ fs, draftsPath: draftPath(userData, "desktop") });
    const { frames, send } = collector();
    const channel: LayoutChannel = createLayoutChannel({
      store,
      draftStore: drafts,
      send,
      saveWindowMs: 10,
    });

    channel.publish();
    expect(frames).toHaveLength(1);
    expect(bodyOf(frames[0])).toEqual({
      ...store.getStatus(),
      revision: 0,
      items: [store.getDoc()],
    });

    const ack = await channel.handleSave({ baseRevision: 0, doc: store.getDoc() });
    expect(ack).toEqual({ ok: true, revision: 1 });
    expect(frames).toHaveLength(2);
    expect(bodyOf(frames[1]).revision).toBe(1);

    // The saved bytes are what the next load will read.
    const written = JSON.parse(await readFile(layoutPath(userData, "desktop"), "utf8")) as {
      version: number;
      root: { type: string };
    };
    expect(written.version).toBe(1);
    expect(written.root.type).not.toBe(undefined);

    expect(channel.handleState()).toEqual({
      ...store.getStatus(),
      revision: 1,
      doc: store.getDoc(),
    });

    await channel.close();
    await drafts.close();
    await store.close();
  });
});
