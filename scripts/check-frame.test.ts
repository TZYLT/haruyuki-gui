/**
 * Gate self-test for scripts/check-frame.mjs - the `frame` gate
 * (docs/21 section 5, C5-R14).
 *
 * The gate is spawned as a real child process against a temporary tree, and
 * one case also imports `collectViolations` directly. Nothing inside the gate
 * is mocked: the point of a self-test is to fail when the rule is removed,
 * weakened or made to pass vacuously.
 *
 * Each case below corresponds to one way the gate could stop working while
 * still reporting PASS:
 *
 *   - it finds no table and calls that clean      -> missing-table case
 *   - it finds an empty table and calls that clean -> empty-table case
 *   - it stops matching literals                   -> unregistered case
 *   - it matches unrelated `t:`/`type:` properties -> false-positive case
 *   - it accepts a row with no summary             -> summary case
 *   - it scans nothing because `--root` is wrong   -> broken-root case
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO_ROOT, "scripts", "check-frame.mjs");

interface GateRun {
  status: number | null;
  output: string;
}

/** Every temp tree this suite creates, removed after each test. */
const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
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
    cwd: REPO_ROOT,
  });

  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Write a tree of files under a fresh temp directory.
 *
 * @param files map of repo-relative path to contents
 * @returns the temp root
 */
function writeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-frame-gate-"));

  createdRoots.push(root);

  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }

  return root;
}

/** A minimal valid frame type table. */
const TABLE = `export const FRAME_TYPES = {
  "bridge.ready": {
    ch: "control",
    coalescible: "never",
    since: "C5",
    summary: "renderer announces itself",
  },
  "bulk.page": {
    ch: "bulk",
    coalescible: "never",
    since: "C5",
    summary: "one page of a snapshot",
  },
} as const satisfies Record<string, FrameTypeSpec>;
`;

/**
 * The workspace directories every case needs.
 *
 * Both `packages/` and `apps/` must exist: the gate refuses to report PASS when
 * one is absent, because scanning nothing would otherwise look like passing.
 */
const EMPTY_PACKAGES = {
  "packages/core/src/index.ts": "export const core = 1;\n",
  "apps/desktop/src/index.ts": "export const desktop = 1;\n",
};

describe("check-frame: table presence", () => {
  it("reports a missing table instead of passing an unscanned repository", () => {
    const root = writeTree(EMPTY_PACKAGES);
    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("frame-table-missing");
    expect(run.output).toContain("FAIL");
  });

  it("reports an empty table instead of passing vacuously", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      "packages/protocol/src/frame/frame-types.ts":
        "export const FRAME_TYPES = {} as const satisfies Record<string, FrameTypeSpec>;\n",
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("frame-table-empty");
  });

  it("exits 2 when a scanned workspace directory is absent", () => {
    const root = writeTree({
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    // apps/ is missing, so the gate cannot honestly report "everything is
    // registered". Exit 2 (broken) rather than 0 (pass).
    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("apps/");
  });
});

describe("check-frame: registration", () => {
  it("passes when every literal in the repository is registered", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      "apps/desktop/src/send.ts":
        'export const frame = { v: 1, ch: "control", seq: 1, t: "bridge.ready", body: {} };\n',
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });

  it("reports a literal that is not in the table", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      // One transposed letter from the registered "bulk.page".
      "packages/core/src/send.ts":
        'export const frame = { ch: "bulk", seq: 2, t: "bulk.pgae", body: {} };\n',
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("frame-type-unregistered");
    expect(run.output).toContain("bulk.pgae");
    expect(run.output).toContain("send.ts:1");
  });

  it("reports an unregistered type written with the `type` key", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      "packages/core/src/send.ts":
        'export const frame = { ch: "stream", type: "term.ouput", body: {} };\n',
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("term.ouput");
  });

  it("skips test files, whose literals are inputs rather than wire claims", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      // A test deliberately feeds invalid values to the code under test. If
      // those had to be registered, the table would collect invented types,
      // including ones whose purpose is to be rejected.
      "packages/core/src/send.test.ts":
        'export const bad = { ch: "stream", t: "not-a-type", body: {} };\n' +
        'export const empty = { ch: "stream", t: "", body: {} };\n',
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });

  it("still catches the same literal one file over, outside the test suffix", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      "packages/core/src/send.test.ts":
        'export const bad = { ch: "stream", t: "not-a-type", body: {} };\n',
      "packages/core/src/send.ts":
        'export const frame = { ch: "stream", t: "not-a-type", body: {} };\n',
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    // The exemption is per file, not per directory: the test is skipped and its
    // neighbour in the same directory is still reported.
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("send.ts:");
    expect(run.output).not.toContain("send.test.ts");
  });

  it("ignores a computed frame type, which cannot be resolved statically", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      "packages/core/src/send.ts":
        'const name = "term.ouput";\nexport const frame = { ch: "stream", t: name, body: {} };\n',
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });
});

describe("check-frame: false positives", () => {
  it("ignores `t:` and `type:` properties that are not frame-shaped", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      // `t` is a common short name and `type` is everywhere. Neither object
      // carries a frame key (ch/v/seq/body), so neither is a frame type.
      "packages/core/src/i18n.ts":
        'export const message = { t: "greeting.hello", count: 2 };\n' +
        'export const token = { type: "refresh", expires: 3600 };\n',
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });

  it("ignores a frame-shaped object whose type is written in backticks", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      // A no-substitution template literal is still a literal value; only a
      // template WITH substitutions is unresolved.
      "packages/core/src/send.ts":
        "export const frame = { ch: `bulk`, v: 1, t: `bulk.page`, body: {} };\n",
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(0);
  });

  it("still reports a backtick literal that is not registered", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      // The registered case above passes whether or not template literals are
      // read at all, so it cannot tell "supports backticks" from "ignores the
      // line". An UNREGISTERED backtick literal can: it is only reported when
      // the branch really reads the value.
      "packages/core/src/send.ts":
        "export const frame = { ch: `bulk`, v: 1, t: `bulk.pgae`, body: {} };\n",
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("bulk.pgae");
  });
});

describe("check-frame: row requirements", () => {
  it("reports a row whose summary is missing", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      "packages/protocol/src/frame/frame-types.ts": `export const FRAME_TYPES = {
  "bridge.ready": { ch: "control", coalescible: "never", since: "C5" },
} as const satisfies Record<string, FrameTypeSpec>;
`,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("frame-summary");
    expect(run.output).toContain("bridge.ready");
  });
});

describe("check-frame: unreadable source is not clean source", () => {
  it("sees a frame literal written in a .tsx file", () => {
    // Parsing a .tsx file as .ts turns JSX into a syntax error. The recovered
    // tree drops the element, so a literal inside a JSX attribute used to be
    // invisible and the gate reported PASS. Every .tsx file in the repository
    // parsed with errors before this case existed.
    const root = writeTree({
      ...EMPTY_PACKAGES,
      "packages/ui/src/bridge/pane.tsx":
        "export function Pane(): unknown {\n" +
        '  return <div data-f={{ v: 1, ch: "stream", seq: 3, t: "typo.in.tsx", body: {} }} />;\n' +
        "}\n",
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("typo.in.tsx");
  });

  it("treats a spread frame type as unreadable instead of registered", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      // The channel arrives through the spread, so the old "must share an object
      // literal with ch/v/seq/body" rule classified the whole object as
      // unrelated and said nothing. A transposed letter reached the wire.
      "packages/core/src/send.ts":
        'const envelope = { ch: "stream", v: 1, seq: 3 };\n' +
        'export const frame = { t: "typo.in.spread", ...envelope };\n',
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("frame-type-unresolved");
    expect(run.output).toContain("typo.in.spread");
  });

  it("refuses a table assembled through a spread instead of reporting it empty", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      // Reporting "empty table" here would be a wrong diagnosis, and reporting
      // PASS would silently unregister every row. Exit 2 says "the gate cannot
      // read this", which is the only honest answer.
      "packages/protocol/src/frame/frame-types.ts": `const EXTRA = {
  "bulk.page": { ch: "bulk", coalescible: "never", since: "C5", summary: "one page" },
} as const;

export const FRAME_TYPES = {
  ...EXTRA,
  "bridge.ready": { ch: "control", coalescible: "never", since: "C5", summary: "ready" },
} as const satisfies Record<string, FrameTypeSpec>;
`,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("spreads");
  });

  it("does not report a summary it cannot read as a missing summary", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      // A shared constant is correct TypeScript. Saying "has no summary" would
      // block a legal refactor, so the two cases get different rule ids.
      "packages/protocol/src/frame/frame-types.ts": `const READY_SUMMARY = "renderer announces itself";

export const FRAME_TYPES = {
  "bridge.ready": { ch: "control", coalescible: "never", since: "C5", summary: READY_SUMMARY },
} as const satisfies Record<string, FrameTypeSpec>;
`,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("frame-summary-unresolved");
    expect(run.output).not.toContain("has no summary");
  });

  it("does not mistake a version stamp for a frame envelope", () => {
    const root = writeTree({
      ...EMPTY_PACKAGES,
      // `v` and `seq` are ordinary short keys. Keying on them flagged an SVG
      // theme descriptor and an onboarding step as unregistered frame types.
      "packages/core/src/theme.ts":
        'export const svg = { v: 2, t: "dark.high-contrast", label: "theme" };\n' +
        'export const step = { seq: 3, t: "onboarding.welcome", text: "hi" };\n',
      "packages/protocol/src/frame/frame-types.ts": TABLE,
    });

    const run = runGateAt(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });
});
