/**
 * Crash records on disk: the shell's own account of a process that died.
 *
 * The writer is always a process that is still alive enough to write. The main
 * process writes its own uncaught-exception record synchronously, before it
 * exits; it writes the renderer and engine records on behalf of children that
 * cannot write anything themselves.
 *
 * Three decisions are stated here because the rest of the module follows from
 * them:
 *
 *   The timestamp lives in the file name, in UTC, without colons. Windows
 *   rejects `:` in a name, and a record whose name cannot be created is no
 *   record at all. The name is also the last-resort order: a file that no longer
 *   parses still has a place in the retention sweep.
 *
 *   Retention deletes whole records and never the newest one. The newest record
 *   is the evidence for the crash that just happened; deleting it to satisfy a
 *   byte quota would throw away exactly what the quota exists to keep.
 *
 *   Unparseable `crash-*.json` files are kept, and still count toward the size.
 *   They are evidence of a bug in the writer, not garbage, and deleting them
 *   would silently hide it. The consequence is that a directory full of corrupt
 *   files can remain over quota; the result reports that instead of claiming the
 *   cap held.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** The three processes whose death leaves a record. */
export const CRASH_KINDS = ["main", "renderer", "engine"] as const;
export type CrashKind = (typeof CRASH_KINDS)[number];

/** Versions captured with every record, so a report is readable without the log. */
export interface CrashVersions {
  version: string;
  electron: string;
  node: string;
  platform: string;
  arch: string;
}

/** Evidence of an engine child that exited when it was not asked to. */
export interface CrashEngine {
  exitCode: number | null;
  signal: string | null;
  engineVersion: string | null;
  protocolVersion: number | null;
  watchdog: "active" | "inactive" | "unknown";
}

/** Evidence of a renderer process that disappeared. */
export interface CrashRenderer {
  reason: string;
  exitCode: number | null;
}

/** Evidence of the main process itself, captured before it exits. */
export interface CrashMain {
  name: string;
  message: string;
  stack?: string;
}

/** Opaque ids; never names or conversation content. */
export interface CrashIds {
  agentId?: string;
  conversationId?: string;
}

/**
 * One crash record. The shape is frozen by the requirement (`32` section 6.1):
 * fields may be added, never renamed or repurposed.
 */
export interface CrashRecord {
  schemaVersion: 1;
  /** ISO 8601 UTC. */
  at: string;
  kind: CrashKind;
  /** ENGINE_CRASHED / RENDERER_CRASHED / MAIN_CRASHED; not a ShellError code. */
  code: string;
  app: CrashVersions;
  engine?: CrashEngine;
  renderer?: CrashRenderer;
  main?: CrashMain;
  ids?: CrashIds;
}

/** Namespace inside `userData` for records. Not the Crashpad directory. */
const CRASH_DIR_NAME = "crashes";
const CRASH_FILE_PREFIX = "crash-";
const CRASH_FILE_EXTENSION = ".json";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The requirement's defaults (`32` section 6.5). */
export interface CrashRetention {
  readonly retentionDays: number;
  readonly maxTotalMb: number;
}

/** Defaults from `32` section 4.7: crashes are kept 30 days, capped at 10 MB. */
export const DEFAULT_CRASH_RETENTION: CrashRetention = { retentionDays: 30, maxTotalMb: 10 };

/** What a write attempted, and why it failed when it did. */
export type CrashWriteResult =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string };

/** What a retention sweep removed. Kept as data so the caller can log it. */
export interface CrashCleanupResult {
  /** File names removed, oldest first. */
  readonly deleted: readonly string[];
  /** Bytes present before the sweep. */
  readonly bytesBefore: number;
  /** Bytes present after the sweep; may still exceed the cap (see module note). */
  readonly bytesAfter: number;
  /** `crash-*.json` files that could not be parsed; kept, never deleted. */
  readonly unreadable: number;
}

/**
 * Where records live. The only function that knows the directory name, so the
 * log and diagnostic paths cannot invent a second one.
 *
 * @param userData the directory Electron reports for this app
 */
export function crashDirFor(userData: string): string {
  return path.join(userData, CRASH_DIR_NAME);
}

/**
 * The file name for an instant.
 *
 * `toISOString` yields `2026-11-14T13:45:00.123Z`; replacing `:` and `.` keeps
 * it sortable, readable, and legal on every filesystem we ship to.
 *
 * @param at the instant the crash happened
 */
export function crashRecordFileName(at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");

  return `${CRASH_FILE_PREFIX}${stamp}${CRASH_FILE_EXTENSION}`;
}

/**
 * The full path for an instant.
 *
 * Two records that happen in the same millisecond share a name, and the second
 * write replaces the first. The requirement fixes the name format, and a
 * collision needs two crashes in one millisecond; losing one of those is
 * cheaper than an unpredictable name.
 *
 * @param dir the crash directory
 * @param at the instant the crash happened
 */
export function crashRecordPath(dir: string, at: Date): string {
  return path.join(dir, crashRecordFileName(at));
}

/** Serialise with an indent, because a person may open the file by hand. */
function serialise(record: CrashRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Describe a thrown value without ever throwing again. */
function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

function isCrashRecordName(name: string): boolean {
  return name.startsWith(CRASH_FILE_PREFIX) && name.endsWith(CRASH_FILE_EXTENSION);
}

/**
 * Whether a parsed value is usable as a record.
 *
 * Deliberately minimal: the point is to keep an unrelated or half-written JSON
 * document from being treated as a crash, not to be a schema validator. Unknown
 * fields are preserved by the reader, which is what lets a later version add
 * fields without this one dropping them.
 */
function isCrashRecord(value: unknown): value is CrashRecord {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  const kind = record["kind"];

  if (record["schemaVersion"] !== 1) return false;
  if (typeof record["at"] !== "string" || Number.isNaN(Date.parse(record["at"]))) return false;
  if (typeof kind !== "string" || !(CRASH_KINDS as readonly string[]).includes(kind)) return false;
  if (typeof record["code"] !== "string") return false;

  return typeof record["app"] === "object" && record["app"] !== null;
}

/**
 * Write a record synchronously.
 *
 * This is the main-process crash path, so it must not throw: an exception while
 * recording an exception would replace the crash with a recursive one. A caller
 * that has nowhere left to report to (the main crash handler) writes the result
 * to stderr; every other caller can decide for itself.
 *
 * @param dir the crash directory; created when missing
 * @param record the record to persist
 */
export function writeCrashRecordSync(dir: string, record: CrashRecord): CrashWriteResult {
  try {
    const target = crashRecordPath(dir, new Date(record.at));

    mkdirSync(dir, { recursive: true });
    writeFileSync(target, serialise(record), "utf8");

    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/**
 * Write a record without blocking the event loop.
 *
 * Resolves rather than rejecting even when the write fails. The renderer crash
 * path continues to rebuild the window whatever happened on disk, and an
 * unhandled rejection from a crash handler would be the second failure caused by
 * reporting the first.
 *
 * @param dir the crash directory; created when missing
 * @param record the record to persist
 */
export async function writeCrashRecord(
  dir: string,
  record: CrashRecord,
): Promise<CrashWriteResult> {
  try {
    const target = crashRecordPath(dir, new Date(record.at));

    await mkdir(dir, { recursive: true });
    await writeFile(target, serialise(record), "utf8");

    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** One `crash-*.json` on disk, parsed when possible. */
interface CrashFile {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  /** `null` when the file exists but is not a usable record. */
  readonly record: CrashRecord | null;
  /** Milliseconds since epoch, or `null` when the record is unusable. */
  readonly at: number | null;
}

/**
 * List the crash files in a directory.
 *
 * Never throws: a missing directory is the normal first-run state, and an
 * unreadable one must not stop the caller from doing the rest of its work.
 * Files that cannot be stat'ed are skipped entirely; they could not be deleted
 * safely, and counting them would make the quota report a size it cannot fix.
 */
function scanCrashDir(dir: string): CrashFile[] {
  let names: string[];

  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const files: CrashFile[] = [];

  for (const name of names) {
    if (!isCrashRecordName(name)) continue;

    const full = path.join(dir, name);
    let bytes = 0;

    try {
      const info = statSync(full);

      if (!info.isFile()) continue;

      bytes = info.size;
    } catch {
      continue;
    }

    let record: CrashRecord | null = null;

    try {
      const parsed: unknown = JSON.parse(readFileSync(full, "utf8"));

      if (isCrashRecord(parsed)) record = parsed;
    } catch {
      // Keep the file. `readCrashRecords` skips it and the sweep refuses to
      // delete it; both are deliberate (see the module note).
    }

    files.push({
      name,
      path: full,
      bytes,
      record,
      at: record === null ? null : Date.parse(record.at),
    });
  }

  return files;
}

/**
 * Read every usable record, newest first.
 *
 * Files that do not parse, or that do not look like records, are skipped but
 * left on disk. A corrupt record is still someone's evidence, and deleting it
 * to make a list tidy would destroy the only copy.
 *
 * @param dir the crash directory
 */
export function readCrashRecords(dir: string): CrashRecord[] {
  return scanCrashDir(dir)
    .filter(
      (file): file is CrashFile & { record: CrashRecord; at: number } =>
        file.record !== null && file.at !== null,
    )
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
    .map((file) => file.record);
}

/**
 * Delete the oldest records until both caps hold.
 *
 * Both caps are checked per file, so a directory can be under the day limit and
 * still lose records to the size limit, and the other way around. The newest
 * usable record is never a candidate, even when it alone exceeds the size cap:
 * see the module note.
 *
 * Only `crash-*.json` is touched. A missing directory is a no-op.
 *
 * @param dir the crash directory
 * @param retention day and byte limits; validated by the settings layer
 * @param now the instant the sweep runs, injected so tests need no clock
 */
export function cleanupCrashRecords(
  dir: string,
  retention: CrashRetention = DEFAULT_CRASH_RETENTION,
  now: Date = new Date(),
): CrashCleanupResult {
  const files = scanCrashDir(dir);
  const bytesBefore = files.reduce((sum, file) => sum + file.bytes, 0);
  const usable = files
    .filter(
      (file): file is CrashFile & { record: CrashRecord; at: number } =>
        file.record !== null && file.at !== null,
    )
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  const newest = usable.at(-1);
  const cutoff = now.getTime() - retention.retentionDays * DAY_MS;
  const maxBytes = retention.maxTotalMb * 1024 * 1024;

  let bytesAfter = bytesBefore;
  const deleted: string[] = [];

  for (const file of usable) {
    if (file === newest) continue;

    const tooOld = file.at < cutoff;

    // Usable records are sorted oldest first, so once this one is neither too
    // old nor over the cap, no later one can be either.
    if (!tooOld && bytesAfter <= maxBytes) break;

    try {
      unlinkSync(file.path);
      bytesAfter -= file.bytes;
      deleted.push(file.name);
    } catch {
      // A record that cannot be deleted is reported by the sizes, not by a
      // thrown exception; keep sweeping the rest.
    }
  }

  return {
    deleted,
    bytesBefore,
    bytesAfter,
    unreadable: files.length - usable.length,
  };
}
