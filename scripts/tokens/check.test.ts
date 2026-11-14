/**
 * Token gate self-test.
 *
 * The point of this file is not that the gate passes on the real tree -- that is
 * what `pnpm verify` does. It is that each rule fires on the fixture that breaks
 * it, and that the green fixture produces no violations at all. A gate whose red
 * cases are untested is a gate that may be passing because it checks nothing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = path.join(REPO_ROOT, "scripts", "tokens", "check.mjs");
const FIXTURES = path.join(REPO_ROOT, "fixtures", "tokens");

interface GateRun {
  status: number | null;
  output: string;
}

/**
 * Run the token gate against one fixture tree.
 *
 * @param name fixture directory name
 * @returns exit status and combined output
 */
function runGateOn(name: string): GateRun {
  const root = path.join(FIXTURES, name);

  expect(existsSync(root), `missing fixture ${name}`).toBe(true);

  const result = spawnSync(process.execPath, [GATE, "--root", root], {
    encoding: "utf8",
    timeout: 30000,
  });

  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("token gate: green case", () => {
  it("passes a complete, legible, themed tree", () => {
    const run = runGateOn("green-complete");

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(run.output).not.toContain("FAIL");
  });
});

describe("token gate: each rule fires on its own fixture", () => {
  it("T1 names a slot that a theme does not define", () => {
    // The fixture declares accent-1 in slots.ts and omits it from one theme, so
    // both halves of the message matter: the slot AND the theme.
    const run = runGateOn("red-missing-slot");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("T1");
    expect(run.output).toContain("--ui-color-accent-1");
    expect(run.output).toContain("light/normal");
  });

  it("T2 rejects a colour literal in a component", () => {
    const run = runGateOn("red-raw-color");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("T2");
    expect(run.output).toContain("Thing.tsx");
  });

  it("T2 reads a colour inside a CSS template literal", () => {
    // The rule used to require a quote after `color:`, so it only ever saw JSX
    // style objects. Every colour this package renders lives in a CSS template
    // literal, so the rule was blind to the one file it exists to police. This is
    // the shape it must catch.
    const run = runGateOn("red-raw-color");

    expect(run.output).toMatch(/styles\.ts.*T2/s);
  });

  it("T2 does not fire on a colour named only in a comment", () => {
    // A stylesheet comment explaining "the old value was #ff0000" is a comment.
    // A rule that flags it teaches people to delete the explanation instead of
    // the colour, so the distinction is pinned in both directions.
    const result = spawnSync(
      process.execPath,
      [GATE, "--root", path.join(FIXTURES, "green-complete")],
      { encoding: "utf8", timeout: 30000 },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("T3 reports a missing theme combination", () => {
    const run = runGateOn("red-missing-theme");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("T3");
    expect(run.output).toContain("dark/high");
  });

  it("T4 reports a pair below the text threshold", () => {
    const run = runGateOn("red-low-contrast");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("T4");
    expect(run.output).toContain("below 4.5:1");
  });

  it("T5 rejects a reference to a slot that does not exist", () => {
    // This rule exists because the first draft of the wave-3 styles referenced
    // --ui-z-popover, which is not a slot. T2 passed it: the spelling was
    // correct, the value was a var(). var() of a missing property is not a CSS
    // error, so the declaration would have been dropped silently.
    const run = runGateOn("red-unknown-slot");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("T5");
    expect(run.output).toContain("--ui-z-popover");
  });

  it("T6 rejects a class that has no rule in the stylesheet", () => {
    // The defect this rule exists for: the skeleton's live region carried a class
    // the stylesheet never defined, so "Loading" rendered as visible text above
    // the placeholder bars. Every existing assertion passed, because the live
    // region was correct and only its styling was missing.
    const run = runGateOn("red-unknown-class");

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("T6");
    expect(run.output).toContain("ui-thing__ghost");
  });

  it("T6 does not accept a longer class as a match for a shorter one", () => {
    // `.ui-thing__ghost` must not be satisfied by `.ui-thing__ghostExtra`. A
    // substring test called a renamed class present, which is a false pass --
    // exactly what this gate exists to prevent, so it is pinned.
    const run = runGateOn("red-unknown-class");

    expect(run.output).toContain("no rule in");
  });

  it("T6 resolves a derived class back to the component's base class", () => {
    // `className={`${classes}__part`}` was skipped whole by a `includes("$")`
    // guard, so none of the eleven derived sub-classes were ever checked. The
    // fixture writes one that resolves to `ui-thing__ghost`.
    const run = runGateOn("red-unknown-class");

    expect(run.output).toContain("ui-thing__ghost");
  });

  it("T6 fails closed when the stylesheet is missing", () => {
    // The first version wrapped the whole rule in `if (existsSync(stylesheet))`,
    // so deleting the stylesheet turned the only class-coverage rule off and the
    // gate reported a clean tree. "Cannot judge" must not read as "clean".
    const tree = path.join(FIXTURES, "green-complete");
    const stylesheet = path.join(tree, "packages", "ui", "src", "components", "styles.ts");
    const saved = readFileSync(stylesheet, "utf8");

    try {
      rmSync(stylesheet);
      const result = spawnSync(process.execPath, [GATE, "--root", tree], {
        encoding: "utf8",
        timeout: 30000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status, output).toBe(1);
      expect(output).toContain("T6");
      expect(output).toContain("cannot judge");
    } finally {
      writeFileSync(stylesheet, saved);
    }
  });

  it("T4 refuses to measure a colour it cannot parse", () => {
    // `luminance()` used `Number.parseInt` on the hex digits, which yields NaN for
    // a malformed value; every comparison against NaN is false, so an unreadable
    // colour passed every contrast rule in silence.
    const tree = path.join(FIXTURES, "green-complete");
    const palettes = path.join(tree, "packages", "ui", "src", "tokens", "palettes.ts");
    const saved = readFileSync(palettes, "utf8");

    try {
      writeFileSync(
        palettes,
        saved.replace(/"--ui-color-neutral-1": "#[0-9a-fA-F]{3,8}"/, '"--ui-color-neutral-1": "#nope"'),
      );
      const result = spawnSync(process.execPath, [GATE, "--root", tree], {
        encoding: "utf8",
        timeout: 30000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      expect(result.status, output).toBe(1);
      expect(output).toContain("T4");
      expect(output).toContain("cannot measure");
    } finally {
      writeFileSync(palettes, saved);
    }
  });

  it("T4 reports a pair below the non-text threshold separately", () => {
    // Borders and icon strokes have their own, lower threshold. A gate that only
    // checked 4.5:1 would either pass a 3.1:1 border or fail a legal one.
    const run = runGateOn("red-low-contrast");

    expect(run.output).toContain("below 3:1");
  });
});

describe("token gate: fail-closed behaviour", () => {
  it("exits 2 when the root is not a token tree", () => {
    // A missing token layer must not look like a clean tree. Exit 2 says "the
    // gate could not judge", which is different from "the tree is bad".
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

describe("token gate: the real tree", () => {
  it("passes on this repository", () => {
    const result = spawnSync(process.execPath, [GATE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60000,
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
