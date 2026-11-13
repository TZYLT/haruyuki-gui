/**
 * Gate self-tests for scripts/check-file-size.mjs (acceptance criterion A-8).
 *
 * Oversized trees are built in the OS temp directory, never in the repository.
 * Cleanup walks the tree and removes it entry by entry with unlink/rmdir; there
 * is no recursive delete API in this file.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO_ROOT, "scripts", "check-file-size.mjs");
const BASELINE = "scripts/source-file-size-baseline.json";

interface GateRun {
  status: number | null;
  output: string;
}

const createdRoots: string[] = [];

/**
 * Materialize a tree of regular files below a fresh temp directory.
 *
 * @param files repo-relative path to file contents
 * @returns absolute temp tree root
 */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-file-size-"));

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
 * Source text with exactly `count` lines: every line ends with "\n".
 *
 * @param count line count
 * @returns file contents
 */
function sourceLines(count: number): string {
  return "export const value = 1;\n".repeat(count);
}

/**
 * @param entries path -> recorded line count
 * @returns baseline JSON text
 */
function baselineText(entries: Record<string, unknown>): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/**
 * Run the real gate against a temp tree.
 *
 * @param root temp tree root
 * @param args extra arguments placed before --root
 * @returns exit code plus combined stdout/stderr
 */
function runFileSizeGate(root: string, args: string[] = []): GateRun {
  const result = spawnSync(process.execPath, [GATE, ...args, "--root", root], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    removeTree(root);
  }
});

describe("check-file-size: the 1000 line limit", () => {
  it("fails a new file with 1001 lines", () => {
    const root = makeTree({ "packages/core/src/big.ts": sourceLines(1001) });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ file-size /);
    expect(run.output).toContain("1001 lines exceeds the 1000 line limit");
  });

  it("passes a new file with exactly 1000 lines", () => {
    const root = makeTree({ "packages/core/src/exact.ts": sourceLines(1000) });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });

  it("passes a baseline-pinned file that still matches its pin", () => {
    const root = makeTree({
      "packages/core/src/big.ts": sourceLines(1001),
      [BASELINE]: baselineText({ "packages/core/src/big.ts": 1001 }),
    });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });
});

describe("check-file-size: the ratchet moves in both directions (A-8)", () => {
  it("fails when a pinned file grows", () => {
    const root = makeTree({
      "packages/core/src/big.ts": sourceLines(1002),
      [BASELINE]: baselineText({ "packages/core/src/big.ts": 1001 }),
    });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ file-size /);
    expect(run.output).toContain("exceeds the recorded baseline of 1001 lines");
  });

  it("fails when a pinned file shrinks but stays above 1000 lines", () => {
    const root = makeTree({
      "packages/core/src/big.ts": sourceLines(1001),
      [BASELINE]: baselineText({ "packages/core/src/big.ts": 1002 }),
    });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ file-size-baseline /);
    expect(run.output).toContain("ratchet the baseline down to 1001");
  });

  it("fails when a pinned file reaches 1000 lines or fewer", () => {
    const root = makeTree({
      "packages/core/src/big.ts": sourceLines(1000),
      [BASELINE]: baselineText({ "packages/core/src/big.ts": 1200 }),
    });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ file-size-baseline /);
    expect(run.output).toContain("delete its obsolete baseline entry");
  });

  it("fails a stale baseline entry whose file no longer exists", () => {
    const root = makeTree({
      "packages/core/src/small.ts": sourceLines(10),
      [BASELINE]: baselineText({ "packages/core/src/dead.ts": 1200 }),
    });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ file-size-baseline /);
    expect(run.output).toContain("stale baseline entry");
  });

  it("exits 2 for a malformed baseline", () => {
    const root = makeTree({
      "packages/core/src/big.ts": sourceLines(1001),
      [BASELINE]: baselineText({ "packages/core/src/big.ts": "not-a-number" }),
    });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(2);
  });
});

describe("check-file-size: --write-baseline never registers a new file", () => {
  it("refuses to add an unpinned oversized file", () => {
    const root = makeTree({ "packages/core/src/big.ts": sourceLines(1001) });
    const run = runFileSizeGate(root, ["--write-baseline"]);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/ file-size /);
    expect(existsSync(path.join(root, BASELINE))).toBe(false);
  });

  it("rewrites an existing pin to the real line count", () => {
    const root = makeTree({
      "packages/core/src/big.ts": sourceLines(1001),
      [BASELINE]: baselineText({ "packages/core/src/big.ts": 1200 }),
    });
    const run = runFileSizeGate(root, ["--write-baseline"]);

    expect(run.status, run.output).toBe(0);
    const written = JSON.parse(readFileSync(path.join(root, BASELINE), "utf8")) as Record<
      string,
      number
    >;

    expect(written).toEqual({ "packages/core/src/big.ts": 1001 });
  });
});

describe("check-file-size: root-level source files are in scope (P2-05)", () => {
  it("fails a root-level source file with 1001 lines", () => {
    const root = makeTree({ "eslint.config.mjs": sourceLines(1001) });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("eslint.config.mjs");
    expect(run.output).toContain("1001 lines exceeds the 1000 line limit");
  });

  it("passes a root-level source file with exactly 1000 lines", () => {
    const root = makeTree({ "vitest.config.mts": sourceLines(1000) });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });

  it("still refuses to pass when the tree contains no source file at all", () => {
    const root = makeTree({ "README.md": "not source\n" });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("refusing to report PASS");
  });
});

describe("check-file-size: line counting edge cases (P2-07)", () => {
  it("fails 1001 lines without a trailing newline", () => {
    const content = `${sourceLines(1000)}export const value = 1;`;
    const root = makeTree({ "packages/core/src/big.ts": content });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("1001 lines exceeds the 1000 line limit");
  });

  it("fails 1001 CRLF lines", () => {
    const root = makeTree({
      "packages/core/src/big.ts": "export const value = 1;\r\n".repeat(1001),
    });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("1001 lines exceeds the 1000 line limit");
  });

  it("passes 1000 CRLF lines", () => {
    const root = makeTree({
      "packages/core/src/exact.ts": "export const value = 1;\r\n".repeat(1000),
    });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });

  it("passes 1000 lines behind a byte order mark", () => {
    const root = makeTree({ "packages/core/src/exact.ts": `\uFEFF${sourceLines(1000)}` });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });

  it("fails 1001 lines behind a byte order mark", () => {
    const root = makeTree({ "packages/core/src/big.ts": `\uFEFF${sourceLines(1001)}` });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("1001 lines exceeds the 1000 line limit");
  });

  it("counts .jsx source files like any other source file", () => {
    const root = makeTree({
      "packages/ui/src/big.jsx": "export const view = <div />;\n".repeat(1001),
    });
    const run = runFileSizeGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("packages/ui/src/big.jsx");
  });
});

describe("check-file-size: --write-baseline is all-or-nothing (P2-07)", () => {
  it("leaves every existing baseline byte untouched when it refuses a new file", () => {
    const rawBaseline = '{"packages/core/src/big.ts": 1200}';
    const root = makeTree({
      "packages/core/src/big.ts": sourceLines(1200),
      "packages/core/src/new.ts": sourceLines(1001),
      [BASELINE]: rawBaseline,
    });
    const before = readFileSync(path.join(root, BASELINE), "utf8");
    const run = runFileSizeGate(root, ["--write-baseline"]);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("is not pinned yet");
    expect(readFileSync(path.join(root, BASELINE), "utf8")).toBe(before);
  });
});
