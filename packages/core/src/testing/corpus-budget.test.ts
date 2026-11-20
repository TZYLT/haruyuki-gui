/**
 * Corpus budget and version alignment.
 *
 * The fixture corpus is data, not code: `fixtures/**` is exempt from the file
 * size, boundary and ownership gates, so its size and its version pin need an
 * in-repo guard that runs in the ordinary test segment. This file is that
 * guard, and it is deliberately independent of `pnpm fixtures:check`: the gate
 * treats engine drift as an advisory `WARN`, while the corpus pinned here must
 * agree with `packages/protocol/src/contract/snapshot.json` or the test fails.
 *
 * The budget enforced below: one recording is at most 2 MB and 400 lines, and
 * the whole recording corpus is at most 4 MB. A megabyte is 1024 * 1024 bytes
 * here; the numbers are ceilings, not targets (the recorded corpus is a few
 * hundred kilobytes today).
 *
 * What "absent pin" means: `snapshot.json` always carries an `engine` object in
 * this repository. If that pin were removed, silently returning would leave the
 * alignment check unenforced while the test stayed green, so the reader is told
 * explicitly that alignment cannot be judged. That is the one failure mode this
 * test must never swallow.
 *
 * Redaction: `scripts/check-fixtures.mjs` already rejects a missing or pre-`r1`
 * marker, but that gate runs in the `fixtures` segment, which can be ordered
 * before or after the test segment; this file is the in-repo guard that CI
 * ordering cannot skip. Wire files must declare `r1` or later. Bridge-frame
 * files have no `redaction` field in their header (see `FramesFixtureHeader`)
 * and are hand-written, so an absent marker is legal there; an explicit `r0` is
 * not, and would mean unredacted content was copied in.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { WireFixture } from "./fixture";
import { loadFixtureText } from "./fixture";

/** `packages/core/src/testing` -> repo root. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The recorded wire corpus, relative to the repo root. */
const RECORDINGS_DIR = path.join(REPO_ROOT, "fixtures", "engine", "recordings");

/** The hand-written bridge corpus, relative to the repo root. */
const BRIDGE_DIR = path.join(REPO_ROOT, "fixtures", "bridge");

/** Contract snapshot that pins the engine pair every wire recording must carry. */
const SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  "packages",
  "protocol",
  "src",
  "contract",
  "snapshot.json",
);

/** One recording's on-disk facts and parsed header. */
type Recording = {
  /** File name, so a failure names the corpus file. */
  name: string;
  /** Size in bytes, from the bytes actually read. */
  bytes: number;
  /** Physical line count; a trailing newline does not add a line. */
  lines: number;
  /** Parsed fixture (the header is what the assertions compare). */
  fixture: WireFixture;
};

/** One corpus file's header, without assuming which fixture kind it is. */
type CorpusHeader = {
  /** File name, so a failure names the corpus file. */
  name: string;
  /** Parsed first line. */
  header: Record<string, unknown>;
};

/** One megabyte, the unit of every ceiling below. */
const MB = 1024 * 1024;

/** Per-file size ceiling: 2 MB. */
const MAX_RECORDING_BYTES = 2 * MB;

/** Per-file line ceiling: 400 lines. */
const MAX_RECORDING_LINES = 400;

/** Corpus-wide size ceiling: 4 MB. */
const MAX_CORPUS_BYTES = 4 * MB;

/** True for a JSON object, the only shape a fixture line may have. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Count physical lines; a single trailing newline does not start a new line. */
function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  let lines = 1;

  for (const character of trimmed) {
    if (character === "\n") {
      lines += 1;
    }
  }

  return lines;
}

/**
 * True when a header marker is `r1` or a later revision (the rule
 * `scripts/check-fixtures.mjs` applies).
 */
function isRedactedMarker(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const match = /^r(\d+)$/.exec(value);

  return match !== null && Number(match[1]) >= 1;
}

/** Read and parse every `.jsonl` file below a corpus directory, sorted by name. */
async function readCorpus(directory: string): Promise<Recording[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();

  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(path.join(directory, name));
      const text = bytes.toString("utf8");

      return {
        name,
        bytes: bytes.byteLength,
        lines: countLines(text),
        fixture: await loadFixtureText(text),
      };
    }),
  );
}

/**
 * Read the first line of every `.jsonl` file below a corpus directory.
 *
 * Used for the redaction marker: a bridge-frame header is not a wire fixture,
 * so it must not be pushed through the wire parser (`loadFixtureText`), which
 * would reject its `kind` before the marker could be read.
 */
async function readHeaders(directory: string): Promise<CorpusHeader[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();

  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(path.join(directory, name), "utf8");
      const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
      const header: unknown = JSON.parse(firstLine);

      if (!isObject(header)) {
        throw new Error(`${name}: the header line is not a JSON object`);
      }

      return { name, header };
    }),
  );
}

/**
 * The engine pair pinned by the contract snapshot.
 *
 * Fails with an explicit message when the pin is absent: the caller must not be
 * able to read "no pin" as "aligned".
 */
async function pinnedEngine(): Promise<{ version: string; commit: string }> {
  const relative = path.relative(REPO_ROOT, SNAPSHOT_PATH).split(path.sep).join("/");
  const snapshot: unknown = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
  const engine = isObject(snapshot) ? snapshot.engine : undefined;

  if (
    !isObject(engine) ||
    typeof engine.version !== "string" ||
    typeof engine.commit !== "string"
  ) {
    throw new Error(
      `${relative} does not pin engine.version and engine.commit, so version alignment ` +
        "cannot be judged; this test fails instead of passing silently",
    );
  }

  return { version: engine.version, commit: engine.commit };
}

/** Human-readable size for an assertion message. */
function formatBytes(bytes: number): string {
  return `${bytes} B (${(bytes / MB).toFixed(3)} MB)`;
}

describe("fixture corpus budget", () => {
  it("has recordings to grade, so a green run is not vacuous", async () => {
    const recordings = await readCorpus(RECORDINGS_DIR);

    expect(recordings.length, `${RECORDINGS_DIR} contains no .jsonl recording`).toBeGreaterThan(0);
  });

  it("keeps every recording within 2 MB and 400 lines", async () => {
    const recordings = await readCorpus(RECORDINGS_DIR);

    for (const recording of recordings) {
      expect(
        recording.bytes,
        `${recording.name} is ${formatBytes(recording.bytes)}, over the 2 MB ceiling`,
      ).toBeLessThanOrEqual(MAX_RECORDING_BYTES);

      expect(
        recording.lines,
        `${recording.name} is ${recording.lines} lines, over the 400 line ceiling`,
      ).toBeLessThanOrEqual(MAX_RECORDING_LINES);
    }
  });

  it("keeps the whole recording corpus within 4 MB", async () => {
    const recordings = await readCorpus(RECORDINGS_DIR);
    const total = recordings.reduce((sum, recording) => sum + recording.bytes, 0);

    expect(
      total,
      `the recording corpus is ${formatBytes(total)}, over the 4 MB ceiling`,
    ).toBeLessThanOrEqual(MAX_CORPUS_BYTES);
  });

  it("aligns every wire header's engine pair with the contract snapshot pin", async () => {
    const pin = await pinnedEngine();
    const recordings = await readCorpus(RECORDINGS_DIR);
    const drift: string[] = [];

    for (const recording of recordings) {
      const header = recording.fixture.header;

      if (header.kind !== "wire") {
        continue;
      }

      const engine: Record<string, unknown> = isObject(header.engine) ? header.engine : {};

      if (engine.version !== pin.version || engine.commit !== pin.commit) {
        drift.push(
          `${recording.name}: engine ${JSON.stringify(engine.version)}@` +
            `${JSON.stringify(engine.commit)} != pinned ${pin.version}@${pin.commit}`,
        );
      }
    }

    expect(
      drift,
      "a wire header must carry the engine pair the contract snapshot pins; " +
        "re-record or re-pin deliberately, never drift",
    ).toEqual([]);
  });

  it("marks every wire corpus file as redacted at r1 or later", async () => {
    const corpora = [...(await readHeaders(RECORDINGS_DIR)), ...(await readHeaders(BRIDGE_DIR))];
    const violations: string[] = [];

    for (const recording of corpora) {
      const { header } = recording;
      const marker = header.redaction;

      // A frames header has no redaction field by design; a wire header must
      // always declare one because the recorder writes it.
      if (marker === undefined) {
        if (header.kind === "wire") {
          violations.push(`${recording.name}: wire header has no "redaction" marker`);
        }

        continue;
      }

      if (!isRedactedMarker(marker)) {
        violations.push(
          `${recording.name}: redaction ${JSON.stringify(marker)} is not "r1" or later`,
        );
      }
    }

    expect(
      violations,
      'every corpus fixture must be redacted at "r1" or later; "r0" means unredacted content ' +
        "was copied into the corpus",
    ).toEqual([]);
  });
});
