/**
 * Gate self-tests for scripts/check-module-ownership.mjs (acceptance criterion
 * A-10): a protected module imported outside its allow list, and a pure barrel
 * forwarding module, must both fail the real gate.
 *
 * Every fixture carries its own scripts/module-ownership.json because the gate
 * reads the policy from the scanned root and treats a missing policy as a hard
 * failure (exit 2).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO_ROOT, "scripts", "check-module-ownership.mjs");
const FIXTURES = path.join(REPO_ROOT, "fixtures", "ownership");

interface GateRun {
  status: number | null;
  output: string;
}

/**
 * @param caseName fixture directory below fixtures/ownership
 * @returns exit code plus combined stdout/stderr
 */
function runOwnershipGate(caseName: string): GateRun {
  const result = spawnSync(process.execPath, [GATE, "--root", path.join(FIXTURES, caseName)], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("check-module-ownership: protected modules (A-10)", () => {
  it("fails when a module outside the allow list imports the domain", () => {
    const run = runOwnershipGate("red-ownership");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ module-ownership /);
    expect(run.output).toContain("packages/ui/src/rogue.ts");
    expect(run.output).toContain("resolves to packages/core/src/engine/secret.ts");
    expect(run.output).toContain("allowed importers: packages/core/src/entry.ts");
  });

  it("passes when only allow-listed importers and the domain itself import the module", () => {
    const run = runOwnershipGate("green-ownership");

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(run.output).not.toMatch(/ module-ownership /);
  });
});

describe("check-module-ownership: the policy file is mandatory", () => {
  it("exits 2 when the scanned tree has no scripts/module-ownership.json", () => {
    const run = runOwnershipGate("missing-config");

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("scripts/module-ownership.json");
    expect(run.output).toContain("must not report PASS");
  });
});

describe("check-module-ownership: barrel forwarding (A-10)", () => {
  it("fails a pure forwarding module", () => {
    const run = runOwnershipGate("red-barrel");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ barrel /);
    expect(run.output).toContain("packages/ui/src/index.ts");
    expect(run.output).toContain("pure forwarding module");
  });

  it("passes modules that declare something of their own, allowed barrels and .d.ts files", () => {
    const run = runOwnershipGate("green-barrel");

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(run.output).not.toMatch(/ barrel /);
  });
});
