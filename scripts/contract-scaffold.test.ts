/**
 * Type-index seam tests: AST scan and type index, shape/field fingerprints, the
 * snapshot v1 schema validator and the CLI dispatcher skeleton.
 *
 * Two kinds of suite live here:
 *
 *   - engine-bound suites read the real read-only engine mirror at
 *     `_research/haruyuki` (v0.6.0 @ 1641a4f), because the union member counts
 *     are locked facts, not fixture choices: `WsProtocolCommand` has 115 members
 *     and `WsProtocolMessage` has 127.
 *   - synthetic suites only use strings, the committed
 *     `fixtures/contract/mini-engine` tree or a temp copy of it.
 *
 * A missing mirror skips the engine-bound suites instead of failing: the pinned
 * mirror is not committed, so a clean clone must stay green. That
 * is exactly why every schema, canonicalization, heritage and fingerprint rule
 * is covered by a synthetic suite below - those must keep running everywhere.
 *
 * Nothing here spawns the real engine, touches the network or writes to the
 * repository; temp trees live under `os.tmpdir()` and are removed again.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
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
import { HERITAGE_CODES } from "./contract/lib/heritage.mjs";
import { arrayOf, first, recordOf } from "./lib/test-assert.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_ROOT = path.join(REPO_ROOT, "_research", "haruyuki");
const MINI_ENGINE = path.join(REPO_ROOT, "fixtures", "contract", "mini-engine");
const PROTOCOL_V2 = "src/types/protocol_v2.ts";
const COMMAND_UNION = "WsProtocolCommand";
const MESSAGE_UNION = "WsProtocolMessage";

/** @type {ReturnType<typeof createTypeIndex>} */
let index;
const ENGINE_AVAILABLE = existsSync(path.join(ENGINE_ROOT, "src", "types"));

/**
 * Engine-bound suites skip themselves in a clean clone: the pinned mirror is
 * not committed, and a clean-clone `verify` must stay green.
 * Run them where `_research/haruyuki` exists; the synthetic suites below cover
 * the same seams without the mirror.
 */
const describeWithEngine = ENGINE_AVAILABLE ? describe : describe.skip;

beforeAll(() => {
  if (!ENGINE_AVAILABLE) {
    return;
  }
  index = createTypeIndex(ENGINE_ROOT);
});

/**
 * Run `body` against a throwaway engine tree built from `files`.
 *
 * The parameters are typed in TS, not JSDoc: a JSDoc `@param` is ignored in a
 * `.ts` file, which left `files` implicitly `any` and `Object.entries(files)`
 * yielding `unknown` values.
 *
 * @param files path below the engine root -> text
 * @param body receives the temp engine root
 */
function withTempEngine(files: Record<string, string>, body: (engineRoot: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "contract-scan-"));

  try {
    writeFileSync(path.join(directory, "package.json"), '{"version":"0.0.1"}', "utf8");

    for (const [relative, text] of Object.entries(files)) {
      const target = path.join(directory, ...relative.split("/"));

      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text, "utf8");
    }

    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describeWithEngine("scan.mjs: union indexing on the pinned engine source", () => {
  it("indexes every production file under src/types", () => {
    expect(index.stats.files).toBe(31);
    expect(listTypeFiles(ENGINE_ROOT)).toHaveLength(31);
    expect(index.files).toContain(PROTOCOL_V2);
  });

  it("skips declaration shims and test files (P4-7)", () => {
    const files = listTypeFiles(ENGINE_ROOT);

    expect(files.filter((file) => file.endsWith(".d.ts"))).toEqual([]);
    expect(files.filter((file) => /\.(test|spec)\.ts$/.test(file))).toEqual([]);
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

describeWithEngine("scan.mjs: resolving one type reference", () => {
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

  it("folds the RuntimeEnvelope base into stream_delta (P4-1)", () => {
    const envelope = index.resolveTypeRef("RuntimeEnvelope", PROTOCOL_V2);
    const delta = index.resolveTypeRef("StreamDeltaMessage", PROTOCOL_V2);

    expect(envelope.ok && delta.ok).toBe(true);
    expect(envelope.entry.fields.map((/** @type {object} */ field) => field.name)).toEqual([
      "runtime",
      "event_seq",
      "emitted_at",
      "idempotency_key",
    ]);
    expect(delta.entry.heritageRefs).toEqual(["RuntimeEnvelope"]);
    expect(delta.entry.fields.map((/** @type {object} */ field) => field.name)).toEqual([
      "runtime",
      "event_seq",
      "emitted_at",
      "idempotency_key",
      "type",
      "delta",
      "subagent_id",
    ]);
  });
});

describeWithEngine("fingerprint.mjs: stability on the pinned engine source", () => {
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
});

describe("fingerprint.mjs: pure hashing rules", () => {
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

  it("strips comments from field type text, matching the shape rule (P4-4)", () => {
    const commented = fieldFingerprint([
      { name: "settings", type: "Settings /* request scoped */", optional: false },
    ]);
    const plain = fieldFingerprint([{ name: "settings", type: "Settings", optional: false }]);
    const changed = fieldFingerprint([
      { name: "settings", type: "Settings | null", optional: false },
    ]);

    expect(commented).toBe(plain);
    expect(changed).not.toBe(plain);
  });
});

describe("scan.mjs: interface heritage (extends) on the mini-engine fixture", () => {
  it("merges a two-level chain and lets the child override a member (P4-1)", () => {
    const miniIndex = createTypeIndex(MINI_ENGINE);
    const leaf = miniIndex.resolveTypeRef("EnvelopeLeafMessage", "src/types/envelope-protocol.ts");
    const base = miniIndex.resolveTypeRef("EnvelopeBase", "src/types/envelope-protocol.ts");

    expect(leaf.ok && base.ok).toBe(true);
    expect(leaf.entry.heritageRefs).toEqual(["EnvelopeMiddle"]);
    expect(leaf.entry.fields.map((/** @type {object} */ field) => field.name)).toEqual([
      "request_id",
      "event_seq",
      "emitted_at",
      "parent_message_id",
      "type",
      "payload",
    ]);

    const baseEmittedAt = base.entry.fields.find(
      (/** @type {object} */ field) => field.name === "emitted_at",
    );
    const leafEmittedAt = leaf.entry.fields.find(
      (/** @type {object} */ field) => field.name === "emitted_at",
    );

    expect(baseEmittedAt.optional).toBe(false);
    expect(leafEmittedAt.optional).toBe(true);
    expect(miniIndex.health).toEqual({ degraded: false, coarse: [], unparsed: [] });
  });

  it("changes the descendant fingerprint when a base gains a field (P4-1)", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "contract-heritage-"));

    try {
      cpSync(MINI_ENGINE, directory, { recursive: true });

      const file = path.join(directory, "src", "types", "envelope-protocol.ts");
      const before = createTypeIndex(directory).resolveTypeRef(
        "EnvelopeLeafMessage",
        "src/types/envelope-protocol.ts",
      );
      const original = readFileSync(file, "utf8");
      const mutated = original.replace(
        "  request_id: string;\n  event_seq: number;\n",
        "  request_id: string;\n  event_seq: number;\n  trace_id: string;\n",
      );

      expect(mutated).not.toBe(original);
      writeFileSync(file, mutated, "utf8");

      const after = createTypeIndex(directory).resolveTypeRef(
        "EnvelopeLeafMessage",
        "src/types/envelope-protocol.ts",
      );

      expect(before.ok && after.ok).toBe(true);
      expect(after.entry.fields.map((/** @type {object} */ field) => field.name)).toContain(
        "trace_id",
      );
      expect(shapeFingerprint(after.entry.bodyText)).not.toBe(
        shapeFingerprint(before.entry.bodyText),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports an unmergeable base as coarse and a cycle as unparsed (P4-1)", () => {
    withTempEngine(
      {
        "src/types/protocol_v2.ts": [
          'import type { External } from "@scope/pkg";',
          "export interface HasExternal extends External { c: string }",
          "export interface LoopA extends LoopB { a: string }",
          "export interface LoopB extends LoopA { b: string }",
        ].join("\n"),
      },
      (root) => {
        const tempIndex = createTypeIndex(root);

        expect(tempIndex.health.degraded).toBe(true);
        expect(tempIndex.health.coarse.join("\n")).toContain(HERITAGE_CODES.UNRESOLVED);
        expect(tempIndex.health.unparsed.join("\n")).toContain(HERITAGE_CODES.CYCLE);
      },
    );
  });
});

describe("scan.mjs: index scope and module resolution (P4-7)", () => {
  it("indexes only production source extensions", () => {
    withTempEngine(
      {
        "src/types/alpha.ts": "export interface Alpha { id: string }\n",
        "src/types/alpha.d.ts": "export interface Ambient { id: string }\n",
        "src/types/alpha.test.ts": "export interface TestOnly { id: string }\n",
        "src/types/alpha.spec.ts": "export interface SpecOnly { id: string }\n",
        "src/types/beta.mts": "export interface Beta { id: string }\n",
      },
      (root) => {
        expect(listTypeFiles(root)).toEqual(["src/types/alpha.ts", "src/types/beta.mts"]);

        const tempIndex = createTypeIndex(root);

        expect(tempIndex.stats.files).toBe(2);
        expect(tempIndex.resolveTypeRef("TestOnly", "src/types/alpha.ts").ok).toBe(false);
        expect(tempIndex.resolveTypeRef("Ambient", "src/types/alpha.ts").ok).toBe(false);
      },
    );
  });

  it("keeps a production declaration free of test-file ambiguity", () => {
    withTempEngine(
      {
        "src/types/alpha.ts": "export interface Shared { id: string }\n",
        "src/types/alpha.test.ts": "export interface Shared { id: number }\n",
      },
      (root) => {
        const resolved = createTypeIndex(root).resolveTypeRef("Shared", "src/types/alpha.ts");

        expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
        expect(resolved.entry.file).toBe("src/types/alpha.ts");
        expect(resolved.entry.fields[0].type).toBe("string");
      },
    );
  });

  it("resolves a relative module with the same extension set the walker indexes", () => {
    withTempEngine(
      {
        "src/types/protocol_v2.ts": [
          'import type { Helper } from "./helper";',
          "export interface UsesHelper { helper: Helper }",
        ].join("\n"),
        "src/types/helper.mts": "export interface Helper { id: string }\n",
      },
      (root) => {
        const resolved = createTypeIndex(root).resolveTypeRef("Helper", "src/types/protocol_v2.ts");

        expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
        expect(resolved.how).toBe("named-import");
        expect(resolved.entry.file).toBe("src/types/helper.mts");
      },
    );
  });
});

describe("scan.mjs: syntax-broken files leave a trace (P4-6)", () => {
  it("records parse diagnostics as unparsed and degrades the index", () => {
    withTempEngine(
      {
        "src/types/fine.ts": "export interface Fine { id: string }\n",
        "src/types/broken.ts": "export interface Oops {\n",
      },
      (root) => {
        const tempIndex = createTypeIndex(root);

        expect(tempIndex.health.degraded).toBe(true);
        expect(tempIndex.health.unparsed).toHaveLength(1);
        expect(tempIndex.health.unparsed[0]).toContain("src/types/broken.ts: parse-error:");
        expect(tempIndex.resolveTypeRef("Fine", "src/types/fine.ts").ok).toBe(true);
      },
    );
  });

  it("leaves health clean for files that parse", () => {
    withTempEngine({ "src/types/fine.ts": "export interface Fine { id: string }\n" }, (root) => {
      expect(createTypeIndex(root).health).toEqual({
        degraded: false,
        coarse: [],
        unparsed: [],
      });
    });
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
 * The counts are the ones this fixture's detail sections imply: one command with
 * a wire, one message, that one command inbound, no inbound-only wire, two
 * advertised commands and two dispatch cases.
 *
 * @returns {Record<string, unknown>}
 */
/**
 * Empty health block with `string[]` fields.
 *
 * Declared on its own because the inline `[]` literals would be inferred as
 * `never[]`, which makes every later `snapshot.health = { coarse: [...] }`
 * assignment in these tests fail to compile.
 */
const EMPTY_HEALTH: { degraded: boolean; coarse: string[]; unparsed: string[] } = {
  degraded: false,
  coarse: [],
  unparsed: [],
};

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
      wireCommands: 1,
      messages: 1,
      inboundAccepted: 1,
      inboundOnly: 0,
      advertisedCommands: 2,
      dispatchCases: 2,
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
    health: { ...EMPTY_HEALTH },
  };
}

/**
 * @param {Record<string, unknown>} snapshot
 * @returns {string[]} violation rules
 */
function violationRules(snapshot) {
  return validateSnapshot(snapshot).violations.map((/** @type {object} */ item) => item.rule);
}

describe("schema.mjs: snapshot v1 validator", () => {
  it("accepts a valid v1 snapshot", () => {
    const result = validateSnapshot(makeValidSnapshot());

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports a missing schemaVersion", () => {
    // A `Record` keeps the key deletable (TS2790: `delete` needs an optional
    // property) while still carrying every real field of the fixture.
    const snapshot: Record<string, unknown> = { ...makeValidSnapshot() };

    delete snapshot.schemaVersion;

    const result = validateSnapshot(snapshot);
    const violations = result.violations;

    expect(result.ok).toBe(false);
    expect(violations).toHaveLength(1);
    expect(first(violations, "violations").rule).toBe("missing-key");
    expect(first(violations, "violations").path).toBe("$.schemaVersion");
  });

  it("reports an unsorted array", () => {
    const snapshot = makeValidSnapshot();

    snapshot.commands = [
      makeCommand("zeta_command", "ZetaCommand"),
      makeCommand("alpha_command", "AlphaCommand"),
    ];
    snapshot.counts = { ...snapshot.counts, wireCommands: 2, inboundAccepted: 2 };

    const result = validateSnapshot(snapshot);
    const violations = result.violations;

    expect(result.ok).toBe(false);
    expect(violations).toHaveLength(1);
    expect(first(violations, "violations").rule).toBe("unsorted-array");
    expect(first(violations, "violations").path).toBe("$.commands");
  });

  it("reports an unknown key", () => {
    const snapshot = { ...makeValidSnapshot(), extra: true };

    expect(violationRules(snapshot)).toEqual(["unknown-key"]);
    expect(first(validateSnapshot(snapshot).violations, "violations").path).toBe("$.extra");
  });

  it("reports an invalid type", () => {
    const valid = makeValidSnapshot();
    const snapshot = { ...valid, engine: { ...valid.engine, commit: 42 } };

    expect(violationRules(snapshot)).toEqual(["invalid-type"]);
    expect(first(validateSnapshot(snapshot).violations, "violations").path).toBe("$.engine.commit");
  });

  it("reports a duplicate wire", () => {
    const snapshot = makeValidSnapshot();

    snapshot.commands = [
      makeCommand("agent_list", "AgentListCommand"),
      makeCommand("agent_list", "OtherCommand"),
    ];
    snapshot.counts = { ...snapshot.counts, wireCommands: 2, inboundAccepted: 2 };

    expect(violationRules(snapshot)).toEqual(["duplicate-wire"]);
  });

  it("reports a broken frozen key order", () => {
    const snapshot = makeValidSnapshot();
    const command = makeCommand("agent_list", "AgentListCommand");

    snapshot.commands = [
      {
        type: command.type,
        wire: command.wire,
        home: command.home,
        direction: command.direction,
        inbound: command.inbound,
        fields: command.fields,
        shapeFingerprint: command.shapeFingerprint,
        fieldLevel: command.fieldLevel,
        health: command.health,
      },
    ];

    expect(violationRules(snapshot)).toEqual(["key-order"]);
  });

  it("reports a malformed shapeFingerprint", () => {
    const snapshot = makeValidSnapshot();

    snapshot.commands = [
      { ...makeCommand("agent_list", "AgentListCommand"), shapeFingerprint: "NOTAHASH" },
    ];

    expect(violationRules(snapshot)).toEqual(["invalid-value"]);
    expect(first(validateSnapshot(snapshot).violations, "violations").path).toBe(
      "$.commands[0].shapeFingerprint",
    );
  });

  it("reports a malformed home", () => {
    const snapshot = makeValidSnapshot();

    snapshot.commands = [
      { ...makeCommand("agent_list", "AgentListCommand"), home: "src/types/protocol_v2.ts" },
    ];

    expect(violationRules(snapshot)).toEqual(["invalid-value"]);
    expect(first(validateSnapshot(snapshot).violations, "violations").path).toBe(
      "$.commands[0].home",
    );
  });

  it("reports a value outside a frozen enum", () => {
    const snapshot = makeValidSnapshot();

    snapshot.commands = [
      { ...makeCommand("agent_list", "AgentListCommand"), direction: ["sideways"] },
    ];

    expect(violationRules(snapshot)).toEqual(["invalid-value"]);
    expect(first(validateSnapshot(snapshot).violations, "violations").path).toBe(
      "$.commands[0].direction[0]",
    );
  });

  it("canonicalizes key order and array order before validation", () => {
    const snapshot = makeValidSnapshot();

    snapshot.commands = [
      makeCommand("zeta_command", "ZetaCommand"),
      makeCommand("alpha_command", "AlphaCommand"),
    ];
    snapshot.counts = { ...snapshot.counts, wireCommands: 2, inboundAccepted: 2 };
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
    expect(
      arrayOf<{ wire: string }>(canonical.commands, "canonical.commands").map(
        (command) => command.wire,
      ),
    ).toEqual(["alpha_command", "zeta_command"]);
    expect(
      arrayOf<string>(
        recordOf(canonical.health, "canonical.health").coarse,
        "canonical.health.coarse",
      ),
    ).toEqual(["alpha", "beta"]);

    const result = validateSnapshot(canonical);

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("keeps unknown keys and illegal elements instead of dropping them (P4-2)", () => {
    // The point of the test is input the snapshot type forbids, so the object
    // is assembled as a plain record rather than by mutating a typed fixture.
    const snapshot: Record<string, unknown> = {
      ...makeValidSnapshot(),
      extra: { nested: true },
      commands: [42],
      messages: [null],
    };

    const canonical = canonicalizeSnapshot(snapshot);

    expect(Object.hasOwn(canonical, "extra")).toBe(true);
    expect(canonical.commands).toEqual([42]);
    expect(canonical.messages).toEqual([null]);
    expect(canonicalizeSnapshot(makeValidSnapshot()).commands).toHaveLength(1);

    const result = validateSnapshot(canonical);
    const rules = result.violations.map((/** @type {object} */ item) => item.rule);

    expect(result.ok).toBe(false);
    expect(rules).toContain("unknown-key");
    expect(rules).toContain("invalid-type");
  });

  it("rejects counts that disagree with the detail sections (P5-3)", () => {
    const cases = [
      { key: "wireCommands", value: 2 },
      { key: "messages", value: 2 },
      { key: "inboundAccepted", value: 124 },
      { key: "advertisedCommands", value: 3 },
      { key: "dispatchCases", value: 3 },
    ];

    for (const { key, value } of cases) {
      const snapshot = makeValidSnapshot();

      snapshot.counts = { ...snapshot.counts, [key]: value };

      const result = validateSnapshot(snapshot);

      expect(result.ok, `${key} should be rejected`).toBe(false);
      expect(result.violations.map((/** @type {object} */ item) => item.rule)).toContain(
        "count-mismatch",
      );
      expect(first(result.violations, "violations").path).toBe(`$.counts.${key}`);
    }
  });

  it("accepts a consistent inbound-only count", () => {
    const snapshot = makeValidSnapshot();

    snapshot.commands = [];
    snapshot.counts = { ...snapshot.counts, wireCommands: 0, inboundAccepted: 3, inboundOnly: 3 };

    expect(validateSnapshot(snapshot).violations).toEqual([]);
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

  it("rejects an unknown option before dispatching", () => {
    const run = spawnSync(process.execPath, [CLI, "check", "--nope"], { encoding: "utf8" });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown option --nope");
  });
});
