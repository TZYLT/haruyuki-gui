/**
 * Self-tests for `scripts/check-fixtures.mjs`.
 *
 * The real gate is spawned against small trees created in `os.tmpdir()`; nothing
 * is mocked and nothing is ever written below `fixtures/`. Each case asserts a
 * rule id, the exit code, and (where it matters) that the output names the
 * fixture by a repo-relative path - never by a machine-absolute one.
 *
 * Covered:
 *   - a clean corpus (allowed synthetic roots and request ids, frozen frames
 *     header without a `redaction` field);
 *   - one shape violation;
 *   - every redaction rule fired exactly once (path, user name, email, bearer
 *     token plus its 64-hex sibling, request id);
 *   - `r0` rejected below `fixtures/` and ignored under `_research/`;
 *   - the version drift as a warning on a green run;
 *   - `--root` isolation and the help / broken-configuration exit codes.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO_ROOT, "scripts", "check-fixtures.mjs");

/** The engine pair the contract snapshot pins at the time of writing. */
const PINNED = { version: "0.6.0", commit: "1641a4f" };

/** Contract snapshot that supplies the pin for `--root` trees. */
const PIN_FILE = "packages/protocol/src/contract/snapshot.json";

/** The name the gate must refuse to see in a corpus fixture. */
const LOCAL_NAME = localUserName();

/** Tracked temp roots, removed pointwise after every test. */
const createdRoots: string[] = [];

interface GateRun {
  status: number | null;
  output: string;
}

/**
 * Spawn the gate with an explicit `--root`.
 *
 * @param root tree to scan
 * @returns exit code plus combined stdout/stderr
 */
function runGate(root: string): GateRun {
  return runArgs(["--root", root]);
}

/**
 * @param args gate arguments
 * @returns exit code plus combined stdout/stderr
 */
function runArgs(args: string[]): GateRun {
  const result = spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8" });

  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * Write a tree of regular files below an existing directory.
 *
 * @param root absolute destination directory
 * @param files repo-relative path to file contents
 */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

/**
 * Create a fresh temp root and materialize files below it.
 *
 * @param files repo-relative path to file contents
 * @returns absolute temp root
 */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-fixtures-"));

  createdRoots.push(root);
  writeTree(root, files);

  return root;
}

/**
 * Remove a tree bottom-up with unlink/rmdir only (no recursive delete). Idempotent.
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
 * @returns the OS user name, or "" when the platform has none
 */
function localUserName(): string {
  try {
    return os.userInfo().username.trim();
  } catch {
    return "";
  }
}

/**
 * @param engine engine pair to pin
 * @returns the contract snapshot file
 */
function pinFiles(engine: Record<string, string> = PINNED): Record<string, string> {
  return { [PIN_FILE]: `${JSON.stringify({ schemaVersion: 1, engine })}\n` };
}

/**
 * @param overrides header fields to change
 * @returns one frozen wire header line
 */
function wireHeader(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "wire",
    schemaVersion: 1,
    engine: { ...PINNED },
    scenario: "self-test",
    redaction: "r1",
    clock: "virtual",
    recordedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

/**
 * @param overrides header fields to change
 * @returns one frozen frames header line (no `redaction` field)
 */
function framesHeader(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "frames",
    schemaVersion: 1,
    bridgeVersion: 1,
    clock: "virtual",
    note: "t vocabulary pending C5",
    ...overrides,
  });
}

/**
 * @param fields extra `msg` fields
 * @returns one s2c wire row
 */
function wireRow(fields: Record<string, unknown>): string {
  return JSON.stringify({ dir: "s2c", at: 0, msg: { type: "self_test_message", ...fields } });
}

/**
 * @param fields extra `msg` fields
 * @returns one c2s wire row
 */
function clientRow(fields: Record<string, unknown>): string {
  return JSON.stringify({ dir: "c2s", at: 0, msg: { type: "input", ...fields } });
}

/**
 * @param lines JSON lines, header first
 * @returns the file body with a trailing newline
 */
function jsonl(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

/**
 * @param files corpus-relative additions
 * @returns a one-recording corpus root
 */
function recordingTree(files: Record<string, string>): string {
  return makeTree({ ...pinFiles(), ...files });
}

/**
 * @param row the single message row
 * @param header wire header to use
 * @returns a corpus root whose only recording carries `row`
 */
function treeWithRow(row: string, header: string = wireHeader()): string {
  return recordingTree({ "fixtures/engine/recordings/case.jsonl": jsonl(header, row) });
}

/**
 * @param output combined gate output
 * @param rule rule id
 * @returns how many violation lines carry that rule
 */
function countRule(output: string, rule: string): number {
  return output.split(` ${rule} `).length - 1;
}

/**
 * @param value absolute path
 * @returns the path in both separators, for "must not leak" assertions
 */
function separators(value: string): string[] {
  return [value, value.replaceAll("\\", "/"), value.replaceAll("/", "\\")];
}

/**
 * A corpus that should pass every job: synthetic roots, synthetic request ids,
 * a frozen frames header and a matching engine pair.
 *
 * @returns temp corpus root
 */
function cleanCorpus(): string {
  return makeTree(cleanCorpusFiles());
}

/**
 * The files of the clean corpus, pin included, for tests that assemble a root
 * by hand.
 *
 * @returns clean corpus files
 */
function cleanCorpusFiles(): Record<string, string> {
  return {
    ...pinFiles(),
    "fixtures/engine/recordings/clean.jsonl": jsonl(
      wireHeader(),
      wireRow({ path: "/tmp/x/session/a", cwd: "C:/work/notes" }),
      clientRow({ request_id: "r-1" }),
      clientRow({ request_id: "req-2" }),
      clientRow({ request_id: "synthetic-perm-allow" }),
    ),
    "fixtures/bridge/ready.jsonl": jsonl(
      framesHeader(),
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 1,
        t: "bridge.ready",
        body: { appVersion: "0.1.0", bridgeVersion: 1 },
      }),
    ),
  };
}

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    removeTree(root);
  }
});

describe("fixture corpus shape", () => {
  it("passes a clean corpus and prints PASS only", () => {
    const root = cleanCorpus();
    const run = runGate(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(run.output).not.toContain("WARN");
    expect(run.output).not.toMatch(/ (?:schema-version|header-kind|wire-|frame-|redaction-)/);
    expect(/[^\x00-\x7F]/.test(run.output)).toBe(false);
  });

  it("reports a shape violation with its file and line", () => {
    const run = runGate(
      recordingTree({
        "fixtures/engine/recordings/bad.jsonl": jsonl(
          wireHeader({ schemaVersion: 2 }),
          wireRow({}),
        ),
      }),
    );

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("fixtures/engine/recordings/bad.jsonl:1 schema-version");
    expect(run.output).toContain("FAIL");
  });

  it("locates a broken message line, not the file", () => {
    const run = runGate(
      recordingTree({
        "fixtures/engine/recordings/bad.jsonl": jsonl(wireHeader(), "not json"),
      }),
    );

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("fixtures/engine/recordings/bad.jsonl:2 json ");
  });
});

describe("redaction rules", () => {
  const CONTENT_CASES: Array<{ rule: string; row: string }> = [
    { rule: "redaction-path", row: wireRow({ cwd: "D:/private/notes.txt" }) },
    { rule: "redaction-email", row: wireRow({ author: "alice@example.com" }) },
    { rule: "redaction-token", row: wireRow({ authorization: "Bearer abcdef0123456789" }) },
    { rule: "redaction-request-id", row: wireRow({ request_id: "msg-abc" }) },
  ];

  it.each(CONTENT_CASES)("$rule fires exactly once", ({ rule, row }) => {
    const run = runGate(treeWithRow(row));

    expect(run.status, run.output).toBe(1);
    expect(countRule(run.output, rule)).toBe(1);
  });

  it("treats a provider API key as a token", () => {
    const run = runGate(treeWithRow(wireRow({ key: "sk-" + "a1".repeat(16) })));

    expect(run.status, run.output).toBe(1);
    expect(countRule(run.output, "redaction-token")).toBe(1);
  });

  it("treats a 64-hex token as a token", () => {
    const run = runGate(treeWithRow(wireRow({ digest: "a".repeat(64) })));

    expect(run.status, run.output).toBe(1);
    expect(countRule(run.output, "redaction-token")).toBe(1);
  });

  it.skipIf(LOCAL_NAME.length < 2)("rejects the local user name", () => {
    const run = runGate(treeWithRow(wireRow({ owner: LOCAL_NAME })));

    expect(run.status, run.output).toBe(1);
    expect(countRule(run.output, "redaction-username")).toBe(1);
    // The gate log is public too: the name must not be echoed.
    expect(run.output).not.toContain(LOCAL_NAME);
  });

  it("rejects a device name other than the synthetic one", () => {
    // The engine echoes the machine name in `device_status.connection_name`
    // (records from 2026-11-14 carry it verbatim). A machine name says where a
    // recording was made, so the only accepted value is the placeholder.
    const run = runGate(
      treeWithRow(wireRow({ device_status: { connection_name: "DESKTOP-9F3KQ2" } })),
    );

    expect(run.status, run.output).toBe(1);
    expect(countRule(run.output, "redaction-host")).toBe(1);
    // The gate log is public too: the device name must not be echoed.
    expect(run.output).not.toContain("DESKTOP-9F3KQ2");
  });

  it("accepts the synthetic device name", () => {
    const run = runGate(
      treeWithRow(wireRow({ device_status: { connection_name: "synthetic-host" } })),
    );

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
  });

  it("accepts the synthetic roots and request ids", () => {
    const run = runGate(cleanCorpus());

    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain("redaction-");
  });

  it("rejects an r0 wire fixture in the corpus", () => {
    const run = runGate(treeWithRow(wireRow({}), wireHeader({ redaction: "r0" })));

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(":1 redaction-state ");
    expect(countRule(run.output, "redaction-state")).toBe(1);
  });

  it("rejects a wire fixture that declares no marker", () => {
    const run = runGate(treeWithRow(wireRow({}), wireHeader({ redaction: undefined })));

    expect(run.status, run.output).toBe(1);
    expect(countRule(run.output, "redaction-state")).toBe(1);
  });

  it("ignores an r0 recording under _research", () => {
    const root = makeTree({
      "_research/a3-probe/raw/session.jsonl": jsonl(
        wireHeader({ redaction: "r0" }),
        wireRow({ cwd: "D:/private/notes.txt" }),
      ),
    });
    const run = runGate(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(run.output).not.toContain("redaction-");
  });
});

describe("version alignment", () => {
  it("reports a drift as a warning and still exits 0", () => {
    const run = runGate(
      treeWithRow(wireRow({}), wireHeader({ engine: { version: "0.5.0", commit: "deadbee" } })),
    );

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(run.output).toContain("WARN fixtures/engine/recordings/case.jsonl:1 version-align ");
    expect(run.output).toContain("0.5.0");
    expect(run.output).toContain("0.6.0");
    expect(run.output.indexOf("WARN")).toBeLessThan(run.output.indexOf("PASS"));
  });

  it("prints no warning when the header matches the pin", () => {
    const run = runGate(cleanCorpus());

    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain("version-align");
  });

  it("fails as a broken configuration when a wire fixture has no pin", () => {
    const run = runGate(
      makeTree({ "fixtures/engine/recordings/orphan.jsonl": jsonl(wireHeader(), wireRow({})) }),
    );

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("ERROR");
    expect(run.output).toContain(PIN_FILE);
  });
});

describe("--root isolation", () => {
  it("reads only the tree it was given", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "haruyuki-fixtures-parent-"));

    createdRoots.push(parent);

    const root = path.join(parent, "tree");
    const sibling = path.join(parent, "outside");

    mkdirSync(root, { recursive: true });
    writeTree(root, cleanCorpusFiles());
    writeTree(sibling, {
      "fixtures/engine/recordings/leak.jsonl": jsonl(wireHeader(), wireRow({ cwd: "D:/private" })),
    });

    const run = runGate(root);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("PASS");
    expect(run.output).not.toContain("leak");
  });

  it("prints repo-relative paths, never the machine absolute root", () => {
    const root = treeWithRow(wireRow({ cwd: "D:/private/notes.txt" }));
    const run = runGate(root);

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("fixtures/engine/recordings/case.jsonl:2 ");

    for (const variant of separators(root)) {
      expect(run.output).not.toContain(variant);
    }
  });

  it("is byte-for-byte stable for the same input", () => {
    const root = treeWithRow(wireRow({ cwd: "D:/private/notes.txt" }));

    const first = runGate(root);
    const second = runGate(root);

    expect(second.status).toBe(first.status);
    expect(second.output).toBe(first.output);
  });

  it("exits 2 when --root does not exist", () => {
    const missing = path.join(os.tmpdir(), `haruyuki-fixtures-missing-${process.pid}`);

    expect(existsSync(missing)).toBe(false);

    const run = runGate(missing);

    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("ERROR");
  });

  it("prints usage and exits 0 for --help", () => {
    const run = runArgs(["--help"]);

    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("--root <dir>");
    expect(run.output).not.toContain("FAIL");
  });
});
