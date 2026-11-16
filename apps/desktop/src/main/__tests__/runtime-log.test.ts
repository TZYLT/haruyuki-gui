/**
 * The "open logs" action is the reverse of the usual happy-path test: a
 * missing directory and a failing `openPath` must be reported, not swallowed.
 * That is the point for this feature -- proving the button opens a directory is
 * not enough; proving it says why when it cannot is the other half.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openLogsDirectory } from "../runtime/log.js";

let work: string | null = null;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "g1-logs-"));
});

afterEach(async () => {
  if (work !== null) await rm(work, { recursive: true, force: true });
  work = null;
});

describe("openLogsDirectory", () => {
  it("opens an existing directory and reports success", async () => {
    const openPath = vi.fn(async () => "");

    await expect(openLogsDirectory(work!, openPath)).resolves.toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(work);
  });

  it("reports a missing directory instead of calling openPath", async () => {
    const openPath = vi.fn(async () => "");

    const result = await openLogsDirectory(path.join(work!, "absent"), openPath);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.detail).toContain("does not exist");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("reports openPath's error string instead of claiming success", async () => {
    const openPath = vi.fn(async () => "no default handler");

    const result = await openLogsDirectory(work!, openPath);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.detail).toContain("no default handler");
  });

  it("reports a thrown openPath error", async () => {
    const openPath = vi.fn(async () => {
      throw new Error("explorer crashed");
    });

    const result = await openLogsDirectory(work!, openPath);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.detail).toContain("explorer crashed");
  });

  it("rejects a file at the log path", async () => {
    const file = path.join(work!, "not-a-dir");
    await writeFile(file, "x", "utf8");

    const result = await openLogsDirectory(file, async () => "");

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.detail).toContain("not a directory");
  });
});
