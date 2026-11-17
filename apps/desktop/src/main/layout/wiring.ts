/**
 * Assembles the layout store, draft store and channel for the desktop shell.
 *
 * The stores are built here rather than in the composition root so their
 * lifetime rules sit in one place:
 *
 *   - the document must finish loading before the channel exists, because both
 *     `publish` and `handleState` read the loaded document;
 *   - the channel must close before the stores do, so a save still inside its
 *     debounce window is flushed while writes are still accepted;
 *   - the only way out is the injected `host.send`, which keeps this module free
 *     of `electron` and runnable in a plain Node process.
 *
 * A default document that does not validate is a startup error, not a state:
 * the store reports `LAYOUT_NO_DEFAULT` and has no document to serve, so there
 * is nothing useful to hand the shell.
 */

import {
  createDraftStore,
  createLayoutChannel,
  createLayoutStore,
  createNodeLayoutFs,
  draftPath,
  layoutPath,
} from "@haruyuki/core";
import type { LayoutChannel } from "@haruyuki/core";
import type { Frame, LayoutDoc } from "@haruyuki/protocol";

/** This shell's fixed key; the two shells never share a layout file. */
const SHELL = "desktop" as const;

/** What the composition root supplies. */
export interface LayoutWiringOptions {
  /** Electron's `userData`; the layout directory is created beneath it. */
  readonly userData: string;
  /** The bridge host. A reload replaces the session behind it, not the host. */
  readonly host: { send(frame: Frame): void };
  /** The shell's page registry; anything else is an unknown page, not an error. */
  readonly knownPageIds: ReadonlySet<string>;
  /** The shell's default document; the store never invents one. */
  readonly defaultDoc: LayoutDoc;
  /** Diagnostic sink: codes and phases, never document or draft text. */
  readonly log?: (code: string, detail?: Record<string, unknown>) => void;
}

/** What the composition root keeps: the channel plus the two lifecycle calls. */
export interface LayoutWiring {
  /** C4's only write path; the IPC handlers must call into it. */
  readonly channel: LayoutChannel;
  /** Emit the current authoritative document once the renderer is ready. */
  publish(): void;
  /** Flush the open save window, then refuse later saves. Idempotent. */
  close(): Promise<void>;
}

/**
 * Build the layout subsystem.
 *
 * The returned promise rejects only for a fatal assembly problem (no valid
 * default document). A damaged layout file is not fatal: the store backs it up,
 * falls back to the default and reports the outcome in `getStatus()`.
 */
export async function createLayoutWiring(options: LayoutWiringOptions): Promise<LayoutWiring> {
  const log = options.log ?? ((): void => undefined);
  const fs = createNodeLayoutFs({ log });

  const store = createLayoutStore({
    fs,
    layoutPath: layoutPath(options.userData, SHELL),
    defaultDoc: options.defaultDoc,
    knownPageIds: options.knownPageIds,
    log,
  });

  const loaded = await store.load();

  if (!loaded.ok) {
    // The channel's first `getDoc()` would throw instead; failing here names
    // the real cause at the point the shell can still report it.
    log("LAYOUT_NO_DEFAULT", { phase: "wiring", step: "load" });
    throw new Error("cannot wire the layout subsystem without a valid default document");
  }

  const draftStore = createDraftStore({
    fs,
    draftsPath: draftPath(options.userData, SHELL),
    log,
  });

  // The draft store's public surface has no eager `load`: it reads its file on
  // the first draft operation so a session that never types does not pay for
  // it. Settling the serial queue still leaves wiring in a known state.
  await draftStore.flush();

  const channel = createLayoutChannel({
    store,
    draftStore,
    send: (frame) => options.host.send(frame),
    log,
  });

  let closed = false;

  return {
    channel,
    publish() {
      // A snapshot after teardown would be a frame nobody can apply; silence is
      // safer than sending one from a closed subsystem.
      if (closed) return;

      channel.publish();
    },
    async close() {
      if (closed) return;

      closed = true;

      try {
        // The channel owns the save window; closing it first flushes a pending
        // save through stores that are still open.
        await channel.close();
      } finally {
        await store.close();
        await draftStore.close();
      }
    },
  };
}
