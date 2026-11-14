/**
 * i18n gate self-test.
 *
 * Each rule must fire on the fixture that breaks it, and the balanced fixture must
 * produce nothing. The key-mismatch case is checked in both directions because a
 * gate that only notices missing keys will happily ship a catalogue with invented
 * ones.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const I18N_GATE = path.join(REPO_ROOT, "scripts", "i18n", "check.mjs");
const FIXTURES_I18N = path.join(REPO_ROOT, "fixtures", "i18n");
const GATE = I18N_GATE;
const FIXTURES = FIXTURES_I18N;

interface GateRun {
  status: number | null;
  output: string;
}

/**
 * Run the i18n gate against one fixture tree.
 *
 * @param name fixture directory name
 * @param removeDirectory optional directory to delete from a copy of the fixture
 * @returns exit status and combined output
 */
function runGateOn(name: string, removeDirectory?: string): GateRun {
  const root = path.join(FIXTURES, name);

  expect(existsSync(root), `missing fixture ${name}`).toBe(true);

  // A copy is used when the case is about an *absent* directory: deleting from
  // the shared fixture would break every other test that reads it.
  const target = removeDirectory === undefined ? root : `${root}-without-${path.basename(removeDirectory)}`;

  if (removeDirectory !== undefined) {
    cpSync(root, target, { recursive: true });
    rmSync(path.join(target, removeDirectory), { recursive: true, force: true });
  }

  const result = spawnSync(process.execPath, [GATE, "--root", target], {
    encoding: "utf8",
    timeout: 30000,
  });

  if (removeDirectory !== undefined) {
    rmSync(target, { recursive: true, force: true });
  }

  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("i18n gate: green case", () => {
  it("passes a balanced catalogue pair", () => {
    const run = runGateOn("green-balanced");

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });
});

describe("i18n gate: each rule fires on its own fixture", () => {
  it("I1 reports a key that the reference has and the translation lacks", () => {
    const run = runGateOn("red-key-mismatch");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("I1");
    expect(run.output).toContain("is missing");
  });

  it("I1 also reports a key the translation invented", () => {
    // The direction a naive check forgets. An extra key is not harmless: it is a
    // message nobody renders, so it rots silently.
    const run = runGateOn("red-key-mismatch");

    expect(run.output).toContain("does not exist in en");
  });

  it("I2 rejects a plural without an other branch", () => {
    // ICU throws at format time for this, which would take down a render.
    const run = runGateOn("red-bad-icu");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("I2");
    expect(run.output).toContain("other branch");
  });

  it("I6 reports a key the code asks for but no catalogue declares", () => {
    const run = runGateOn("red-dangling-ref");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("I6");
    expect(run.output).toContain("is referenced but not declared");
  });

  it("I6 also reports a declared key nothing references", () => {
    // The direction that keeps the catalogue from accumulating entries nobody
    // renders, which the next translator would faithfully translate.
    const run = runGateOn("red-unused-key");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("is declared but never referenced");
  });

  it("I4 rejects a namespace outside the frozen set", () => {
    const run = runGateOn("red-bad-key-format");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("I4");
    expect(run.output).toContain("misc.action.save");
  });

  it("I5 rejects a value that is its own key", () => {
    // The classic untranslated stub: it renders, it looks like an id, and it
    // reads as a deliberate identifier to everyone who is not looking for it.
    const run = runGateOn("red-key-as-value");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("I5");
    expect(run.output).toContain("has the key as its value");
  });

  it("I2 accepts an escaped brace, which is legal ICU", () => {
    // `Use '{' to open a block` is valid: ICU uses single quotes to escape the
    // brace. A brace-counting validator reads it as an unbalanced opening brace
    // and fails a correct catalogue, which is the fastest way to teach people to
    // ignore the gate.
    const tree = path.join(FIXTURES_I18N, "green-balanced");
    const file = path.join(tree, "packages", "ui", "src", "i18n", "locales", "en.ts");
    const saved = readFileSync(file, "utf8");

    try {
      writeFileSync(file, saved.replace('"Save"', '"Use \'{\' to open a block"'));
      const result = spawnSync(process.execPath, [I18N_GATE, "--root", tree], {
        encoding: "utf8",
        timeout: 30000,
      });

      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
    } finally {
      writeFileSync(file, saved);
    }
  });

  it("I6 fails closed when no source directory exists", () => {
    // The guard was `if (sources.length > 0)`, so a tree with no consumer
    // directory skipped half of I6 and reported PASS. A renamed directory would
    // have silently disabled the rule.
    const run = runGateOn("green-balanced", path.join("packages", "ui", "src", "components"));

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("cannot tell which keys are unused");
  });

  it("I3 reports a placeholder that one side dropped", () => {
    const run = runGateOn("red-placeholder-drift");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("I3");
    expect(run.output).toContain("code");
  });
});

describe("i18n gate: fail-closed behaviour", () => {
  it("exits 2 when the root has no catalogue", () => {
    const result = spawnSync(process.execPath, [GATE, "--root", path.join(REPO_ROOT, "scripts")], {
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(2);
  });

  it("exits 2 on an unknown argument", () => {
    const result = spawnSync(process.execPath, [GATE, "--nonsense"], {
      encoding: "utf8",
      timeout: 30000,
    });

    expect(result.status).toBe(2);
  });
});

describe("i18n gate: the real tree", () => {
  it("passes on this repository", () => {
    const result = spawnSync(process.execPath, [GATE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60000,
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
