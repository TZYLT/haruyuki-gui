/**
 * Gate self-test: `scripts/check-contract.mjs` end to end.
 *
 * The suite drives the real gate script as a child process against the fixture
 * trees under `fixtures/contract/`, so a broken gate cannot hide behind a unit
 * test of its own helpers:
 *
 *   1. `repos/green` passes, and the one `coarse` warning in its snapshot stays a
 *      warning - the trap `map.mjs` sets up (`severity: "warning"` must never turn
 *      `verify` red).
 *   2. Every `repos/red-*` fails with exit 1, one violation, the expected rule
 *      id, the expected file, and (for the stale artifact) the expected line.
 *      `repos/red-missing-truth` fails with exit 2, because a missing truth
 *      source is a broken gate, not a red repository.
 *   3. The mini engine is parseable by the committed extractors: `contract:update`
 *      produces a clean snapshot, and deleting a dispatch case / renaming the
 *      `WebSocket:` startup line in a temp copy shows up as a changed snapshot.
 *   4. `collectContractViolations` is exported for the Lead's `cli.mjs` reuse and
 *      does not run the gate when imported.
 *
 * Discipline: nothing is written into the repository. The mini-engine mutation
 * copies and every generated snapshot live under one `fs.mkdtemp(os.tmpdir())`
 * root, and this file never deletes recursively (route doc 08 section 5.1).
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { collectContractViolations } from "./check-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO_ROOT, "scripts", "check-contract.mjs");
const CLI = path.join(REPO_ROOT, "scripts", "contract", "cli.mjs");
const FIXTURES = path.join(REPO_ROOT, "fixtures", "contract");
const REPOS = path.join(FIXTURES, "repos");
const MINI_ENGINE = path.join(FIXTURES, "mini-engine");
const EXPECTED_COMMANDS = path.join(FIXTURES, "expected-commands.txt");

/** The three committed contract files, repo-relative posix paths. */
const CONTRACT_DIR = "packages/protocol/src/contract";
const SNAPSHOT_FILE = `${CONTRACT_DIR}/snapshot.json`;
const CAPABILITIES_FILE = `${CONTRACT_DIR}/capabilities.json`;
const MAP_FILE = `${CONTRACT_DIR}/command-map.generated.ts`;

/** One OS temp root for every artifact this suite creates. */
const TEMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "contract-gate-"));

interface CommandRun {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

/**
 * Absolute path of the file the gate reports for one artifact.
 *
 * @param root absolute scanned root
 * @param relative repo-relative posix path
 * @returns absolute path
 */
function contractFile(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

/**
 * Run one node script and capture both streams.
 *
 * @param script absolute script path
 * @param args script arguments
 * @param env child environment, defaults to this process's
 * @returns exit code plus both streams and their concatenation
 */
function runNode(script: string, args: string[], env: NodeJS.ProcessEnv = process.env): CommandRun {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` };
}

/**
 * Run the gate against one fixture root.
 *
 * @param root absolute root or repo-relative fixture path
 * @param extra arguments appended after `--root <dir>`
 * @returns the child process result
 */
function runGate(root: string, extra: string[] = []): CommandRun {
  return runNode(GATE, ["--root", root, ...extra]);
}

/**
 * @param name fixture directory name below `repos/`
 * @returns absolute fixture root
 */
function fixture(name: string): string {
  return path.join(REPOS, name);
}

/**
 * @param file absolute JSON file path
 * @returns parsed value
 */
function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Git directory of this checkout, derived without running git.
 *
 * `buildSnapshot` pins the engine commit with `git rev-parse --short HEAD` and
 * marks the snapshot degraded when that fails. A mutation copy under the OS temp
 * directory is outside the checkout, so those runs hand the extractor this
 * checkout's git directory through `GIT_DIR` - the commit read-back then
 * succeeds exactly as it does for the in-repo fixture engine.
 *
 * @returns absolute git directory path
 */
function currentGitDir(): string {
  const dotGit = path.join(REPO_ROOT, ".git");

  if (statSync(dotGit).isDirectory()) {
    return dotGit;
  }

  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
  const value = match?.[1]?.trim();

  if (value === undefined || value === "") {
    throw new Error(`cannot resolve the git directory from ${dotGit}`);
  }

  return path.resolve(REPO_ROOT, value);
}

/**
 * Non-comment, non-empty ids in `expected-commands.txt`.
 *
 * @returns wire command ids in file order
 */
function expectedCommandIds(): string[] {
  return readFileSync(EXPECTED_COMMANDS, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** @type {any} */
let cachedBaseline = null;

/**
 * Snapshot of the pristine mini engine, generated once for the comparison half.
 *
 * @returns generated snapshot object
 */
function baselineSnapshot(): any {
  if (cachedBaseline === null) {
    const out = path.join(TEMP_ROOT, "baseline.json");
    const run = runNode(CLI, ["update", "--engine", MINI_ENGINE, "--out", out]);

    expect(run.status).toBe(0);
    cachedBaseline = readJson(out);
  }

  return cachedBaseline;
}

/**
 * Copy the mini engine to a fresh temp tree (never mutate the repository copy).
 *
 * @param label short name used in the temp directory name
 * @returns absolute copy root
 */
function copyMiniEngine(label: string): string {
  const copy = path.join(mkdtempSync(path.join(os.tmpdir(), `contract-gate-${label}-`)), "engine");

  cpSync(MINI_ENGINE, copy, { recursive: true });

  return copy;
}

/**
 * Run `contract:update` against a temp engine copy.
 *
 * @param engineRoot temp engine root
 * @param outName file name below `TEMP_ROOT`
 * @returns child process result
 */
function updateCopy(engineRoot: string, outName: string): CommandRun {
  return runNode(CLI, ["update", "--engine", engineRoot, "--out", path.join(TEMP_ROOT, outName)], {
    ...process.env,
    GIT_DIR: currentGitDir(),
  });
}

/** Line where the hand-edited byte sits in the stale fixture artifact. */
const STALE_LINE =
  readFileSync(contractFile(fixture("red-stale"), MAP_FILE), "utf8")
    .split("\n")
    .findIndex((line) => line.includes("hand edited after generation")) + 1;

/** One fixture per rule, each expected to fail with exactly one violation. */
const RED_CASES = [
  {
    name: "red-map-missing",
    rule: "contract-map",
    code: "missing-capability",
    file: MAP_FILE,
  },
  {
    name: "red-map-duplicate",
    rule: "contract-map",
    code: "duplicate-name",
    file: CAPABILITIES_FILE,
  },
  {
    name: "red-map-fallback",
    rule: "contract-map",
    code: "dangling-fallback",
    file: CAPABILITIES_FILE,
  },
  {
    name: "red-map-wire",
    rule: "contract-map",
    code: "unknown-wire",
    file: CAPABILITIES_FILE,
  },
  {
    name: "red-map-since",
    rule: "contract-map",
    code: "since-ahead",
    file: CAPABILITIES_FILE,
  },
  {
    name: "red-map-pending",
    rule: "contract-map",
    code: "pending-without-proposal",
    file: CAPABILITIES_FILE,
  },
  {
    name: "red-stale",
    rule: "contract-stale",
    code: "stale-artifact",
    file: MAP_FILE,
  },
  {
    name: "red-cover",
    rule: "contract-cover",
    code: "fields-without-detail",
    file: CAPABILITIES_FILE,
  },
  {
    name: "red-degraded",
    rule: "contract-health",
    code: "degraded-snapshot",
    file: SNAPSHOT_FILE,
  },
] as const;

describe("check-contract.mjs: green fixture", () => {
  it("passes with exit 0 and no violation line", () => {
    const run = runGate(fixture("green"));

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("PASS\n");
    expect(run.stderr).toBe("");
  });

  it("keeps the snapshot coarse warning a warning, never a failure", () => {
    const snapshot = readJson(contractFile(fixture("green"), SNAPSHOT_FILE));

    expect(snapshot.health.coarse.length).toBeGreaterThan(0);

    const loud = runGate(fixture("green"), ["--verbose"]);

    expect(loud.status).toBe(0);
    expect(loud.stdout).toBe("PASS\n");
    expect(loud.stderr).toContain("1 warning(s)");
    expect(loud.stderr).toContain("warning: contract-health coarse-fields");
  });

  it("is byte-identical to the committed contract artifacts", () => {
    for (const relative of [SNAPSHOT_FILE, CAPABILITIES_FILE, MAP_FILE]) {
      const green = readFileSync(contractFile(fixture("green"), relative));
      const committed = readFileSync(contractFile(REPO_ROOT, relative));

      expect(green.equals(committed)).toBe(true);
    }
  });
});

describe("check-contract.mjs: red fixtures", () => {
  for (const entry of RED_CASES) {
    it(`${entry.name} fails with ${entry.rule} ${entry.code}`, () => {
      const run = runGate(fixture(entry.name));

      expect(run.status).toBe(1);
      expect(run.output).toContain(` ${entry.rule} `);
      expect(run.output).toContain(`${entry.code}:`);
      expect(run.output).toContain(entry.file);
      // One fixture changes exactly one thing, so a single violation is the
      // proof that the red case is single-caused rather than a pile-up.
      expect(run.output).toContain("FAIL: 1 violation(s)");
    });
  }

  it("points the stale artifact at the hand-edited line", () => {
    const run = runGate(fixture("red-stale"));

    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`${MAP_FILE}:${STALE_LINE} contract-stale`);
  });

  it("exits 2 when a truth source is missing", () => {
    const run = runGate(fixture("red-missing-truth"));

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("ERROR:");
    expect(run.stderr).toContain(SNAPSHOT_FILE);
  });

  it("fails with contract-stale when the generated artifact is missing", () => {
    const root = path.join(
      mkdtempSync(path.join(os.tmpdir(), "contract-gate-missing-artifact-")),
      "repo",
    );

    cpSync(fixture("green"), root, { recursive: true });
    unlinkSync(contractFile(root, MAP_FILE));

    const run = runGate(root);

    expect(run.status).toBe(1);
    expect(run.output).toContain("contract-stale missing-artifact:");
    expect(run.output).toContain(MAP_FILE);
    expect(run.output).toContain("FAIL: 1 violation(s)");
  });

  it("exits 2 for a bad --root instead of reporting PASS", () => {
    const run = runGate(path.join(REPOS, "does-not-exist"));

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("ERROR:");
  });

  it("passes on this repository with no arguments", () => {
    const run = runNode(GATE, []);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("PASS\n");
  });
});

describe("fixtures/contract: pinned checklist and fixture shape", () => {
  it("pins 124 sorted, unique, ASCII wire ids", () => {
    const ids = expectedCommandIds();
    const text = readFileSync(EXPECTED_COMMANDS, "utf8");

    expect(ids).toHaveLength(124);
    expect(new Set(ids).size).toBe(124);
    expect(ids).toEqual([...ids].sort());

    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
    }

    expect(text.split("\n").every((line) => /^[\x20-\x7e]*$/.test(line))).toBe(true);
  });

  it("matches the wire set of the committed snapshot exactly", () => {
    const snapshot = readJson(contractFile(REPO_ROOT, SNAPSHOT_FILE));
    const wires = snapshot.commands.map((command: any) => command.wire);

    expect(expectedCommandIds()).toEqual(wires);
  });
});

describe("fixtures/contract/mini-engine: extractor compatibility", () => {
  it("updates to a clean snapshot with the expected counts and shapes", () => {
    const snapshot = baselineSnapshot();

    expect(snapshot.health).toEqual({ degraded: false, coarse: [], unparsed: [] });
    expect(snapshot.counts).toEqual({
      unionMembers: 3,
      wireCommands: 4,
      messages: 2,
      inboundAccepted: 3,
      inboundOnly: 0,
      advertisedCommands: 3,
      dispatchCases: 3,
    });
    expect(snapshot.commands.map((command: any) => command.wire)).toEqual([
      "agent_cancel",
      "agent_list",
      "file_ops",
      "queue_resume",
    ]);

    const fileOps = snapshot.commands.find((command: any) => command.wire === "file_ops");

    expect(fileOps.direction).toEqual(["c2s", "s2c"]);
    expect(snapshot.special.fileOps.directions).toEqual(["c2s", "s2c"]);
    expect(snapshot.special.remoteCommands.dispatchCases).toEqual(["clear", "compact", "status"]);
    expect(snapshot.special.startupText.required).toEqual([
      "^Listening on (ws://\\S+)$",
      "^WebSocket:\\s+(ws://\\S+)$",
    ]);
    expect(snapshot.special.startupText.optional).toEqual(["^OpenAI:"]);
  });

  it("detects a deleted dispatch case in a temp engine copy", () => {
    const copy = copyMiniEngine("dispatch");
    const file = path.join(copy, "src", "websocket", "listener", "commands.ts");
    const original = readFileSync(file, "utf8");
    const mutated = original.replace('    case "compact":\n      return "compact:ok";\n', "");

    expect(mutated).not.toBe(original);
    writeFileSync(file, mutated, "utf8");

    const run = updateCopy(copy, "mutated-dispatch.json");

    expect(run.status).toBe(0);

    const snapshot = readJson(path.join(TEMP_ROOT, "mutated-dispatch.json"));
    const baseline = baselineSnapshot();

    expect(snapshot.counts.dispatchCases).toBe(2);
    expect(snapshot.special.remoteCommands.dispatchCases).toEqual(["clear", "status"]);
    expect(
      baseline.special.remoteCommands.dispatchCases.filter(
        (id: string) => !snapshot.special.remoteCommands.dispatchCases.includes(id),
      ),
    ).toEqual(["compact"]);
  });

  it("detects a changed WebSocket startup line in a temp engine copy", () => {
    const copy = copyMiniEngine("startup");
    const file = path.join(copy, "src", "cli", "subcommands", "app-server.ts");
    const original = readFileSync(file, "utf8");

    expect(original).toContain("WebSocket:");
    writeFileSync(file, original.replace("WebSocket:", "WS:"), "utf8");

    const run = updateCopy(copy, "mutated-startup.json");

    expect(run.status).toBe(0);

    const snapshot = readJson(path.join(TEMP_ROOT, "mutated-startup.json"));
    const baseline = baselineSnapshot();

    expect(snapshot.special.startupText.required).toContain("^WS:\\s+(ws://\\S+)$");
    expect(snapshot.special.startupText.required).not.toEqual(
      baseline.special.startupText.required,
    );
    expect(baseline.special.startupText.required).toContain("^WebSocket:\\s+(ws://\\S+)$");
  });
});

describe("check-contract.mjs: reusable collector", () => {
  it("returns no violation for the green fixture without spawning the gate", () => {
    expect(collectContractViolations({ root: fixture("green") })).toEqual([]);
  });

  it("returns the same gate-shaped violation the CLI prints", () => {
    const violations = collectContractViolations({ root: fixture("red-map-duplicate") });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      file: CAPABILITIES_FILE,
      rule: "contract-map",
      message: expect.stringContaining("duplicate-name"),
    });
    expect(violations[0].line).toBeUndefined();
  });

  it("lifts the stale artifact line into the violation", () => {
    const violations = collectContractViolations({ root: fixture("red-stale") });

    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe(MAP_FILE);
    expect(violations[0].line).toBe(STALE_LINE);
  });
});
