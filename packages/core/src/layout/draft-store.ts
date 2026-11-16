/**
 * The per-conversation draft text store (`send.ts`; docs/36 sections 3.3, 3.4 and
 * 4.3.8; docs/35 section 6.8).
 *
 * What this owns
 *   One JSON file per shell (`layout/drafts-desktop.json` /
 *   `layout/drafts-vscode.json`) mapping a conversation id to a piece of plain
 *   text plus the ISO timestamp that eviction sorts by. The text is all that is
 *   stored: no attachments, no images, no file references -- that is a user
 *   decision, not an implementation detail to be "improved" later.
 *
 * Immediate writes
 *   `LayoutChannel` does not throttle the draft store: the renderer's input
 *   the renderer's input cadence and its own 1 s debounce belong to E5, and C4's
 *   only job is that a `saveDraft` which resolved is on disk. Every mutation is
 *   therefore written through `atomicWrite` before its ack resolves, and the
 *   whole read-modify-write runs on one serial queue so two concurrent saves
 *   cannot overwrite each other's entry.
 *
 * Never lose a file we could not read
 *   A file we cannot parse, cannot understand, or cannot read at all is mirrored
 *   as empty and (for the first two) copied to `drafts-<shell>.corrupt-<ts>.json`
 *   before anything is replaced. A version above 1 is different: it was written
 *   by a newer build, so the store refuses every write (`DRAFT_INVALID`) and the
 *   bytes stay exactly as they were. The same refusal applies after a stat or
 *   read error, because overwriting drafts we never managed to read would be
 *   data loss dressed up as a save.
 *
 * Budgets
 *   1 MiB of UTF-8 text per conversation, 1000 conversations, 10 MiB of
 *   serialised file. The first is refused with `DRAFT_TOO_LARGE` (never
 *   truncated); the other two evict the oldest `updatedAt` first. Eviction runs
 *   against an over-estimate of the serialised size -- each entry counted as if
 *   it were its own object -- so the file written is always under the same
 *   10 MiB cap the load path enforces. The entry just saved is the newest and
 *   therefore the last candidate; a single valid draft can never be evicted by
 *   its own write.
 *
 * Unknown keys
 *   `DraftFile` names the keys C4 understands. A newer renderer may add keys at
 *   the file level; they are copied through verbatim (`Object.defineProperty`
 *   inclusive, so a JSON `__proto__` becomes a field rather than a prototype
 *   rather than a prototype change). Draft entries themselves are rewritten
 *   as exactly `{ text, updatedAt }`, so an entry cannot smuggle extra state
 *   past the "text only" rule.
 *
 * No shell names here
 *   The caller passes the file path (`draftPath(userData, shell)`), so this
 *   module has no `desktop`/`vscode` constant to get wrong and two stores on two
 *   paths cannot alias each other (invariant I-4).
 */

import { dirname } from "node:path";

import type { DraftAck, LayoutErrorCode } from "@haruyuki/protocol";

import { atomicWrite, backupFile, pruneBackups } from "./layout-fs";
import type { LayoutFs } from "./layout-fs";
import { backupPathFor, corruptionPrefix, formatTimestamp } from "./layout-paths";

/** One conversation's draft: the text and the timestamp eviction orders by. */
interface DraftEntry {
  text: string;
  updatedAt: string;
}

/**
 * The on-disk shape (docs/35 section 6.8).
 *
 * `drafts` is keyed by the engine's conversation id, which C4 never validates:
 * it is an opaque string, not a foreign key.
 */
export type DraftFile = {
  version: 1;
  drafts: Record<string, { text: string; updatedAt: string }>;
  extras?: Record<string, unknown>;
};

/** Limits shared by the write path and the read-side guards. */
export const DRAFT_LIMITS = {
  /** UTF-8 bytes of one draft's text; larger is refused, never truncated. */
  maxEntryBytes: 1024 * 1024,
  /** The whole file; also the `stat` guard checked before the file is parsed. */
  maxFileBytes: 10 * 1024 * 1024,
  /** Conversations kept in one file; the oldest `updatedAt` is evicted first. */
  maxEntries: 1000,
  /** Corruption copies kept, the same "newest three" rule as the layout store. */
  maxBackups: 3,
} as const;

/**
 * Diagnostic log code for an eviction.
 *
 * Not a wire error and not a user-visible code: nothing failed, the file simply
 * reached a budget. It lives here rather than in `LayoutErrorCode` because E1/E5
 * have no reason to explain it.
 */
export const DRAFT_EVICTED_LOG = "DRAFT_EVICTED";

/** Everything the draft store needs injected; no shell, no `userData` root. */
export type DraftStoreOptions = {
  fs: LayoutFs;
  /** `draftPath(userData, shell)`; the store never derives it. */
  draftsPath: string;
  /** Timestamp source for `updatedAt` and backup names; tests inject it. */
  clock?: () => Date;
  /** Reason codes and counts only: no draft text, no absolute paths. */
  log?: (code: string, detail?: Record<string, unknown>) => void;
};

/** The public surface the layout channel talks to. */
export type DraftStore = {
  /** The stored text, or `null` when this conversation has no draft. */
  loadDraft(conversationId: string): Promise<string | null>;
  /** Replace one conversation's draft; resolves only once it is on disk. */
  saveDraft(conversationId: string, text: string): Promise<DraftAck>;
  /** Remove one conversation's draft; other conversations are untouched. */
  clearDraft(conversationId: string): Promise<DraftAck>;
  /** Resolve once every queued write has landed (nothing is buffered). */
  flush(): Promise<void>;
  /** Drain queued writes; like `LayoutStore.close`, there is nothing to release. */
  close(): Promise<void>;
};

/** Why writes are refused; `null` means the store is writable. */
type ReadOnlyReason = "version" | "io" | null;

/** A JSON object as `JSON.parse` produces them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A defensible `updatedAt` for eviction ordering.
 *
 * A timestamp that cannot be parsed cannot be ordered, and an entry whose order
 * is unknown would silently jump to the front of the eviction queue. The whole
 * entry is dropped instead; the other conversations in the file survive.
 */
function toEntry(value: unknown): DraftEntry | null {
  if (!isRecord(value)) return null;
  const { text, updatedAt } = value;
  if (typeof text !== "string" || typeof updatedAt !== "string") return null;
  if (Number.isNaN(Date.parse(updatedAt))) return null;
  return { text, updatedAt };
}

/** `drafts-desktop` from `.../layout/drafts-desktop.json`; the backup prefix stem. */
/** Define an own enumerable key, so a JSON `__proto__` stays a field. */
function defineKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * A draft store over one file.
 *
 * The file is read lazily, on the first operation, and the mirror is kept in
 * memory afterwards: E5 reads a draft on every conversation switch, and
 * re-parsing the file for each of those would be work with no new information.
 * Every mutation goes through `serialise`, so the sequence "read mirror, mutate,
 * write file, ack" is atomic with respect to other callers.
 */
export function createDraftStore(options: DraftStoreOptions): DraftStore {
  const { fs, draftsPath } = options;
  const clock = options.clock ?? ((): Date => new Date());
  const log = options.log ?? ((): void => undefined);

  const backupDir = dirname(draftsPath);
  const backupPrefix = corruptionPrefix(draftsPath);

  /** The in-memory mirror of `drafts`. Replaced, never mutated by callers. */
  let drafts = new Map<string, DraftEntry>();
  /** File-level keys this version does not know, copied through on write. */
  let preserved: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let loaded = false;
  let readOnly: ReadOnlyReason = null;
  /** Resolves after `mkdir`; a failed attempt is retried by the next write. */
  let directoryReady: Promise<void> | null = null;
  /** Tail of the serial queue; every mutation runs behind it. */
  let tail: Promise<unknown> = Promise.resolve();

  function serialise<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function ensureDirectory(): Promise<void> {
    if (directoryReady === null) {
      directoryReady = fs.mkdir(backupDir).catch((error: unknown) => {
        directoryReady = null;
        throw error;
      });
    }
    return directoryReady;
  }

  /** Copy the current file aside and prune to the newest copies. Best effort. */
  async function preserve(): Promise<boolean> {
    const target = backupPathFor(draftsPath, formatTimestamp(clock()));
    const copied = await backupFile(fs, draftsPath, target);
    if (copied) await pruneBackups(fs, backupDir, backupPrefix, DRAFT_LIMITS.maxBackups);
    return copied;
  }

  /** Honour "backup first, then mirror as empty" for an unusable file. */
  async function discardAsEmpty(
    code: "DRAFT_INVALID" | "DRAFT_TOO_LARGE",
    detail: Record<string, unknown>,
  ): Promise<void> {
    const backedUp = await preserve();
    drafts = new Map();
    preserved = Object.create(null) as Record<string, unknown>;

    // Writable only if the unusable file was actually copied aside. Without a
    // copy, the next keystroke would replace the only remaining bytes, so the
    // store stays read-only for this file instead of pretending the backup
    // succeeded.
    readOnly = backedUp ? null : "io";
    log(code, { ...detail, backup: backedUp });
  }

  /** Read the file once; every failure ends in a documented, empty mirror. */
  async function load(): Promise<void> {
    if (loaded) return;
    // Set before the first await: one unreadable file must not be retried on
    // every keystroke, and a read error must not look like "no file" later.
    loaded = true;

    let size: number | null;
    try {
      const info = await fs.stat(draftsPath);
      size = info === null ? null : info.size;
    } catch {
      readOnly = "io";
      log("DRAFT_IO_ERROR", { phase: "load", step: "stat" });
      return;
    }
    if (size === null) return;
    if (size > DRAFT_LIMITS.maxFileBytes) {
      // Do not parse 10 MiB+ of untrusted text: back it up and start empty.
      await discardAsEmpty("DRAFT_TOO_LARGE", { phase: "load", step: "stat", bytes: size });
      return;
    }

    let text: string | null;
    try {
      text = await fs.readFile(draftsPath);
    } catch {
      readOnly = "io";
      log("DRAFT_IO_ERROR", { phase: "load", step: "read" });
      return;
    }
    if (text === null) return;

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      await discardAsEmpty("DRAFT_INVALID", { phase: "load", step: "parse" });
      return;
    }
    if (!isRecord(raw)) {
      await discardAsEmpty("DRAFT_INVALID", { phase: "load", step: "shape" });
      return;
    }

    // A newer build owns this file. Keep the bytes, answer empty, refuse writes.
    if (typeof raw.version === "number" && raw.version > 1) {
      readOnly = "version";
      log("DRAFT_INVALID", { phase: "load", step: "version", version: raw.version });
      return;
    }

    // A file written before the version field existed is v1, exactly as the
    // layout store treats it. Two adjacent files in one
    // directory must not disagree about what a missing version means.
    const version = raw.version === undefined ? 1 : raw.version;

    if (raw.version === undefined) {
      log("DRAFT_VERSION_ASSUMED", { phase: "load", assumed: 1 });
    }

    if (version !== 1 || !isRecord(raw.drafts)) {
      await discardAsEmpty("DRAFT_INVALID", { phase: "load", step: "version" });
      return;
    }

    const next = new Map<string, DraftEntry>();
    let dropped = 0;
    for (const [conversationId, value] of Object.entries(raw.drafts)) {
      const entry = toEntry(value);
      if (entry === null) {
        dropped += 1;
        continue;
      }
      next.set(conversationId, entry);
    }
    drafts = next;
    preserved = collectPreserved(raw);
    if (dropped > 0) {
      // One unreadable entry is not a corrupt file: the rest is still the user's.
      log("DRAFT_INVALID", { phase: "load", step: "entry", dropped });
    }
  }

  /** The bytes a single entry adds to the file, counting its own braces. */
  function entryBytes(conversationId: string, entry: DraftEntry): number {
    return Buffer.byteLength(JSON.stringify({ [conversationId]: entry }), "utf8");
  }

  /** Wrapper plus preserved keys, estimated upward. */
  function skeletonBytes(): number {
    // The wrapper is pure ASCII, so its string length is its byte count.
    let total = JSON.stringify({ version: 1, drafts: {} }).length + 1;
    for (const key of Object.keys(preserved)) {
      total += Buffer.byteLength(JSON.stringify({ [key]: preserved[key] }), "utf8");
    }
    return total;
  }

  /** Oldest entry that may be evicted, or `null` when only `keep` is left. */
  function oldestEvictable(keep: string): string | null {
    let oldestId: string | null = null;
    let oldestAt = 0;
    for (const [conversationId, entry] of drafts) {
      if (conversationId === keep) continue;
      // Compare instants, not strings: a loaded file could carry an offset other
      // than `Z`, where lexicographic order is not chronological order.
      const at = Date.parse(entry.updatedAt);
      if (oldestId === null || at < oldestAt || (at === oldestAt && conversationId < oldestId)) {
        oldestId = conversationId;
        oldestAt = at;
      }
    }
    return oldestId;
  }

  /** Evict until the entry count and the serialised size are both back in budget. */
  function evict(keep: string): number {
    let estimate = skeletonBytes();
    for (const [conversationId, entry] of drafts) {
      estimate += entryBytes(conversationId, entry);
    }
    let evicted = 0;
    while (drafts.size > DRAFT_LIMITS.maxEntries || estimate > DRAFT_LIMITS.maxFileBytes) {
      const victim = oldestEvictable(keep);
      if (victim === null) break;
      const entry = drafts.get(victim);
      if (entry !== undefined) estimate -= entryBytes(victim, entry);
      drafts.delete(victim);
      evicted += 1;
    }
    return evicted;
  }

  /** Exactly what the file contains: version, entries, then unknown keys. */
  function serialiseFile(): string {
    const body: Record<string, DraftEntry> = Object.create(null) as Record<string, DraftEntry>;
    for (const [conversationId, entry] of drafts) {
      body[conversationId] = { text: entry.text, updatedAt: entry.updatedAt };
    }

    // Typed as the declared on-disk shape: a `DraftFile` that stops matching
    // what the loader accepts is a compile error here instead of a silent
    // "every draft disappeared after an upgrade".
    const draftFile: DraftFile = { version: 1, drafts: body };
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    out["version"] = draftFile.version;
    out["drafts"] = draftFile.drafts;

    for (const key of Object.keys(preserved)) defineKey(out, key, preserved[key]);
    return `${JSON.stringify(out)}\n`;
  }

  async function write(): Promise<void> {
    await ensureDirectory();
    await atomicWrite(fs, draftsPath, serialiseFile());
  }

  /** The code a mutation must fail with before it is allowed to touch the file. */
  function refusal(): LayoutErrorCode | null {
    if (readOnly === "version") return "DRAFT_INVALID";
    if (readOnly === "io") return "DRAFT_IO_ERROR";
    return null;
  }

  /** Put the mirror back after a failed write, so memory never claims success. */
  function restore(
    previous: [string, DraftEntry][],
    previousPreserved: Record<string, unknown>,
  ): void {
    drafts = new Map(previous);
    preserved = previousPreserved;
  }

  return {
    async loadDraft(conversationId) {
      return serialise(async () => {
        await load();
        return drafts.get(conversationId)?.text ?? null;
      });
    },

    async saveDraft(conversationId, text) {
      return serialise(async (): Promise<DraftAck> => {
        await load();
        const code = refusal();
        if (code !== null) {
          log(code, { phase: "save", step: "refused" });
          return { ok: false, code };
        }
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > DRAFT_LIMITS.maxEntryBytes) {
          log("DRAFT_TOO_LARGE", { phase: "save", bytes, limit: DRAFT_LIMITS.maxEntryBytes });
          return { ok: false, code: "DRAFT_TOO_LARGE" };
        }

        const previous: [string, DraftEntry][] = [...drafts];
        const previousPreserved = preserved;
        drafts.set(conversationId, { text, updatedAt: clock().toISOString() });
        const evicted = evict(conversationId);
        try {
          await write();
        } catch {
          restore(previous, previousPreserved);
          log("DRAFT_IO_ERROR", { phase: "save", step: "write" });
          return { ok: false, code: "DRAFT_IO_ERROR" };
        }
        if (evicted > 0) log(DRAFT_EVICTED_LOG, { phase: "save", evicted, entries: drafts.size });
        return { ok: true };
      });
    },

    async clearDraft(conversationId) {
      return serialise(async (): Promise<DraftAck> => {
        await load();
        const code = refusal();
        if (code !== null) {
          log(code, { phase: "clear", step: "refused" });
          return { ok: false, code };
        }
        if (!drafts.has(conversationId)) return { ok: true };

        const previous: [string, DraftEntry][] = [...drafts];
        drafts.delete(conversationId);
        try {
          await write();
        } catch {
          restore(previous, preserved);
          log("DRAFT_IO_ERROR", { phase: "clear", step: "write" });
          return { ok: false, code: "DRAFT_IO_ERROR" };
        }
        return { ok: true };
      });
    },

    async flush() {
      // Nothing is buffered: waiting for the queue is the whole contract.
      await serialise(async () => undefined);
    },

    async close() {
      // Like `LayoutStore.close`: no timer, no handle, nothing to release. Only
      // the writes already queued have to land before the process can go.
      await serialise(async () => undefined);
    },
  };
}

/** Every file-level key this version does not own, as own enumerable fields. */
function collectPreserved(raw: Record<string, unknown>): Record<string, unknown> {
  const preserved: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key === "version" || key === "drafts") continue;
    defineKey(preserved, key, raw[key]);
  }
  return preserved;
}
