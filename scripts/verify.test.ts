/**
 * Aggregator self-tests: `scripts/verify.mjs` end to end, plus the pre-commit
 * rename case.
 *
 * The aggregator had zero coverage (P3-09), so these tests spawn the real
 * script against a disposable stub checkout instead of mocking it:
 *
 *   1. a stub tree (package.json, node_modules, stub gate scripts and stub
 *      gate self-test files) plus a fake `pnpm` on PATH, so a full run costs a
 *      handful of short child processes and never touches the real tree;
 *   2. default mode runs the seven segments in the documented order, and
 *      `--full` appends the three repository-discipline segments;
 *   3. P3-01: a missing `check-contract.mjs` is a loud exit 2 before the first
 *      segment runs, exactly like a missing `check-boundaries.mjs`;
 *   4. P3-03: the coverage note names the test segment by its real index
 *      (six), derived from the segment assembly instead of a stale literal;
 *   5. P3-07: the aggregator folds a non-ASCII working directory to ASCII;
 *   6. no fail-fast: one failing segment still runs every later segment and
 *      lands in the summary, exit 1;
 *   7. only the three contract exit codes 0/1/2 are ever produced;
 *   8. P3-02: a `git mv` plus edit (status `R`) reaches both eslint and
 *      prettier through the real `.githooks/pre-commit`.
 *
 * Everything written lives under one `fs.mkdtemp(os.tmpdir())` root; the
 * helper below removes it bottom-up without a recursive delete.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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

import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY = path.join(REPO_ROOT, "scripts", "verify.mjs");
const PRE_COMMIT = path.join(REPO_ROOT, ".githooks", "pre-commit");

/** Any byte outside 7-bit ASCII, the aggregator's output contract. */
const NON_ASCII = /[^\x00-\x7F]/;

/**
 * The segment scripts the aggregator must require before running anything.
 * A stale entry here makes the stub tree miss a file, which turns into a
 * visible "required file not found" failure rather than a silent pass.
 */
const SEGMENT_SCRIPTS = [
  "check-boundaries.mjs",
  "check-contract.mjs",
  "check-cycles.mjs",
  "check-file-size.mjs",
  "check-module-ownership.mjs",
];

/** Mirrors GATE_SELF_TEST_FILES in verify.mjs; see the note above. */
const GATE_SELF_TEST_FILES = [
  "boundaries-matrix.test.ts",
  "eslint-boundaries.test.ts",
  "cycles.test.ts",
  "file-size-ratchet.test.ts",
  "module-ownership.test.ts",
  "contract-gate.test.ts",
];

/** Default-mode segment labels, in the documented order. */
const DEFAULT_LABELS = [
  "typecheck",
  "lint",
  "boundaries",
  "gate self-test",
  "contract",
  "test",
  "coverage",
];

/** The three segments appended by --full. */
const FULL_LABELS = ["file size", "cycles", "module ownership"];

/** One stub gate script, written for every SEGMENT_SCRIPTS entry. */
const GATE_STUB = [
  'import { appendFileSync } from "node:fs";',
  'import { basename } from "node:path";',
  "",
  'const name = basename(process.argv[1] ?? "");',
  "const log = process.env.HARUYUKI_STUB_LOG;",
  "",
  "if (log) {",
  '  appendFileSync(log, "gate " + name + " " + process.argv.slice(2).join(" ") + "\\n");',
  "}",
  "",
  "// A failing segment still prints a payload the aggregator must replay.",
  'process.stdout.write("stub gate output: " + name + "\\n");',
  "",
  'const failing = (process.env.HARUYUKI_STUB_FAIL ?? "").split(",");',
  "process.exit(failing.includes(name) ? 1 : 0);",
  "",
].join("\n");

const createdRoots: string[] = [];

interface VerifyRun {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

interface StubTree {
  base: string;
  root: string;
  bin: string;
  logFile: string;
}

/**
 * Materialize a disposable checkout the aggregator accepts as a repository.
 *
 * @param options missing repo-relative posix paths, extra files to create, root directory name
 * @returns the temp base, the checkout root, the fake-pnpm bin dir and the log
 */
function makeStubTree(
  options: { missing?: string[]; extraFiles?: string[]; rootName?: string } = {},
): StubTree {
  const base = mkdtempSync(path.join(os.tmpdir(), "haruyuki-verify-"));
  const root = path.join(base, options.rootName ?? "checkout");
  const bin = path.join(base, "bin");
  const logFile = path.join(base, "calls.log");
  const missing = new Set(options.missing ?? []);

  createdRoots.push(base);

  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{ "name": "stub-tree", "private": true }\n');
  writeFileSync(path.join(root, "node_modules", ".keep"), "");

  for (const name of SEGMENT_SCRIPTS) {
    if (!missing.has(`scripts/${name}`)) {
      writeFileSync(path.join(root, "scripts", name), GATE_STUB);
    }
  }

  for (const name of GATE_SELF_TEST_FILES) {
    writeFileSync(path.join(root, "scripts", name), "");
  }

  for (const relative of options.extraFiles ?? []) {
    const absolute = path.join(root, relative);

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, "");
  }

  writeFakePnpm(bin);

  return { base, root, bin, logFile };
}

/**
 * Write the fake `pnpm`: it records its command line and exits with the status
 * the test asks for. Both a POSIX script and a Windows `.cmd` shim are written
 * so the same tree works on either platform.
 *
 * @param bin directory placed first on PATH
 */
function writeFakePnpm(bin: string): void {
  mkdirSync(bin, { recursive: true });

  const shim = path.join(bin, "pnpm");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      'printf \'pnpm %s\\n\' "$*" >> "$HARUYUKI_STUB_LOG"',
      'exit "${HARUYUKI_STUB_PNPM_STATUS:-0}"',
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);

  const cmd = path.join(bin, "pnpm.cmd");
  writeFileSync(
    cmd,
    [
      "@echo off",
      'echo pnpm %*>>"%HARUYUKI_STUB_LOG%"',
      "if defined HARUYUKI_STUB_PNPM_STATUS exit /b %HARUYUKI_STUB_PNPM_STATUS%",
      "exit /b 0",
      "",
    ].join("\r\n"),
  );
  chmodSync(cmd, 0o755);
}

/**
 * Prefix the fake-pnpm directory to PATH, preserving the platform's key case.
 *
 * @param bin directory to prepend
 * @returns a copy of the current environment
 */
function withFakePnpmPath(bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

  env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ""}`;

  return env;
}

/**
 * @param tree stub checkout
 * @param args aggregator arguments
 * @param extra additional environment variables
 * @returns exit code plus both streams
 */
function runVerify(tree: StubTree, args: string[] = [], extra: NodeJS.ProcessEnv = {}): VerifyRun {
  const result = spawnSync(process.execPath, [VERIFY, ...args], {
    cwd: tree.root,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...withFakePnpmPath(tree.bin),
      HARUYUKI_STUB_LOG: tree.logFile,
      ...extra,
    },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` };
}

/** Runs shared across tests so the suite stays well under the 10 s budget. */
const runs = new Map<string, VerifyRun>();

/**
 * @param key cache key
 * @param factory creates the run on first use
 * @returns the cached run
 */
function cachedRun(key: string, factory: () => VerifyRun): VerifyRun {
  const existing = runs.get(key);

  if (existing !== undefined) {
    return existing;
  }

  const run = factory();

  runs.set(key, run);

  return run;
}

/**
 * @param key cache key
 * @returns the cached run without creating it
 */
function peekRun(key: string): VerifyRun | undefined {
  return runs.get(key);
}

/**
 * Assert the bracket headings of `labels` appear in exactly this order.
 *
 * @param run aggregator run
 * @param labels expected labels, position `index + 1` of `total`
 * @param total segment count printed by the aggregator
 */
function expectHeadingsInOrder(run: VerifyRun, labels: string[], total: number): void {
  const positions = labels.map((label, index) => {
    const heading = `[${index + 1}/${total}] ${label}`;
    const position = run.output.indexOf(heading);

    expect(position, `missing heading "${heading}" in:\n${run.output}`).toBeGreaterThanOrEqual(0);

    return position;
  });

  expect(positions).toEqual([...positions].sort((left, right) => left - right));
}

/**
 * @param run aggregator run
 * @param message assertion message
 */
function expectAscii(run: VerifyRun, message: string): void {
  expect(NON_ASCII.test(run.output), `${message}\n${run.output}`).toBe(false);
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

afterAll(() => {
  for (const root of createdRoots.splice(0)) {
    removeTree(root);
  }
});

describe("verify aggregator: segment assembly", () => {
  it("runs the seven default segments in the documented order", () => {
    const tree = makeStubTree();
    const run = cachedRun("default", () => runVerify(tree));

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("verify: 7 segments, mode default");
    expectHeadingsInOrder(run, DEFAULT_LABELS, 7);

    // The gate scripts themselves ran in segment order, not just the printer.
    const gateLog = readFileSync(tree.logFile, "utf8");

    expect(gateLog.indexOf("check-boundaries.mjs")).toBeGreaterThanOrEqual(0);
    expect(gateLog.indexOf("check-contract.mjs")).toBeGreaterThan(
      gateLog.indexOf("check-boundaries.mjs"),
    );
    expect(run.output).toContain("[3/7] boundaries  PASS");
    expect(run.output).toContain("[5/7] contract  PASS");
  });

  it("appends the three --full segments in the documented order", () => {
    const tree = makeStubTree();
    const run = cachedRun("full", () => runVerify(tree, ["--full"]));

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("verify: 10 segments, mode full");
    expectHeadingsInOrder(run, [...DEFAULT_LABELS, ...FULL_LABELS], 10);
    expect(run.output).toContain("[10/10] module ownership  PASS");
  });

  it("names the test segment by its real index in the coverage notes (P3-03)", () => {
    cachedRun("default", () => runVerify(makeStubTree()));

    const run = peekRun("default");

    expect(run).toBeDefined();
    expect(run?.output).toContain("test verdicts belong to segment 6, not here");
    expect(run?.output).not.toContain("test verdicts belong to segment 5");
    expect(run?.output).toContain("[6/7] test  PASS");
  });
});

describe("verify aggregator: test discovery", () => {
  /**
   * Collect the test files the aggregator passed to vitest, in order.
   *
   * @param tree stub checkout
   * @param run aggregator run
   * @returns repo-relative test file paths handed to `vitest run`
   */
  function collectedTests(tree: StubTree, run: VerifyRun): string[] {
    expect(existsSync(tree.logFile), run.output).toBe(true);

    // Split on `\r?\n`: the Windows `.cmd` shim echoes its line ending as CRLF,
    // which would otherwise leave a trailing `\r` on the last token of every
    // line and silently drop exactly that one file from the assertion.
    return readFileSync(tree.logFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("pnpm exec vitest run "))
      .flatMap((line) => line.slice("pnpm exec vitest run ".length).trim().split(" "))
      .filter((token) => token.endsWith(".test.ts") || token.endsWith(".test.tsx"));
  }

  it("collects package tests as well as script tests (G2)", () => {
    // Green side of the pair: both files exist, both must reach vitest. Before
    // Previously the discovery only read `scripts/`, so a renderer test was written,
    // passed locally when run by path, and never ran in `verify`.
    const tree = makeStubTree({
      extraFiles: [
        "packages/ui/src/tokens/tokens.test.ts",
        "packages/ui/src/Button.test.tsx",
        // The stub tree only materializes the gate self-test set, so the two
        // pre-existing script tests have to be written explicitly for the
        // "nothing fell out of the set" half of the assertion.
        "scripts/verify.test.ts",
        "scripts/contract-diff.test.ts",
      ],
    });
    const run = runVerify(tree);
    const collected = collectedTests(tree, run);

    expect(run.status, run.output).toBe(0);
    expect(collected).toContain("packages/ui/src/tokens/tokens.test.ts");
    expect(collected).toContain("packages/ui/src/Button.test.tsx");
    // The pre-existing script tests must not fall out of the set while widening it.
    expect(collected).toContain("scripts/verify.test.ts");
    expect(collected).toContain("scripts/contract-diff.test.ts");
  });

  it("never collects a test file under fixtures, node_modules or docs", () => {
    // Red side of the pair: these paths look like tests but must stay out. The
    // fixture trees are deliberately broken, so collecting them would make
    // `verify` fail for reasons that have nothing to do with the product.
    const tree = makeStubTree({
      extraFiles: [
        "fixtures/i18n/red-bad-icu/Broken.test.ts",
        "node_modules/some-package/test/thing.test.ts",
        "docs/examples/sample.test.ts",
      ],
    });
    const run = runVerify(tree);
    const collected = collectedTests(tree, run);

    expect(run.status, run.output).toBe(0);
    expect(collected.some((file) => file.startsWith("fixtures/"))).toBe(false);
    expect(collected.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(collected.some((file) => file.startsWith("docs/"))).toBe(false);
  });

  it("does not collect a .test.tsx that is not under a discovered root", () => {
    const tree = makeStubTree({ extraFiles: ["apps/desktop/src/shell.test.tsx"] });

    expect(collectedTests(tree, runVerify(tree))).not.toContain("apps/desktop/src/shell.test.tsx");
  });
});

describe("verify aggregator: fail closed", () => {
  it("exits 2 before any segment when check-contract.mjs is missing (P3-01)", () => {
    // A non-ASCII working directory doubles as the P3-07 error-path assertion.
    const tree = makeStubTree({
      missing: ["scripts/check-contract.mjs"],
      rootName: "\u6d4b\u8bd5-checkout",
    });
    const run = cachedRun("missing", () => runVerify(tree));

    expect(run.status, run.output).toBe(2);
    expect(run.stderr).toContain("required file not found: scripts/check-contract.mjs");
    expect(run.stderr).toContain('needed by segment "contract"');
    expect(run.stdout).not.toContain("[1/7]");

    // No segment may have started: neither the gate stubs nor pnpm was called.
    expect(existsSync(tree.logFile)).toBe(false);
    expectAscii(run, "the missing-script error must stay ASCII");
  });

  it("exits 2 on an unknown argument before any segment", () => {
    const tree = makeStubTree();
    const run = cachedRun("unknown", () => runVerify(tree, ["--nope"]));

    expect(run.status, run.output).toBe(2);
    expect(run.stderr).toContain("unknown argument: --nope");
    expect(run.stdout).not.toContain("[1/7]");
    expect(existsSync(tree.logFile)).toBe(false);
  });

  it("requires the three --full-only scripts as well (ten segments) (P3-01)", () => {
    const tree = makeStubTree({ missing: ["scripts/check-cycles.mjs"] });
    const run = cachedRun("missing-full", () => runVerify(tree, ["--full"]));

    expect(run.status, run.output).toBe(2);
    expect(run.stderr).toContain("required file not found: scripts/check-cycles.mjs");
    expect(run.stderr).toContain('needed by segment "cycles"');
    expect(run.stdout).not.toContain("[1/10]");
  });

  it("produces only the three contract exit codes 0, 1 and 2", () => {
    const success = cachedRun("default", () => runVerify(makeStubTree()));
    const failure = cachedRun("failing", () =>
      runVerify(makeStubTree(), [], { HARUYUKI_STUB_FAIL: "check-boundaries.mjs" }),
    );
    const broken = cachedRun("unknown", () => runVerify(makeStubTree(), ["--nope"]));
    const codes = [success.status, failure.status, broken.status];

    expect(codes).toEqual([0, 1, 2]);

    for (const code of codes) {
      expect([0, 1, 2]).toContain(code);
    }
  });
});

describe("verify aggregator: behaviour", () => {
  it("keeps running after a failed segment and reports it in the summary", () => {
    const tree = makeStubTree();
    const run = cachedRun("failing", () =>
      runVerify(tree, [], { HARUYUKI_STUB_FAIL: "check-boundaries.mjs" }),
    );

    expect(run.status, run.output).toBe(1);
    expectHeadingsInOrder(run, DEFAULT_LABELS, 7);
    expect(run.output).toContain("[3/7] boundaries  FAIL");
    // Later segments still ran, including the one after the failure.
    expect(run.output).toContain("[5/7] contract  PASS");
    expect(run.output).toContain("[7/7] coverage  PASS");
    expect(run.output).toContain("verify: 1 of 7 segments FAILED");
    expect(run.output).toContain("FAILED: boundaries");
    // The failing segment's captured output is replayed as the debugging payload.
    expect(run.output).toContain("stub gate output: check-boundaries.mjs");
  });

  it("folds a non-ASCII working directory to ASCII in its own lines (P3-07)", () => {
    const tree = makeStubTree({ rootName: "\u9879\u76ee-checkout" });
    const run = cachedRun("non-ascii", () => runVerify(tree));

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("root ");
    expect(run.output).not.toContain("\u9879\u76ee");
    expectAscii(run, "the aggregator header must stay ASCII");
  });
});

const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

interface GitRun {
  status: number | null;
  output: string;
}

interface HookRepo {
  repo: string;
  logFile: string;
  env: NodeJS.ProcessEnv;
}

/**
 * @param cwd repository directory
 * @param args git arguments
 * @param env extra environment
 * @returns exit code plus combined output
 */
function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): GitRun {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, ...env },
  });

  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * Create a disposable git repository wired to the real `.githooks/pre-commit`,
 * with the file-size gate and `pnpm` stubbed so only the hook logic runs.
 *
 * @returns repository path, call log path and the hook environment
 */
function makeHookRepo(): HookRepo {
  const base = mkdtempSync(path.join(os.tmpdir(), "haruyuki-hook-"));
  const repo = path.join(base, "repo");
  const bin = path.join(base, "bin");
  const logFile = path.join(base, "calls.log");

  createdRoots.push(base);
  mkdirSync(path.join(repo, ".githooks"), { recursive: true });
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  copyFileSync(PRE_COMMIT, path.join(repo, ".githooks", "pre-commit"));
  chmodSync(path.join(repo, ".githooks", "pre-commit"), 0o755);
  writeFileSync(path.join(repo, "scripts", "check-file-size.mjs"), "process.exit(0);\n");
  writeFakePnpm(bin);

  expect(runGit(repo, ["init", "-q"]).status).toBe(0);
  expect(runGit(repo, ["config", "user.name", "verify-test"]).status).toBe(0);
  expect(runGit(repo, ["config", "user.email", "verify-test@example.invalid"]).status).toBe(0);
  expect(runGit(repo, ["config", "core.hooksPath", ".githooks"]).status).toBe(0);

  return { repo, logFile, env: { ...withFakePnpmPath(bin), HARUYUKI_STUB_LOG: logFile } };
}

describe.skipIf(!gitAvailable)("pre-commit hook", () => {
  it("lints and formats a renamed and edited file (status R) (P3-02)", () => {
    const hook = makeHookRepo();
    const repo = hook.repo;

    writeFileSync(path.join(repo, "old.ts"), "export const value = 1;\n");
    expect(runGit(repo, ["add", "-A"]).status).toBe(0);
    expect(runGit(repo, ["commit", "-q", "--no-verify", "-m", "initial"]).status).toBe(0);

    // Rename plus an edit: the staged status is `R`, not `A`, `C` or `M`.
    expect(runGit(repo, ["mv", "old.ts", "new.ts"]).status).toBe(0);
    writeFileSync(path.join(repo, "new.ts"), "export const value = 1;\nexport const extra = 2;\n");
    expect(runGit(repo, ["add", "new.ts"]).status).toBe(0);
    expect(runGit(repo, ["status", "--short"]).output).toContain("old.ts -> new.ts");

    const commit = runGit(repo, ["commit", "-q", "-m", "rename"], hook.env);

    expect(commit.status, commit.output).toBe(0);
    expect(commit.output).toContain("pre-commit: ok");

    const calls = readFileSync(hook.logFile, "utf8");

    expect(calls).toContain("eslint --no-warn-ignored new.ts");
    expect(calls).toContain("prettier --check new.ts");
  });

  it("skips a staged source path that is gone from the work tree (P3-02)", () => {
    const hook = makeHookRepo();
    const repo = hook.repo;

    writeFileSync(path.join(repo, "gone.ts"), "export const value = 1;\n");
    expect(runGit(repo, ["add", "gone.ts"]).status).toBe(0);
    unlinkSync(path.join(repo, "gone.ts"));

    const commit = runGit(repo, ["commit", "-q", "-m", "staged but deleted"], hook.env);

    expect(commit.status, commit.output).toBe(0);
    expect(commit.output).toContain("note: skipped 1 staged path(s) that are not present on disk");
    // Nothing to lint, so both staging steps are skipped instead of failing.
    expect(commit.output).toContain("1/3 eslint: skipped, no staged source file");
    expect(commit.output).toContain("3/3 prettier: skipped, no staged source file");
  });

  it("warns without failing when the staged file count exceeds the budget (P3-08)", () => {
    const hook = makeHookRepo();
    const repo = hook.repo;
    const files = Array.from({ length: 21 }, (_, index) => `file-${index}.ts`);

    for (const file of files) {
      writeFileSync(path.join(repo, file), "export const value = 1;\n");
    }

    expect(runGit(repo, ["add", ...files]).status).toBe(0);

    const commit = runGit(repo, ["commit", "-q", "-m", "over budget"], hook.env);

    expect(commit.status, commit.output).toBe(0);
    expect(commit.output).toContain("1/3 eslint: 21 staged file(s)");
    expect(commit.output).toContain("over the 20-file budget");
    expect(commit.output).toContain("pre-commit: ok");
  });
});
