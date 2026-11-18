import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The gate and the test runner must agree on which files are tests.
//
// They are two lists in two files, and they silently disagreed once: a root
// reached vitest's own include list and not the gate's discovery walk, so the
// pipeline's own tests never ran while the test segment reported green. Nothing
// compared them, and "read them side by side" is exactly the kind of care that
// fails quietly.
//
// This converts that comment into a check. Both lists are read as text and
// compared on their literal path segments, so a root added to one and not the
// other makes this fail rather than making the gate quieter.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const CONFIG = readFileSync(path.join(ROOT, "vitest.config.mts"), "utf8");
const GATE = readFileSync(path.join(ROOT, "scripts", "verify.mjs"), "utf8");

/** The include globs the runner is configured with. */
function runnerIncludes() {
  const block = /include:\s*\[([\s\S]*?)\]/.exec(CONFIG);
  if (block === null) throw new Error("vitest.config.mts has no include list");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** One line per discovery root in the gate, as written in its source. */
function gateRootLines() {
  const block = /const roots = \[([\s\S]*?)\];/.exec(GATE);
  if (block === null) throw new Error("verify.mjs has no discovery roots");
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("pattern:"));
}

/** The literal directory segments of a glob, up to its wildcard. */
function literalSegments(glob) {
  return glob
    .split("/")
    .filter((part) => part.length > 0 && !part.includes("*") && !part.includes("."));
}

describe("the test gate and the test runner cover the same files", () => {
  it("has both lists to compare", () => {
    expect(runnerIncludes().length).toBeGreaterThan(0);
    expect(gateRootLines().length).toBeGreaterThan(0);
  });

  it("gives every runner include a gate root that reaches it", () => {
    // The direction that failed: a file vitest would run and the gate would not.
    const roots = gateRootLines();

    for (const include of runnerIncludes()) {
      const segments = literalSegments(include);
      const covered = roots.some((root) => segments.every((part) => root.includes(part)));

      expect(covered, `vitest includes ${include} but no gate root reaches it`).toBe(true);
    }
  });

  it("gives every gate root a runner include that covers it", () => {
    // The other direction: a file the gate would run and vitest would refuse,
    // which made the segment fail with "no test files found".
    const includes = runnerIncludes();

    for (const root of gateRootLines()) {
      // The root's own source text names its tree; those names must all appear
      // in some include. Reading the line is enough to catch a new tree.
      const names = ["scripts", "packages", "apps"].filter((name) => root.includes(`"${name}"`));
      const covered = includes.some((include) => names.every((name) => include.includes(name)));

      expect(covered, `the gate walks a root vitest does not cover: ${root}`).toBe(true);
    }
  });

  it("reaches the pipeline's own tests, which is the case that was missing", () => {
    // Named explicitly: this is the specific tree whose absence went unnoticed.
    const covered = gateRootLines().some(
      (root) => root.includes('"apps"') && root.includes("scripts"),
    );

    expect(covered, "the gate must walk apps/*/scripts, where the pipeline tests live").toBe(true);
  });
});
