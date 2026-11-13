/**
 * Diff and report tests.
 *
 * Two kinds of input are exercised on purpose:
 *
 *   - the committed baseline `packages/protocol/src/contract/snapshot.json`
 *     (v0.6.0 @ 1641a4f) for the self-diff, real wire changes and the real
 *     `capabilities.json` reverse lookup;
 *   - small synthetic snapshots for the four change classes (added,
 *     removed, suspected rename, field optionality), so each class is asserted
 *     in isolation and a fixture does not depend on engine extraction.
 *
 * Layout assertions pin the seven-section order, ASCII-only lines, one entry
 * per line and `(none)` for empty sections. Bad input asserts exit code 2 both
 * through `main()` and through a real `node scripts/contract/diff.mjs` spawn.
 * Determinism renders the same pair twice and compares bytes.
 *
 * Two suites cover review findings P5-1 and P5-2. P5-1: an `inbound` flag that
 * leaves the accepted set while the wire stays in the union, and a counts-only
 * drift, must both reach section 5 and `summary.total` (the value
 * `check --engine` gates on), while the `diff` CLI stays in report mode. P5-2:
 * the inbound extractor degrades when the OR chain no longer holds a
 * `is<Name>(argument)` call, and records a non-identifier guard argument as
 * `health.coarse` instead of dropping it.
 *
 * Temp files use `fs.mkdtemp(os.tmpdir())`; each created file is unlinked
 * individually and the directory is left to the OS (discipline 03 section 1.1).
 * The P5-2 fixtures are single-file engine trees in that same temp directory.
 * Nothing here writes into the repository, touches the network or runs an
 * extractor against the real engine.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DiffInputError, diffSnapshots, main, runDiff } from "./contract/diff.mjs";
import { extractInboundSet } from "./contract/lib/inbound.mjs";
import { SECTION_TITLES, renderReport } from "./contract/report.mjs";
import { defined, first } from "./lib/test-assert.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  "packages",
  "protocol",
  "src",
  "contract",
  "snapshot.json",
);
const CAPABILITIES_PATH = path.join(
  REPO_ROOT,
  "packages",
  "protocol",
  "src",
  "contract",
  "capabilities.json",
);
const DIFF_CLI = path.join(REPO_ROOT, "scripts", "contract", "diff.mjs");

const ZERO_SUMMARY = {
  added: 0,
  removed: 0,
  suspectedRenames: 0,
  fieldChanges: 0,
  parityChanges: 0,
  capabilityImpacts: 0,
  actions: 0,
  total: 0,
};

type Snapshot = Record<string, any>;
type Capability = { name: string; wire: string; detail?: boolean; legacy?: boolean };

let baseline: Snapshot;
let capabilities: Capability[];
let tempDirectory: string;
const createdFiles: string[] = [];

beforeAll(() => {
  baseline = readJson(SNAPSHOT_PATH) as Snapshot;
  capabilities = (readJson(CAPABILITIES_PATH) as { capabilities: Capability[] }).capabilities;
  tempDirectory = mkdtempSync(path.join(os.tmpdir(), "contract-diff-"));
});

afterAll(() => {
  for (const file of createdFiles) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }
});

/** Read and parse one JSON file. */
function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** Deep clone a JSON value. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Write a JSON fixture to the shared temp directory and track it for cleanup. */
function writeTemp(name: string, value: unknown): string {
  const filePath = path.join(tempDirectory, name);
  writeFileSync(filePath, JSON.stringify(value), "utf8");
  createdFiles.push(filePath);

  return filePath;
}

/** Build one command record with the snapshot v1 shape. */
function command(wire: string, type: string, options: Record<string, any> = {}) {
  return {
    wire,
    type,
    home: options.home ?? "src/types/protocol_v2.ts:1",
    direction: options.direction ?? ["c2s"],
    inbound: options.inbound ?? true,
    fields: options.fields ?? [],
    shapeFingerprint: options.shapeFingerprint ?? "000000000001",
    fieldLevel: options.fieldLevel ?? true,
    health: "ok",
  };
}

/** Build one message record with the snapshot v1 shape. */
function message(wire: string, type: string, options: Record<string, any> = {}) {
  return {
    wire,
    type,
    home: options.home ?? "src/types/protocol_v2.ts:1",
    fields: options.fields ?? [],
    shapeFingerprint: options.shapeFingerprint ?? "000000000002",
    fieldLevel: options.fieldLevel ?? false,
    health: "ok",
  };
}

/** Build one field record. */
function field(name: string, type: string, optional = false) {
  return { name, type, optional };
}

/** Build a complete v1 snapshot around the supplied commands/messages/special. */
function snapshot(options: Record<string, any> = {}): Snapshot {
  const commands = options.commands ?? [];
  const messages = options.messages ?? [];
  const advertised = options.advertised ?? ["clear"];
  const dispatchCases = options.dispatchCases ?? ["clear"];
  const required = options.required ?? ["^Listening on (ws://\\S+)$"];
  const optional = options.optional ?? ["^OpenAI:"];

  return {
    schemaVersion: 1,
    engine: {
      version: "0.6.0",
      commit: "1641a4f",
      source: "clone",
      extractedAt: "2026-11-13T00:00:00.000Z",
      extractor: "contract-snapshot@1",
    },
    counts: {
      unionMembers: commands.length,
      wireCommands: commands.length,
      messages: messages.length,
      inboundAccepted: commands.filter((record: Snapshot) => record.inbound === true).length,
      inboundOnly: 0,
      advertisedCommands: advertised.length,
      dispatchCases: dispatchCases.length,
    },
    commands,
    messages,
    special: {
      fileOps: options.fileOps ?? { wire: "file_ops", directions: ["c2s", "s2c"] },
      remoteCommands: {
        advertised,
        handledElsewhere: options.handledElsewhere ?? {},
        unadvertisedAliases: options.unadvertisedAliases ?? {},
        dispatchCases,
      },
      startupText: { required, optional },
    },
    health: { degraded: false, coarse: [], unparsed: [] },
  };
}

/** Run the pure diff against the real capability table. */
function diff(left: Snapshot, right: Snapshot) {
  return diffSnapshots(left, right, { capabilities });
}

/** Render a diff result and return its lines. */
function report(left: Snapshot, right: Snapshot): string[] {
  return renderReport(diff(left, right));
}

/** Return the entries of one report section (empty lines skipped). */
function sectionOf(lines: string[], title: string): string[] {
  const start = lines.indexOf(title);

  if (start === -1) {
    return [];
  }

  const entries: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (SECTION_TITLES.includes(line)) {
      break;
    }

    if (line.length > 0) {
      entries.push(line);
    }
  }

  return entries;
}

/**
 * Read one of the seven report section titles.
 *
 * `SECTION_TITLES` comes from the gate as a plain `readonly string[]`, so
 * `noUncheckedIndexedAccess` types `sectionTitle(2)` as `string | undefined`
 * and `sectionOf(lines, sectionTitle(2))` would not compile - even though the
 * report always emits all seven sections.
 *
 * @param position zero-based section position, 0-6
 * @returns the title at that position
 */
function sectionTitle(position: number): string {
  return defined(SECTION_TITLES[position], `SECTION_TITLES[${position}]`);
}

/** Find the baseline command record with this wire. */
function baselineCommand(wire: string): Snapshot {
  const record = baseline.commands.find((entry: Snapshot) => entry.wire === wire);

  expect(record, `baseline command ${wire} is missing`).toBeDefined();

  return record;
}

describe("self diff against the committed baseline", () => {
  it("reports all seven counts as zero", () => {
    const { result, lines } = runDiff({
      a: SNAPSHOT_PATH,
      b: SNAPSHOT_PATH,
      capabilities,
    });

    expect(result.summary).toEqual(ZERO_SUMMARY);

    for (const title of SECTION_TITLES) {
      expect(sectionOf(lines, title)).toEqual(["(none)"]);
    }
  });

  it("is zero for the pure function too and ignores engine.extractedAt", () => {
    const changedClock = clone(baseline);

    changedClock.engine.extractedAt = "2030-01-01T00:00:00.000Z";

    expect(diff(baseline, changedClock).summary).toEqual(ZERO_SUMMARY);
  });
});

describe("change classes on small synthetic snapshots", () => {
  const left = snapshot({
    commands: [
      command("alpha", "AlphaCommand", {
        shapeFingerprint: "aaaaaaaaaaaa",
        fields: [field("value", "string", false)],
      }),
      command("beta", "BetaCommand", {
        shapeFingerprint: "bbbbbbbbbbbb",
        fields: [field("flag", "boolean", false)],
      }),
      command("gamma", "GammaCommand", {
        shapeFingerprint: "cccccccccccc",
        fields: [field("x", "number", false)],
      }),
    ],
    messages: [message("event_one", "EventOneMessage", { shapeFingerprint: "dddddddddddd" })],
  });
  const right = snapshot({
    commands: [
      command("alpha_renamed", "AlphaRenamedCommand", {
        shapeFingerprint: "aaaaaaaaaaaa",
        fields: [field("value", "string", false)],
      }),
      command("beta", "BetaCommand", {
        shapeFingerprint: "bbbbbbbbbbbb",
        fields: [field("flag", "boolean", true)],
      }),
      command("delta", "DeltaCommand", {
        shapeFingerprint: "eeeeeeeeeeee",
        fields: [field("y", "string", false)],
      }),
    ],
    messages: [message("event_one", "EventOneMessage", { shapeFingerprint: "dddddddddddd" })],
  });

  it("classifies one added, one removed, one suspected rename and one field flip", () => {
    const result = diff(left, right);

    expect(result.added.commands.map((record: Snapshot) => record.wire)).toContain("delta");
    expect(result.removed.commands.map((record: Snapshot) => record.wire)).toContain("gamma");
    expect(result.suspectedRenames).toHaveLength(1);
    expect(result.suspectedRenames[0]).toMatchObject({
      kind: "command",
      from: { wire: "alpha" },
      to: { wire: "alpha_renamed" },
      shapeFingerprint: "aaaaaaaaaaaa",
    });
    expect(result.fieldChanges).toHaveLength(1);
    expect(result.fieldChanges[0]).toMatchObject({
      kind: "command",
      wire: "beta",
      change: "optionality-changed",
      field: "flag",
      fromOptional: false,
      toOptional: true,
    });
  });

  it("words the rename as a suspicion and keeps the wire facts in sections 1 and 2", () => {
    const lines = report(left, right);
    const renameEntries = sectionOf(lines, sectionTitle(2));

    expect(renameEntries).toHaveLength(1);
    expect(renameEntries[0]).toContain("suspected rename");
    expect(renameEntries[0]).toContain("not a confirmed rename");
    expect(sectionOf(lines, sectionTitle(0)).join("\n")).toContain("delta");
    expect(sectionOf(lines, sectionTitle(1)).join("\n")).toContain("gamma");
  });

  it("does not pair an ambiguous fingerprint", () => {
    const ambiguousLeft = snapshot({
      commands: [
        command("first", "FirstCommand", { shapeFingerprint: "ffffffffffff" }),
        command("second", "SecondCommand", { shapeFingerprint: "ffffffffffff" }),
      ],
    });
    const ambiguousRight = snapshot({
      commands: [command("third", "ThirdCommand", { shapeFingerprint: "ffffffffffff" })],
    });

    expect(diff(ambiguousLeft, ambiguousRight).suspectedRenames).toEqual([]);
  });
});

describe("field changes against the committed baseline", () => {
  it("reports an optionality flip on a detail wire", () => {
    const changed = clone(baseline);
    const record = changed.commands.find((entry: Snapshot) => entry.wire === "agent_list");
    const requestId = record.fields.find((entry: Snapshot) => entry.name === "request_id");

    requestId.optional = true;

    const result = diff(baseline, changed);
    const lines = report(baseline, changed);

    expect(result.fieldChanges).toHaveLength(1);
    expect(result.fieldChanges[0]).toMatchObject({
      kind: "command",
      wire: "agent_list",
      change: "optionality-changed",
      field: "request_id",
      fromOptional: false,
      toOptional: true,
    });
    expect(sectionOf(lines, sectionTitle(3))[0]).toContain("optionality-changed");
  });

  it("reports a type change", () => {
    const changed = clone(baseline);
    const record = changed.commands.find((entry: Snapshot) => entry.wire === "agent_list");
    const requestId = record.fields.find((entry: Snapshot) => entry.name === "request_id");

    requestId.type = "number";

    expect(diff(baseline, changed).fieldChanges[0]).toMatchObject({
      wire: "agent_list",
      change: "type-changed",
      field: "request_id",
      fromType: "string",
      toType: "number",
    });
  });

  it("emits field-text-changed when only the field fingerprint moved", () => {
    const changed = clone(baseline);
    const record = changed.commands.find((entry: Snapshot) => entry.wire === "agent_list");
    const requestId = record.fields.find((entry: Snapshot) => entry.name === "request_id");

    requestId.nested = true;

    const result = diff(baseline, changed);
    const lines = report(baseline, changed);

    expect(result.fieldChanges).toHaveLength(1);
    expect(first(result.fieldChanges, "diff.fieldChanges").change).toBe("field-text-changed");
    expect(sectionOf(lines, sectionTitle(3))[0]).toContain("field-text-changed");
  });

  it("ignores wires that are not field-level", () => {
    const changed = clone(baseline);
    const record = changed.commands.find((entry: Snapshot) => entry.wire === "file_ops");

    expect(record.fieldLevel).toBe(false);
    record.fields = [field("extra", "string", false)];

    expect(diff(baseline, changed).fieldChanges).toEqual([]);
  });

  it("turns a detail registration flip into an action, not a field change", () => {
    const changed = clone(baseline);
    const record = changed.commands.find((entry: Snapshot) => entry.wire === "agent_list");

    record.fieldLevel = false;

    const result = diff(baseline, changed);

    expect(result.fieldChanges).toEqual([]);
    expect(result.actions.map((action: Snapshot) => action.text).join("\n")).toContain(
      "detail registration for wire agent_list",
    );
  });
});

describe("parity changes", () => {
  it("reports an advertised list change", () => {
    const changed = clone(baseline);
    const advertised = changed.special.remoteCommands.advertised.filter(
      (entry: string) => entry !== "clear",
    );

    advertised.push("new-broadcast");
    changed.special.remoteCommands.advertised = advertised;

    const result = diff(baseline, changed);
    const lines = report(baseline, changed);

    expect(result.parityChanges).toContainEqual({
      area: "remoteCommands.advertised",
      change: "removed",
      key: "clear",
    });
    expect(result.parityChanges).toContainEqual({
      area: "remoteCommands.advertised",
      change: "added",
      key: "new-broadcast",
    });
    expect(sectionOf(lines, sectionTitle(4)).join("\n")).toContain(
      "remoteCommands.advertised added new-broadcast",
    );
  });

  it("reports a startupText.required change", () => {
    const changed = clone(baseline);
    const required = [...changed.special.startupText.required];

    required[0] = "^Listening on (ws://\\S+)$ ";

    changed.special.startupText.required = required;

    const result = diff(baseline, changed);

    expect(result.parityChanges).toContainEqual({
      area: "startupText.required",
      change: "removed",
      key: "^Listening on (ws://\\S+)$",
    });
    expect(result.parityChanges).toContainEqual({
      area: "startupText.required",
      change: "added",
      key: "^Listening on (ws://\\S+)$ ",
    });
  });
});

describe("inbound flag and counts drift (P5-1)", () => {
  const base = snapshot({
    commands: [
      command("alpha", "AlphaCommand", { shapeFingerprint: "aaaaaaaaaaaa" }),
      command("beta", "BetaCommand", { shapeFingerprint: "bbbbbbbbbbbb" }),
    ],
  });

  it("reports a wire that leaves the accepted set but stays in the union", () => {
    const drifted = clone(base);
    const beta = drifted.commands.find((entry: Snapshot) => entry.wire === "beta");

    beta.inbound = false;
    drifted.counts.inboundAccepted = 1;

    const result = diff(base, drifted);
    const parity = sectionOf(report(base, drifted), sectionTitle(4)).join("\n");

    expect(result.added.commands).toEqual([]);
    expect(result.removed.commands).toEqual([]);
    expect(result.parityChanges).toContainEqual({
      area: "inbound.accepted",
      change: "lost",
      key: "beta",
    });
    expect(result.parityChanges).toContainEqual({
      area: "counts.inbound",
      change: "changed",
      from: 2,
      to: 1,
    });
    expect(result.summary.total).toBeGreaterThan(0);
    expect(parity).toContain("inbound.accepted lost beta");
    expect(parity).toContain("counts.inbound changed from=2 to=1");
  });

  it("restores to a zero summary when the guard is put back", () => {
    expect(diff(base, clone(base)).summary).toEqual(ZERO_SUMMARY);
  });

  it("reports a counts-only drift that no record section can see", () => {
    const drifted = clone(base);

    drifted.counts.inboundAccepted = 1;

    const result = diff(base, drifted);

    expect(result.added.commands).toEqual([]);
    expect(result.removed.commands).toEqual([]);
    expect(result.parityChanges).toEqual([
      { area: "counts.inbound", change: "changed", from: 2, to: 1 },
    ]);
    expect(result.summary.total).toBeGreaterThan(0);
  });

  it("makes an inboundOnly difference readable", () => {
    const drifted = clone(base);

    drifted.counts.inboundOnly = 1;

    const result = diff(base, drifted);
    const parity = sectionOf(report(base, drifted), sectionTitle(4)).join("\n");

    expect(result.parityChanges).toContainEqual({
      area: "counts.inboundOnly",
      change: "changed",
      from: 0,
      to: 1,
    });
    expect(parity).toContain("counts.inboundOnly changed from=0 to=1");
    expect(result.summary.total).toBeGreaterThan(0);
  });

  it("keeps the independent diff CLI in report mode for counts drift", () => {
    const drifted = clone(base);

    drifted.counts.inboundAccepted = 1;

    const leftPath = writeTemp("p5-1-left.json", base);
    const rightPath = writeTemp("p5-1-right.json", drifted);
    const outPath = path.join(tempDirectory, "p5-1-report.txt");

    createdFiles.push(outPath);
    expect(main([leftPath, rightPath, "--out", outPath])).toBe(0);
    expect(readFileSync(outPath, "utf8")).toContain("counts.inbound changed from=2 to=1");
  });
});

describe("inbound extraction degradation (P5-2)", () => {
  const INDEX = {
    resolveTypeRef(ref: string) {
      const wires: Record<string, string> = { AlphaCommand: "alpha", BetaCommand: "beta" };
      const wire = wires[ref];

      return wire === undefined
        ? { ok: false, code: "type-not-found", message: `no type ${ref}` }
        : {
            ok: true,
            entry: { name: ref, typeLiteral: wire, file: "src/types/protocol.ts", line: 1 },
          };
    },
  };

  /** Materialize one single-file engine tree for the inbound extractor seam. */
  function inboundTree(name: string, body: string): string {
    const root = path.join(tempDirectory, name);
    const directory = path.join(root, "src", "websocket", "listener");
    const filePath = path.join(directory, "protocol-inbound.ts");

    mkdirSync(directory, { recursive: true });
    writeFileSync(filePath, body, "utf8");
    createdFiles.push(filePath);

    return root;
  }

  const REWRITTEN_CHAIN = `export function parseServerMessage(parsed: unknown): unknown {
  const guards = [isAlphaCommand, isBetaCommand];
  return guards.some((guard) => guard(parsed)) ? parsed : null;
}`;

  const PROPERTY_ARGUMENT_CHAIN = `export function parseServerMessage(parsed: any): unknown {
  if (isAlphaCommand(parsed.value)) {
    return parsed;
  }
  if (isBetaCommand(parsed.value)) {
    return parsed;
  }
  return null;
}`;

  const MIXED_CHAIN = `export function parseServerMessage(parsed: any): unknown {
  if (isAlphaCommand(parsed)) {
    return parsed;
  }
  if (isBetaCommand(parsed.value)) {
    return parsed;
  }
  return null;
}`;

  it("degrades when the OR chain holds no guard call any more", () => {
    const root = inboundTree("p5-2-rewritten", REWRITTEN_CHAIN);
    const { inbound, health } = extractInboundSet(INDEX, root, "src/types/protocol.ts");

    expect(inbound.guardCount).toBe(0);
    expect(inbound.accepted).toEqual([]);
    expect(health.degraded).toBe(true);
    expect(health.unparsed.join(" ")).toContain("inbound-chain-empty");
  });

  it("records a non-identifier guard argument as coarse instead of dropping it", () => {
    const root = inboundTree("p5-2-property", PROPERTY_ARGUMENT_CHAIN);
    const { inbound, health } = extractInboundSet(INDEX, root, "src/types/protocol.ts");

    expect(inbound.accepted).toEqual([]);
    expect(health.degraded).toBe(true);
    expect(health.coarse).toHaveLength(2);
    expect(health.coarse[0]).toMatchObject({
      file: "src/websocket/listener/protocol-inbound.ts",
      symbol: "isAlphaCommand",
      reason: "guard-argument-is-not-a-bare-identifier",
    });
  });

  it("keeps a partially coarse chain usable and visible", () => {
    const root = inboundTree("p5-2-mixed", MIXED_CHAIN);
    const { inbound, health } = extractInboundSet(INDEX, root, "src/types/protocol.ts");

    expect(inbound.guardCount).toBe(1);
    expect(inbound.accepted).toEqual(["alpha"]);
    expect(health.degraded).toBe(false);
    expect(health.coarse).toHaveLength(1);
  });
});

describe("capability impact", () => {
  it("hits real capability entries and separates detail from non-detail", () => {
    expect(capabilities.find((entry) => entry.name === "agent.list")?.wire).toBe("agent_list");
    expect(capabilities.find((entry) => entry.name === "file.ops")?.wire).toBe("file_ops");

    const changed = clone(baseline);

    changed.commands = changed.commands.filter(
      (entry: Snapshot) => entry.wire !== "agent_list" && entry.wire !== "file_ops",
    );

    const result = diff(baseline, changed);
    const lines = report(baseline, changed);
    const impacts = result.capabilityImpacts;

    expect(impacts).toContainEqual(
      expect.objectContaining({
        wire: "agent_list",
        capability: "agent.list",
        detail: true,
        status: "breaking",
      }),
    );
    expect(impacts).toContainEqual(
      expect.objectContaining({
        wire: "file_ops",
        capability: "file.ops",
        detail: false,
        status: "breaking",
      }),
    );
    expect(sectionOf(lines, sectionTitle(5)).join("\n")).toContain(
      "capability agent.list detail=yes status=breaking",
    );
    expect(sectionOf(lines, sectionTitle(5)).join("\n")).toContain(
      "capability file.ops detail=no status=breaking",
    );
  });

  it("does not list an added wire that no capability registers", () => {
    const left = snapshot({ commands: [command("known", "KnownCommand")] });
    const right = snapshot({
      commands: [command("known", "KnownCommand"), command("unknown_new", "UnknownNewCommand")],
    });

    expect(diff(left, right).capabilityImpacts).toEqual([]);
  });
});

describe("report layout", () => {
  it("prints the seven sections in the frozen order", () => {
    const lines = report(baseline, baseline);
    const positions = SECTION_TITLES.map((title) => lines.indexOf(title));

    expect(lines[0]).toBe("CONTRACT SNAPSHOT DIFF");

    for (const position of positions) {
      expect(position).toBeGreaterThan(0);
    }

    for (let index = 1; index < positions.length; index += 1) {
      const previous = defined(positions[index - 1], `positions[${index - 1}]`);

      expect(positions[index]).toBeGreaterThan(previous);
    }
  });

  it("prints (none) for every empty section and no stray blanks inside entries", () => {
    const lines = report(baseline, baseline);
    const noneCount = lines.filter((line) => line === "(none)").length;

    expect(noneCount).toBe(SECTION_TITLES.length);

    for (const line of lines) {
      expect(line).not.toContain("\n");
    }
  });

  it("keeps every line ASCII and free of Chinese", () => {
    const changed = clone(baseline);
    const lines = report(baseline, changed);

    for (const line of lines) {
      expect(line).toMatch(/^[\x20-\x7E]*$/);
      expect(line).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

describe("broken input and exit codes", () => {
  it("rejects a missing file with DiffInputError file-not-found", () => {
    let error: unknown;

    try {
      runDiff({ a: path.join(tempDirectory, "missing.json") });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DiffInputError);
    expect((error as InstanceType<typeof DiffInputError>).code).toBe("file-not-found");
  });

  it("returns 2 for a missing file", () => {
    expect(main([path.join(tempDirectory, "missing.json")])).toBe(2);
  });

  it("returns 2 for invalid JSON", () => {
    const filePath = path.join(tempDirectory, "broken.json");

    writeFileSync(filePath, "{ not json", "utf8");
    createdFiles.push(filePath);

    expect(main([filePath])).toBe(2);
  });

  it("returns 2 for an unknown schemaVersion", () => {
    const filePath = writeTemp("schema-v2.json", { ...snapshot(), schemaVersion: 2 });

    expect(main([filePath])).toBe(2);
  });

  it("returns 0 in report mode even when the report has changes", () => {
    const changed = clone(baseline);

    changed.commands = changed.commands.filter((entry: Snapshot) => entry.wire !== "agent_list");

    const changedPath = writeTemp("changed.json", changed);
    const outPath = path.join(tempDirectory, "report.txt");

    createdFiles.push(outPath);
    expect(main([SNAPSHOT_PATH, changedPath, "--out", outPath])).toBe(0);

    const text = readFileSync(outPath, "utf8");

    expect(text).toContain("CONTRACT SNAPSHOT DIFF");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("exits 2 from the real CLI when the input is broken", () => {
    const run = spawnSync(process.execPath, [DIFF_CLI, path.join(tempDirectory, "missing.json")], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("not found");
  });
});

describe("determinism", () => {
  it("renders the same pair twice byte for byte", () => {
    const changed = clone(baseline);
    const record = changed.commands.find((entry: Snapshot) => entry.wire === "agent_list");

    record.fields[0].optional = true;

    const first = runDiff({ a: baseline, b: changed, capabilities });
    const second = runDiff({ a: baseline, b: changed, capabilities });

    expect(second.lines).toEqual(first.lines);
    expect(`${second.lines.join("\n")}\n`).toBe(`${first.lines.join("\n")}\n`);
  });

  it("writes identical bytes through --out twice", () => {
    const changed = clone(baseline);
    const changedPath = writeTemp("determinism.json", changed);
    const firstPath = path.join(tempDirectory, "report-a.txt");
    const secondPath = path.join(tempDirectory, "report-b.txt");

    createdFiles.push(firstPath, secondPath);

    expect(main([SNAPSHOT_PATH, changedPath, "--out", firstPath])).toBe(0);
    expect(main([SNAPSHOT_PATH, changedPath, "--out", secondPath])).toBe(0);
    expect(readFileSync(secondPath)).toEqual(readFileSync(firstPath));
  });
});
