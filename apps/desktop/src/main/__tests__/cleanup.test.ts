import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runShellCleanup } from "../diagnostics/cleanup.js";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-cleanup-"));

  created.push(dir);

  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe("runShellCleanup", () => {
  it("removes an old day file, keeps today, and logs the section", async () => {
    const root = await tempDir();
    const logs = path.join(root, "logs");

    await mkdir(logs, { recursive: true });
    await writeFile(path.join(root, "keep.txt"), "not ours", "utf8");
    await writeFile(path.join(logs, "shell-2026-11-01.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(logs, "shell-2026-11-16.jsonl"), "{}\n", "utf8");

    const events: string[] = [];
    const result = await runShellCleanup({
      logsDir: logs,
      crashDir: path.join(root, "crashes"),
      crashDumpsDir: path.join(root, "crash-dumps"),
      now: new Date("2026-11-16T12:00:00.000Z"),
      onLog: (event) => events.push(event),
    });

    expect(result.logs?.deleted).toEqual(["shell-2026-11-01.jsonl"]);
    expect(await readdir(logs)).toEqual(["shell-2026-11-16.jsonl"]);
    expect(await readdir(root)).toContain("keep.txt");
    expect(events).toContain("logs.cleanup");
  });
});
