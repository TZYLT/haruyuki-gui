/**
 * Cross-gate self-tests:
 *
 * 1. The shared CLI contract - a missing `--root` and an empty directory must
 *    exit 2 (the gate is broken), never 0 (PASS). A gate that inspects nothing
 *    must not report success.
 * 2. A-13 - every gate prints ASCII-only output in both the PASS and the FAIL
 *    case, so no Chinese text leaks into the machine-readable gate log.
 *
 * The real scripts are spawned; nothing is mocked.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(REPO_ROOT, "scripts");
const FIXTURES = path.join(REPO_ROOT, "fixtures");

interface GateRun {
  status: number | null;
  output: string;
}

interface Gate {
  name: string;
  script: string;
}

const GATES: Gate[] = [
  { name: "check-boundaries", script: path.join(SCRIPTS, "check-boundaries.mjs") },
  { name: "check-cycles", script: path.join(SCRIPTS, "check-cycles.mjs") },
  { name: "check-file-size", script: path.join(SCRIPTS, "check-file-size.mjs") },
  { name: "check-module-ownership", script: path.join(SCRIPTS, "check-module-ownership.mjs") },
];

const FILE_SIZE_GATE = path.join(SCRIPTS, "check-file-size.mjs");

/** A path that is deliberately never created. */
const MISSING_ROOT = path.join(os.tmpdir(), `haruyuki-gate-missing-${process.pid}-${Date.now()}`);

/** Any byte outside 7-bit ASCII. */
const NON_ASCII = /[^\x00-\x7F]/;

const createdRoots: string[] = [];

/**
 * @param script absolute gate script path
 * @param args gate arguments
 * @returns exit code plus combined stdout/stderr
 */
function runGate(script: string, args: string[]): GateRun {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * @param script absolute gate script path
 * @param scenario fixture directory below fixtures/
 * @returns exit code plus combined stdout/stderr
 */
function runFixture(script: string, scenario: string): GateRun {
  return runGate(script, ["--root", path.join(FIXTURES, scenario)]);
}

/**
 * Materialize a tree of regular files below a fresh temp directory.
 *
 * @param files repo-relative path to file contents
 * @returns absolute temp tree root
 */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-gate-contract-"));

  createdRoots.push(root);

  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  return root;
}

/**
 * Remove a temp tree bottom-up with unlink/rmdir only. Idempotent.
 *
 * @param root absolute tree root
 */
function removeTree(root: string): void {
  if (!existsSync(root)) {
    return;
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);

    if (entry.isDirectory()) {
      removeTree(absolute);
    } else {
      unlinkSync(absolute);
    }
  }

  rmdirSync(root);
}

/**
 * @param run gate run
 */
function expectAscii(run: GateRun): void {
  expect(NON_ASCII.test(run.output), `non-ASCII output:\n${run.output}`).toBe(false);
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    removeTree(root);
  }
});

describe("gate CLI contract: fail closed", () => {
  it.each(GATES)("$name exits 2 when --root does not exist", ({ script }) => {
    const run = runGate(script, ["--root", MISSING_ROOT]);

    expect(existsSync(MISSING_ROOT)).toBe(false);
    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("ERROR");
    expectAscii(run);
  });

  it.each(GATES)("$name exits 2 on an empty directory", ({ script }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-gate-empty-"));

    createdRoots.push(root);

    const run = runGate(script, ["--root", root]);

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("ERROR");
    expectAscii(run);
  });
});

describe("A-13: every gate prints ASCII-only output", () => {
  const FIXTURE_CASES: Array<{
    name: string;
    script: string;
    pass: string;
    fail: string;
  }> = [
    {
      name: "check-boundaries",
      script: path.join(SCRIPTS, "check-boundaries.mjs"),
      pass: "boundaries/green-allowed-value-edges",
      fail: "boundaries/red-r6-ui-core-value",
    },
    {
      name: "check-cycles",
      script: path.join(SCRIPTS, "check-cycles.mjs"),
      pass: "cycles/clean",
      fail: "cycles/red-a-b-a",
    },
    {
      name: "check-module-ownership",
      script: path.join(SCRIPTS, "check-module-ownership.mjs"),
      pass: "ownership/green-ownership",
      fail: "ownership/red-ownership",
    },
  ];

  it.each(FIXTURE_CASES)("$name PASS output is ASCII", ({ script, pass }) => {
    const run = runFixture(script, pass);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expectAscii(run);
  });

  it.each(FIXTURE_CASES)("$name FAIL output is ASCII", ({ script, fail }) => {
    const run = runFixture(script, fail);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("FAIL");
    expectAscii(run);
  });

  it("check-file-size PASS output is ASCII", () => {
    const root = makeTree({ "packages/core/src/small.ts": "export const value = 1;\n" });
    const run = runGate(FILE_SIZE_GATE, ["--root", root]);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expectAscii(run);
  });

  it("check-file-size FAIL output is ASCII", () => {
    const root = makeTree({ "packages/core/src/big.ts": "export const value = 1;\n".repeat(1001) });
    const run = runGate(FILE_SIZE_GATE, ["--root", root]);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("FAIL");
    expectAscii(run);
  });
});
