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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

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

const createdRoots: string[] = [];

/**
 * Materialize a tree of regular files below a fresh temp directory.
 *
 * Temp trees are used for the path-normalization cases only: a Windows junction
 * cannot be committed to git, and a case variant of the same directory cannot
 * coexist with the real one on a case-insensitive file system.
 *
 * @param files repo-relative path to file contents
 * @returns absolute temp tree root
 */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-ownership-"));

  createdRoots.push(root);

  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  return root;
}

/**
 * Remove a temp tree bottom-up. Junctions and symbolic links are unlinked, never
 * followed, so the target tree is left untouched.
 *
 * @param root absolute tree root
 */
function removeTree(root: string): void {
  if (!existsSync(root)) {
    return;
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);

    if (entry.isSymbolicLink()) {
      try {
        unlinkSync(absolute);
      } catch {
        rmdirSync(absolute);
      }
    } else if (entry.isDirectory()) {
      removeTree(absolute);
    } else {
      unlinkSync(absolute);
    }
  }

  rmdirSync(root);
}

/**
 * @param root absolute tree root
 * @returns exit code plus combined stdout/stderr
 */
function runOwnershipGateAt(root: string): GateRun {
  const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * Policy that protects a directory and allows no importer at all.
 *
 * @param domain repo-relative protected glob
 * @returns policy file text
 */
function ownershipPolicy(domain: string): string {
  return `${JSON.stringify(
    {
      modules: [{ path: domain, allowedImporters: ["packages/core/src/entry.ts"] }],
      barrels: { forbid: true, allow: [] },
    },
    null,
    2,
  )}\n`;
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    removeTree(root);
  }
});

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

  it("fails a forwarding module that only also uses import x = require(...)", () => {
    const run = runOwnershipGate("red-barrel-import-equals");

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

describe("check-module-ownership: source extension set (P2-02)", () => {
  it("scans .jsx modules like any other source file", () => {
    const run = runOwnershipGate("red-ownership-jsx");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ module-ownership /);
    expect(run.output).toContain("packages/ui/src/rogue.jsx");
    expect(run.output).toContain("resolves to packages/core/src/engine/secret.ts");
  });
});

describe("check-module-ownership: subpath exports (D1)", () => {
  it("resolves a subpath import through the package's exports map", () => {
    // The resolver used to join the subpath onto the package directory, so
    // `@haruyuki/ui/i18n/core` became `packages/ui/i18n/core` and never resolved.
    // The gate reported it against the importing file, which is the one place the
    // problem was not -- so the diagnosis pointed at the consumer of a working
    // specifier rather than at the resolver.
    const run = runOwnershipGate("green-subpath-exports");

    expect(run.status, run.output).toBe(0);
  });

  it("still reports a subpath the package does not declare", () => {
    // A subpath that is neither exported nor layout-mirrored must stay unresolved:
    // making every subpath resolve would make the gate blind, which is the failure it
    // exists to prevent.
    const tree = makeTree({
      "packages/ui/package.json": JSON.stringify({
        name: "@haruyuki/ui",
        exports: { ".": "./src/index.ts" },
      }),
      "packages/ui/src/index.ts": 'export const A = "a" as const;\n',
      "packages/app/package.json": JSON.stringify({ name: "@haruyuki/app" }),
      "packages/app/src/consumer.ts": 'import { X } from "@haruyuki/ui/not-exported";\n',
      "scripts/module-ownership.json": JSON.stringify({
        modules: [],
        barrels: { forbid: true, allow: [] },
      }),
    });
    const result = spawnSync(process.execPath, [GATE, "--root", tree], { encoding: "utf8" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status, output).toBe(1);
    expect(output).toContain("@haruyuki/ui/not-exported");
  });
});

describe("check-module-ownership: resolved paths are canonical before matching (P2-01)", () => {
  it("fails when a protected directory is imported with different letter case", () => {
    const run = runOwnershipGate("red-ownership-case");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ module-ownership /);
    expect(run.output).toContain("packages/ui/src/rogue.ts");
    expect(run.output).toContain("resolves to packages/core/src/Engine/secret.ts");
  });

  it("fails when a junction aliases the protected directory", () => {
    const root = makeTree({
      "packages/core/src/engine/secret.ts": 'export const secret = "secret";\n',
      "packages/ui/src/rogue.ts":
        'import { secret } from "../link/src/engine/secret";\nexport const value = secret;\n',
      "scripts/module-ownership.json": ownershipPolicy("packages/core/src/engine/**"),
    });
    const link = path.join(root, "packages", "ui", "link");

    symlinkSync(
      path.join(root, "packages", "core"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    const run = runOwnershipGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ module-ownership /);
    expect(run.output).toContain("packages/ui/src/rogue.ts");
    expect(run.output).toContain("resolves to packages/core/src/engine/secret.ts");
  });

  it.skipIf(process.platform !== "win32")(
    "fails when the specifier spells a protected directory in upper case",
    () => {
      const root = makeTree({
        "packages/core/src/engine/secret.ts": 'export const secret = "secret";\n',
        "packages/ui/src/rogue.ts":
          'import { secret } from "../../core/src/ENGINE/secret";\nexport const value = secret;\n',
        "scripts/module-ownership.json": ownershipPolicy("packages/core/src/engine/**"),
      });

      const run = runOwnershipGateAt(root);

      expect(run.status, run.output).toBe(1);
      expect(run.output).toMatch(/ module-ownership /);
      expect(run.output).toContain("resolves to packages/core/src/engine/secret.ts");
    },
  );
});

describe("check-module-ownership: a rule that matches nothing is a config error (P2-06)", () => {
  it("exits 2 when a non-empty rule set has a path matching no imported file", () => {
    const run = runOwnershipGate("red-rule-no-match");

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("matched no imported file");
    expect(run.output).toContain("packages/core/src/engine/**");
  });
});
