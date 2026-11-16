/**
 * Retention at its exact edges: the day a window includes, the byte that puts a
 * directory over the cap, the newest file that survives anyway, and the section
 * boundary that keeps one broken directory from stopping the other two.
 *
 * `retention.test.ts` states one behaviour per test with room to breathe. This
 * file pins the boundaries themselves: `retentionDays` counts the current day,
 * so 7 keeps today and the six before it and deletes the seventh; the size pass
 * deletes only while the total is *over* the cap, so a directory exactly at the
 * cap is untouched; the newest crash record and dump are never candidates even
 * when they alone exceed it.
 *
 * Everything is deterministic: the clock is injected, and the one filesystem
 * timestamp a sweep reads (a minidump's mtime) is set explicitly and read back
 * before the sweep runs.
 */

import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MINIDUMP_RETENTION,
  cleanupCrashes,
  cleanupLogs,
  cleanupMinidumps,
  runStartupCleanup,
} from "../diagnostics/retention.js";
import {
  DEFAULT_CRASH_RETENTION,
  crashDirFor,
  writeCrashRecord,
  type CrashRecord,
} from "../crash/records.js";
import { DEFAULT_LOG_RETENTION } from "../settings.js";

/** Directories this file made, removed pointwise after each test. */
const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-boundary-"));

  created.push(dir);

  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

/** The fixed instant every sweep runs at. */
const NOW = new Date("2026-11-16T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

/** The `shell-YYYY-MM-DD.jsonl` name for a day offset from {@link NOW}. */
function logName(offsetDays: number): string {
  return `shell-${new Date(NOW.getTime() - offsetDays * DAY_MS).toISOString().slice(0, 10)}.jsonl`;
}

async function writeSized(file: string, bytes: number): Promise<void> {
  await writeFile(file, Buffer.alloc(bytes, 0x61));
}

/** Whether a path exists, without a `stat` throw in the middle of an assertion. */
async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);

    return true;
  } catch {
    return false;
  }
}

/** A minimal record P3's reader considers usable. */
function crashRecordAt(at: string): CrashRecord {
  return {
    schemaVersion: 1,
    at,
    kind: "main",
    code: "MAIN_CRASHED",
    app: {
      version: "0.1.0",
      electron: "45.3.2",
      node: "24.22.3",
      platform: "win32",
      arch: "x64",
    },
    main: { name: "Error", message: "boom" },
  };
}

/** The three quotas as the documents state them, not as one shared constant. */
describe("the quotas the boundaries are written against", () => {
  it("are the three pairs from the requirement", () => {
    expect(DEFAULT_LOG_RETENTION).toEqual({ retentionDays: 7, maxTotalMb: 50 });
    expect(DEFAULT_CRASH_RETENTION).toEqual({ retentionDays: 30, maxTotalMb: 10 });
    expect(DEFAULT_MINIDUMP_RETENTION).toEqual({ retentionDays: 7, maxTotalMb: 200 });
  });
});

describe("logs: the day window includes today", () => {
  it("deletes day 7 and keeps day 6, the last day inside the window", async () => {
    const dir = await tempDir();

    await writeSized(path.join(dir, logName(6)), 10);
    await writeSized(path.join(dir, logName(7)), 10);

    const result = await cleanupLogs(dir, DEFAULT_LOG_RETENTION, NOW);

    expect(result.deleted).toEqual([logName(7)]);
    expect(await exists(path.join(dir, logName(6)))).toBe(true);
    expect(await exists(path.join(dir, logName(7)))).toBe(false);
    expect(result.bytesBefore).toBe(20);
    expect(result.bytesAfter).toBe(10);
    expect(result.overCap).toBe(false);
  });

  it("never deletes today, even when today alone is over the cap", async () => {
    const dir = await tempDir();

    await writeSized(path.join(dir, logName(0)), 2 * MB);

    const result = await cleanupLogs(dir, { retentionDays: 7, maxTotalMb: 1 }, NOW);

    expect(result.deleted).toEqual([]);
    expect(result.overCap).toBe(true);
    expect(result.bytesAfter).toBe(2 * MB);
    expect(await exists(path.join(dir, logName(0)))).toBe(true);
  });

  it("leaves a directory exactly at the cap untouched and deletes once over it", async () => {
    const atCap = await tempDir();

    await writeSized(path.join(atCap, logName(1)), MB / 2);
    await writeSized(path.join(atCap, logName(2)), MB / 2);

    const exact = await cleanupLogs(atCap, { retentionDays: 7, maxTotalMb: 1 }, NOW);

    expect(exact.bytesBefore).toBe(MB);
    expect(exact.deleted).toEqual([]);
    expect(exact.overCap).toBe(false);

    // One byte more is over the cap: the oldest file goes, and the total lands
    // back on the cap rather than below it.
    await writeSized(path.join(atCap, logName(3)), 1);

    const over = await cleanupLogs(atCap, { retentionDays: 7, maxTotalMb: 1 }, NOW);

    expect(over.deleted).toEqual([logName(3)]);
    expect(over.bytesAfter).toBe(MB);
    expect(over.overCap).toBe(false);
  });

  it("keeps a future day file when the directory is inside the cap", async () => {
    // A day file from tomorrow is not this sweep's to delete; the age pass sorts
    // it after every file it would delete and stops.
    const dir = await tempDir();

    await writeSized(path.join(dir, logName(-1)), 10);

    const result = await cleanupLogs(dir, DEFAULT_LOG_RETENTION, NOW);

    expect(result.deleted).toEqual([]);
    expect(await exists(path.join(dir, logName(-1)))).toBe(true);
  });

  it("keeps a future day file even when the directory is over the cap", async () => {
    const dir = await tempDir();

    await writeSized(path.join(dir, logName(0)), 30 * MB);
    await writeSized(path.join(dir, logName(-1)), 30 * MB);

    const result = await cleanupLogs(dir, DEFAULT_LOG_RETENTION, NOW);

    expect(result.deleted).toEqual([]);
    expect(await exists(path.join(dir, logName(-1)))).toBe(true);
    expect(result.overCap).toBe(true);
  });

  it("manages only shell-YYYY-MM-DD.jsonl files", async () => {
    const dir = await tempDir();
    const foreign = ["engine-2026-11-16.jsonl", "shell-2026-11-16.jsonl.bak", "notes.log"];

    for (const name of foreign) await writeSized(path.join(dir, name), 10);

    await writeSized(path.join(dir, logName(30)), 10);

    const result = await cleanupLogs(dir, DEFAULT_LOG_RETENTION, NOW);

    expect(result.deleted).toEqual([logName(30)]);
    for (const name of foreign) expect(await exists(path.join(dir, name)), name).toBe(true);
  });
});

describe("crashes: 30 days, newest kept", () => {
  it("keeps a record exactly on the 30-day cutoff and deletes the one a millisecond older", async () => {
    const dir = await tempDir();
    const cutoff = new Date(NOW.getTime() - DEFAULT_CRASH_RETENTION.retentionDays * DAY_MS);
    const older = new Date(cutoff.getTime() - 1);

    await writeCrashRecord(dir, crashRecordAt(older.toISOString()));
    await writeCrashRecord(dir, crashRecordAt(cutoff.toISOString()));

    const result = await cleanupCrashes(dir, DEFAULT_CRASH_RETENTION, NOW);
    const left = await readdir(dir);

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toContain(older.toISOString().replace(/[:.]/g, "-"));
    expect(left).toHaveLength(1);
    // The surviving bytes are the surviving record, not an estimate.
    expect(result.bytesAfter).toBe((await stat(path.join(dir, left[0] ?? ""))).size);
  });

  it("keeps the newest record even when it alone exceeds the cap", async () => {
    const dir = await tempDir();
    const older = new Date(NOW.getTime() - 2 * DAY_MS).toISOString();

    // A cap of zero makes the rule visible without writing a 10 MB record: the
    // sweep must still leave the newest usable record on disk.
    await writeCrashRecord(dir, crashRecordAt(older));
    await writeCrashRecord(dir, crashRecordAt(NOW.toISOString()));

    const result = await cleanupCrashes(dir, { retentionDays: 30, maxTotalMb: 0 }, NOW);

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toContain(older.replace(/[:.]/g, "-"));
    expect(result.bytesAfter).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);

    const left = await readdir(dir);
    expect(left).toHaveLength(1);
  });

  it("reports an unparseable record instead of deleting it", async () => {
    const dir = crashDirFor(await tempDir());

    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "crash-2026-01-01T00-00-00-000Z.json"), "{ not json", "utf8");
    await writeCrashRecord(dir, crashRecordAt(NOW.toISOString()));

    const result = await cleanupCrashes(dir, DEFAULT_CRASH_RETENTION, NOW);

    expect(result.unreadable).toBe(1);
    expect(result.deleted).toEqual([]);
    expect(await exists(path.join(dir, "crash-2026-01-01T00-00-00-000Z.json"))).toBe(true);
  });
});

describe("minidumps: reports/*.dmp only, newest kept", () => {
  /** A crash-dumps root with an empty `reports/` directory. */
  async function dumpsRoot(): Promise<{ root: string; reports: string }> {
    const root = await tempDir();
    const reports = path.join(root, "reports");

    await mkdir(reports, { recursive: true });

    return { root, reports };
  }

  /** Give a file an exact mtime and prove the filesystem kept it. */
  async function setMtime(file: string, at: number): Promise<void> {
    await utimes(file, new Date(at), new Date(at));
    expect((await stat(file)).mtimeMs, `filesystem kept the mtime of ${file}`).toBe(at);
  }

  it("keeps the dump exactly on the 7-day cutoff and deletes one a millisecond older", async () => {
    const { root, reports } = await dumpsRoot();
    const cutoff = NOW.getTime() - DEFAULT_MINIDUMP_RETENTION.retentionDays * DAY_MS;
    const edge = path.join(reports, "edge.dmp");
    const older = path.join(reports, "older.dmp");

    await writeSized(edge, 10);
    await writeSized(older, 10);
    await setMtime(edge, cutoff);
    await setMtime(older, cutoff - 1);

    const result = await cleanupMinidumps(root, DEFAULT_MINIDUMP_RETENTION, NOW);

    expect(result.deleted).toEqual(["older.dmp"]);
    expect(await exists(edge)).toBe(true);
    expect(await exists(older)).toBe(false);
    expect(result.bytesBefore).toBe(20);
    expect(result.bytesAfter).toBe(10);
    expect(result.overCap).toBe(false);
  });

  it("keeps the newest dump even when it alone exceeds the cap", async () => {
    const { root, reports } = await dumpsRoot();
    const newest = path.join(reports, "newest.dmp");
    const older = path.join(reports, "older.dmp");

    await writeSized(newest, 2 * MB);
    await writeSized(older, 16);
    await setMtime(newest, NOW.getTime() - DAY_MS);
    await setMtime(older, NOW.getTime() - 2 * DAY_MS);

    const result = await cleanupMinidumps(root, { retentionDays: 7, maxTotalMb: 1 }, NOW);

    expect(result.deleted).toEqual(["older.dmp"]);
    expect(result.overCap).toBe(true);
    expect(result.bytesAfter).toBe(2 * MB);
    expect(await exists(newest)).toBe(true);
  });

  it("touches only top-level reports/*.dmp files", async () => {
    const { root, reports } = await dumpsRoot();
    const metadata = path.join(root, "metadata");

    await mkdir(metadata, { recursive: true });

    const foreign = [
      path.join(metadata, "state.json"),
      path.join(root, "settings.dat"),
      path.join(root, "attachments", "x.dmp"),
      path.join(reports, "readme.txt"),
    ];

    for (const file of foreign) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeSized(file, 10);
      // Old enough that the age pass would take it if it were managed.
      await setMtime(file, NOW.getTime() - 40 * DAY_MS);
    }

    const result = await cleanupMinidumps(root, DEFAULT_MINIDUMP_RETENTION, NOW);

    expect(result.deleted).toEqual([]);
    expect(result.bytesBefore).toBe(0);
    for (const file of foreign) expect(await exists(file), file).toBe(true);
  });

  it("is a no-op when reports/ does not exist", async () => {
    const root = await tempDir();

    expect(await cleanupMinidumps(root, DEFAULT_MINIDUMP_RETENTION, NOW)).toEqual({
      deleted: [],
      bytesBefore: 0,
      bytesAfter: 0,
      overCap: false,
    });
  });
});

describe("runStartupCleanup isolates a broken section", () => {
  it("reports the log failure and still sweeps crashes and dumps", async () => {
    const home = await tempDir();
    // A file where the logs directory should be: `readdir` throws ENOTDIR, which
    // is the shape of "a drive went away" and must not stop the other sections.
    const logsPath = path.join(home, "logs-is-a-file");
    const crashDir = crashDirFor(home);
    const crashDumpsDir = path.join(home, "crash-dumps");

    await writeFile(logsPath, "not a directory", "utf8");
    await mkdir(crashDumpsDir, { recursive: true });
    await writeCrashRecord(crashDir, crashRecordAt(NOW.toISOString()));

    const result = await runStartupCleanup({
      logsDir: logsPath,
      crashDir,
      crashDumpsDir,
      now: NOW,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.section).toBe("logs");
    expect((result.failures[0]?.error ?? "").length).toBeGreaterThan(0);
    expect(result.logs).toBeNull();
    // The other two sections ran anyway: a missing log directory is not a reason
    // to leave old crash evidence on disk.
    expect(result.crashes).not.toBeNull();
    expect(result.minidumps).not.toBeNull();
    expect(result.crashes?.bytesAfter).toBeGreaterThan(0);
  });

  it("sweeps all three sections when every directory exists", async () => {
    const home = await tempDir();
    const logsDir = path.join(home, "logs");
    const crashDir = crashDirFor(home);
    const crashDumpsDir = path.join(home, "crash-dumps");
    const reports = path.join(crashDumpsDir, "reports");

    await Promise.all([mkdir(logsDir, { recursive: true }), mkdir(reports, { recursive: true })]);
    await writeSized(path.join(logsDir, logName(30)), 10);
    await writeCrashRecord(
      crashDir,
      crashRecordAt(new Date(NOW.getTime() - 40 * DAY_MS).toISOString()),
    );
    await writeCrashRecord(crashDir, crashRecordAt(NOW.toISOString()));

    const result = await runStartupCleanup({ logsDir, crashDir, crashDumpsDir, now: NOW });

    expect(result.failures).toEqual([]);
    expect(result.logs?.deleted).toEqual([logName(30)]);
    expect(result.crashes?.deleted).toHaveLength(1);
    expect(result.minidumps?.deleted).toEqual([]);
  });
});
