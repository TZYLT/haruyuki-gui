/**
 * `release.mjs` is the one command the whole item is judged by, and its two
 * interesting behaviours are easy to get wrong in a way that still "works":
 * a flag pair that silently does both instead of refusing, and a dereference
 * that skips links instead of resolving them. Both are pinned here.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dereferenceTree,
  parseArgs,
  scanArtifacts,
  scanTrees,
  UsageError,
  writeChecksums,
} from "./release.mjs";

let work: string | null = null;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "g2-release-"));
});

afterEach(async () => {
  if (work !== null) await rm(work, { recursive: true, force: true });
  work = null;
});

describe("parseArgs", () => {
  it("does both platforms when neither flag is given", () => {
    expect(parseArgs([]).targets).toEqual(["win32", "linux"]);
  });

  it("narrows to one platform when asked", () => {
    expect(parseArgs(["--win-only"]).targets).toEqual(["win32"]);
    expect(parseArgs(["--linux-only"]).targets).toEqual(["linux"]);
  });

  it("refuses the pair instead of guessing, because both means the same as neither", () => {
    expect(() => parseArgs(["--win-only", "--linux-only"])).toThrow(UsageError);
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    // Silently ignoring a typo turns "--win-onyl" into "build everything",
    // which is the most expensive possible interpretation of a typo.
    expect(() => parseArgs(["--win-onyl"])).toThrow(UsageError);
  });

  it("keeps round 1 separate from a skipped check", () => {
    const options = parseArgs(["--skip-bundle"]);
    expect(options.skipBundle).toBe(true);
    expect(options.skipInstall).toBe(false);
    expect(options.skipFetch).toBe(false);
  });
});

describe("dereferenceTree", () => {
  it("replaces a relative symlink with the file it points at", async () => {
    if (work === null) throw new Error("no work directory");
    await writeFile(path.join(work, "cli.js"), "console.log(1);\n");
    await symlink(path.join("cli.js"), path.join(work, "link.js"));

    const result = await dereferenceTree(work);

    expect(result.replaced).toBe(1);
    // A link is a way of reaching content, so the content is what survives.
    expect(await readFile(path.join(work, "link.js"), "utf8")).toBe("console.log(1);\n");
  });

  it("refuses a dangling link instead of dropping it", async () => {
    if (work === null) throw new Error("no work directory");
    await symlink(path.join(work, "gone.js"), path.join(work, "link.js"));

    // Dropping it would leave the lock describing a tree with one file fewer
    // than the one on disk, and that mismatch surfaces at start-up, not here.
    await expect(dereferenceTree(work)).rejects.toThrow(/dangling symlink/);
  });
});

describe("scanArtifacts", () => {
  it("finds what the builder wrote instead of expecting names", async () => {
    if (work === null) throw new Error("no work directory");
    await mkdir(path.join(work, "win-unpacked"), { recursive: true });
    await writeFile(path.join(work, "win-unpacked", "app.exe"), "BINARY");
    await writeFile(path.join(work, "haruyuki-0.1.0-win-x64.zip"), "ZIPDATA");

    const found = await scanArtifacts(work);

    // The tree is zip content, not something a user downloads.
    expect(found.map((artifact) => artifact.file)).toEqual(["haruyuki-0.1.0-win-x64.zip"]);
    expect(found[0]?.bytes).toBe(7);
  });

  it("returns nothing for a directory that does not exist yet", async () => {
    expect(await scanArtifacts(path.join(work ?? "", "release"))).toEqual([]);
  });
});

describe("writeChecksums", () => {
  it("writes the GNU format that sha256sum -c reads", async () => {
    if (work === null) throw new Error("no work directory");
    await writeFile(path.join(work, "a.zip"), "ZIPDATA");

    const contents = await writeChecksums(work, [{ file: "a.zip", bytes: 7 }]);

    // Two spaces, a bare file name: anything else fails to verify downstream.
    expect(contents).toMatch(/^[0-9a-f]{64} {2}a\.zip\n$/);
  });
});

describe("scanTrees", () => {
  it("reports the unpacked tree that the artifact list leaves out", async () => {
    if (work === null) throw new Error("no work directory");
    await mkdir(path.join(work, "win-unpacked"), { recursive: true });
    await writeFile(path.join(work, "win-unpacked", "app.exe"), "BINARY");

    // The tree is not a download, so it stays out of the artifacts - but a
    // manifest that never mentions it cannot judge the artifact claim.
    expect(await scanTrees(work)).toEqual(["win-unpacked"]);
    expect((await scanArtifacts(work)).map((artifact) => artifact.file)).toEqual([]);
  });
});
