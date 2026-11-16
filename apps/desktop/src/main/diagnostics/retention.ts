/**
 * Retention: what the shell keeps on disk, and what it lets go.
 *
 * Three independent quotas (`32` section 4.7): logs 7 days / 50 MB, crash records
 * 30 days / 10 MB, minidumps 7 days / 200 MB. They are enforced separately
 * because they answer different questions -- how much history is useful, and how
 * much disk a bug report may cost.
 *
 * Two rules shape every sweep:
 *
 *   Whole units only. A day file is deleted whole, never truncated; so is a
 *   crash record and a dump. A half-file is unreadable evidence, and rewriting a
 *   log to get under a cap would corrupt the JSONL a reader is about to open.
 *
 *   Something is always left behind. Today's log is never deleted, and the
 *   newest crash record / dump survives even when it alone exceeds the cap
 *   (`RD-17`). Deleting the only evidence of the crash a sweep exists to explain
 *   is worse than being over quota for a day, so a sweep reports the size it
 *   could not remove (`overCap`) instead of pretending the cap held -- which
 *   `32` section 4.7 asks for in `summary.txt`.
 *
 * It does not decide *when* to sweep (`RD-17`) or log the result: that is the
 * caller's job, and the caller owns the clock and the logger.
 */

import { readdir, stat, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { cleanupCrashRecords, DEFAULT_CRASH_RETENTION } from "../crash/records.js";
import type { CrashCleanupResult } from "../crash/records.js";
import { DEFAULT_LOG_RETENTION } from "../settings.js";
import type { LogRetention } from "../settings.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The only log files this sweep may touch: `shell-YYYY-MM-DD.jsonl`. */
const LOG_FILE = /^shell-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/** Where crashpad writes dumps, relative to the crash-dumps root. */
const MINIDUMP_SUBDIR = "reports";

/** The only dumps this sweep may touch, and only directly inside `reports/`. */
const MINIDUMP_FILE = /\.dmp$/i;

/**
 * A day window and a size cap, for the sweeps that take their numbers from a
 * caller rather than from `shell-settings.json`.
 */
export interface RetentionWindow {
  readonly retentionDays: number;
  readonly maxTotalMb: number;
}

/** Defaults from `32` section 6.5: dumps are kept a week, capped at 200 MB. */
export const DEFAULT_MINIDUMP_RETENTION: RetentionWindow = { retentionDays: 7, maxTotalMb: 200 };

/** What a sweep removed, and whether the cap still holds afterwards. */
export interface RetentionSweep {
  /** File names removed, oldest first. */
  readonly deleted: readonly string[];
  /** Bytes of *managed* files present before the sweep. */
  readonly bytesBefore: number;
  /** Bytes of managed files present after the sweep; may still exceed the cap. */
  readonly bytesAfter: number;
  /** Whether the managed files are still over the cap; a failed delete counts. */
  readonly overCap: boolean;
}

/** One section's failure. A sweep never throws; it reports. */
export interface CleanupFailure {
  readonly section: "logs" | "crashes" | "minidumps";
  /** Human-readable cause, for the log line the caller writes. */
  readonly error: string;
}

/** Where the shell's three managed directories are, plus the clock. */
export interface StartupCleanupOptions {
  readonly logsDir: string;
  readonly crashDir: string;
  readonly crashDumpsDir: string;
  /** Injected so a test needs no clock, and so all three sections agree on it. */
  readonly now?: Date;
  /** Overrides for the log pair; defaults to `shell-settings.json`'s default. */
  readonly logs?: LogRetention;
  /** Overrides for the crash pair; defaults to 30 days / 10 MB. */
  readonly crashes?: RetentionWindow;
  /** Overrides for the dump pair; defaults to 7 days / 200 MB. */
  readonly minidumps?: RetentionWindow;
}

/** What a startup sweep achieved, section by section. */
export interface StartupCleanupResult {
  readonly logs: RetentionSweep | null;
  readonly crashes: CrashCleanupResult | null;
  readonly minidumps: RetentionSweep | null;
  readonly failures: readonly CleanupFailure[];
}

/** A managed file, with what the sweep needs to order and price it. */
interface ManagedFile {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  /** UTC midnight of the day the name claims, or the mtime for a dump. */
  readonly at: number;
}

/** A directory entry list, with "the directory does not exist" as an empty list. */
async function listDir(dir: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];

    throw error;
  }
}

/** Whether an error means "nothing there", which every sweep treats as a no-op. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** A file's size and modification time, or `null` when it is not a regular file. */
async function stampOf(file: string): Promise<{ bytes: number; mtimeMs: number } | null> {
  try {
    const info = await stat(file);

    return info.isFile() ? { bytes: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * UTC midnight of the day an instant falls in.
 *
 * `Date.UTC` rather than `setHours(0, 0, 0, 0)`: the day files are named in UTC,
 * and a local midnight would shift the window by the UTC offset.
 */
function utcDayStart(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/**
 * The UTC day a `shell-YYYY-MM-DD.jsonl` name claims, or `null`.
 *
 * The date is validated by round-tripping it: `shell-2026-02-30.jsonl` must not
 * be treated as a log file (it is not one this shell writes), and normalising it
 * into March would make an unrelated file eligible for deletion.
 */
function logFileDay(name: string): number | null {
  const match = LOG_FILE.exec(name);

  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(start);

  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }

  return start;
}

/** Delete one file; a failure is reported through the sizes, not thrown. */
async function remove(file: ManagedFile, deleted: string[]): Promise<boolean> {
  try {
    await unlink(file.path);
    deleted.push(file.name);

    return true;
  } catch {
    return false;
  }
}

/**
 * Delete old and oversized log day files.
 *
 * The window is `retentionDays` UTC days *including today*: with the default 7,
 * today and the six days before it survive. The current day is excluded from
 * every candidate list before anything is decided, which is what makes "never
 * deleted" unconditional rather than a condition the size pass could forget.
 *
 * Only `shell-YYYY-MM-DD.jsonl` is considered. A rotated file someone renamed by
 * hand, a directory with a matching name, and the engine's own logs are all
 * invisible here: deleting a file this shell did not write is not a retention
 * decision it is allowed to make.
 *
 * @param logsDir `app.getPath("logs")`
 * @param options the user's pair, already validated by the settings layer
 * @param now the instant the sweep runs
 */
export async function cleanupLogs(
  logsDir: string,
  options: LogRetention = DEFAULT_LOG_RETENTION,
  now: Date = new Date(),
): Promise<RetentionSweep> {
  const today = utcDayStart(now);
  const oldestKeptDay = today - (options.retentionDays - 1) * DAY_MS;
  const maxBytes = options.maxTotalMb * 1024 * 1024;

  const files: ManagedFile[] = [];

  for (const entry of await listDir(logsDir)) {
    if (!entry.isFile()) continue;

    const day = logFileDay(entry.name);

    if (day === null) continue;

    const file = path.join(logsDir, entry.name);
    const stamp = await stampOf(file);

    if (stamp === null) continue;

    files.push({ name: entry.name, path: file, bytes: stamp.bytes, at: day });
  }

  const bytesBefore = files.reduce((sum, file) => sum + file.bytes, 0);
  const deleted: string[] = [];
  let bytesAfter = bytesBefore;

  files.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));

  // The current day is excluded once, here, so neither pass below can reach it.
  // A day file from the future is excluded too: it is not this sweep's to delete,
  // even when the directory is over the size cap.
  let older = files.filter((file) => file.at < today);

  for (const file of older) {
    // Sorted oldest first: the first file inside the window ends the age pass.
    if (file.at >= oldestKeptDay) break;

    if (await remove(file, deleted)) bytesAfter -= file.bytes;
  }

  older = older.filter((file) => !deleted.includes(file.name));

  // The size pass runs even after the age pass, and both are needed: a directory
  // can be well inside the day window and still be 300 MB of chatty logs.
  for (const file of older) {
    if (bytesAfter <= maxBytes) break;

    if (await remove(file, deleted)) bytesAfter -= file.bytes;
  }

  return { deleted, bytesBefore, bytesAfter, overCap: bytesAfter > maxBytes };
}

/**
 * Delete old and oversized crash records.
 *
 * Delegation, not reimplementation: `P3` owns the record format and the "newest
 * one is never deleted" rule, and two owners for one policy is how the sweep and
 * the reader drift apart. This wrapper exists so a caller can run all three
 * sweeps with one import and one options shape.
 *
 * @param crashDir `crashDirFor(userData)`
 * @param options 30 days / 10 MB unless the caller says otherwise
 * @param now the instant the sweep runs
 */
export async function cleanupCrashes(
  crashDir: string,
  options: RetentionWindow = DEFAULT_CRASH_RETENTION,
  now: Date = new Date(),
): Promise<CrashCleanupResult> {
  return cleanupCrashRecords(crashDir, options, now);
}

/**
 * Delete old and oversized minidumps.
 *
 * Only `<crashDumps>/reports/*.dmp` is considered, and only the top level: crashpad
 * owns `metadata/`, `settings.dat` and `attachments/`, and a sweep that walked into
 * them would delete another component's state and could blow the startup budget.
 *
 * Age comes from the modification time because a dump's name is crashpad's, not
 * ours. The newest dump is never deleted, in either pass -- see the module note.
 *
 * @param crashDumpsDir the crash-dumps root, not `reports/`
 * @param options 7 days / 200 MB unless the caller says otherwise
 * @param now the instant the sweep runs
 */
export async function cleanupMinidumps(
  crashDumpsDir: string,
  options: RetentionWindow = DEFAULT_MINIDUMP_RETENTION,
  now: Date = new Date(),
): Promise<RetentionSweep> {
  const reports = path.join(crashDumpsDir, MINIDUMP_SUBDIR);
  const cutoff = now.getTime() - options.retentionDays * DAY_MS;
  const maxBytes = options.maxTotalMb * 1024 * 1024;

  const files: ManagedFile[] = [];

  for (const entry of await listDir(reports)) {
    if (!entry.isFile() || !MINIDUMP_FILE.test(entry.name)) continue;

    const file = path.join(reports, entry.name);
    const stamp = await stampOf(file);

    if (stamp === null) continue;

    files.push({ name: entry.name, path: file, bytes: stamp.bytes, at: stamp.mtimeMs });
  }

  const bytesBefore = files.reduce((sum, file) => sum + file.bytes, 0);
  const deleted: string[] = [];
  let bytesAfter = bytesBefore;

  files.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));

  const newest = files.at(-1);
  const older = files.filter((file) => file !== newest);

  for (const file of older) {
    if (file.at >= cutoff) break;

    if (await remove(file, deleted)) bytesAfter -= file.bytes;
  }

  const remaining = older.filter((file) => !deleted.includes(file.name));

  for (const file of remaining) {
    if (bytesAfter <= maxBytes) break;

    if (await remove(file, deleted)) bytesAfter -= file.bytes;
  }

  return { deleted, bytesBefore, bytesAfter, overCap: bytesAfter > maxBytes };
}

/** A failure as text: an error object's message, or whatever else was thrown. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run all three sweeps once, at startup (or before an export).
 *
 * Every section is isolated: a log directory on a disconnected drive must not
 * stop the crash sweep, and no failure here may block a launch -- a shell that
 * refuses to open because it could not delete a log is worse than one over quota.
 * The clock is captured once so all three sections agree on "today".
 *
 * @param options the three directories, the clock and optional quota overrides
 */
export async function runStartupCleanup(
  options: StartupCleanupOptions,
): Promise<StartupCleanupResult> {
  const now = options.now ?? new Date();
  const failures: CleanupFailure[] = [];

  let logs: RetentionSweep | null = null;
  let crashes: CrashCleanupResult | null = null;
  let minidumps: RetentionSweep | null = null;

  try {
    logs = await cleanupLogs(options.logsDir, options.logs ?? DEFAULT_LOG_RETENTION, now);
  } catch (error) {
    failures.push({ section: "logs", error: describe(error) });
  }

  try {
    crashes = await cleanupCrashes(
      options.crashDir,
      options.crashes ?? DEFAULT_CRASH_RETENTION,
      now,
    );
  } catch (error) {
    failures.push({ section: "crashes", error: describe(error) });
  }

  try {
    minidumps = await cleanupMinidumps(
      options.crashDumpsDir,
      options.minidumps ?? DEFAULT_MINIDUMP_RETENTION,
      now,
    );
  } catch (error) {
    failures.push({ section: "minidumps", error: describe(error) });
  }

  return { logs, crashes, minidumps, failures };
}
