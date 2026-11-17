/**
 * `manifest.mjs` writes the two documents a release page quotes. The thing that
 * matters is that they cannot drift apart, and the thing that is easy to get
 * wrong is guessing why a platform has no artifact.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashTable, platformOf } from "./manifest.mjs";

let work: string | null = null;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "g2-manifest-"));
});

afterEach(async () => {
  if (work !== null) await rm(work, { recursive: true, force: true });
  work = null;
});

describe("platformOf", () => {
  it("reads the extension when the extension is enough", () => {
    expect(platformOf("Haruyuki-0.1.0-linux-x86_64.AppImage")).toBe("linux");
    expect(platformOf("Haruyuki Setup 0.1.0.exe")).toBe("win32");
  });

  it("breaks the tie on the name for a zip, which both platforms use", () => {
    expect(platformOf("Haruyuki-0.1.0-win-x64.zip")).toBe("win32");
    expect(platformOf("Haruyuki-0.1.0-linux-x64.zip")).toBe("linux");
  });

  it("returns null rather than guessing when the name says nothing", () => {
    // A wrong guess here attributes a file to a platform that never shipped it.
    expect(platformOf("bundle.zip")).toBeNull();
    expect(platformOf("builder-debug.yml")).toBeNull();
  });
});

describe("hashTable", () => {
  it("renders the same digests that go into SHA256SUMS", () => {
    const artifacts = [
      { file: "Haruyuki-0.1.0-win-x64.zip", sha256: "a".repeat(64) },
      { file: "Haruyuki-0.1.0-linux-x86_64.AppImage", sha256: "b".repeat(64) },
    ];

    const table = hashTable(artifacts);

    // One row per artifact, each carrying its own file name and digest, so a
    // reader can find a file without translating formats.
    for (const artifact of artifacts) {
      expect(table).toContain(artifact.file);
      expect(table).toContain(artifact.sha256);
    }
    expect(table.split("\n")).toHaveLength(artifacts.length + 2);
  });
});
