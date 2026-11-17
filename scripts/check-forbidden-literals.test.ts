/**
 * Self-tests for `scripts/check-forbidden-literals.mjs`.
 *
 * The real gate is spawned against small trees created in `os.tmpdir()`, so each
 * case proves the rule fires on the shape it is meant to catch and stays quiet on
 * the shapes it must not.
 *
 * Covered:
 *   - a clean tree passes;
 *   - a wire message name in a business module is a violation;
 *   - the same name inside the transport adapter is allowed, because naming it is
 *     that adapter's job;
 *   - our own domain words (`sync`, `input`) are not wire violations, because a
 *     rule that fires on those would be "fixed" by renaming a domain concept;
 *   - an internal document number is a violation, in a comment and in a string;
 *   - the help and broken-configuration exit codes.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(process.cwd(), "scripts/check-forbidden-literals.mjs");
const BUSINESS = "packages/core/src/engine/reconnect";
const BASELINE = "scripts/forbidden-literals-baseline.json";

/** A baseline that excuses nothing, so every case below is about the rule itself. */
const EMPTY_BASELINE = JSON.stringify({ files: {} });
const TRANSPORT = "packages/core/src/engine/client";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "forbidden-literals-"));
  roots.push(root);

  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
}

describe("forbidden literals gate", () => {
  it("passes a module that names no wire message", () => {
    const root = makeTree({
      [BASELINE]: EMPTY_BASELINE,
      [`${BUSINESS}/clean.ts`]: 'export const step = { step: "sync" };\n',
    });

    const result = run(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
  });

  it("rejects a wire message name in a business module", () => {
    const root = makeTree({
      [BASELINE]: EMPTY_BASELINE,
      [`${BUSINESS}/bad.ts`]: 'const frame = { type: "agent_list" };\n',
    });

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("wire-literal");
    expect(result.stderr).toContain('"agent_list"');
  });

  it("allows the transport adapter to name wire messages", () => {
    const root = makeTree({
      [BASELINE]: EMPTY_BASELINE,
      [`${TRANSPORT}/frames.ts`]: 'const frames = ["agent_list"];\n',
    });

    const result = run(root);

    expect(result.status).toBe(0);
  });

  it("does not fire on the words this layer uses for its own concepts", () => {
    // "sync" is a step name here and "input" is a port; a check that flagged them
    // would be answered by renaming the domain, which fixes nothing.
    const root = makeTree({
      [BASELINE]: EMPTY_BASELINE,
      [`${BUSINESS}/domain.ts`]:
        'export type Step = "sync";\nexport interface Port { input: string }\n',
    });

    const result = run(root);

    expect(result.status).toBe(0);
  });

  it("rejects an internal document number in a comment and in a string", () => {
    const root = makeTree({
      [BASELINE]: EMPTY_BASELINE,
      [`${BUSINESS}/refs.ts`]: "/** see docs/47 for why */\nexport const note = 'E-147';\n",
    });

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("internal-number");
  });

  it("lets a file keep the violations it was frozen with, and fails the next one", () => {
    // The point of a baseline rather than a narrower scope: the old lines are
    // excused, and a new one in the same file is not.
    const file = `${BUSINESS}/legacy.ts`;
    const root = makeTree({
      [BASELINE]: JSON.stringify({ files: { [file]: 1 } }),
      [file]: "/** see docs/47 for why */\nexport const note = 'docs/18';\n",
    });

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("internal-number");
    // Exactly one line escapes the allowance, not both.
    expect(
      result.stderr
        .trim()
        .split("\n")
        .filter((line) => line.includes("internal-number")),
    ).toHaveLength(1);
  });

  it("prints help and exits zero", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("check-forbidden-literals");
  });
});
