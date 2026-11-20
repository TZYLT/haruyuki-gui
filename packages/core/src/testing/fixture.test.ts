/**
 * Tests for the fixture loaders.
 *
 * The contract is the two line formats the loaders accept: `wire` and `frames`.
 * The wire cases prove that validation is delegated to
 * `fixtures/engine/replay.mjs` - the error text and the 1-based line number are
 * that module's, not a second implementation's - while the bridge cases cover the
 * format this module owns.
 *
 * Every temp directory is created per case and removed point by point in
 * `afterEach` (`removeTree`), so vitest exits without dangling handles.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeTree } from "../engine/engine-test-support";

import { loadFixture, loadFixtureText, loadFramesFixture } from "./fixture";

/* ------------------------------------------------------------------ */
/* temp files                                                          */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = [];

/** Create one temp directory that `afterEach` removes. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "haruyuki-fixture-"));
  tempDirs.push(dir);
  return dir;
}

/** Write one fixture file into a fresh temp directory and return its path. */
async function writeFixture(name: string, text: string): Promise<string> {
  const file = path.join(await makeTempDir(), name);
  await writeFile(file, text, "utf8");
  return file;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTree(dir);
  }
});

/* ------------------------------------------------------------------ */
/* wire fixtures                                                       */
/* ------------------------------------------------------------------ */

const WIRE_HEADER = {
  kind: "wire",
  schemaVersion: 1,
  engine: { version: "0.6.0", commit: "1641a4f" },
  scenario: "fixture-loader",
  redaction: "r1",
  clock: "virtual",
  recordedAt: "2024-01-01T00:00:00.000Z",
};

/** Build wire JSONL text: the header, then one message per line. */
function wireText(lines: Array<Record<string, unknown>>): string {
  return [WIRE_HEADER, ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

const WIRE_LINES: Array<Record<string, unknown>> = [
  { dir: "s2c", at: 0, msg: { type: "app_server_info_response", success: true } },
  { dir: "c2s", at: 5, msg: { type: "input", request_id: "r-1" } },
  { dir: "s2c", at: 10, msg: { type: "turn_finished" } },
];

describe("loadFixture", () => {
  it("reads a wire fixture and keeps the header and the line order", async () => {
    const file = await writeFixture("wire.jsonl", wireText(WIRE_LINES));
    const fixture = await loadFixture(file);

    expect(fixture.header).toEqual(WIRE_HEADER);
    expect(fixture.lines).toEqual(WIRE_LINES);
  });

  it("accepts JSONL text directly, so an inline fixture needs no temp file", async () => {
    const text = wireText(WIRE_LINES);

    expect(await loadFixtureText(text)).toEqual(
      await loadFixture(await writeFixture("inline.jsonl", text)),
    );
  });

  it("rejects a header that is not a wire header and names line 1", async () => {
    const text = JSON.stringify({ kind: "frames", schemaVersion: 1, bridgeVersion: 1 }) + "\n";
    const file = await writeFixture("bad-header.jsonl", text);

    await expect(loadFixture(file)).rejects.toThrow(/fixture line 1: header "kind" must be "wire"/);
  });

  it("rejects a bad message line and reports its 1-based line number", async () => {
    const text = [
      JSON.stringify(WIRE_HEADER),
      JSON.stringify({ dir: "s2c", at: 0, msg: { type: "s2c" } }),
      JSON.stringify({ dir: "s2c", msg: { type: "missing-at" } }),
    ].join("\n");
    const file = await writeFixture("bad-line.jsonl", text);

    await expect(loadFixture(file)).rejects.toThrow(/fixture line 3: "at" must be/);
  });

  it("rejects a missing file with the path in the message", async () => {
    const missing = path.join(await makeTempDir(), "absent.jsonl");

    await expect(loadFixture(missing)).rejects.toThrow("fixture: cannot read");
    await expect(loadFixture(missing)).rejects.toThrow(missing);
  });
});

/* ------------------------------------------------------------------ */
/* bridge-frame fixtures                                               */
/* ------------------------------------------------------------------ */

const FRAMES_HEADER = {
  kind: "frames",
  schemaVersion: 1,
  bridgeVersion: 1,
  clock: "virtual",
  note: "t vocabulary not frozen yet",
};

/** Build bridge-frame JSONL text: the header, then one envelope per line. */
function framesText(lines: Array<Record<string, unknown>>): string {
  return [FRAMES_HEADER, ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

const FRAME_LINES: Array<Record<string, unknown>> = [
  {
    v: 1,
    ch: "control",
    seq: 1,
    t: "bridge.ready",
    body: { appVersion: "0.1.0", bridgeVersion: 1 },
  },
  { v: 1, ch: "stream", seq: 2, t: "delta.message", body: { delta: "synthetic" } },
  { v: 1, ch: "bulk", seq: 3, t: "bulk.page", body: { items: [] }, page: { more: false } },
];

describe("loadFramesFixture", () => {
  it("reads the frames header and every Frame envelope, page included", async () => {
    const file = await writeFixture("frames.jsonl", framesText(FRAME_LINES));
    const fixture = await loadFramesFixture(file);

    expect(fixture.header).toEqual(FRAMES_HEADER);
    expect(fixture.frames).toEqual(FRAME_LINES);
  });

  it("rejects a header whose bridgeVersion is not the frozen 1", async () => {
    const text = JSON.stringify({ kind: "frames", schemaVersion: 1, bridgeVersion: 2 });
    const file = await writeFixture("bad-frames-header.jsonl", text);

    await expect(loadFramesFixture(file)).rejects.toThrow(
      /fixture: line 1: header "bridgeVersion" must be 1/,
    );
  });

  it("keeps every page field the envelope carried, not just `more`", async () => {
    // A loader that narrows the envelope cannot be used to test a consumer
    // that reads the narrowed-away fields, and the loss is invisible at the
    // call site: the frame simply arrives looking older than it is.
    const frame = {
      v: 1,
      ch: "bulk",
      seq: 1,
      t: "bulk.page",
      body: {},
      page: { more: true, watermark: 40, token: "snap-40-p1" },
    };
    const text = [JSON.stringify(FRAMES_HEADER), JSON.stringify(frame)].join("\n");
    const file = await writeFixture("frames-cursor.jsonl", text);
    const fixture = await loadFramesFixture(file);

    expect(fixture.frames[0]?.page).toEqual({ more: true, watermark: 40, token: "snap-40-p1" });
  });

  it("still loads a corpus whose page predates the cursor", async () => {
    const frame = { v: 1, ch: "bulk", seq: 1, t: "bulk.page", body: {}, page: { more: false } };
    const text = [JSON.stringify(FRAMES_HEADER), JSON.stringify(frame)].join("\n");
    const file = await writeFixture("frames-old-page.jsonl", text);
    const fixture = await loadFramesFixture(file);

    expect(fixture.frames[0]?.page).toEqual({ more: false });
  });

  it("rejects a cursor whose watermark is not a number", async () => {
    const frame = {
      v: 1,
      ch: "bulk",
      seq: 1,
      t: "bulk.page",
      body: {},
      page: { more: true, watermark: "40" },
    };
    const text = [JSON.stringify(FRAMES_HEADER), JSON.stringify(frame)].join("\n");
    const file = await writeFixture("frames-bad-cursor.jsonl", text);

    await expect(loadFramesFixture(file)).rejects.toThrow(/frame "page" must be an object/);
  });

  it("rejects a line that is not a Frame envelope and names its line", async () => {
    const text = [
      JSON.stringify(FRAMES_HEADER),
      JSON.stringify(FRAME_LINES[0]),
      JSON.stringify({ dir: "s2c", at: 0, msg: {} }),
    ].join("\n");
    const file = await writeFixture("bad-frames-line.jsonl", text);

    await expect(loadFramesFixture(file)).rejects.toThrow(/fixture: line 3: frame "v" must be 1/);
  });
});
