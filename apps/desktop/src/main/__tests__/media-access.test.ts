/**
 * The position-trust decision: fail closed, always.
 *
 * The requirement states it as a red condition: a damaged file must
 * not be read as "trust everything". That is the shape of the tests here -- every
 * way the file can fail to say an unambiguous yes resolves to "the position check
 * stays on".
 *
 * Two properties are worth separating, because they fail differently:
 *
 *   **Closed** -- an absent, unreadable or malformed file keeps the check on. A
 *   switch that failed open would silently turn a convenience range into a
 *   whole-disk browser.
 *
 *   **Strict** -- `"true"`, `1` and `"yes"` are all refused. A truthy check would
 *   accept a hand-edited file whose author did not mean to switch anything on,
 *   and this is a security decision being read rather than a preference.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MEDIA_ACCESS_DEFAULT,
  MEDIA_ACCESS_VERSION,
  mediaAccessPath,
  parseMediaAccess,
  readMediaAccess,
  skipsPositionCheck,
} from "../media-access.js";

/** Directories created by a test, removed afterwards. */
const created: string[] = [];

/** Make a scratch directory that will be cleaned up. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d2-access-"));
  created.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the file's location", () => {
  it("is its own document, not a section of shell-settings.json", () => {
    // `D1`'s settings document has its field set pinned by a key-set assertion,
    // and a security decision does not belong in a file about window geometry.
    // The separate file is what lets `F5` add the switch without touching a
    // finished item's test.
    const location = mediaAccessPath("/home/u");

    expect(path.basename(location)).toBe("media-access.json");
    expect(location).not.toContain("shell-settings");
  });

  it("puts the file under userData, beside the settings it is not part of", () => {
    expect(mediaAccessPath("/home/u")).toBe(path.join("/home/u", "media-access.json"));
  });
});

describe("parseMediaAccess fails closed", () => {
  it("treats an empty file as no decision", () => {
    expect(parseMediaAccess("")).toEqual(MEDIA_ACCESS_DEFAULT);
  });

  it("treats a truncated write as no decision", () => {
    // The realistic corruption: a crash mid-write leaves half a document.
    expect(parseMediaAccess('{"version": 1, "trustAllPaths": tr')).toEqual(MEDIA_ACCESS_DEFAULT);
  });

  it("treats a JSON array or scalar as no decision", () => {
    expect(parseMediaAccess("[]")).toEqual(MEDIA_ACCESS_DEFAULT);
    expect(parseMediaAccess("true")).toEqual(MEDIA_ACCESS_DEFAULT);
    expect(parseMediaAccess("null")).toEqual(MEDIA_ACCESS_DEFAULT);
  });

  it("treats an unknown version as no decision rather than half-reading it", () => {
    // A newer build may attach a field that changes what the flag means.
    // Honouring the flag while ignoring the field would be acting on half a
    // document.
    expect(
      parseMediaAccess(JSON.stringify({ version: 2, trustAllPaths: true, decidedAt: "x" })),
    ).toEqual(MEDIA_ACCESS_DEFAULT);
  });

  it("treats a missing version as no decision", () => {
    expect(parseMediaAccess(JSON.stringify({ trustAllPaths: true }))).toEqual(MEDIA_ACCESS_DEFAULT);
  });

  it("refuses truthy-but-not-true values", () => {
    // A hand-edited file whose author wrote `"true"` did not make a decision this
    // code can honour: the type is part of the meaning.
    for (const value of ["true", 1, "yes", {}, []]) {
      expect(
        parseMediaAccess(JSON.stringify({ version: 1, trustAllPaths: value, decidedAt: "x" })),
        JSON.stringify(value),
      ).toEqual(MEDIA_ACCESS_DEFAULT);
    }
  });

  it("reads an explicit true", () => {
    const parsed = parseMediaAccess(
      JSON.stringify({ version: 1, trustAllPaths: true, decidedAt: "2026-11-16T00:00:00Z" }),
    );

    expect(parsed.trustAllPaths).toBe(true);
    expect(parsed.decidedAt).toBe("2026-11-16T00:00:00Z");
  });

  it("reads an explicit false as the default rather than as an error", () => {
    // A user who switched it off has made a decision; the answer is the same as
    // having made none, which is why one value covers both.
    expect(
      parseMediaAccess(JSON.stringify({ version: 1, trustAllPaths: false, decidedAt: "x" })),
    ).toEqual(MEDIA_ACCESS_DEFAULT);
  });

  it("keeps a missing decidedAt rather than refusing the whole document", () => {
    // `decidedAt` is for the log; nothing branches on it, so its absence is not
    // a reason to ignore a decision the user did make.
    const parsed = parseMediaAccess(JSON.stringify({ version: 1, trustAllPaths: true }));

    expect(parsed.trustAllPaths).toBe(true);
    expect(parsed.decidedAt).toBe("");
  });

  it("ignores extra keys rather than refusing the document", () => {
    const parsed = parseMediaAccess(
      JSON.stringify({ version: 1, trustAllPaths: true, decidedAt: "x", future: 1 }),
    );

    expect(parsed.trustAllPaths).toBe(true);
  });
});

describe("readMediaAccess", () => {
  it("answers the default when the file is absent, which is not an error", () => {
    // The normal state before `F5` ships: there is no writer yet.
    return expect(readMediaAccess(path.join(tmpdir(), "d2-no-such-dir-xyz"))).resolves.toEqual(
      MEDIA_ACCESS_DEFAULT,
    );
  });

  it("reads a file that says yes", async () => {
    const dir = await scratch();
    await writeFile(
      mediaAccessPath(dir),
      JSON.stringify({ version: MEDIA_ACCESS_VERSION, trustAllPaths: true, decidedAt: "t" }),
      "utf8",
    );

    const access = await readMediaAccess(dir);

    expect(access.trustAllPaths).toBe(true);
  });

  it("answers the default for a directory where the file should be", async () => {
    // A `stat` that succeeds and a read that fails is a distinct path from "the
    // file is not there", and both must close.
    const dir = await scratch();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(mediaAccessPath(dir));

    await expect(readMediaAccess(dir)).resolves.toEqual(MEDIA_ACCESS_DEFAULT);
  });

  it("answers the default for binary garbage", async () => {
    const dir = await syncScratch();
    writeFileSync(mediaAccessPath(dir), Buffer.from([0x00, 0xff, 0xfe, 0x01]));

    await expect(readMediaAccess(dir)).resolves.toEqual(MEDIA_ACCESS_DEFAULT);
  });
});

/** A scratch directory made synchronously, for tests that write with `*Sync`. */
function syncScratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "d2-access-sync-"));
  created.push(dir);

  return dir;
}

describe("skipsPositionCheck", () => {
  it("answers true only for an explicit yes", () => {
    expect(skipsPositionCheck({ version: 1, trustAllPaths: true, decidedAt: "x" })).toBe(true);
    expect(skipsPositionCheck(MEDIA_ACCESS_DEFAULT)).toBe(false);
  });
});

describe("the two things the switch does NOT do", () => {
  it("does not decide what types are served -- that is the MIME table's job", async () => {
    // Read as a claim about module boundaries: this module has no notion of a
    // file type, so "trust all paths" cannot make an `.exe` previewable.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(import.meta.dirname, "..", "media-access.ts"), "utf8"),
    );

    // Asserted on identifiers rather than on the prose: the comments legitimately
    // discuss types ("cannot make an .exe previewable"), and a grep over words
    // would fail on the explanation instead of on the code.
    expect(source).not.toMatch(/contentTypeFor|MEDIA_TYPE_POLICY|mediaContentTypeFor/);
  });

  it("does not write anything -- the switch's writer is F5", async () => {
    // Doc 29 `T-15` gives the interface and the writes to `F5`; this item has the
    // read side only. A writer here would be a second place that decides.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(import.meta.dirname, "..", "media-access.ts"), "utf8"),
    );

    expect(source).not.toMatch(/writeFile|writeFileSync|mkdir/);
  });
});
