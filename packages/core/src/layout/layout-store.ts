/**
 * The layout store: one file in, one authoritative document out
 * , against the sections 3.3, 3.6, 4.3 and work packages the log/the bridge).
 *
 * What this module owns
 *   `load` turns whatever is on disk into a document plus the facts the
 *   renderer needs (`outcome`, `writable`, `foundVersion`, `unknownPageIds`),
 *   and `save` is the only path that writes the file. Everything else -- the
 *   800 ms batching window, the snapshot frame, the draft file -- belongs to
 *   other modules; this one has no transport and no clock beyond the backup
 *   timestamp.
 *
 * The load ladder must run in this order
 *   0. `stat` first: a missing file is the normal first run; a read error means
 *      core cannot know what is on disk, so it must not offer to overwrite it.
 *   1. `JSON.parse` failure: back the bytes up, fall back to the default, and
 *      still be writable -- the user's next intentional save is how the file
 *      comes back.
 *   2. Version check before structure: a newer document is left untouched and
 *      the store becomes read-only (`unsupported-version`). A missing version
 *      is treated as v1 (the D1 precedent) and is writable.
 *   3. Structure: an invalid but parseable document is backed up, its unknown
 *      tabs are scanned defensively (the tree may not even be a tree), and the
 *      default document is extended with a recovery panel holding those tabs.
 *      That is the only way "fall back to default" and "never lose an unknown
 *      panel" can both be true.
 *   4. A valid document loads as `ok`, with dangling selections soft-repaired
 *      by the validator.
 *
 * Why `load` never writes the target
 *   Invariant I-2: a corrupt or newer file must still be there after `load`.
 *   The store's only load-time writes are a byte copy into `desktop.corrupt-*`
 *   and pruning older copies; the layout file itself is written only by `save`.
 *
 * Why `save` re-validates after merging
 *   The renderer's document is a candidate: it validates, then unknown tabs
 *   that the renderer dropped are merged back. The
 *   merged result is validated again because that is the document that will be
 *   written, and it is what the next load will read. A merge that would still
 *   lose an unknown tab is refused, not written.
 *
 * Failure is a code, never prose
 *   Every branch returns a `LayoutErrorCode` (invariant I-7) and logs only the
 *   the step -- never document text, never page props.
 */

import { basename, dirname } from "node:path";

import type {
  LayoutDoc,
  LayoutErrorCode,
  LayoutOutcome,
  LayoutStatus,
  LayoutTab,
} from "@haruyuki/protocol";
import { LAYOUT_DOC_VERSION } from "@haruyuki/protocol";

import { atomicWrite, backupFile, pruneBackups } from "./layout-fs";
import type { LayoutFs } from "./layout-fs";
import { collectUnknownTabs, mergeUnknownTabs } from "./layout-merge";
import { backupPathFor, corruptionPrefix, formatTimestamp } from "./layout-paths";
import { validateLayoutDoc } from "./layout-validate";
import type { LayoutValidation } from "./layout-validate";

/**
 * Hard read ceiling for a layout file.
 *
 * The written document is capped at 256 KiB by the validator. A file larger
 * than 1 MiB is not a layout document that merely grew; it is treated as
 * corrupt without being read into memory.
 */
const MAX_LAYOUT_READ_BYTES = 1024 * 1024;

/** What `load` returns: the document plus the facts about how it got there. */
export type LayoutLoadResult =
  | {
      ok: true;
      doc: LayoutDoc;
      outcome: LayoutOutcome;
      writable: boolean;
      foundVersion: number | null;
      unknownPageIds: string[];
    }
  | { ok: false; code: "LAYOUT_NO_DEFAULT" };

/** What `save` returns; `revision` only advances after a completed write. */
export type LayoutSaveResult =
  { ok: true; revision: number } | { ok: false; code: LayoutErrorCode; detail?: string };

/** Construction inputs. `fs` and `layoutPath` are injected so tests can fail writes. */
export type LayoutStoreOptions = {
  fs: LayoutFs;
  /** Absolute path of the shell's layout file, e.g. `.../layout/desktop.json`. */
  layoutPath: string;
  /** The caller's default document; this layer never invents one. */
  defaultDoc: LayoutDoc;
  /** The caller's page registry; a `pageId` missing here is unknown, not invalid. */
  knownPageIds: ReadonlySet<string>;
  /** Backup timestamp source; tests inject a fixed clock. */
  clock?: () => Date;
  /** Diagnostic sink; receives codes and file names, never document content. */
  log?: (code: string, detail?: Record<string, unknown>) => void;
};

/** The store surface the layout channel depends on. */
export type LayoutStore = {
  load(): Promise<LayoutLoadResult>;
  save(next: LayoutDoc): Promise<LayoutSaveResult>;
  validate(value: unknown): LayoutValidation;
  getDoc(): LayoutDoc;
  getRevision(): number;
  isWritable(): boolean;
  getStatus(): LayoutStatus;
  flush(): Promise<void>;
  close(): Promise<void>;
};

/** Build a store. Nothing touches the filesystem until `load` or `save`. */
export function createLayoutStore(options: LayoutStoreOptions): LayoutStore {
  const { fs, layoutPath, knownPageIds, clock = () => new Date(), log } = options;

  // The registry is copied: an external Set mutation must not change what
  // counts as unknown between two saves.
  const known = new Set(knownPageIds);

  // The default is validated once, at construction. A bad default is an
  // assembly error, not a user scenario, so `load` reports it rather than
  // throwing from the constructor.
  const defaultValidation = validateLayoutDoc(options.defaultDoc, known, log);
  const defaultDoc = defaultValidation.ok ? defaultValidation.doc : null;

  const directory = dirname(layoutPath);
  const backupPrefix = corruptionPrefix(layoutPath);

  let doc: LayoutDoc | null = null;
  let revision = 0;
  let outcome: LayoutOutcome = "default";
  let writable = false;
  let foundVersion: number | null = null;
  /** Why `save` must refuse when `writable` is false; null while writable. */
  let blocked: LayoutErrorCode | null = null;

  /**
   * The unknown `pageId`s of the current document, deduplicated in first-seen
   * order. Recomputed from the document rather than cached, because after a
   * relabel the cached list would describe a document nobody has any more.
   */
  function unknownPageIdsOf(current: LayoutDoc): string[] {
    const seen = new Set<string>();
    const ids: string[] = [];

    for (const { tab } of collectUnknownTabs(current, known)) {
      if (!seen.has(tab.pageId)) {
        seen.add(tab.pageId);
        ids.push(tab.pageId);
      }
    }

    return ids;
  }

  /** Record a load result, handle the no-default case, and hand out a copy. */
  function settle(
    nextDoc: LayoutDoc,
    nextOutcome: LayoutOutcome,
    nextWritable: boolean,
    nextFoundVersion: number | null,
    nextBlocked?: LayoutErrorCode,
  ): LayoutLoadResult {
    doc = nextDoc;
    outcome = nextOutcome;
    writable = nextWritable;
    foundVersion = nextFoundVersion;

    if (nextBlocked !== undefined) {
      blocked = nextBlocked;
    }

    return {
      ok: true,
      doc: cloneJson(nextDoc),
      outcome,
      writable,
      foundVersion,
      unknownPageIds: unknownPageIdsOf(nextDoc),
    };
  }

  /**
   * Copy the current file aside and prune to the newest three. Never throws.
   *
   * Returns whether the copy landed. Callers must not promise "backed up" when
   * it did not: `writable: true` is conditional on the backup, because the next
   * because the next save overwrites the only copy of the damaged file.
   */
  async function backUp(): Promise<boolean> {
    const target = backupPathFor(layoutPath, formatTimestamp(clock()));
    const copied = await backupFile(fs, layoutPath, target);

    if (!copied) {
      log?.("LAYOUT_IO_ERROR", { file: basename(layoutPath), step: "backup" });
    }

    await pruneBackups(fs, directory, backupPrefix);

    return copied;
  }

  /**
   * A recovery branch whose writability depends on the backup having landed.
   * Without a copy, the load result is read-only: `save` refuses with
   * `LAYOUT_IO_ERROR` instead of destroying the only remaining bytes.
   */
  function recovered(
    nextDoc: LayoutDoc,
    nextOutcome: LayoutOutcome,
    nextFoundVersion: number | null,
    backedUp: boolean,
  ): LayoutLoadResult {
    if (backedUp) {
      return settle(nextDoc, nextOutcome, true, nextFoundVersion);
    }

    return settle(nextDoc, nextOutcome, false, nextFoundVersion, "LAYOUT_IO_ERROR");
  }

  /** The unreadable-file branch: default document, read-only, IO error on save. */
  function readFailure(fallback: LayoutDoc): LayoutLoadResult {
    log?.("LAYOUT_IO_ERROR", { file: basename(layoutPath), step: "load" });
    return settle(fallback, "read-error", false, null, "LAYOUT_IO_ERROR");
  }

  async function load(): Promise<LayoutLoadResult> {
    if (defaultDoc === null) {
      return { ok: false, code: "LAYOUT_NO_DEFAULT" };
    }

    let size: Awaited<ReturnType<LayoutFs["stat"]>>;

    try {
      size = await fs.stat(layoutPath);
    } catch {
      return readFailure(defaultDoc);
    }

    // No file at all: the normal first run. `default` is writable, so the first
    // intentional save creates the file.
    if (size === null) {
      return settle(defaultDoc, "default", true, null);
    }

    // Oversized: not a layout document worth reading into memory. Back the
    // bytes up and treat it as corrupt without calling `readFile`.
    if (size.size > MAX_LAYOUT_READ_BYTES) {
      await backUp();
      log?.("LAYOUT_CORRUPT", { file: basename(layoutPath), reason: "oversized" });
      return settle(defaultDoc, "corrupt", true, null);
    }

    let text: string | null;

    try {
      text = await fs.readFile(layoutPath);
    } catch {
      return readFailure(defaultDoc);
    }

    // The file vanished between `stat` and `read`: same as a first run.
    if (text === null) {
      return settle(defaultDoc, "default", true, null);
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      const backedUp = await backUp();
      log?.("LAYOUT_CORRUPT", { file: basename(layoutPath), reason: "parse" });
      return recovered(defaultDoc, "corrupt", null, backedUp);
    }

    if (!isRecord(parsed)) {
      const backedUp = await backUp();
      log?.("LAYOUT_CORRUPT", { file: basename(layoutPath), reason: "top-level" });
      return recovered(defaultDoc, "corrupt", null, backedUp);
    }

    const rawVersion = parsed["version"];
    const numericVersion = typeof rawVersion === "number" ? rawVersion : null;

    if (rawVersion === undefined) {
      // A file written before the version field existed is v1.
      parsed["version"] = LAYOUT_DOC_VERSION;
    } else if (numericVersion !== null && Number.isInteger(numericVersion)) {
      if (numericVersion > LAYOUT_DOC_VERSION) {
        // Do not read, do not overwrite. `writable: false` is what makes `save`
        // refuse with LAYOUT_UNSUPPORTED_VERSION instead of downgrading.
        await backUp();
        log?.("LAYOUT_UNSUPPORTED_VERSION", {
          file: basename(layoutPath),
          foundVersion: numericVersion,
        });
        return settle(
          defaultDoc,
          "unsupported-version",
          false,
          numericVersion,
          "LAYOUT_UNSUPPORTED_VERSION",
        );
      }

      if (numericVersion < LAYOUT_DOC_VERSION) {
        // v1 has nothing to migrate from; zero or negative is not a version.
        const backedUp = await backUp();
        log?.("LAYOUT_CORRUPT", { file: basename(layoutPath), reason: "version" });
        return recovered(defaultDoc, "corrupt", numericVersion, backedUp);
      }
    } else {
      // A string, a fraction, null, an object: not a version this build wrote.
      const backedUp = await backUp();
      log?.("LAYOUT_CORRUPT", { file: basename(layoutPath), reason: "version" });
      return recovered(defaultDoc, "corrupt", numericVersion, backedUp);
    }

    const validation = validateLayoutDoc(parsed, known, log);

    if (validation.ok) {
      return settle(validation.doc, "ok", true, numericVersion);
    }

    // Parseable but unusable. Back it up first (I-2), then decide whether the
    // caller may save over it. Unsupported versions are read-only; every
    // other structural failure is recoverable, because the bytes are backed up.
    const backedUp = await backUp();

    if (validation.code === "LAYOUT_UNSUPPORTED_VERSION") {
      log?.("LAYOUT_UNSUPPORTED_VERSION", { file: basename(layoutPath) });
      return settle(
        defaultDoc,
        "unsupported-version",
        false,
        numericVersion,
        "LAYOUT_UNSUPPORTED_VERSION",
      );
    }

    if (validation.code === "LAYOUT_CORRUPT") {
      log?.("LAYOUT_CORRUPT", { file: basename(layoutPath), reason: "validate" });
      return recovered(defaultDoc, "corrupt", numericVersion, backedUp);
    }

    log?.(validation.code, {
      file: basename(layoutPath),
      reason: "invalid",
    });
    return recovered(
      recoverUnknownTabs(parsed, defaultDoc, known, log),
      "fell-back-to-default",
      numericVersion,
      backedUp,
    );
  }

  async function save(next: LayoutDoc): Promise<LayoutSaveResult> {
    if (doc === null) {
      // Saving before a load is a programming error, not a user scenario; the
      // channel is required to call `load` first.
      return { ok: false, code: "LAYOUT_INVALID", detail: "save() before load()" };
    }

    if (!writable) {
      return { ok: false, code: blocked ?? "LAYOUT_IO_ERROR" };
    }

    const validation = validateLayoutDoc(next, known, log);

    if (!validation.ok) {
      return validation.detail === undefined
        ? { ok: false, code: validation.code }
        : { ok: false, code: validation.code, detail: validation.detail };
    }

    // Put back unknown tabs the renderer dropped before deciding this is the
    // document to write. The merge clones, so the
    // authoritative document is untouched if the write later fails.
    const merged = mergeUnknownTabs(doc, validation.doc, known);

    // Defensive assertion, not a reachable branch: `mergeUnknownTabs` already
    // re-inserts every unknown tab of `doc`, so this can only fire if the merge
    // itself regresses. It is kept because the alternative -- writing a document
    // that silently dropped a panel the user cannot see -- is exactly what
    // unknown-tab preservation forbids; there is no test that can reach it.
    if (losesUnknownTabs(doc, merged, known)) {
      log?.("LAYOUT_UNKNOWN_PANELS_LOST", { file: basename(layoutPath) });
      return { ok: false, code: "LAYOUT_UNKNOWN_PANELS_LOST" };
    }

    // Validate what will actually be written: the merge can only add tabs, but
    // it is the merged document the next load has to accept.
    const mergedValidation = validateLayoutDoc(merged, known, log);

    if (!mergedValidation.ok) {
      return mergedValidation.detail === undefined
        ? { ok: false, code: mergedValidation.code }
        : { ok: false, code: mergedValidation.code, detail: mergedValidation.detail };
    }

    // No trailing newline: the 256 KiB budget is measured on the
    // bytes the validator saw, so the file on disk must be exactly those bytes
    // (docs/36 4.3.1 "by the actual file bytes"). A newline here would write one
    // byte more than any document that passed validation.
    const text = JSON.stringify(mergedValidation.doc);

    try {
      await fs.mkdir(directory);
      await atomicWrite(fs, layoutPath, text);
    } catch (error) {
      log?.("LAYOUT_IO_ERROR", {
        file: basename(layoutPath),
        step: "save",
        error: errorCode(error),
      });
      // The atomic write leaves the previous file readable, so the store keeps
      // describing it: the candidate document was not accepted.
      return { ok: false, code: "LAYOUT_IO_ERROR" };
    }

    doc = mergedValidation.doc;
    revision += 1;

    // The damaged document has been replaced by a good one, so the load-time
    // verdict no longer describes what is on disk. Without this, a snapshot
    // published after the save would still say "fell-back-to-default" and a
    // reconnecting renderer would show the recovery notice a second time.
    outcome = "ok";
    writable = true;
    blocked = null;

    return { ok: true, revision };
  }

  return {
    load,
    save,
    validate(value) {
      return validateLayoutDoc(value, known, log);
    },
    getDoc() {
      if (doc === null) {
        throw new Error("LayoutStore.getDoc() called before load()");
      }

      return cloneJson(doc);
    },
    getRevision() {
      return revision;
    },
    isWritable() {
      return doc !== null && writable;
    },
    getStatus() {
      if (doc === null) {
        throw new Error("LayoutStore.getStatus() called before load()");
      }

      return {
        outcome,
        writable,
        foundVersion,
        unknownPageIds: unknownPageIdsOf(doc),
      };
    },
    async flush() {
      // The store writes synchronously within `save`; the debounce window that
      // could hold a pending change lives in `LayoutChannel`.
    },
    async close() {
      // Nothing to release: no timer, no file handle kept open.
    },
  };
}

/**
 * Recover the unknown tabs a structurally invalid but parseable file still
 * contains.
 *
 * The scan is tolerant on purpose: this is the one document where the tree may
 * not be a tree at all. Instead of trusting `LayoutSplit.children` to be an
 * array, it walks any `children` array it finds and any `tabs` array it finds,
 * so a dropped `children` key in the corrupt file does not turn a recoverable
 * load into a thrown exception. The tabs are then handed to the merge module,
 * which creates the `recovered-<n>` panel and preserves `props`/`extras`/hidden.
 */
function recoverUnknownTabs(
  corrupt: Record<string, unknown>,
  fallback: LayoutDoc,
  known: ReadonlySet<string>,
  log?: (code: string, detail?: Record<string, unknown>) => void,
): LayoutDoc {
  const tabs = scanUnknownTabs(corrupt, known);

  if (tabs.length === 0) {
    return cloneJson(fallback);
  }

  // Every collected tab sits in one synthetic panel whose id the fallback does
  // not use, so the merge has nowhere to put them but the recovery panel.
  const source: LayoutDoc = {
    version: LAYOUT_DOC_VERSION,
    root: {
      type: "panel",
      id: unusedPanelId(fallback),
      tabs,
    },
  };
  const merged = mergeUnknownTabs(source, fallback, known);
  const validation = validateLayoutDoc(merged, known, log);

  // A recovery panel must not make an otherwise valid fallback invalid. If it
  // somehow does, the default document still loads; the backup keeps the
  // original bytes either way. The drop is still reported: unknown panels must
  // forbids clearing unknown panels silently, and a caller that sees an empty
  // unknownPageIds must be able to tell "none found" from "dropped".
  if (validation.ok) {
    return validation.doc;
  }

  log?.("LAYOUT_INVALID", {
    step: "recovery",
    reason: validation.code,
    dropped: tabs.length,
  });

  return cloneJson(fallback);
}

/** Depth-first, null-tolerant scan for unknown tabs in arbitrary parsed JSON. */
function scanUnknownTabs(value: Record<string, unknown>, known: ReadonlySet<string>): LayoutTab[] {
  const tabs: LayoutTab[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (!isRecord(node)) {
      return;
    }

    const candidates = node["tabs"];

    if (Array.isArray(candidates)) {
      for (const candidate of candidates) {
        if (!isRecord(candidate)) {
          continue;
        }

        const tabId = candidate["tabId"];
        const pageId = candidate["pageId"];

        if (
          typeof tabId === "string" &&
          typeof pageId === "string" &&
          !known.has(pageId) &&
          !seen.has(tabId)
        ) {
          seen.add(tabId);
          tabs.push(candidate as unknown as LayoutTab);
        }
      }
    }

    const children = node["children"];

    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child);
      }
    }
  };

  visit(value["root"]);

  return tabs;
}

/** A panel id the fallback document does not already use. */
function unusedPanelId(fallback: LayoutDoc): string {
  const used = new Set<string>();

  const visit = (node: unknown): void => {
    if (!isRecord(node)) {
      return;
    }

    const id = node["id"];

    if (typeof id === "string") {
      used.add(id);
    }

    const children = node["children"];

    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child);
      }
    }
  };

  visit(fallback.root);

  const base = "recovery-source";
  let candidate = base;
  let counter = 2;

  while (used.has(candidate)) {
    candidate = `${base}-${String(counter)}`;
    counter += 1;
  }

  return candidate;
}

/** True when an unknown tab of `current` is missing from `merged`. */
function losesUnknownTabs(
  current: LayoutDoc,
  merged: LayoutDoc,
  known: ReadonlySet<string>,
): boolean {
  // Every tab id the merged document kept. An empty registry lists them all,
  // which is what containment needs; the calls below do not care about knownness.
  const mergedTabIds = new Set<string>();

  for (const { tab } of collectUnknownTabs(merged, EMPTY_KNOWN)) {
    mergedTabIds.add(tab.tabId);
  }

  for (const { tab } of collectUnknownTabs(current, known)) {
    if (!mergedTabIds.has(tab.tabId)) {
      return true;
    }
  }

  return false;
}

/** Registry meaning "nothing is known", used only to enumerate every tab id. */
const EMPTY_KNOWN: ReadonlySet<string> = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON deep copy; documents are JSON by contract, so a round trip is exact. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The error's `code` when it has one, for logs; never the message or content. */
function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error["code"] === "string") {
    return error["code"];
  }

  return "unknown";
}
