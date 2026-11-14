/**
 * Budget of the gate's `fixtures` segment.
 *
 * The budget has two numbers: the recording additions add at most 20 s to the test
 * segment, and `pnpm verify` itself stays inside its budget. Spawning the whole
 * aggregator here is too slow for a unit test - it runs typecheck, lint and the
 * full suite - so this file measures the cheapest honest proxy: the `fixtures`
 * segment alone, run three times, each under the 5 s the route doc names as the
 * trigger for `R-08` ("fixtures segment > 5 s"). Three runs rather than one
 * because a single sample cannot tell a steady cost from a cold-start outlier.
 *
 * The second half of the budget would be "the segment list is unchanged", counted
 * from the labels the aggregator prints. `scripts/verify.mjs` has no dry-run or
 * list mode: `parseArguments` accepts exactly `--full` and `--verbose` and
 * anything else is a usage error (exit 2). Counting the labels without running
 * every segment therefore requires changing the aggregator, which this task
 * must not touch. The half is skipped and the skip is pinned below instead: the
 * test asserts the unsupported flags are still rejected with the exact
 * supported set, so a future dry-run mode fails this test and tells its author
 * to wire the label count in rather than leaving the hole open silently.
 *
 * Timing method: `spawnSync` with `process.execPath`, so the sample includes
 * the same process start the aggregator pays, and uses the Node running the
 * tests rather than whatever `node` is first on PATH.
 */

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** `scripts/` -> repo root. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The `fixtures` segment's script, the one whose wall time is budgeted. */
const FIXTURES_GATE = path.join(REPO_ROOT, "scripts", "check-fixtures.mjs");

/** The aggregator; used only to prove the dry-run half cannot be measured. */
const VERIFY_GATE = path.join(REPO_ROOT, "scripts", "verify.mjs");

/** Samples per segment; three separates a steady cost from one cold outlier. */
const RUNS = 3;

/** The `fixtures` segment budget (milliseconds). */
const MAX_SEGMENT_MS = 5_000;

/** Hard stop so a hung gate fails the test instead of hanging the segment. */
const TIMEOUT_MS = 15_000;

/** Result of one spawned gate run. */
type GateRun = {
  /** Exit code, or null when the process was killed. */
  status: number | null;
  /** Combined stdout and stderr. */
  output: string;
  /** Measured wall time in milliseconds, process start included. */
  ms: number;
  /** True when the spawn hit {@link TIMEOUT_MS}. */
  timedOut: boolean;
};

/** Spawn one gate script with `process.execPath` and time it. */
function spawnGate(script: string, args: readonly string[] = []): GateRun {
  const started = performance.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
  });
  const ms = performance.now() - started;
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    ms,
    timedOut: code === "ETIMEDOUT",
  };
}

describe("verify budget", () => {
  it(`runs the fixtures segment ${RUNS} times, each under 5 s`, () => {
    const runs: GateRun[] = [];

    for (let run = 0; run < RUNS; run += 1) {
      const measured = spawnGate(FIXTURES_GATE);

      runs.push(measured);

      expect(
        measured.timedOut,
        `fixtures gate run ${run} did not finish within ${TIMEOUT_MS} ms`,
      ).toBe(false);

      expect(
        measured.status,
        `fixtures gate run ${run} exited ${measured.status}, so its time is not the cost of a ` +
          `green segment; output:\n${measured.output}`,
      ).toBe(0);
    }

    for (const [run, measured] of runs.entries()) {
      expect(
        measured.ms,
        `fixtures gate run ${run} took ${measured.ms.toFixed(0)} ms, over the ` +
          `${MAX_SEGMENT_MS} ms budget set for this segment`,
      ).toBeLessThan(MAX_SEGMENT_MS);
    }
  });

  it("has no dry-run mode, so the segment-label half of the budget is skipped", () => {
    // The aggregator accepts exactly these two flags; "unsupported" is exit 2
    // and names the supported set, which is what makes the skip explicit.
    for (const flag of ["--dry-run", "--help"]) {
      const measured = spawnGate(VERIFY_GATE, [flag]);

      expect(
        measured.status,
        `verify ${flag} exited ${measured.status}; if a read-only mode now exists, replace ` +
          "this case with a count of the segment labels it prints",
      ).toBe(2);

      expect(
        measured.output,
        `verify ${flag} must report the supported flag set; output:\n${measured.output}`,
      ).toContain("supported: --full, --verbose");
    }
  });
});
