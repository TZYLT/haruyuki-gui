/**
 * Snapshot assembly tests.
 *
 * The locked facts are asserted against the real read-only engine mirror at
 * `_research/haruyuki` (v0.6.0 @ 1641a4f) plus the runtime
 * `packages/protocol/src/contract/capabilities.json`:
 *
 *   counts            115 / 124 / 136 / 124 / 0 / 14 / 12
 *   fieldLevel        whatever `detail: true` currently registers (table B keeps
 *                     growing in the same file, so the expectation is computed
 *                     from the file, never 39)
 *   file_ops          one command record with two directions and one message
 *   health            one coarse message line, not degraded, deduplicated
 *
 * Capability reads are guarded against a concurrent capabilities write: the suite builds
 * twice against the same file bytes and falls back to a frozen temp copy only if
 * the file changed mid-build. A missing mirror skips the engine-bound suites
 * instead of failing: the mirror is not committed and a clean clone must stay
 * green. The write-time guard rails and the ASCII discipline are
 * plain `describe` suites because they never read `_research`.
 *
 * The temp directory comes from `fs.mkdtemp(os.tmpdir())`; only the single file
 * this test creates is deleted, never the directory (discipline 03 section 1.1).
 * Nothing here spawns the engine, touches the network or writes into the repo.
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  SNAPSHOT_KEY_ORDER,
  SNAPSHOT_SCHEMA_VERSION,
  canonicalizeSnapshot,
  validateSnapshot,
} from "./contract/lib/schema.mjs";
import { buildSnapshot, readEngineVersion, writeSnapshot } from "./contract/snapshot.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = fileURLToPath(import.meta.url);
const SNAPSHOT_MODULE_FILE = path.join(REPO_ROOT, "scripts", "contract", "snapshot.mjs");
const ENGINE_ROOT = path.join(REPO_ROOT, "_research", "haruyuki");
const MINI_ENGINE = path.join(REPO_ROOT, "fixtures", "contract", "mini-engine");
const CAPABILITIES_PATH = path.join(
  REPO_ROOT,
  "packages",
  "protocol",
  "src",
  "contract",
  "capabilities.json",
);

const MISSING_CAPABILITIES_HINT =
  `capabilities table is missing at ${CAPABILITIES_PATH}. ` +
  "Snapshot assembly joins `fieldLevel` against it; restore the file from the repository.";

/** How often to retry a build pair while the capabilities table may be rewritten. */
const BUILD_ATTEMPTS = 4;

/** Delay between retries, in milliseconds. */
const RETRY_DELAY_MS = 50;

/** Code-unit comparison, matching the snapshot validator's ordering rule. */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Build one minimal, fully valid v1 snapshot without touching the engine mirror.
 *
 * Used by the write-time guard rails, which must run in a clean clone too.
 *
 * @returns {any}
 */
function makeMinimalSnapshot() {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    engine: {
      version: "0.0.1",
      commit: "unknown",
      source: "clone",
      extractedAt: "2026-11-13T12:00:00.000Z",
      extractor: "contract-snapshot@1",
    },
    counts: {
      unionMembers: 1,
      wireCommands: 1,
      messages: 1,
      inboundAccepted: 1,
      inboundOnly: 0,
      advertisedCommands: 0,
      dispatchCases: 0,
    },
    commands: [
      {
        wire: "agent_list",
        type: "AgentListCommand",
        home: "src/types/protocol_v2.ts:1608",
        direction: ["c2s"],
        inbound: true,
        fields: [],
        shapeFingerprint: "3f2a1c9d0e42",
        fieldLevel: false,
        health: "ok",
      },
    ],
    messages: [
      {
        wire: "stream_delta",
        type: "StreamDeltaMessage",
        home: "src/types/protocol_v2.ts:596",
        fields: [],
        shapeFingerprint: "9b1c2d3e4f50",
        fieldLevel: false,
        health: "ok",
      },
    ],
    special: {
      fileOps: { wire: "file_ops", directions: [] },
      remoteCommands: {
        advertised: [],
        handledElsewhere: {},
        unadvertisedAliases: {},
        dispatchCases: [],
      },
      startupText: { required: [], optional: [] },
    },
    health: { degraded: false, coarse: [], unparsed: [] },
  };
}

/**
 * Strip the one time-varying field so two builds can be byte-compared.
 *
 * @param {any} value snapshot object
 * @returns {string}
 */
function withoutTimestamp(value) {
  return JSON.stringify({ ...value, engine: { ...value.engine, extractedAt: "" } });
}

/**
 * Read the runtime capabilities bytes.
 *
 * @returns {string}
 */
function readCapabilitiesText() {
  return readFileSync(CAPABILITIES_PATH, "utf8");
}

/**
 * Read the runtime `detail: true` wire set from capabilities.json contents.
 *
 * @param {string} text capabilities.json contents
 * @returns {string[]} distinct detail wires, lexicographically sorted
 */
function parseDetailWires(text) {
  const parsed = JSON.parse(text);
  const entries = Array.isArray(parsed) ? parsed : parsed?.capabilities;

  if (!Array.isArray(entries)) {
    throw new Error(`capabilities.json has no capability array: ${CAPABILITIES_PATH}`);
  }

  const detailWires = entries
    .filter((entry) => entry && entry.detail === true && typeof entry.wire === "string")
    .map((entry) => entry.wire);

  return [...new Set(detailWires)].sort(compareStrings);
}

/**
 * Build the snapshot twice from identical capabilities bytes.
 *
 * The capabilities table is edited elsewhere and may gain table B at any moment;
 * an unstable read would make the determinism case flaky for a reason that is not
 * a snapshot-assembly defect.
 * The loop retries while the file text changes, then falls back to one frozen
 * copy so both builds share their input. The temp copy is removed as a single
 * file; the temp directory is left to the OS temp area.
 *
 * @returns {Promise<{first: any, second: any, capabilitiesText: string}>}
 */
async function buildStablePair() {
  for (let attempt = 0; attempt < BUILD_ATTEMPTS; attempt += 1) {
    const before = readCapabilitiesText();

    try {
      const first = buildSnapshot({ engineRoot: ENGINE_ROOT, capabilitiesPath: CAPABILITIES_PATH });
      const second = buildSnapshot({
        engineRoot: ENGINE_ROOT,
        capabilitiesPath: CAPABILITIES_PATH,
      });
      const after = readCapabilitiesText();

      if (before === after) {
        return { first, second, capabilitiesText: after };
      }
    } catch (error) {
      if (attempt === BUILD_ATTEMPTS - 1) {
        throw error;
      }
    }

    await delay(RETRY_DELAY_MS);
  }

  const frozenText = readCapabilitiesText();
  const directory = mkdtempSync(path.join(os.tmpdir(), "contract-snapshot-caps-"));
  const frozenPath = path.join(directory, "capabilities.json");

  writeFileSync(frozenPath, frozenText, "utf8");

  try {
    return {
      first: buildSnapshot({ engineRoot: ENGINE_ROOT, capabilitiesPath: frozenPath }),
      second: buildSnapshot({ engineRoot: ENGINE_ROOT, capabilitiesPath: frozenPath }),
      capabilitiesText: frozenText,
    };
  } finally {
    unlinkSync(frozenPath);
  }
}

/** @type {any} */
let snapshot;
/** @type {any} */
let secondSnapshot;
/** @type {string[]} */
let detailWires;

const ENGINE_AVAILABLE = existsSync(path.join(ENGINE_ROOT, "src", "types"));

/**
 * Engine-bound suites skip themselves in a clean clone: the pinned mirror is
 * not committed, and a clean-clone verify must stay green.
 */
const describeWithEngine = ENGINE_AVAILABLE ? describe : describe.skip;

beforeAll(async () => {
  if (!ENGINE_AVAILABLE) {
    return;
  }

  if (!existsSync(CAPABILITIES_PATH)) {
    throw new Error(MISSING_CAPABILITIES_HINT);
  }

  const built = await buildStablePair();

  snapshot = built.first;
  secondSnapshot = built.second;
  detailWires = parseDetailWires(built.capabilitiesText);
});

describeWithEngine("buildSnapshot: counts on the pinned engine source", () => {
  it("derives all seven counts from extraction data", () => {
    expect(snapshot.counts).toEqual({
      unionMembers: 115,
      wireCommands: 124,
      messages: 136,
      inboundAccepted: 124,
      inboundOnly: 0,
      advertisedCommands: 14,
      dispatchCases: 12,
    });
    expect(Object.keys(snapshot.counts)).toEqual([...SNAPSHOT_KEY_ORDER.counts]);
  });

  it("keeps counts equal to the arrays they describe", () => {
    // Hard-coded truth, not `counts.inboundAccepted - counts.inboundOnly`: the
    // old assertion compared two values derived from the same build, so it could
    // never go red (P5-6).
    expect(snapshot.counts.wireCommands).toBe(
      snapshot.commands.filter((command) => typeof command.wire === "string").length,
    );
    expect(snapshot.counts.messages).toBe(snapshot.messages.length);
    expect(snapshot.counts.inboundAccepted).toBe(124);
    expect(snapshot.counts.inboundOnly).toBe(0);
    expect(snapshot.commands.filter((command) => command.inbound)).toHaveLength(124);
    // wireOnly: a wire command the inbound guard chain does not accept.
    expect(snapshot.commands.filter((command) => !command.inbound)).toHaveLength(0);
    expect(snapshot.commands.every((command) => typeof command.wire === "string")).toBe(true);
  });

  it("pins engine provenance from the mirror", () => {
    expect(snapshot.engine).toMatchObject({
      version: "0.6.0",
      commit: "1641a4f",
      source: "clone",
      extractor: "contract-snapshot@1",
    });
    expect(Object.keys(snapshot.engine)).toEqual([...SNAPSHOT_KEY_ORDER.engine]);
    expect(snapshot.engine.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describeWithEngine("buildSnapshot: command records", () => {
  it("emits the frozen command key order and boolean joins", () => {
    for (const command of snapshot.commands) {
      expect(Object.keys(command)).toEqual([...SNAPSHOT_KEY_ORDER.command]);
      expect(typeof command.inbound).toBe("boolean");
      expect(typeof command.fieldLevel).toBe("boolean");
      expect(Array.isArray(command.fields)).toBe(true);
      expect(command.home).toMatch(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*:\d+$/);
    }
  });

  it("sorts commands by wire and keeps every wire unique", () => {
    const wires = snapshot.commands.map((command) => command.wire);

    expect(wires).toEqual([...wires].sort(compareStrings));
    expect(new Set(wires).size).toBe(wires.length);
  });

  it("joins the inbound accepted set into the command records", () => {
    expect(snapshot.commands.find((command) => command.wire === "file_ops").inbound).toBe(true);
  });

  it("clears fields for commands outside the detail set", () => {
    const fileOps = snapshot.commands.find((command) => command.wire === "file_ops");

    expect(fileOps.fieldLevel).toBe(false);
    expect(fileOps.fields).toEqual([]);

    const nonDetailed = snapshot.commands.filter((command) => !command.fieldLevel);

    expect(nonDetailed.length).toBeGreaterThan(0);

    for (const command of nonDetailed) {
      expect(command.fields).toEqual([]);
    }
  });

  it("matches fieldLevel to the runtime detail set", () => {
    const detailed = snapshot.commands.filter((command) => command.fieldLevel);
    const detailedWires = detailed.map((command) => command.wire);

    expect(detailedWires).toEqual(detailWires);
  });

  it("keeps fields for a detail wire whose interface declares them", () => {
    const agentList = snapshot.commands.find((command) => command.wire === "agent_list");

    expect(agentList.fieldLevel).toBe(true);
    expect(agentList.fields.length).toBeGreaterThan(0);
    expect(agentList.fields.map((field) => field.name)).toEqual(
      [...agentList.fields.map((field) => field.name)].sort(compareStrings),
    );
  });
});

describeWithEngine("buildSnapshot: message records", () => {
  it("emits the frozen message key order", () => {
    for (const message of snapshot.messages) {
      expect(Object.keys(message)).toEqual([...SNAPSHOT_KEY_ORDER.message]);
      expect(Array.isArray(message.fields)).toBe(true);
      expect(Object.hasOwn(message, "inbound")).toBe(false);
      expect(Object.hasOwn(message, "direction")).toBe(false);
    }
  });

  it("applies the same detail rule to messages", () => {
    const messageWires = new Set(snapshot.messages.map((message) => message.wire));
    const expected = detailWires.filter((wire) => messageWires.has(wire));
    const actual = snapshot.messages
      .filter((message) => message.fieldLevel)
      .map((message) => message.wire);

    expect(actual).toEqual(expected);

    for (const message of snapshot.messages.filter((item) => !item.fieldLevel)) {
      expect(message.fields).toEqual([]);
    }
  });

  it("sorts messages by wire and keeps every wire unique", () => {
    const wires = snapshot.messages.map((message) => message.wire);

    expect(wires).toEqual([...wires].sort(compareStrings));
    expect(new Set(wires).size).toBe(wires.length);
  });
});

describeWithEngine("buildSnapshot: special cases and health", () => {
  it("carries file_ops in both arrays with both directions", () => {
    const command = snapshot.commands.find((record) => record.wire === "file_ops");
    const message = snapshot.messages.find((record) => record.wire === "file_ops");

    expect(command.direction).toEqual(["c2s", "s2c"]);
    expect(message).toBeDefined();
    expect(snapshot.special.fileOps).toEqual({
      wire: "file_ops",
      directions: ["c2s", "s2c"],
    });
  });

  it("carries the four remote command facts", () => {
    const remote = snapshot.special.remoteCommands;

    expect(remote.advertised).toHaveLength(14);
    expect(Object.keys(remote.handledElsewhere)).toHaveLength(3);
    expect(Object.keys(remote.unadvertisedAliases)).toHaveLength(1);
    expect(remote.dispatchCases).toHaveLength(12);
    expect(remote.advertised).toEqual([...remote.advertised].sort(compareStrings));
    expect(remote.dispatchCases).toEqual([...remote.dispatchCases].sort(compareStrings));
    expect(Object.keys(remote.handledElsewhere)).toEqual(
      [...Object.keys(remote.handledElsewhere)].sort(compareStrings),
    );
  });

  it("carries the required and optional startup shapes", () => {
    const startup = snapshot.special.startupText;

    expect(startup.required).toHaveLength(2);
    expect(startup.optional).toContain("^OpenAI:");
    expect(startup.required).toEqual([...startup.required].sort(compareStrings));
  });

  it("merges and deduplicates extractor health", () => {
    expect(snapshot.health.degraded).toBe(false);
    expect(snapshot.health.unparsed).toEqual([]);
    expect(snapshot.health.coarse).toHaveLength(1);
    expect(snapshot.health.coarse[0]).toContain("LaunchSubagentResponse");
    expect(snapshot.health.coarse).toEqual([...new Set(snapshot.health.coarse)]);
    expect(snapshot.health.coarse).toEqual([...snapshot.health.coarse].sort(compareStrings));
  });
});

describeWithEngine("buildSnapshot: determinism and schema", () => {
  it("produces a snapshot with zero schema violations", () => {
    const result = validateSnapshot(snapshot);

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("restores canonical order after commands and messages are shuffled", () => {
    const shuffled = {
      ...snapshot,
      commands: [...snapshot.commands].reverse(),
      messages: [...snapshot.messages].reverse(),
    };
    const restored = canonicalizeSnapshot(shuffled);

    expect(restored.commands).toEqual(snapshot.commands);
    expect(restored.messages).toEqual(snapshot.messages);
    expect(validateSnapshot(restored).ok).toBe(true);
  });

  it("rejects fields smuggled onto a non-fieldLevel command", () => {
    const smuggled = canonicalizeSnapshot({
      ...snapshot,
      commands: snapshot.commands.map((command) =>
        command.fieldLevel
          ? command
          : { ...command, fields: [{ name: "x", type: "string", optional: false }] },
      ),
    });
    const rules = validateSnapshot(smuggled).violations.map((violation) => violation.rule);

    expect(rules).toContain("fields-without-field-level");
  });

  it("is byte-identical across two builds apart from extractedAt", () => {
    expect(withoutTimestamp(secondSnapshot)).toBe(withoutTimestamp(snapshot));
  });
});

describeWithEngine("buildSnapshot: disk round trip", () => {
  it("writes snapshot.json to a temp directory and reads it back valid", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "contract-snapshot-"));
    const target = path.join(directory, "snapshot.json");

    writeSnapshot(target, snapshot);

    try {
      const text = readFileSync(target, "utf8");
      const parsed = JSON.parse(text);
      const lines = text.trimEnd().split("\n");
      const recordLines = lines.filter((line) => line.startsWith("    {"));

      expect(text.endsWith("\n")).toBe(true);
      expect(lines.length).toBeLessThan(2000);
      expect(recordLines).toHaveLength(snapshot.commands.length + snapshot.messages.length);
      expect(parsed).toEqual(snapshot);
      expect(validateSnapshot(parsed).violations).toEqual([]);
    } finally {
      unlinkSync(target);
    }

    expect(existsSync(target)).toBe(false);
  });
});

describeWithEngine("buildSnapshot: explicit failures", () => {
  it("rejects a missing capabilities file", () => {
    const missing = path.join(path.dirname(CAPABILITIES_PATH), "capabilities.missing.json");

    expect(existsSync(missing)).toBe(false);
    expect(() => buildSnapshot({ engineRoot: ENGINE_ROOT, capabilitiesPath: missing })).toThrow(
      /capabilities file not found/i,
    );
  });

  it("reads the pinned engine version from the mirror manifest", () => {
    expect(readEngineVersion(ENGINE_ROOT)).toEqual({ version: "0.6.0", degraded: false });
  });
});

describe("buildSnapshot: failures that need no engine tree", () => {
  it("rejects a missing engine mirror instead of returning an empty snapshot", () => {
    const missing = path.join(os.tmpdir(), "contract-missing-engine-mirror");

    expect(existsSync(missing)).toBe(false);
    expect(() =>
      buildSnapshot({ engineRoot: missing, capabilitiesPath: CAPABILITIES_PATH }),
    ).toThrow(/engine type directory not found/i);
  });

  it("falls back to unknown plus degraded when the manifest is unreadable (A2-D14)", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "contract-engine-manifest-"));
    const manifest = path.join(directory, "package.json");

    writeFileSync(manifest, "{ not json", "utf8");

    try {
      expect(readEngineVersion(directory)).toEqual({ version: "unknown", degraded: true });
    } finally {
      unlinkSync(manifest);
    }

    expect(readEngineVersion(directory)).toEqual({ version: "unknown", degraded: true });
  });
});

/**
 * Read the `health` block of a `buildSnapshot` result.
 *
 * `buildSnapshot` is annotated `@returns {Record<string, unknown>}`, so every
 * field it returns is `unknown`. Narrowing the one block the tests read keeps
 * the assertions checked without an `as` cast.
 *
 * @param built value returned by `buildSnapshot`
 * @returns the health block, with `unparsed` coerced to strings
 */
function snapshotHealth(built: Record<string, unknown>): {
  degraded: boolean;
  unparsed: string[];
} {
  const health = built.health;

  if (typeof health !== "object" || health === null) {
    throw new Error(`buildSnapshot returned no health block: ${JSON.stringify(health)}`);
  }

  const degraded = "degraded" in health ? health.degraded : undefined;
  const unparsed = "unparsed" in health ? health.unparsed : undefined;

  if (typeof degraded !== "boolean" || !Array.isArray(unparsed)) {
    throw new Error(`buildSnapshot returned an unexpected health block: ${JSON.stringify(health)}`);
  }

  return { degraded, unparsed: unparsed.map((entry: unknown) => String(entry)) };
}

describe("writeSnapshot: refuses an invalid snapshot (P4-2)", () => {
  it("rejects a schema-incomplete snapshot", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "contract-snapshot-invalid-"));
    const target = path.join(directory, "snapshot.json");

    try {
      expect(() => writeSnapshot(target, { schemaVersion: 1 })).toThrow(/invalid snapshot/);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an illegal command element instead of silently dropping it", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "contract-snapshot-elements-"));
    const target = path.join(directory, "snapshot.json");
    // An illegal element is the point of this test, so the object is assembled
    // from scratch: `writeSnapshot` takes `unknown`, and a mutation here would
    // have to satisfy the command record type it is deliberately violating.
    const snapshotWithElement = { ...makeMinimalSnapshot(), commands: [42] };

    try {
      expect(() => writeSnapshot(target, snapshotWithElement)).toThrow(/invalid snapshot/);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("buildSnapshot: index parse diagnostics reach the snapshot (P4-6)", () => {
  it("degrades and records a syntax-broken type file instead of hiding it", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "contract-snapshot-broken-"));

    try {
      cpSync(MINI_ENGINE, directory, { recursive: true });
      writeFileSync(
        path.join(directory, "src", "types", "broken.ts"),
        "export interface Broken {\n",
        "utf8",
      );

      const built = buildSnapshot({
        engineRoot: directory,
        capabilitiesPath: CAPABILITIES_PATH,
      });
      const health = snapshotHealth(built);

      expect(health.degraded).toBe(true);
      expect(health.unparsed.join("\n")).toContain("src/types/broken.ts: parse-error:");
      expect(validateSnapshot(built).violations).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("contract-snapshot: ASCII discipline", () => {
  it("keeps the assembler and this test file pure ASCII", () => {
    for (const file of [SNAPSHOT_MODULE_FILE, TEST_FILE]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/[^\x00-\x7f]/);
    }
  });
});
