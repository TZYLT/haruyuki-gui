/**
 * The layout wire payloads.
 *
 * `layout.snapshot` is the only frame type v1 registers: core sends the
 * authoritative document to the renderer on it, and the renderer writes back a
 * whole document through the preload `invoke` channel. There is no
 * `layout.change`/`layout.ack`/`layout.request` in v1; an unregistered `t` is
 * refused by the C5 sender, so a later producer hits that wall instead of
 * silently emitting a contract nobody signed.
 */

import type { LayoutDoc } from "./layout-doc.js";

/** The single frame type this item adds to `FRAME_TYPES`. */
export const LAYOUT_SNAPSHOT_FRAME = "layout.snapshot" as const;

/** How the last load ended, as the renderer needs to explain it. */
export type LayoutOutcome =
  | "ok"
  | "default"
  | "migrated"
  | "corrupt"
  | "fell-back-to-default"
  | "unsupported-version"
  | "read-error";

/** Facts about the loaded document, not about any particular save. */
export type LayoutStatus = {
  outcome: LayoutOutcome;
  /** False after a newer-version or read-error outcome; `save` must refuse. */
  writable: boolean;
  /** The version found on disk; null when the file had no version field. */
  foundVersion: number | null;
  /** Unknown `pageId`s, first-seen order, hidden tabs included. */
  unknownPageIds: string[];
};

/**
 * One `layout.snapshot` body.
 *
 * `items` is an array because the C5 pager slices an array body; v1 always
 * carries exactly one document and the renderer takes `items[0]`. `page` is
 * added by the sender (`watermark` identifies the snapshot, `token` identifies
 * the page, `more` is false on the last page); C4 never fills those fields.
 */
export type LayoutSnapshotBody = LayoutStatus & {
  /** Monotonic document revision; 0 before the first successful save. */
  revision: number;
  items: LayoutDoc[];
};

/** A renderer request to write a whole document. */
export type LayoutSaveRequest = {
  /** The revision the renderer based this document on. */
  baseRevision: number;
  doc: LayoutDoc;
};

/** A renderer write result. `revision` is always the current one. */
export type LayoutSaveAck =
  { ok: true; revision: number } | { ok: false; code: LayoutErrorCode; revision: number };

/** The state reply to `handleState`, used on init and after a lost frame. */
export type LayoutState = LayoutStatus & {
  revision: number;
  doc: LayoutDoc;
};

/** A draft read/write/clear result. */
export type DraftAck = { ok: true } | { ok: false; code: LayoutErrorCode };

/** Error codes shared by core and the renderer; no user-facing text. */
export type LayoutErrorCode =
  | "LAYOUT_CORRUPT"
  | "LAYOUT_INVALID"
  | "LAYOUT_UNSUPPORTED_VERSION"
  | "LAYOUT_TOO_LARGE"
  | "LAYOUT_UNKNOWN_PANELS_LOST"
  | "LAYOUT_IO_ERROR"
  | "LAYOUT_NO_DEFAULT"
  | "LAYOUT_REVISION_STALE"
  | "DRAFT_INVALID"
  | "DRAFT_TOO_LARGE"
  | "DRAFT_IO_ERROR";
