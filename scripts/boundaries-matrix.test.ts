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
 *
 * The drift guard at the bottom imports the gate module (its CLI call is
 * entry-point guarded) and calls `assertMatrixIsConsistent()` with deliberately
 * broken tables, so a matrix edit that forgets a rule id cannot stay green.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { MATRIX, RULE_BY_EDGE, assertMatrixIsConsistent } from "./check-boundaries.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO_ROOT, "scripts", "check-boundaries.mjs");
const FIXTURES = path.join(REPO_ROOT, "fixtures", "boundaries");

interface GateRun {
  status: number | null;
  output: string;
}

/** Every OS temp tree this suite creates, removed after each test. */
const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    removeTree(root);
  }
});

/**
 * Run the real gate against one root directory.
 *
 * @param root absolute directory to scan
 * @returns exit code plus combined stdout/stderr
 */
function runGateAt(root: string): GateRun {
  const result = spawnSync(process.execPath, [GATE, "--root", root], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * Run the real gate against one fixture tree.
 *
 * @param caseName fixture directory below fixtures/boundaries
 * @returns exit code plus combined stdout/stderr
 */
function runBoundaryGate(caseName: string): GateRun {
  return runGateAt(path.join(FIXTURES, caseName));
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

/**
 * Materialize a tree of regular files below an existing directory.
 *
 * @param root absolute tree root
 * @param files repo-relative path to file contents
 */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

/**
 * Remove one temp tree bottom-up with unlink/rmdir only (no recursive remove).
 * Idempotent.
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

/** One red fixture per forbidden matrix cell and per host/Node constraint. */
const RED_CASES: Array<[string, string]> = [
  // R1: protocol is the leaf and imports no internal package.
  ["red-r1-protocol-core", "R1"],
  ["red-r1-protocol-ui", "R1"],
  ["red-r1-protocol-desktop", "R1"],
  ["red-r1-protocol-vscode", "R1"],
  // R1 must also see a relative path that crosses the package boundary.
  ["red-r1-protocol-core-relative", "R1"],
  // R1 must also see a type-position import() and typeof import().
  ["red-r1-protocol-core-type-position", "R1"],
  // R2 / R3 / R5: host APIs are forbidden outside apps/*.
  ["red-r2-core-host-apis", "R2"],
  ["red-r3-protocol-host-apis", "R3"],
  ["red-r5-ui-host-apis", "R5"],
  // R4: the renderer stays free of Node builtins, node: prefixed and bare.
  ["red-r4-ui-node-builtins", "R4"],
  // R4 must apply to the deprecated bare "sys" alias too (P1-8).
  ["red-r4-ui-sys-builtin", "R4"],
  // R6: ui may only type-import core. The bypass forms must all be caught.
  ["red-r6-ui-core-value", "R6"],
  ["red-r6-ui-core-relative", "R6"],
  ["red-r6-ui-core-require", "R6"],
  ["red-r6-ui-core-dynamic-import", "R6"],
  ["red-r6-ui-core-export-from", "R6"],
  ["red-r6-ui-core-deep-path", "R6"],
  // `createRequire(...)("x")` and `module.require("x")` are require() forms.
  ["red-r6-ui-core-create-require", "R6"],
  ["red-r6-ui-core-module-require", "R6"],
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
  // A-2 / R6 / R7: a type-position import() and typeof import() are type-only.
  "green-r6-r7-type-position",
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

describe("check-boundaries: type-position import() (P1-1)", () => {
  it("flags both import(...).T and typeof import(...) on protocol -> core", () => {
    const run = runBoundaryGate("red-r1-protocol-core-type-position");

    expect(run.status, run.output).toBe(1);
    expect(reportedRuleIds(run.output)).toEqual(["R1"]);
    // One violation per type-position form: import(...).T and typeof import(...).
    expect(run.output.match(/R1:/g) ?? []).toHaveLength(2);
  });

  it("passes a type-position import() on the type-allowed ui edges", () => {
    const run = runBoundaryGate("green-r6-r7-type-position");

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(reportedRuleIds(run.output)).toEqual([]);
  });
});

describe("check-boundaries: Windows case-insensitive attribution (P1-2)", () => {
  it("never attributes a case-mismatched package path to local", () => {
    const run = runBoundaryGate("red-r6-ui-core-case-alias");

    // Windows resolves ../../Core/... to the real packages/core, so the edge is
    // ui -> core and R6 must fire. POSIX has no ./Core directory, so the gate
    // must fail closed as unresolved. Either way the import never passes.
    expect(run.status, run.output).toBe(1);
    expect(run.output).not.toContain("PASS");

    if (process.platform === "win32") {
      expect(reportedRuleIds(run.output)).toEqual(["R6"]);
    } else {
      expect(run.output).toContain("unresolved");
    }
  });
});

describe("check-boundaries: file: URLs (P1-3)", () => {
  it("resolves an absolute file: URL to the real target package", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-boundaries-file-url-"));
    createdRoots.push(root);

    // The gate canonicalizes --root, so build the URL from the canonical path
    // (a Windows 8.3 temp path would otherwise resolve outside the scan root).
    const target = path.join(realpathSync.native(root), "packages", "core", "src", "index.ts");

    writeTree(root, {
      "packages/core/src/index.ts": 'export const core = "core";\n',
      "packages/protocol/src/index.ts":
        `import { core } from ${JSON.stringify(pathToFileURL(target).href)};\n` +
        "export const value = core;\n",
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(reportedRuleIds(run.output)).toEqual(["R1"]);
  });

  it("reports a file: URL that cannot be converted as unresolved", () => {
    const run = runBoundaryGate("red-unresolved-file-url");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("unresolved");
    expect(reportedRuleIds(run.output)).toEqual([]);
  });
});

describe("check-boundaries: workspace subpath specifiers", () => {
  it("attributes @haruyuki/<pkg>/<subpath> to that package, not to unresolved", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-boundaries-subpath-"));
    createdRoots.push(root);

    // A subpath export is a real entry point of the package (the test-support
    // surface is one), so the matrix must grade it as vscode -> core instead of
    // treating the second path segment as an unknown external package. If this
    // regressed to "external", any forbidden edge written as a subpath would
    // quietly pass.
    writeTree(root, {
      "packages/protocol/src/index.ts": 'export const protocol = "protocol";\n',
      "packages/core/src/index.ts": 'export const core = "core";\n',
      "apps/vscode/src/extension.ts":
        'import { TESTING_SUPPORT_VERSION } from "@haruyuki/core/testing";\n' +
        "export const extension = TESTING_SUPPORT_VERSION;\n",
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(reportedRuleIds(run.output)).toEqual([]);
  });
});

describe("check-boundaries: fail-closed regressions (P1-7, P1-10)", () => {
  it("exits 2 when packages/ holds none of the five matrix packages", () => {
    const run = runBoundaryGate("broken-only-unrelated-packages");

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("ERROR");
    expect(run.output).toContain("no workspace package directory");
    expect(run.output).not.toContain("PASS");
  });

  it("flags an unresolved path specifier instead of treating it as local", () => {
    const run = runBoundaryGate("red-unresolved-path-specifier");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("unresolved");
    expect(reportedRuleIds(run.output)).toEqual([]);
  });

  it("flags an unknown @haruyuki name instead of treating it as external", () => {
    const run = runBoundaryGate("red-unknown-workspace-package");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("unresolved");
    expect(reportedRuleIds(run.output)).toEqual([]);
  });
});

/** Count the non-diagonal cells that are not "allow". */
function restrictedCellCount(matrix: Record<string, Record<string, string>>): number {
  return Object.entries(matrix).flatMap(([from, row]) =>
    Object.entries(row).filter(([to, permission]) => to !== from && permission !== "allow"),
  ).length;
}

describe("check-boundaries: matrix drift guard (P1-7)", () => {
  it("accepts the committed matrix and rule table", () => {
    expect(() => assertMatrixIsConsistent()).not.toThrow();
    expect(restrictedCellCount(MATRIX)).toBe(13);
    expect(RULE_BY_EDGE.size).toBe(13);
  });

  it("rejects a matrix with 13 restricted edges but only 12 rule ids", () => {
    const drifted = new Map(RULE_BY_EDGE);

    drifted.delete("ui->vscode");

    expect(() => assertMatrixIsConsistent(MATRIX, drifted)).toThrow(
      /matrix has 13 restricted edge\(s\) but RULE_BY_EDGE has 12/,
    );
  });

  it("rejects a rule id registered with a permission the matrix does not grant", () => {
    const drifted = new Map(RULE_BY_EDGE);

    drifted.set("ui->core", { rule: "R6", permission: "forbid" });

    expect(() => assertMatrixIsConsistent(MATRIX, drifted)).toThrow(
      /matrix edge ui->core is "type" but its rule is registered as "forbid"/,
    );
  });

  it("rejects a rule table entry that names an allowed cell", () => {
    const drifted = new Map(RULE_BY_EDGE);

    drifted.delete("ui->vscode");
    drifted.set("core->protocol", { rule: "R6", permission: "type" });

    expect(() => assertMatrixIsConsistent(MATRIX, drifted)).toThrow(
      /matrix edge ui->vscode is "forbid" but has no rule id/,
    );
  });
});

describe("check-boundaries: R6 test-file exemption (C5-Q14)", () => {
  /** A tree where the renderer imports core both from a test and from production. */
  function exemptionTree(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-boundaries-r6-exempt-"));

    createdRoots.push(root);

    writeTree(root, {
      "packages/protocol/src/index.ts": 'export const protocol = "protocol";\n',
      "packages/core/src/index.ts": 'export const core = "core";\n',
      // Green: a test may construct the real core collaborators it exercises.
      "packages/ui/src/bridge/store.test.ts":
        'import { core } from "@haruyuki/core";\n' + "export const x = core;\n",
      // Red: the same import one file over, in production code, stays forbidden.
      "packages/ui/src/bridge/store.ts":
        'import { core } from "@haruyuki/core";\n' + "export const x = core;\n",
    });

    return root;
  }

  it("exempts a test file but keeps the same import forbidden in production code", () => {
    const run = runGateAt(exemptionTree());

    expect(run.status, run.output).toBe(1);
    // The exemption is per file, not per package: exactly one violation, from
    // the production file. A package-wide exemption would report zero here.
    expect(reportedRuleIds(run.output)).toEqual(["R6"]);
    expect(run.output).toContain("store.ts");
    expect(run.output).not.toContain("store.test.ts");
  });

  it("does not extend the exemption to R7", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-boundaries-r7-test-"));

    createdRoots.push(root);

    writeTree(root, {
      "packages/protocol/src/index.ts": 'export const protocol = "protocol";\n',
      "packages/core/src/index.ts": 'export const core = "core";\n',
      // R7 is deliberately not exempted: the frame-type table reaches the
      // renderer by injection, so no test needs to value-import protocol.
      "packages/ui/src/bridge/table.test.ts":
        'import { protocol } from "@haruyuki/protocol";\n' + "export const y = protocol;\n",
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(reportedRuleIds(run.output)).toEqual(["R7"]);
  });

  it("still rejects a non-test file whose name merely contains 'test'", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-boundaries-r6-trap-"));

    createdRoots.push(root);

    writeTree(root, {
      "packages/protocol/src/index.ts": 'export const protocol = "protocol";\n',
      "packages/core/src/index.ts": 'export const core = "core";\n',
      // `latest.ts` and `contest.ts` end in "test" as a substring but are not
      // test files; a `contains "test"` rule would let both through.
      "packages/ui/src/bridge/latest.ts":
        'import { core } from "@haruyuki/core";\n' + "export const a = core;\n",
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(reportedRuleIds(run.output)).toEqual(["R6"]);
  });
});
