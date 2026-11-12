/**
 * Gate self-tests for scripts/check-cycles.mjs (acceptance criterion A-9).
 *
 * The real gate is spawned against a committed fixture tree: no mocking, no
 * in-process import of the script.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO_ROOT, "scripts", "check-cycles.mjs");
const FIXTURES = path.join(REPO_ROOT, "fixtures", "cycles");

interface GateRun {
  status: number | null;
  output: string;
}

/**
 * @param caseName fixture directory below fixtures/cycles
 * @returns exit code plus combined stdout/stderr
 */
function runCyclesGate(caseName: string): GateRun {
  const result = spawnSync(process.execPath, [GATE, "--root", path.join(FIXTURES, caseName)], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("check-cycles (A-9)", () => {
  it("passes a tree without circular imports", () => {
    const run = runCyclesGate("clean");

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(run.output).not.toMatch(/ circular /);
  });

  it("fails a two-module cycle a -> b -> a", () => {
    const run = runCyclesGate("red-a-b-a");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ circular /);
    expect(run.output).toContain("FAIL");
    expect(run.output).toContain(
      "packages/core/src/a.ts -> packages/core/src/b.ts -> packages/core/src/a.ts",
    );
  });
});
