/**
 * Cross-check tests.
 *
 * The comparison runs against the real committed snapshot plus synthetic
 * `.d.ts` trees built in `fs.mkdtemp(os.tmpdir())`. Three real commands are
 * sampled from the snapshot:
 *
 *   agent_list   copied field for field -> no difference
 *   input        half the fields copied, one type changed, one field added
 *                -> one `field-diff` per added / removed / type-changed field
 *   file_ops     interface omitted -> `missing-in-dts` (and fieldLevel false,
 *                so a present-but-different interface must not produce a
 *                field diff; that is a separate case below)
 *
 * The `gitHead` cases pin the warning contract: a mismatch is one warning and still exit 0.
 * Broken input (missing directory, directory without `.d.ts`) is a structured
 * `{ok: false, code}` result with exit 2, never a thrown exception.
 *
 * Temp files are created with `mkdtemp` and deleted one by one in `afterAll`;
 * the temp directories themselves are left alone (discipline 03 section 1.1:
 * no recursive deletion).
 */
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { crossCheck, exitCodeFor, formatCrossCheck } from "./contract/cross-check.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  "packages",
  "protocol",
  "src",
  "contract",
  "snapshot.json",
);

const SNAPSHOT = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));

/** Every temp file this suite creates, deleted individually in `afterAll`. */
const createdFiles = [];

/**
 * Create a fresh temp directory for one fixture.
 *
 * @returns {string}
 */
function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "contract-cross-check-"));
}

/**
 * Write one fixture file and remember it for single-point deletion.
 *
 * @param {string} dir
 * @param {string} name
 * @param {string} text
 * @returns {string} absolute path
 */
function writeFixture(dir, name, text) {
  const file = path.join(dir, name);

  writeFileSync(file, text, "utf8");
  createdFiles.push(file);

  return file;
}

/**
 * Return one real snapshot command by wire id, failing loudly if the sample
 * command disappeared from the snapshot.
 *
 * @param {string} wire
 * @returns {any}
 */
function commandByWire(wire) {
  const command = SNAPSHOT.commands.find((candidate) => candidate.wire === wire);

  if (!command) {
    throw new Error(`snapshot sample command is missing: ${wire}`);
  }

  return command;
}

/**
 * Render one command interface from explicit fields.
 *
 * @param {string} name
 * @param {{name: string, type: string, optional?: boolean}[]} fields
 * @returns {string}
 */
function renderInterface(name, fields) {
  const lines = [`export interface ${name} {`];

  for (const field of fields) {
    lines.push(`  ${field.name}${field.optional ? "?" : ""}: ${field.type};`);
  }

  lines.push("}");

  return lines.join("\n");
}

/**
 * Render a real snapshot command, optionally transforming its fields.
 *
 * @param {any} command
 * @param {(fields: any[]) => any[]} [transform]
 * @returns {string}
 */
function renderCommand(command, transform = (fields) => fields) {
  const fields = transform(command.fields.map((field) => ({ ...field })));

  return renderInterface(command.type, fields);
}

/**
 * Build the main three-command fixture:
 *   - AgentListCommand exact
 *   - InputCommand with half its fields, one changed type and one extra field
 *   - FileOpsCommand omitted
 *   - unrelated helper declarations that the command rule must ignore
 *
 * @param {{gitHead?: string | null}} [options]
 * @returns {string} temp directory
 */
function makeMainFixture(options = {}) {
  const dir = makeTempDir();
  const agentList = commandByWire("agent_list");
  const input = commandByWire("input");

  const inputText = renderCommand(input, (fields) => {
    const kept = fields
      .filter((field) => field.name !== "runtime" && field.name !== "type")
      .map((field) => (field.name === "request_id" ? { ...field, type: "number" } : field));

    kept.push({ name: "extra_flag", type: "boolean", optional: false });

    return kept;
  });

  const dtsText = [
    renderCommand(agentList),
    inputText,
    "export interface Helper {\n  note: string;\n}",
    'export type AliasCommand = {\n  type: "alias_command";\n};',
    'export interface GhostCommand {\n  type: "ghost_command";\n  request_id: string;\n}',
  ].join("\n");

  writeFixture(dir, "protocol.d.ts", `${dtsText}\n`);

  if (options.gitHead !== null && options.gitHead !== undefined) {
    writeFixture(
      dir,
      "package.json",
      `${JSON.stringify({ name: "fixture-types", gitHead: options.gitHead }, null, 2)}\n`,
    );
  }

  return dir;
}

afterAll(() => {
  for (const file of createdFiles) {
    try {
      unlinkSync(file);
    } catch {
      // A file may already be gone; cleanup stays single-point and best effort.
    }
  }
});

describe("cross-check type layer", () => {
  it("classifies the sampled commands against the real snapshot", () => {
    const dtsDir = makeMainFixture({ gitHead: "deadbeef" });
    const result = crossCheck({ dtsDir, snapshot: SNAPSHOT });

    expect(result.ok).toBe(true);

    const differences = result.differences;

    // agent_list was copied exactly, so it contributes nothing.
    expect(differences.filter((difference) => difference.type === "AgentListCommand")).toEqual([]);

    // input: one added field, one changed type, two removed fields.
    const inputDiffs = differences.filter((difference) => difference.type === "InputCommand");

    expect(inputDiffs.map((difference) => [difference.field, difference.change])).toEqual([
      ["extra_flag", "added"],
      ["request_id", "type-changed"],
      ["runtime", "removed"],
      ["type", "removed"],
    ]);

    expect(inputDiffs.find((difference) => difference.field === "request_id")).toMatchObject({
      kind: "field-diff",
      type: "InputCommand",
      wire: "input",
      file: "protocol.d.ts",
      field: "request_id",
      change: "type-changed",
      snapshotType: "string",
      dtsType: "number",
    });
    expect(typeof inputDiffs.find((difference) => difference.field === "request_id").line).toBe(
      "number",
    );

    // file_ops has no interface in the fixture.
    expect(
      differences
        .filter((difference) => difference.type === "FileOpsCommand")
        .map((difference) => difference.kind),
    ).toEqual(["missing-in-dts"]);

    // Only the *Command interface is reported as unknown to the snapshot;
    // Helper and the AliasCommand type alias are ignored by the rule.
    expect(
      differences
        .filter((difference) => difference.kind === "missing-in-snapshot")
        .map((difference) => difference.type),
    ).toEqual(["GhostCommand"]);

    const ghost = differences.find((difference) => difference.type === "GhostCommand");

    expect(ghost).toMatchObject({
      kind: "missing-in-snapshot",
      type: "GhostCommand",
      file: "protocol.d.ts",
    });
    expect(typeof ghost.line).toBe("number");
    expect(differences.some((difference) => difference.type === "Helper")).toBe(false);
    expect(differences.some((difference) => difference.type === "AliasCommand")).toBe(false);
  });

  it("does not compare fields for fieldLevel false entries", () => {
    const dir = makeTempDir();

    writeFixture(
      dir,
      "protocol.d.ts",
      'export interface FileOpsCommand {\n  type: "file_ops";\n  unexpected: string;\n}\n',
    );

    const result = crossCheck({ dtsDir: dir, snapshot: SNAPSHOT });

    expect(result.ok).toBe(true);
    expect(result.differences.filter((difference) => difference.type === "FileOpsCommand")).toEqual(
      [],
    );
  });

  it("turns a gitHead mismatch into one warning and still exits 0", () => {
    const dtsDir = makeMainFixture({ gitHead: "deadbeef" });
    const result = crossCheck({ dtsDir, snapshot: SNAPSHOT });

    expect(result.ok).toBe(true);
    expect(result.gitHead).toBe("deadbeef");
    expect(result.warnings).toEqual([
      `gitHead mismatch: dts=deadbeef snapshot=${SNAPSHOT.engine.commit}`,
    ]);
    expect(result.differences.length).toBeGreaterThan(0);
    expect(exitCodeFor(result)).toBe(0);

    const reportLines = formatCrossCheck(result)
      .split("\n")
      .filter((line) => line !== "");

    expect(reportLines[0]).toContain("result=ok");
    expect(reportLines[1]).toBe(
      `warning: gitHead mismatch: dts=deadbeef snapshot=${SNAPSHOT.engine.commit}`,
    );
  });

  it("treats an absent package.json as gitHead null without a warning", () => {
    const dir = makeTempDir();

    writeFixture(dir, "protocol.d.ts", `${renderCommand(commandByWire("agent_list"))}\n`);

    const result = crossCheck({ dtsDir: dir, snapshot: SNAPSHOT });

    expect(result.ok).toBe(true);
    expect(result.gitHead).toBe(null);
    expect(result.warnings).toEqual([]);
    expect(exitCodeFor(result)).toBe(0);
  });

  it("returns code 2 for a directory without .d.ts files and does not throw", () => {
    const dir = makeTempDir();
    let result;

    expect(() => {
      result = crossCheck({ dtsDir: dir, snapshot: SNAPSHOT });
    }).not.toThrow();

    expect(result.ok).toBe(false);
    expect(result.code).toBe("dts-dir-empty");
    expect(result.differences).toEqual([]);
    expect(exitCodeFor(result)).toBe(2);
    expect(formatCrossCheck(result)).toContain("result=input-error code=dts-dir-empty");
  });

  it("returns code 2 for a missing directory and does not throw", () => {
    const missing = path.join(makeTempDir(), "missing");
    let result;

    expect(() => {
      result = crossCheck({ dtsDir: missing, snapshot: SNAPSHOT });
    }).not.toThrow();

    expect(result.ok).toBe(false);
    expect(result.code).toBe("dts-dir-missing");
    expect(exitCodeFor(result)).toBe(2);
  });

  it("is deterministic and its report is ASCII with one entry per line", () => {
    const dtsDir = makeMainFixture({ gitHead: "deadbeef" });
    const first = crossCheck({ dtsDir, snapshot: SNAPSHOT });
    const second = crossCheck({ dtsDir, snapshot: SNAPSHOT });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const report = formatCrossCheck(first);

    expect(formatCrossCheck(second)).toBe(report);

    for (const line of report.split("\n")) {
      if (line === "") {
        continue;
      }

      expect(line).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
