/**
 * Gate self-tests for scripts/check-boundaries.mjs - the authoritative package
 * boundary matrix (acceptance criteria A-1 and A-2).
 *
 * The gate is spawned as a real child process against a fixture tree; nothing
 * inside the gate is mocked. That is the point of a self-test: it must fail
 * when the rule itself is removed, bypassed or loses Windows path handling.
 *
 * Red cases: exit code 1, the expected rule id is the only rule reported, and
 * the summary says FAIL. Green cases: exit code 0, no rule id, and PASS.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO_ROOT, "scripts", "check-boundaries.mjs");
const FIXTURES = path.join(REPO_ROOT, "fixtures", "boundaries");

interface GateRun {
  status: number | null;
  output: string;
}

/**
 * Run the real gate against one fixture tree.
 *
 * @param caseName fixture directory below fixtures/boundaries
 * @returns exit code plus combined stdout/stderr
 */
function runBoundaryGate(caseName: string): GateRun {
  const result = spawnSync(process.execPath, [GATE, "--root", path.join(FIXTURES, caseName)], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * Distinct rule ids mentioned in the output.
 *
 * @param output combined stdout/stderr
 * @returns rule ids in first-seen order
 */
function reportedRuleIds(output: string): string[] {
  return [...new Set(output.match(/\bR[0-9]{1,2}\b/g) ?? [])];
}

/** One red fixture per forbidden matrix cell and per host/Node constraint. */
const RED_CASES: Array<[string, string]> = [
  // R1: protocol is the leaf and imports no internal package.
  ["red-r1-protocol-core", "R1"],
  ["red-r1-protocol-ui", "R1"],
  ["red-r1-protocol-desktop", "R1"],
  ["red-r1-protocol-vscode", "R1"],
  // R1 must also see a relative path that crosses the package boundary.
  ["red-r1-protocol-core-relative", "R1"],
  // R2 / R3 / R5: host APIs are forbidden outside apps/*.
  ["red-r2-core-host-apis", "R2"],
  ["red-r3-protocol-host-apis", "R3"],
  ["red-r5-ui-host-apis", "R5"],
  // R4: the renderer stays free of Node builtins, node: prefixed and bare.
  ["red-r4-ui-node-builtins", "R4"],
  // R6: ui may only type-import core. The bypass forms must all be caught.
  ["red-r6-ui-core-value", "R6"],
  ["red-r6-ui-core-relative", "R6"],
  ["red-r6-ui-core-require", "R6"],
  ["red-r6-ui-core-dynamic-import", "R6"],
  ["red-r6-ui-core-export-from", "R6"],
  ["red-r6-ui-core-deep-path", "R6"],
  // A mixed clause (one type specifier plus one value specifier) executes the
  // module, so it is a value import.
  ["red-r6-ui-core-mixed", "R6"],
  ["red-r6-ui-core-side-effect", "R6"],
  // R7: ui may only type-import protocol.
  ["red-r7-ui-protocol-value", "R7"],
  ["red-r7-ui-protocol-relative", "R7"],
  // R8 / R9: the app shells must not import each other.
  ["red-r8-desktop-vscode", "R8"],
  ["red-r9-vscode-desktop", "R9"],
  // R10: core must not reach up into the renderer or the app shells.
  ["red-r10-core-ui", "R10"],
  ["red-r10-core-desktop", "R10"],
  ["red-r10-core-vscode", "R10"],
  // R11: ui must not import an app shell.
  ["red-r11-ui-desktop", "R11"],
  ["red-r11-ui-vscode", "R11"],
  // R12: each app shell binds one host API and may not import the other one.
  ["red-r12-desktop-vscode-host", "R12"],
  ["red-r12-vscode-electron-host", "R12"],
  ["red-r12-vscode-electron-type-only", "R12"],
];

/** One green fixture per allowed cell, including both type-only alternatives. */
const GREEN_CASES: string[] = [
  // R1 legal case: protocol imports nothing internal.
  "green-r1-protocol-clean",
  // A-2 / R6 / R7: every import-type form must pass.
  "green-r6-r7-type-only-forms",
  // A-2: core->protocol, ui->{protocol,core} type-only, desktop/vscode->all.
  "green-allowed-value-edges",
  // R12 legal case: each shell may import its own host API.
  "green-r12-shells-own-host-api",
];

describe("check-boundaries: matrix red cases (A-1)", () => {
  it.each(RED_CASES)("flags %s with %s", (caseName, rule) => {
    const run = runBoundaryGate(caseName);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("FAIL");
    // Exactly this rule: a different rule firing would still be a red gate, but
    // it would prove the matrix is mis-wired for this cell.
    expect(reportedRuleIds(run.output)).toEqual([rule]);
  });
});

describe("check-boundaries: matrix green cases (A-2)", () => {
  it.each(GREEN_CASES)("passes %s", (caseName) => {
    const run = runBoundaryGate(caseName);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(reportedRuleIds(run.output)).toEqual([]);
  });
});

describe("check-boundaries: bypass forms", () => {
  it("attributes a relative path across packages to R6", () => {
    const run = runBoundaryGate("red-r6-ui-core-relative");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("R6");
  });

  it("attributes require() to R6", () => {
    const run = runBoundaryGate("red-r6-ui-core-require");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("R6");
  });

  it("attributes a dynamic import() to R6", () => {
    const run = runBoundaryGate("red-r6-ui-core-dynamic-import");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("R6");
  });

  it("attributes export ... from to R6", () => {
    const run = runBoundaryGate("red-r6-ui-core-export-from");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("R6");
  });

  it("attributes a deep package path to R6", () => {
    const run = runBoundaryGate("red-r6-ui-core-deep-path");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("R6");
  });
});
