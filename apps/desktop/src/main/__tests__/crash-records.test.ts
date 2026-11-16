import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  crashDirFor,
  crashRecordFileName,
  crashRecordPath,
  cleanupCrashRecords,
  readCrashRecords,
  writeCrashRecord,
  writeCrashRecordSync,
} from "../crash/records.js";
import type { CrashRecord, CrashVersions } from "../crash/records.js";

/** Directories to remove after each test. Only the ones this file made. */
const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-crash-"));

  created.push(dir);

  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const VERSIONS: CrashVersions = {
  version: "0.1.0",
  electron: "45.3.2",
  node: "24.22.3",
  platform: "win32",
  arch: "x64",
};

/**
 * A valid record. The main variant is the smallest: the fields that distinguish
 * the kinds are filled by the capture tests, not by the storage tests.
 */
function recordAt(at: string, stack = "at main (main.ts:1:1)"): CrashRecord {
  return {
    schemaVersion: 1,
    at,
    kind: "main",
    code: "MAIN_CRASHED",
    app: VERSIONS,
    main: { name: "Error", message: "boom", stack },
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);

    return true;
  } catch {
    return false;
  }
}

describe("crashDirFor", () => {
  it("puts records under userData and nowhere else", () => {
    const userData = process.platform === "win32" ? "C:\\Users\\x\\AppData" : "/home/x/.config";

    expect(crashDirFor(userData)).toBe(path.join(userData, "crashes"));
  });
});

describe("crashRecordFileName", () => {
  it("uses a filesystem-safe UTC timestamp", () => {
    const at = new Date("2026-11-14T13:45:00.123Z");

    expect(crashRecordFileName(at)).toBe("crash-2026-11-14T13-45-00-123Z.json");
    expect(crashRecordFileName(at)).not.toMatch(/[:/\\]/);
    expect(crashRecordFileName(at)).toMatch(
      /^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/,
    );
  });

  it("names the path from the record instant", () => {
    const at = new Date("2026-11-14T13:45:00.123Z");

    expect(crashRecordPath("crashes", at)).toBe(
      path.join("crashes", "crash-2026-11-14T13-45-00-123Z.json"),
    );
  });
});

describe("writeCrashRecord", () => {
  it("round-trips a record", async () => {
    const dir = await tempDir();
    const record = recordAt("2026-11-14T13:45:00.123Z");
    const result = await writeCrashRecord(dir, record);

    expect(result.ok).toBe(true);
    expect(readCrashRecords(dir)).toEqual([record]);
  });

  it("writes the record as readable JSON", async () => {
    const dir = await tempDir();
    const record = recordAt("2026-11-14T13:45:00.123Z");

    await writeCrashRecord(dir, record);

    const text = await readFile(crashRecordPath(dir, new Date(record.at)), "utf8");

    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "kind": "main"');
  });
});

describe("writeCrashRecordSync", () => {
  it("creates the directory on the way", async () => {
    const root = await tempDir();
    const dir = path.join(root, "nested", "crashes");
    const record = recordAt("2026-11-14T13:45:00.123Z");
    const result = writeCrashRecordSync(dir, record);

    expect(result).toEqual({ ok: true, path: crashRecordPath(dir, new Date(record.at)) });
    expect(readCrashRecords(dir)).toEqual([record]);
  });

  it("returns a failure instead of throwing", async () => {
    const root = await tempDir();
    const blocker = path.join(root, "blocker");

    await writeFile(blocker, "not a directory");

    const result = writeCrashRecordSync(
      path.join(blocker, "crashes"),
      recordAt("2026-11-14T13:45:00.123Z"),
    );

    expect(result.ok).toBe(false);
  });
});

describe("readCrashRecords", () => {
  it("returns an empty list when there is no directory", async () => {
    const root = await tempDir();

    expect(readCrashRecords(path.join(root, "missing"))).toEqual([]);
  });

  it("skips a file that is not JSON, and keeps it", async () => {
    const dir = await tempDir();
    const record = recordAt("2026-11-14T13:45:00.123Z");
    const broken = path.join(dir, "crash-broken.json");

    await writeCrashRecord(dir, record);
    await writeFile(broken, '{"schemaVersion": 1, "kind": ');

    expect(readCrashRecords(dir)).toEqual([record]);
    expect(await exists(broken)).toBe(true);
  });

  it("skips JSON that is not a record, and keeps it", async () => {
    const dir = await tempDir();
    const record = recordAt("2026-11-14T13:45:00.123Z");
    const wrong = path.join(dir, "crash-wrong.json");

    await writeCrashRecord(dir, record);
    await writeFile(wrong, JSON.stringify({ schemaVersion: 2, kind: "main" }));

    expect(readCrashRecords(dir)).toEqual([record]);
    expect(await exists(wrong)).toBe(true);
  });

  it("returns the newest record first", async () => {
    const dir = await tempDir();

    await writeCrashRecord(dir, recordAt("2026-11-14T01:00:00.000Z"));
    await writeCrashRecord(dir, recordAt("2026-11-14T03:00:00.000Z"));
    await writeCrashRecord(dir, recordAt("2026-11-14T02:00:00.000Z"));

    expect(readCrashRecords(dir).map((record) => record.at)).toEqual([
      "2026-11-14T03:00:00.000Z",
      "2026-11-14T02:00:00.000Z",
      "2026-11-14T01:00:00.000Z",
    ]);
  });
});

describe("cleanupCrashRecords", () => {
  const now = new Date("2026-11-16T12:00:00.000Z");

  it("deletes records older than 30 days", async () => {
    const dir = await tempDir();
    const old = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const older = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const newest = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

    await writeCrashRecord(dir, recordAt(old.toISOString()));
    await writeCrashRecord(dir, recordAt(older.toISOString()));
    await writeCrashRecord(dir, recordAt(newest.toISOString()));

    const result = cleanupCrashRecords(dir, { retentionDays: 30, maxTotalMb: 10 }, now);

    expect(result.deleted).toEqual([crashRecordFileName(old)]);
    expect(readCrashRecords(dir).map((record) => record.at)).toEqual([
      newest.toISOString(),
      older.toISOString(),
    ]);
  });

  it("deletes the oldest records until the size cap holds", async () => {
    const dir = await tempDir();
    const threeMegabytes = 3 * 1024 * 1024;
    const instants = [4, 3, 2, 1].map((hours) => new Date(now.getTime() - hours * 60 * 60 * 1000));
    const oldest = instants[0];

    if (oldest === undefined) throw new Error("the fixture needs at least one instant");

    for (const at of instants) {
      await writeCrashRecord(dir, recordAt(at.toISOString(), "x".repeat(threeMegabytes)));
    }

    const result = cleanupCrashRecords(dir, { retentionDays: 30, maxTotalMb: 10 }, now);

    // 12 MB in, 9 MB after one deletion: the cap is reached before a second
    // record has to go.
    expect(result.bytesBefore).toBeGreaterThan(10 * 1024 * 1024);
    expect(result.bytesAfter).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(result.deleted).toEqual([crashRecordFileName(oldest)]);
    expect(readCrashRecords(dir)).toHaveLength(3);
  });

  it("never deletes the newest record, even when it alone exceeds both caps", async () => {
    const dir = await tempDir();
    const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const record = recordAt(old.toISOString(), "x".repeat(2 * 1024 * 1024));

    await writeCrashRecord(dir, record);

    const result = cleanupCrashRecords(dir, { retentionDays: 30, maxTotalMb: 1 }, now);

    expect(result.deleted).toEqual([]);
    expect(readCrashRecords(dir)).toEqual([record]);
  });

  it("counts a corrupt file toward the size but never deletes it", async () => {
    const dir = await tempDir();
    const corrupt = path.join(dir, "crash-corrupt.json");

    await writeFile(corrupt, "x".repeat(2 * 1024 * 1024));
    await writeCrashRecord(dir, recordAt(now.toISOString()));

    const result = cleanupCrashRecords(dir, { retentionDays: 30, maxTotalMb: 1 }, now);

    expect(result.unreadable).toBe(1);
    expect(result.deleted).toEqual([]);
    expect(await exists(corrupt)).toBe(true);
  });

  it("touches only crash-*.json files", async () => {
    const dir = await tempDir();
    const bystander = path.join(dir, "notes.txt");

    await writeFile(bystander, "x".repeat(2 * 1024 * 1024));

    const result = cleanupCrashRecords(dir, { retentionDays: 30, maxTotalMb: 1 }, now);

    expect(result.deleted).toEqual([]);
    expect(await exists(bystander)).toBe(true);
  });
});
