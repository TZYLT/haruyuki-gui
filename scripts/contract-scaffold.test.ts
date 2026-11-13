/**
 * Type-index seam tests: AST scan and type index, shape/field fingerprints, the
 * snapshot v1 schema validator and the CLI dispatcher skeleton.
 *
 * The scanner tests run against the real read-only engine mirror at
 * `_research/haruyuki` (v0.6.0 @ 1641a4f) because the union member counts are
 * locked facts, not fixture choices: `WsProtocolCommand` has 115 members and
 * `WsProtocolMessage` has 127. A missing mirror is a hard failure with a clear
 * message; silently skipping would let the seam rot until the capability table starts.
 *
 * Nothing here spawns the real engine, touches the network or writes to the
 * repository. The only child process is the local CLI skeleton.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  FINGERPRINT_LENGTH,
  fieldFingerprint,
  normalizeBodyText,
  shapeFingerprint,
} from "./contract/lib/fingerprint.mjs";
import {
  SNAPSHOT_KEY_ORDER,
  SNAPSHOT_SCHEMA_VERSION,
  canonicalizeSnapshot,
  validateSnapshot,
} from "./contract/lib/schema.mjs";
import { FAILURE_CODES, createTypeIndex, listTypeFiles } from "./contract/lib/scan.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_ROOT = path.join(REPO_ROOT, "_research", "haruyuki");
const PROTOCOL_V2 = "src/types/protocol_v2.ts";
const COMMAND_UNION = "WsProtocolCommand";
const MESSAGE_UNION = "WsProtocolMessage";

const MISSING_MIRROR_HINT =
  `engine mirror is missing at ${ENGINE_ROOT}. ` +
  "type reads the pinned engine source: create the read-only mirror with " +
  "`git clone --shared <main checkout>/_research/haruyuki _research/haruyuki` " +
  "and check out commit 1641a4f (v0.6.0).";

/** @type {ReturnType<typeof createTypeIndex>} */
let index;

beforeAll(() => {
  if (!existsSync(path.join(ENGINE_ROOT, "src", "types"))) {
    throw new Error(MISSING_MIRROR_HINT);
  }

  index = createTypeIndex(ENGINE_ROOT);
});

describe("scan.mjs: union indexing on the pinned engine source", () => {
  it("indexes every file under src/types", () => {
    expect(index.stats.files).toBe(42);
    expect(listTypeFiles(ENGINE_ROOT)).toHaveLength(42);
    expect(index.files).toContain(PROTOCOL_V2);
  });

  it("reads 115 members from WsProtocolCommand", () => {
    const union = index.resolveUnion(COMMAND_UNION, PROTOCOL_V2);

    expect(union.ok, JSON.stringify(union)).toBe(true);
    expect(union.members).toHaveLength(115);

    const unresolved = union.members.filter((/** @type {object} */ member) => !member.ok);

    expect(unresolved, JSON.stringify(unresolved)).toHaveLength(0);
  });

  it("reads 127 members from WsProtocolMessage", () => {
    const union = index.resolveUnion(MESSAGE_UNION, PROTOCOL_V2);

    expect(union.ok, JSON.stringify(union)).toBe(true);
    expect(union.members).toHaveLength(127);

    const refs = union.members.map((/** @type {object} */ member) => member.ref);

    expect(refs).toContain('import("./queue-update-protocol").ResumeQueueResponseMessage');
    expect(refs).toContain("EmbeddingProtocol.EmbeddingStatusResponseMessage");

    const unresolved = union.members.filter((/** @type {object} */ member) => !member.ok);

    expect(unresolved, JSON.stringify(unresolved)).toHaveLength(0);
  });

  it("sees all three member forms in the command union", () => {
    const union = index.resolveUnion(COMMAND_UNION, PROTOCOL_V2);
    const refs = union.members.map((/** @type {object} */ member) => member.ref);

    expect(refs).toContain("AgentListCommand");
    expect(refs).toContain("CwdProtocol.SetBootWorkingDirectoryCommand");
    expect(refs).toContain('import("./queue-update-protocol").ResumeQueueCommand');
    expect(refs.some((/** @type {string} */ ref) => ref.startsWith("EmbeddingProtocol."))).toBe(
      true,
    );
  });
});

describe("scan.mjs: resolving one type reference", () => {
  it("resolves a bare identifier to file, line, literal, fields and body", () => {
    const result = index.resolveTypeRef("AgentListCommand", PROTOCOL_V2);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.how).toBe("local");
    expect(result.entry.file).toBe(PROTOCOL_V2);
    expect(result.entry.line).toBe(1608);
    expect(result.entry.typeLiteral).toBe("agent_list");
    expect(result.entry.fields.length).toBeGreaterThan(0);
    expect(result.entry.fields.map((/** @type {object} */ field) => field.name)).toContain(
      "request_id",
    );
    expect(result.entry.bodyText).toContain("request_id");
  });

  it("resolves a namespace member through its namespace import", () => {
    const result = index.resolveTypeRef("EmbeddingProtocol.EmbeddingStatusCommand", PROTOCOL_V2);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.how).toBe("namespace-import");
    expect(result.entry.file).toBe("src/types/embedding-protocol.ts");
    expect(result.entry.typeLiteral).toBe("embedding_status");
  });

  it("resolves an import-type member through its relative module", () => {
    const result = index.resolveTypeRef(
      'import("./queue-update-protocol").ResumeQueueCommand',
      PROTOCOL_V2,
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.how).toBe("import-type");
    expect(result.entry.file).toBe("src/types/queue-update-protocol.ts");
    expect(result.entry.line).toBe(14);
    expect(result.entry.typeLiteral).toBe("resume_queue");
  });

  it("resolves a union alias member to its own union instead of guessing", () => {
    const result = index.resolveTypeRef("CronProtocolCommand", PROTOCOL_V2);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.entry.kind).toBe("type");
    expect(result.entry.unionMembers).toHaveLength(10);
  });

  it("returns a structured failure instead of throwing", () => {
    let result;

    expect(() => {
      result = index.resolveTypeRef("NoSuchTypeAtAll", PROTOCOL_V2);
    }).not.toThrow();

    expect(result.ok).toBe(false);
    expect(result.code).toBe(FAILURE_CODES.UNRESOLVED_SYMBOL);
    expect(result.fromFile).toBe(PROTOCOL_V2);
    expect(result.message).toContain("NoSuchTypeAtAll");
  });
});

describe("fingerprint.mjs: shape and field fingerprints", () => {
  it("is stable across two independent index builds", () => {
    const first = createTypeIndex(ENGINE_ROOT);
    const second = createTypeIndex(ENGINE_ROOT);
    const left = first.resolveTypeRef("AgentListCommand", PROTOCOL_V2);
    const right = second.resolveTypeRef("AgentListCommand", PROTOCOL_V2);

    expect(left.ok && right.ok).toBe(true);
    expect(shapeFingerprint(left.entry.bodyText)).toBe(shapeFingerprint(right.entry.bodyText));
    expect(shapeFingerprint(left.entry.bodyText)).toMatch(/^[0-9a-f]{12}$/);
    expect(fieldFingerprint(left.entry.fields)).toBe(fieldFingerprint(right.entry.fields));
    expect(fieldFingerprint(left.entry.fields)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("ignores comments and whitespace but not content", () => {
    const commented = shapeFingerprint("interface X {\n  // note\n  a: string;\n}");
    const plain = shapeFingerprint("interface X { a: string; }");
    const changed = shapeFingerprint("interface X { a: number; }");

    expect(normalizeBodyText("a // note\n b")).toBe("a b");
    expect(commented).toBe(plain);
    expect(plain).toHaveLength(FINGERPRINT_LENGTH);
    expect(changed).not.toBe(plain);
  });

  it("sorts fields before hashing so declaration order does not leak", () => {
    const ordered = fieldFingerprint([
      { name: "alpha", type: "string", optional: false },
      { name: "zeta", type: "number", optional: true },
    ]);
    const reversed = fieldFingerprint([
      { name: "zeta", type: "number", optional: true },
      { name: "alpha", type: "string", optional: false },
    ]);

    expect(reversed).toBe(ordered);
  });
});

/**
 * Build one valid command record for the schema fixtures.
 *
 * @param {string} wire
 * @param {string} type
 * @returns {Record<string, unknown>}
 */
function makeCommand(wire, type) {
  return {
    wire,
    type,
    home: "src/types/protocol_v2.ts:1608",
    direction: ["c2s"],
    inbound: true,
    fields: [{ name: "request_id", type: "string", optional: false }],
    shapeFingerprint: "3f2a1c9d0e42",
    fieldLevel: true,
    health: "ok",
  };
}

/**
 * Build one valid message record for the schema fixtures.
 *
 * @param {string} wire
 * @param {string} type
 * @returns {Record<string, unknown>}
 */
function makeMessage(wire, type) {
  return {
    wire,
    type,
    home: "src/types/protocol_v2.ts:2574",
    fields: [],
    shapeFingerprint: "9b1c2d3e4f50",
    fieldLevel: false,
    health: "ok",
  };
}

/**
 * Build a minimal snapshot that satisfies every v1 rule.
 *
 * @returns {Record<string, unknown>}
 */
function makeValidSnapshot() {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    engine: {
      version: "0.6.0",
      commit: "1641a4f",
      source: "clone",
      extractedAt: "2026-11-13T12:00:00.000Z",
      extractor: "contract-snapshot@1",
    },
    counts: {
      unionMembers: 115,
      wireCommands: 124,
      messages: 127,
      inboundAccepted: 124,
      inboundOnly: 9,
      advertisedCommands: 14,
      dispatchCases: 12,
    },
    commands: [makeCommand("agent_list", "AgentListCommand")],
    messages: [makeMessage("stream_delta", "StreamDeltaMessage")],
    special: {
      fileOps: { wire: "file_ops", directions: ["c2s", "s2c"] },
      remoteCommands: {
        advertised: ["clear", "toolset"],
        handledElsewhere: { monitor_stop: "monitor_stop", secret: "secret_list" },
        unadvertisedAliases: { "set-max-context": "context-limit" },
        dispatchCases: ["clear", "toolset"],
      },
      startupText: {
        required: ["^Listening on (ws://\\S+)$", "^WebSocket:\\s+(ws://\\S+)$"],
        optional: ["^OpenAI:"],
      },
    },
    health: { degraded: false, coarse: [], unparsed: [] },
  };
}

describe("schema.mjs: snapshot v1 validator", () => {
  it("accepts a valid v1 snapshot", () => {
    const result = validateSnapshot(makeValidSnapshot());

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports a missing schemaVersion", () => {
    const snapshot = makeValidSnapshot();

    delete snapshot.schemaVersion;

    const result = validateSnapshot(snapshot);
    const violations = result.violations;

    expect(result.ok).toBe(false);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("missing-key");
    expect(violations[0].path).toBe("$.schemaVersion");
  });

  it("reports an unsorted array", () => {
    const snapshot = makeValidSnapshot();

    snapshot.commands = [
      makeCommand("zeta_command", "ZetaCommand"),
      makeCommand("alpha_command", "AlphaCommand"),
    ];

    const result = validateSnapshot(snapshot);
    const violations = result.violations;

    expect(result.ok).toBe(false);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("unsorted-array");
    expect(violations[0].path).toBe("$.commands");
  });

  it("canonicalizes key order and array order before validation", () => {
    const snapshot = makeValidSnapshot();

    snapshot.commands = [
      makeCommand("zeta_command", "ZetaCommand"),
      makeCommand("alpha_command", "AlphaCommand"),
    ];
    snapshot.health = { unparsed: [], coarse: ["beta", "alpha"], degraded: false };
    snapshot.special = {
      startupText: {
        optional: ["^OpenAI:"],
        required: ["^WebSocket:\\s+(ws://\\S+)$", "^Listening on (ws://\\S+)$"],
      },
      remoteCommands: {
        dispatchCases: ["toolset", "clear"],
        advertised: ["toolset", "clear"],
        handledElsewhere: { secret: "secret_list", monitor_stop: "monitor_stop" },
        unadvertisedAliases: { "set-max-context": "context-limit" },
      },
      fileOps: { directions: ["s2c", "c2s"], wire: "file_ops" },
    };

    const canonical = canonicalizeSnapshot(snapshot);

    expect(Object.keys(canonical)).toEqual([...SNAPSHOT_KEY_ORDER.root]);
    expect(canonical.commands.map((/** @type {object} */ command) => command.wire)).toEqual([
      "alpha_command",
      "zeta_command",
    ]);
    expect(canonical.health.coarse).toEqual(["alpha", "beta"]);

    const result = validateSnapshot(canonical);

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("contract/cli.mjs: dispatcher skeleton", () => {
  const CLI = path.join(REPO_ROOT, "scripts", "contract", "cli.mjs");

  it("prints usage and exits 2 without a subcommand", () => {
    const run = spawnSync(process.execPath, [CLI], { encoding: "utf8" });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Usage:");
    expect(run.stderr).toContain("update");
    expect(run.stderr).toContain("generate");
  });

  it("exits 2 with a not-implemented notice for a stubbed subcommand", () => {
    const run = spawnSync(process.execPath, [CLI, "check"], { encoding: "utf8" });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("not implemented yet");
    expect(run.stderr).toContain("contract");
  });

  it("rejects an unknown option before dispatching", () => {
    const run = spawnSync(process.execPath, [CLI, "check", "--nope"], { encoding: "utf8" });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown option --nope");
  });
});
