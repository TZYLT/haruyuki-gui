/**
 * Tests for the injectable filesystem and its durability helpers.
 *
 * Two layers of evidence are needed. The real `node:fs/promises` adapter is
 * exercised against a disposable `mkdtemp` directory, because the contract it
 * must honour is about real ENOENT, real sizes and a real atomic rename. The
 * failure paths -- rename that dies between write and move, a directory that
 * cannot be listed -- are exercised with an in-memory `LayoutFs`, which is the
 * whole reason the interface exists: the rule is not to mock `node:fs`. The
 * `node:fs`. The injected fake also lets a test prove that the OLD file is still
 * readable after a failed rename, which a real filesystem cannot be made to do
 * on demand.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backupPath, layoutPath } from "./layout-paths";
import { atomicWrite, backupFile, createNodeLayoutFs, pruneBackups } from "./layout-fs";
import type { LayoutFs } from "./layout-fs";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "haruyuki-layout-fs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createNodeLayoutFs", () => {
  it("reads a missing file and stats a missing path as null", async () => {
    const fs = createNodeLayoutFs();
    const missing = join(root, "layout", "desktop.json");
    await expect(fs.readFile(missing)).resolves.toBeNull();
    await expect(fs.stat(missing)).resolves.toBeNull();
  });

  it("round-trips text, creates parents recursively and reports real sizes", async () => {
    const fs = createNodeLayoutFs();
    const file = join(root, "layout", "desktop.json");
    await fs.mkdir(dirname(file));
    await fs.mkdir(dirname(file)); // recursive mkdir is idempotent
    await fs.writeFile(file, '{"version":1}');
    await expect(fs.readFile(file)).resolves.toBe('{"version":1}');
    await expect(fs.stat(file)).resolves.toEqual({
      size: Buffer.byteLength('{"version":1}', "utf8"),
    });
  });

  it("rethrows errors that are not ENOENT", async () => {
    const fs = createNodeLayoutFs();
    const directory = join(root, "layout");
    await fs.mkdir(directory);
    // Reading a directory is not "absent": it must surface, not come back null.
    let caught: unknown = null;
    try {
      await fs.readFile(directory);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).not.toBe("ENOENT");
  });

  it("lists directory entries", async () => {
    const fs = createNodeLayoutFs();
    await fs.mkdir(join(root, "layout"));
    await fs.writeFile(join(root, "layout", "a.json"), "{}");
    await fs.writeFile(join(root, "layout", "b.json"), "{}");
    await expect(fs.readdir(join(root, "layout"))).resolves.toEqual(
      expect.arrayContaining(["a.json", "b.json"]),
    );
  });
});

describe("atomicWrite", () => {
  it("writes the content and leaves no temporary sibling behind", async () => {
    const fs = createNodeLayoutFs();
    const dir = join(root, "layout");
    const file = join(dir, "desktop.json");
    await fs.mkdir(dir);
    await atomicWrite(fs, file, '{"version":1,"root":{"type":"panel"}}');
    expect(await readFile(file, "utf8")).toBe('{"version":1,"root":{"type":"panel"}}');
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("replaces an existing file atomically", async () => {
    const fs = createNodeLayoutFs();
    const dir = join(root, "layout");
    const file = join(dir, "desktop.json");
    await fs.mkdir(dir);
    await writeFile(file, "old", "utf8");
    await atomicWrite(fs, file, "new");
    await expect(fs.readFile(file)).resolves.toBe("new");
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("keeps the old file readable and removes the temporary when rename fails", async () => {
    const file = join(root, "layout", "desktop.json");
    const { fs, files } = createFakeFs({ [file]: "old" }, { rename: true });

    await expect(atomicWrite(fs, file, "new")).rejects.toMatchObject({ code: "EPERM" });

    expect(files.get(file)).toBe("old");
    expect([...files.keys()].filter((path) => path.includes(".tmp-"))).toEqual([]);
  });

  it("removes the temporary and rethrows when the write itself fails", async () => {
    const file = join(root, "layout", "desktop.json");
    const { fs, files } = createFakeFs({ [file]: "old" }, { write: true });

    await expect(atomicWrite(fs, file, "new")).rejects.toMatchObject({ code: "EIO" });

    expect(files.get(file)).toBe("old");
    expect([...files.keys()].filter((path) => path.includes(".tmp-"))).toEqual([]);
  });

  it("still rethrows the original error when cleanup also fails", async () => {
    const file = join(root, "layout", "desktop.json");
    const { fs } = createFakeFs({ [file]: "old" }, { rename: true, unlink: true });

    await expect(atomicWrite(fs, file, "new")).rejects.toMatchObject({ code: "EPERM" });
  });
});

describe("backupFile", () => {
  it("copies the bytes and reports success", async () => {
    const fs = createNodeLayoutFs();
    const dir = join(root, "layout");
    const file = layoutPath(root, "desktop");
    const backup = backupPath(root, "desktop", "2026-11-16T21-30-24-123Z");
    await fs.mkdir(dir);
    await writeFile(file, '{"version":1}', "utf8");

    await expect(backupFile(fs, file, backup)).resolves.toBe(true);
    await expect(readFile(backup, "utf8")).resolves.toBe('{"version":1}');
  });

  it("reports failure instead of throwing when the source is missing", async () => {
    const fs = createNodeLayoutFs();
    const backup = backupPath(root, "desktop", "2026-11-16T21-30-24-123Z");
    await expect(backupFile(fs, layoutPath(root, "desktop"), backup)).resolves.toBe(false);
  });
});

describe("pruneBackups", () => {
  it("keeps the newest three copies and leaves unrelated files alone", async () => {
    const fs = createNodeLayoutFs();
    const dir = join(root, "layout");
    const prefix = "desktop.corrupt-";
    await fs.mkdir(dir);
    for (const stamp of ["01", "02", "03", "04", "05"]) {
      await writeFile(join(dir, `${prefix}${stamp}.json`), stamp, "utf8");
    }
    await writeFile(join(dir, "desktop.json"), "{}", "utf8");
    await writeFile(join(dir, "vscode.corrupt-09.json"), "{}", "utf8");

    await pruneBackups(fs, dir, prefix);

    const names = (await readdir(dir)).sort();
    expect(names).toEqual(
      [
        "desktop.corrupt-03.json",
        "desktop.corrupt-04.json",
        "desktop.corrupt-05.json",
        "desktop.json",
        "vscode.corrupt-09.json",
      ].sort(),
    );
  });

  it("honours a custom keep count", async () => {
    const fs = createNodeLayoutFs();
    const dir = join(root, "layout");
    await fs.mkdir(dir);
    for (const stamp of ["01", "02", "03"]) {
      await writeFile(join(dir, `desktop.corrupt-${stamp}.json`), stamp, "utf8");
    }
    await pruneBackups(fs, dir, "desktop.corrupt-", 1);
    await expect(readdir(dir)).resolves.toEqual(["desktop.corrupt-03.json"]);
  });

  it("never throws when the directory cannot be listed or a file cannot be removed", async () => {
    const dir = join(root, "layout");
    const readdirFail = createFakeFs({}, { readdir: true });
    await expect(pruneBackups(readdirFail.fs, dir, "desktop.corrupt-")).resolves.toBeUndefined();

    const unlinkFail = createFakeFs(
      { [join(dir, "desktop.corrupt-01.json")]: "1" },
      { unlink: true },
    );
    await expect(pruneBackups(unlinkFail.fs, dir, "desktop.corrupt-", 0)).resolves.toBeUndefined();
    expect([...unlinkFail.files.keys()]).toEqual([join(dir, "desktop.corrupt-01.json")]);
  });

  it("is a no-op for a missing directory", async () => {
    const fs = createNodeLayoutFs();
    await expect(
      pruneBackups(fs, join(root, "absent"), "desktop.corrupt-"),
    ).resolves.toBeUndefined();
  });
});

describe("two shells", () => {
  it("writes and reads independent layout files", async () => {
    const fs = createNodeLayoutFs();
    const dir = join(root, "layout");
    const desktop = layoutPath(root, "desktop");
    const vscode = layoutPath(root, "vscode");
    await fs.mkdir(dir);
    await atomicWrite(fs, desktop, '{"version":1,"shell":"desktop"}');
    await atomicWrite(fs, vscode, '{"version":1,"shell":"vscode"}');

    await expect(fs.readFile(desktop)).resolves.toBe('{"version":1,"shell":"desktop"}');
    await expect(fs.readFile(vscode)).resolves.toBe('{"version":1,"shell":"vscode"}');
    expect(basename(desktop)).not.toBe(basename(vscode));
  });
});

type Failure = "write" | "rename" | "copy" | "unlink" | "readdir";

/** In-memory `LayoutFs` with per-operation failure injection. */
function createFakeFs(
  seed: Record<string, string> = {},
  failures: Partial<Record<Failure, boolean>> = {},
): { fs: LayoutFs; files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  const failure = (code: string, operation: string): Error =>
    Object.assign(new Error(`${operation} failed`), { code });
  const fs: LayoutFs = {
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async writeFile(path, data) {
      if (failures.write) throw failure("EIO", "write");
      files.set(path, data);
    },
    async rename(from, to) {
      if (failures.rename) throw failure("EPERM", "rename");
      const data = files.get(from);
      if (data === undefined) throw failure("ENOENT", "rename");
      files.set(to, data);
      files.delete(from);
    },
    async copyFile(from, to) {
      if (failures.copy) throw failure("EIO", "copy");
      const data = files.get(from);
      if (data === undefined) throw failure("ENOENT", "copy");
      files.set(to, data);
    },
    async mkdir() {},
    async unlink(path) {
      if (failures.unlink) throw failure("EPERM", "unlink");
      if (!files.delete(path)) throw failure("ENOENT", "unlink");
    },
    async readdir(dir) {
      if (failures.readdir) throw failure("ENOTDIR", "readdir");
      return [...files.keys()]
        .filter((path) => dirname(path) === dir)
        .map((path) => basename(path));
    },
    async stat(path) {
      const data = files.get(path);
      return data === undefined ? null : { size: Buffer.byteLength(data, "utf8") };
    },
  };
  return { fs, files };
}
