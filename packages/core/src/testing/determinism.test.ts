/**
 * Determinism of the wire corpus.
 *
 * Every recording under `fixtures/engine/recordings` is replayed 100 times
 * through the fake server's `replay` mode with one plan that exercises `speed`
 * (a numeric multiplier, so the per-step delay arithmetic runs), `duplicate`
 * and `reorder`. Each run's collected s2c texts are hashed with sha256 and the
 * are hashed with sha256 and the test demands exactly one distinct hash; the
 * run to run, because determinism here means the same bytes, not merely the same
 * same bytes, not merely the same digest. A wall-clock read, a random order or
 * a timestamp added on the replay path would show up as a second hash.
 *
 * Why the comparison input is the text the client received: the replay engine
 * 3.4.3 fixes the comparison object as each line's compact JSON serialization,
 * with the recorder and the replay engine sharing that serializer (ruling
 * comparison object. Hashing the received `msg` objects again would compare
 * parsed values and hide a serialization drift.
 *
 * Why the default instant clock: `speed: 2` still runs the arithmetic that
 * turns `at` deltas into waits, but the injected clock never sleeps, so 100
 * runs cost socket round-trips rather than seconds of wall time. The measured
 * wall time is in the delivery report; the whole file is sized to fit the
 * repository's 180 s test-segment appetite.
 *
 * The plan is derived from each fixture, never hard-coded: injection line
 * numbers are 1-based indexes into `fixture.lines` (header excluded), and a
 * fixture that grows or loses s2c lines keeps a valid plan. No recording in the
 * corpus is zero-s2c today; that shape gets its own case below because
 * `replayThrough` finishes on the socket open when a plan emits nothing.
 */

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ReplayInjection, ReplayPlan, WireFixture } from "./fixture";
import { loadFixture, loadFixtureText } from "./fixture";
import { replayThrough } from "./replay-client";

/** `packages/core/src/testing` -> repo root. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Directory the corpus lives in; the task's "every fixture" scope. */
const CORPUS_DIR = path.join(REPO_ROOT, "fixtures", "engine", "recordings");

/** Runs per fixture: determinism means "the same fixture 100 times", byte for byte. */
const RUNS = 100;

/** Speed multiplier; with the instant clock it only exercises the arithmetic. */
const SPEED = 2;

/** One s2c line: its 1-based fixture index and the text replay emits for it. */
type Emission = {
  /** 1-based index into `fixture.lines`, the plan's injection coordinate. */
  number: number;
  /** Compact JSON serialization, the comparison object. */
  text: string;
};

/** What one replay produced, reduced to what the determinism assertions need. */
type RunSummary = {
  /** sha256 over the received s2c texts, joined by newlines. */
  hash: string;
  /** Number of s2c frames the client received. */
  frames: number;
  /** Raw received texts, in arrival order. */
  received: string[];
};

/** Corpus file names, sorted so the test order does not depend on the manager. */
function discoverRecordings(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

/** Every s2c line of a fixture, in fixture order, with its plan coordinate. */
function s2cEmissions(fixture: WireFixture): Emission[] {
  return fixture.lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => entry.line.dir === "s2c")
    .map((entry) => ({ number: entry.number, text: JSON.stringify(entry.line.msg) }));
}

/**
 * Build the plan that exercises `speed`, `duplicate` and `reorder`.
 *
 * `duplicate` repeats the first s2c line once, `reorder` swaps the second and
 * third s2c lines. An injection is dropped when the fixture has too few s2c
 * lines to place it, which keeps this helper total for a corpus that grows a
 * one-frame or zero-frame recording.
 */
function buildPlan(emissions: readonly Emission[]): ReplayPlan {
  const inject: ReplayInjection[] = [];
  const first = emissions[0];
  const second = emissions[1];
  const third = emissions[2];

  if (first !== undefined) {
    inject.push({ kind: "duplicate", line: first.number, times: 1 });
  }

  if (second !== undefined && third !== undefined) {
    inject.push({ kind: "reorder", lines: [second.number, third.number] });
  }

  return { speed: SPEED, inject };
}

/** sha256 of the received texts; a stable digest for one run's wire output. */
function hashTexts(texts: readonly string[]): string {
  return createHash("sha256").update(texts.join("\n"), "utf8").digest("hex");
}

/** Replay once and reduce the result to a {@link RunSummary}. */
async function replayOnce(fixture: WireFixture, plan: ReplayPlan): Promise<RunSummary> {
  const result = await replayThrough({ fixture, plan });

  return {
    hash: hashTexts(result.received),
    frames: result.frames.length,
    received: result.received,
  };
}

/** Corpora in the directory; empty is a corpus problem, asserted separately. */
const RECORDINGS = discoverRecordings();

describe("replay determinism of fixtures/engine/recordings", () => {
  it("finds the recordings it claims to grade", () => {
    expect(RECORDINGS.length, `${CORPUS_DIR} has no .jsonl recording`).toBeGreaterThan(0);
  });

  for (const name of RECORDINGS) {
    it(`${name}: 100 runs with speed/duplicate/reorder produce one hash`, async () => {
      const fixture = await loadFixture(path.join(CORPUS_DIR, name));
      const emissions = s2cEmissions(fixture);
      const plan = buildPlan(emissions);
      const duplicated = emissions[0] === undefined ? 0 : 1;
      const expectedFrames = emissions.length + duplicated;
      const hashes = new Set<string>();
      let reference: string[] | undefined;

      for (let run = 0; run < RUNS; run += 1) {
        const summary = await replayOnce(fixture, plan);

        hashes.add(summary.hash);

        expect(summary.frames, `${name}: run ${run} received ${summary.frames} s2c frames`).toBe(
          expectedFrames,
        );

        if (reference === undefined) {
          reference = summary.received;
        } else {
          expect(summary.received, `${name}: run ${run} differs from run 0`).toEqual(reference);
        }
      }

      expect(
        hashes.size,
        `${name}: ${RUNS} runs produced ${hashes.size} distinct hashes (${[...hashes].join(", ")}); ` +
          "a replay that reads a clock, a random source or a fresh timestamp is not deterministic",
      ).toBe(1);

      // The plan must actually reach the wire, otherwise "one hash" would only
      // prove that the default plan is stable. Duplicate puts a copy of the
      // first emission directly behind it; reorder then swaps the second and
      // third s2c lines, so those two arrive in the opposite order.
      if (emissions[0] !== undefined && emissions[1] !== undefined && emissions[2] !== undefined) {
        expect(reference?.[0], `${name}: emission 0 is not the first s2c line`).toBe(
          emissions[0].text,
        );
        expect(reference?.[1], `${name}: the duplicated line was not re-emitted`).toBe(
          emissions[0].text,
        );
        expect(reference?.[2], `${name}: reorder did not move the third s2c line forward`).toBe(
          emissions[2].text,
        );
        expect(reference?.[3], `${name}: reorder did not move the second s2c line back`).toBe(
          emissions[1].text,
        );

        // And the injected plan must differ from a plain replay of the same
        // fixture; one extra run is the cheap proof that the injections ran.
        const baseline = await replayOnce(fixture, { speed: SPEED });

        expect(
          hashes.has(baseline.hash),
          `${name}: the duplicate/reorder injections did not change the emitted text`,
        ).toBe(false);
      }
    });
  }

  it("replays the disconnect + resume shape to one hash", async () => {
    const loaded = await Promise.all(
      RECORDINGS.map(async (name) => ({
        name,
        fixture: await loadFixture(path.join(CORPUS_DIR, name)),
      })),
    );

    // The smallest recording keeps this case cheap; sorting by s2c count first
    // and by name second makes the pick deterministic.
    const target = loaded
      .map((entry) => ({ ...entry, emissions: s2cEmissions(entry.fixture) }))
      .filter((entry) => entry.emissions.length >= 4)
      .sort(
        (left, right) =>
          left.emissions.length - right.emissions.length || left.name.localeCompare(right.name),
      )[0];

    expect(target, "no recording has four s2c lines to disconnect after").toBeDefined();

    if (target === undefined) {
      return;
    }

    const { fixture, emissions, name } = target;
    const plan: ReplayPlan = {
      speed: SPEED,
      inject: [
        { kind: "duplicate", line: emissions[0]?.number ?? 1, times: 1 },
        { kind: "reorder", lines: [emissions[1]?.number ?? 1, emissions[2]?.number ?? 1] },
        { kind: "disconnect", atLine: emissions[2]?.number ?? 1, resume: true },
      ],
    };
    const expectedFrames = emissions.length + 1;
    const hashes = new Set<string>();

    for (let run = 0; run < RUNS; run += 1) {
      const summary = await replayOnce(fixture, plan);

      hashes.add(summary.hash);

      expect(summary.frames, `${name}: run ${run} lost frames across the reconnect`).toBe(
        expectedFrames,
      );
    }

    expect(hashes.size, `${name}: the disconnect + resume replay is not deterministic`).toBe(1);
  });

  it("replays the zero-s2c shape to one hash", async () => {
    // No recording is zero-s2c today, so the shape is built inline: a valid
    // header plus one c2s line. `replayThrough` finishes when the socket opens,
    // because the plan emits nothing. 100 runs must agree on the empty digest.
    const text =
      [
        {
          kind: "wire",
          schemaVersion: 1,
          engine: { version: "0.6.0", commit: "1641a4f" },
          scenario: "zero-s2c",
          redaction: "r1",
          clock: "virtual",
        },
        { dir: "c2s", at: 3, msg: { type: "input", request_id: "r-1" } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n";
    const fixture = await loadFixtureText(text);
    const plan: ReplayPlan = { speed: SPEED };
    const hashes = new Set<string>();

    for (let run = 0; run < RUNS; run += 1) {
      const summary = await replayOnce(fixture, plan);

      hashes.add(summary.hash);

      expect(summary.frames, `zero-s2c: run ${run} received a frame`).toBe(0);
    }

    expect(hashes.size, "the zero-s2c replay is not deterministic").toBe(1);
    expect([...hashes][0], "the empty wire output must hash the empty string").toBe(hashTexts([]));
  });
});
