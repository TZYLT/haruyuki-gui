/**
 * Usage-level tests for `scripts/engine/record.mjs`.
 *
 * The recorder itself needs a real engine and a model turn, so it has no unit
 * suite; these cases cover the part that runs before anything is spawned. That is
 * also where a 2026-11-14 review finding lived: `--out` pointing into the tracked
 * corpus was accepted, and the file was truncated with `open(..., "w")` before the
 * engine even started, so a mistyped command could destroy a published fixture.
 *
 * Every case here exits before `spawn`, so the suite is hermetic: no engine
 * process, no network, no credential, no fixture written.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECORD = path.join(REPO_ROOT, "scripts", "engine", "record.mjs");

/** Temp roots created by a test, removed pointwise after it. */
const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    // Pointwise rather than recursive: the root is a real temporary directory and
    // nothing else may be in it, but a recursive delete is not the house style.
    for (const entry of ["send.json", "out.jsonl", "out.jsonl.partial"]) {
      try {
        unlinkSync(path.join(root, entry));
      } catch {
        /* not created */
      }
    }

    try {
      rmdirSync(root);
    } catch {
      /* already gone */
    }
  }
});

/**
 * @param args command line
 * @returns stdout, stderr and exit status
 */
function runRecorder(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [RECORD, ...args], { encoding: "utf8" });

  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/**
 * @returns a temp directory holding a valid `--send` file
 */
function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-record-usage-"));

  createdRoots.push(root);
  writeFileSync(path.join(root, "send.json"), `${JSON.stringify([{ type: "input" }])}\n`);

  return root;
}

describe("record.mjs usage", () => {
  it("prints usage and exits 0 for --help", () => {
    const run = runRecorder("--help");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("--scenario");
    expect(run.stdout).toContain("--auto-approve");
    // The dead flag is gone rather than documented as a no-op.
    expect(run.stdout).not.toContain("--keep-raw");
  });

  it("rejects an unknown flag", () => {
    const run = runRecorder("--scenario", "terminal", "--nope");

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown flag: --nope");
  });

  it("refuses an --out inside the tracked corpus", () => {
    const target = path.join(REPO_ROOT, "fixtures", "engine", "recordings", "probe.jsonl");
    const run = runRecorder("--scenario", "terminal", "--send", "send.json", "--out", target);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("must not point into fixtures/");
    // The guard runs before the file is opened, so nothing was truncated.
    expect(existsSync(target)).toBe(false);
  });

  it("requires --scenario and --send", () => {
    expect(runRecorder().status).toBe(2);
    expect(runRecorder("--scenario", "terminal").stderr).toContain("missing required flag: --send");
  });
});
