/**
 * The layout channel: the one path a renderer's layout change and draft text
 * take into core. `LayoutChannel` is that surface, and layout-channel.test.ts
 * pins the frame, revision and window behaviour it promises.
 *
 * Transport-neutral by construction
 *   The only way out is the injected `send`, and the only ways in are the
 *   methods below. Nothing here imports `electron`, `vscode`, `apps/*` or
 *   `packages/ui`, so the whole suite runs against an in-memory pipe: a test
 *   passes `send: (frame) => frames.push(frame)` and reads the snapshot back.
 *   That is the transport-neutrality requirement, not a testing convenience.
 *
 * One frame, no pages
 *   `publish` builds exactly one `layout.snapshot` on the `bulk` channel and
 *   hands it over untouched. It does not mint `seq` and it does not fill
 *   `page.watermark`/`page.token`/`page.more`: the shared frame sender
 *   (`createFrameSender`) numbers and pages a snapshot, and a producer that
 *   guessed those fields would fork the paging contract. The body is
 *   `{ ...store.getStatus(), revision, items: [doc] }` -- an array body, which
 *   is what makes the pager treat the document as one page on its own.
 *
 * 800 ms, not 1000
 *   `handleSave` does not write immediately. Requests merge into one window of
 *   {@link LAYOUT_SAVE_WINDOW_MS}, the last document wins, and the window fires
 *   one `store.save`. The window is not restarted by a later request: ten
 *   changes in flight are one write, and the deadline stays the one set by the
 *   first change. 800 rather than 1000 leaves room for the renderer's own
 *   <=100 ms merge (it must not add a second long debounce) and for the write
 *   itself, so a save still fits the one-second budget.
 *
 * Revision, twice
 *   A request whose `baseRevision` is not the current revision cannot be
 *   applied: it was made against a document that no longer exists. It is
 *   refused at call time with `LAYOUT_REVISION_STALE` and the renderer is handed
 *   the current snapshot instead of a guess.
 *   The check runs a second time right before the write, because the window may
 *   have opened while an earlier save was still in flight; when that save
 *   advanced the revision the queued batch is stale after all. Saves are
 *   serialized on one promise chain, so two batches never write the same file
 *   at once.
 *
 * Delivery is not durability
 *   If `send` throws after a successful save, the document stays on disk, the
 *   ack is still `ok: true`, and the failure is logged: the renderer can recover
 *   with `handleState`. A failed `store.save`, on the other hand, is a failed
 *   change and the ack says so.
 *
 * Drafts are delegated, never throttled
 *   `handleDraftGet`/`handleDraftSet`/`handleDraftClear` are thin calls into the
 *   injected `DraftStore`. The draft store writes immediately; the renderer
 *   owns the typing debounce. This module adding one would make a draft loss
 *   window on quit.
 *
 * Ownership
 *   The channel owns its timer and nothing else. The stores are injected and
 *   stay open after `close`: their owner built them, so closing them here would
 *   double-close a resource this module did not open.
 */

import type {
  DraftAck,
  Frame,
  LayoutDoc,
  LayoutSaveAck,
  LayoutSaveRequest,
  LayoutSnapshotBody,
  LayoutState,
} from "@haruyuki/protocol";
import { FRAME_PROTOCOL_VERSION, LAYOUT_SNAPSHOT_FRAME } from "@haruyuki/protocol";

import type { DraftStore } from "./draft-store";
import type { LayoutSaveResult, LayoutStore } from "./layout-store";

/**
 * The save window: the single "about a second" debounce in the layout path.
 *
 * 800 ms rather than 1000, so that the renderer's <=100 ms merge plus this
 * window plus the write still lands under one second.
 */
export const LAYOUT_SAVE_WINDOW_MS = 800;

/**
 * The timer surface, injectable so tests can use fake time instead of sleeping.
 *
 * `unknown` handles are deliberate: the host may return a number or an object,
 * and the channel only ever passes the handle back to the matching canceller.
 */
export type LayoutChannelScheduler = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** Construction inputs. `send` is usually `FrameSender.send`; tests inject a collector. */
export type LayoutChannelOptions = {
  store: LayoutStore;
  draftStore: DraftStore;
  /** Emit one frame. Must be `createFrameSender` in production, not a back door. */
  send: (frame: Frame) => void;
  /** Override {@link LAYOUT_SAVE_WINDOW_MS}; tests inject 0 or a short window. */
  saveWindowMs?: number;
  /** Timer injection for tests; defaults to the host timers. */
  scheduler?: LayoutChannelScheduler;
  /** Diagnostic sink: codes and phases, never document or draft text. */
  log?: (code: string, detail?: Record<string, unknown>) => void;
};

/** The channel surface the desktop bridge calls. */
export type LayoutChannel = {
  /** core -> ui: emit the current authoritative document as a snapshot. */
  publish(): void;
  /** ui -> core: the current state, used on init and after a lost frame. */
  handleState(): LayoutState;
  /** ui -> core: write a whole document, coalesced into the save window. */
  handleSave(request: LayoutSaveRequest): Promise<LayoutSaveAck>;
  /** ui -> core: read one conversation's draft. */
  handleDraftGet(conversationId: string): Promise<{ text: string | null }>;
  /** ui -> core: replace one conversation's draft. */
  handleDraftSet(conversationId: string, text: string): Promise<DraftAck>;
  /** ui -> core: remove one conversation's draft. */
  handleDraftClear(conversationId: string): Promise<DraftAck>;
  /** Write whatever the window is holding, then drain the stores. */
  flush(): Promise<void>;
  /** Normal quit: cancel the window, flush, refuse later saves. */
  close(): Promise<void>;
};

/** One window's worth of requests: the last document and everyone waiting on it. */
interface PendingBatch {
  /** `baseRevision` of the last request in the batch; all acks share one result. */
  baseRevision: number;
  /** The last document submitted in this window. */
  doc: LayoutDoc;
  /** Ack resolvers, one per `handleSave` call merged into this batch. */
  settle: ((ack: LayoutSaveAck) => void)[];
}

/** Default timers: the host's. Wrapped so the injection point has a concrete shape. */
const defaultScheduler: LayoutChannelScheduler = {
  setTimeout(callback, ms) {
    return setTimeout(callback, ms);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Build a channel over an already loaded store.
 *
 * The store must have been loaded (`await store.load()`) before `publish` or
 * `handleState` is called; calling either earlier is a programming error and
 * surfaces the store's own exception. `handleSave` before a load is not: it is
 * answered with the store's `LAYOUT_INVALID`.
 */
export function createLayoutChannel(options: LayoutChannelOptions): LayoutChannel {
  const { store, draftStore, send } = options;
  const windowMs = options.saveWindowMs ?? LAYOUT_SAVE_WINDOW_MS;
  const scheduler = options.scheduler ?? defaultScheduler;
  const log = options.log ?? ((): void => undefined);

  /** The open window, or `null` when nothing is waiting. */
  let pending: PendingBatch | null = null;
  /** The window's timer handle, or `null` when no timer is armed. */
  let timer: unknown = null;
  /** Serial queue of save batches: at most one `store.save` is ever in flight. */
  let writeTail: Promise<void> = Promise.resolve();
  let closed = false;

  function snapshotFrame(): Frame {
    const body: LayoutSnapshotBody = {
      ...store.getStatus(),
      revision: store.getRevision(),
      items: [store.getDoc()],
    };

    // `seq: 0` is a placeholder: the sender assigns the real sequence, and no
    // `page` is built here because the pager mints watermark/token/more.
    return {
      v: FRAME_PROTOCOL_VERSION,
      ch: "bulk",
      seq: 0,
      t: LAYOUT_SNAPSHOT_FRAME,
      body,
    };
  }

  function publish(): void {
    const frame = snapshotFrame();
    try {
      send(frame);
    } catch {
      // The snapshot was built but not delivered. Nothing is rolled back: the
      // authoritative document is the store's, and `handleState` can re-read it.
      log("LAYOUT_IO_ERROR", { phase: "publish", step: "send" });
    }
  }

  /**
   * Publish from inside an ack path, where a missing store state must not turn
   * a refused or completed save into a thrown exception the caller never asked
   * for. The public `publish` keeps propagating that error: there it is a
   * programming error worth seeing.
   */
  function publishQuietly(): void {
    try {
      publish();
    } catch {
      log("LAYOUT_IO_ERROR", { phase: "publish", step: "snapshot" });
    }
  }

  function settle(batch: PendingBatch, ack: LayoutSaveAck): void {
    for (const resolve of batch.settle) resolve(ack);
  }

  /** One save, strictly after the previous one finished. */
  async function run(batch: PendingBatch): Promise<void> {
    // Re-check the base revision now that the save in flight has finished: the
    // window may span a revision change made by that save.
    const current = store.getRevision();
    if (batch.baseRevision !== current) {
      publishQuietly();
      settle(batch, { ok: false, code: "LAYOUT_REVISION_STALE", revision: current });
      return;
    }

    let result: LayoutSaveResult;
    try {
      result = await store.save(batch.doc);
    } catch {
      // `save` reports failures as codes; anything thrown is a defect, and the
      // callers still deserve an answer rather than a promise that never settles.
      log("LAYOUT_IO_ERROR", { phase: "save", step: "throw" });
      settle(batch, { ok: false, code: "LAYOUT_IO_ERROR", revision: store.getRevision() });
      return;
    }

    if (result.ok) {
      // The snapshot goes out before the acks, and delivery is best effort: a
      // throwing `send` must never turn a durable save into a failed one. The
      // revision is read back from the store so the ack and `handleState` can
      // never disagree.
      publishQuietly();
      settle(batch, { ok: true, revision: store.getRevision() });
      return;
    }

    // A failed write leaves both the file and the revision where they were, so
    // there is no new snapshot to publish.
    settle(batch, { ok: false, code: result.code, revision: store.getRevision() });
  }

  function enqueue(batch: PendingBatch): void {
    // `.then(run, run)`: a batch must still run after a previous one threw. The
    // queue is the only thing serializing `store.save`, so it never skips.
    writeTail = writeTail.then(
      () => run(batch),
      () => run(batch),
    );
  }

  /** The window expired: detach the batch and let the queue write it. */
  function fireWindow(): void {
    timer = null;
    const batch = pending;
    pending = null;
    if (batch !== null) enqueue(batch);
  }

  function handleSave(request: LayoutSaveRequest): Promise<LayoutSaveAck> {
    if (closed) {
      // A save accepted after `close` would arm a timer the owner already
      // believes it shut down; refuse instead of resurrecting it.
      return Promise.resolve({
        ok: false,
        code: "LAYOUT_IO_ERROR",
        revision: store.getRevision(),
      });
    }

    const current = store.getRevision();
    if (request.baseRevision !== current) {
      // Refuse now rather than queue a document that is already behind; hand the
      // renderer the current snapshot so it can re-base.
      publishQuietly();
      return Promise.resolve({
        ok: false,
        code: "LAYOUT_REVISION_STALE",
        revision: current,
      });
    }

    return new Promise<LayoutSaveAck>((resolve) => {
      if (pending === null) {
        pending = { baseRevision: request.baseRevision, doc: request.doc, settle: [resolve] };
      } else {
        // Last document wins. Later requests reuse the window already armed and
        // the timer is deliberately not restarted.
        pending.baseRevision = request.baseRevision;
        pending.doc = request.doc;
        pending.settle.push(resolve);
      }
      if (timer === null) timer = scheduler.setTimeout(fireWindow, windowMs);
    });
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
    const batch = pending;
    pending = null;
    if (batch !== null) enqueue(batch);

    await writeTail;
    await store.flush();
    await draftStore.flush();
  }

  return {
    publish,
    handleState() {
      return {
        ...store.getStatus(),
        revision: store.getRevision(),
        doc: store.getDoc(),
      };
    },
    handleSave,
    async handleDraftGet(conversationId) {
      return { text: await draftStore.loadDraft(conversationId) };
    },
    handleDraftSet(conversationId, text) {
      return draftStore.saveDraft(conversationId, text);
    },
    handleDraftClear(conversationId) {
      return draftStore.clearDraft(conversationId);
    },
    flush,
    async close() {
      if (closed) return;
      closed = true;
      await flush();
    },
  };
}
