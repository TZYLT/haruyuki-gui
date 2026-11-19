/**
 * Gate self-tests for scripts/check-cycles.mjs (acceptance criterion A-9).
 *
 * The real gate is spawned against a committed fixture tree: no mocking, no
 * in-process import of the script.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

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

  it("fails a cycle made of .tsx modules", () => {
    const run = runCyclesGate("red-tsx-cycle");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ circular /);
    expect(run.output).toContain(
      "packages/core/src/a.tsx -> packages/core/src/b.tsx -> packages/core/src/a.tsx",
    );
  });

  it("passes a tree whose only source files are .tsx", () => {
    const run = runCyclesGate("clean-tsx");

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(run.output).not.toMatch(/ circular /);
  });
});

describe("check-cycles: a broken graph is exit 2, never PASS", () => {
  it("reports the file:line of a source file that does not parse", () => {
    const run = runCyclesGate("red-syntax-error");

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("packages/core/src/broken.ts:1");
    expect(run.output).toContain("cannot parse");
  });

  it("reports an in-repo import that does not resolve", () => {
    const run = runCyclesGate("red-unresolved");

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain('"./missing"');
  });
});

/**
 * The gate judges the repository, not every file on disk.
 *
 * `apps/desktop/runtime` and `apps/desktop/release` are written by the packaging
 * pipeline and gitignored. Walking them read a bundled engine as source: the gate
 * reported forty-six unresolved imports and cycles that exist only inside a bundle,
 * so a correct tree went red for anyone who ran `package` before `verify --full`.
 *
 * The case below is the same shape in miniature: a tree whose only cycle lives
 * inside a gitignored directory. It must pass - and the identical tree without the
 * ignore rule must still fail, which is what keeps this from being a test that
 * passes by not looking.
 */
describe("check-cycles: gitignored output is not source", () => {
  const created = path.join(REPO_ROOT, "fixtures", "cycles");

  const built = mkdtempSync(path.join(created, "tmp-ignored-"));
  const kept = mkdtempSync(path.join(created, "tmp-kept-"));

  afterAll(() => {
    rmSync(built, { recursive: true, force: true });
    rmSync(kept, { recursive: true, force: true });
  });

  for (const [root, ignored] of [
    [built, true],
    [kept, false],
  ] as const) {
    mkdirSync(path.join(root, "packages", "core", "src"), { recursive: true });
    mkdirSync(path.join(root, "packages", "core", "generated"), { recursive: true });
    writeFileSync(path.join(root, "packages", "core", "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(
      path.join(root, "packages", "core", "generated", "one.js"),
      'import "./two.js";\nexport const one = 1;\n',
    );
    writeFileSync(
      path.join(root, "packages", "core", "generated", "two.js"),
      'import "./one.js";\nexport const two = 2;\n',
    );

    if (ignored) {
      writeFileSync(path.join(root, ".gitignore"), "packages/core/generated/\n");
    }
  }

  it("passes when the only cycle sits behind .gitignore", () => {
    const run = spawnSync(process.execPath, [GATE, "--root", built], { encoding: "utf8" });
    const output = `${run.stdout}${run.stderr}`;

    expect(run.status, output).toBe(0);
    expect(output).toContain("PASS");
  });

  it("still fails the same cycle when nothing ignores it", () => {
    const run = spawnSync(process.execPath, [GATE, "--root", kept], { encoding: "utf8" });
    const output = `${run.stdout}${run.stderr}`;

    // Exit 1 is a violation; the point of this half is that the tree really does
    // contain a cycle, so a green here would mean the first test proved nothing.
    expect(run.status, output).toBe(1);
    expect(output).toMatch(/ circular /);
  });
});
