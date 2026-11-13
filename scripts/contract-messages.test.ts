/**
 * Message extraction tests: the `WsProtocolMessage` union, the `parseServerMessage`
 * inbound accepted set and the two-direction `file_ops` case.
 *
 * The locked counts are asserted against the real read-only engine mirror at
 * `_research/haruyuki` (v0.6.0 @ 1641a4f), because 127 union members, 124
 * OR-chain items and 136 wire records are locked facts, not fixture choices. A
 * missing mirror skips those suites instead of failing: the mirror is not
 * committed and a clean clone must stay green.
 *
 * The string fixtures at the bottom drive the pure helpers only, so the contract
 * reuse the same red cases for its gate fixtures without an engine checkout.
 * They are plain `describe` suites because they never read `_research`, so they
 * keep running in a clean clone. Nothing here writes to the repository, spawns
 * the engine or touches the network.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  FILE_OPS_WIRE,
  MESSAGE_UNION,
  PROTOCOL_TYPES_FILE,
  WIRE_CODES,
  extractMessages,
  readWireLiteralFromTypeText,
} from "./contract/extract-messages.mjs";
import {
  GUARD_CODES,
  INBOUND_FILE,
  INBOUND_FUNCTION,
  collectGuardNames,
  findGuardWire,
  lookupGuardType,
  parseGuardWire,
  readFunctionBodyText,
  resolveInboundGuard,
} from "./contract/lib/inbound.mjs";
import { createTypeIndex } from "./contract/lib/scan.mjs";
import { assertFailure } from "./lib/test-assert.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_ROOT = path.join(REPO_ROOT, "_research", "haruyuki");
const EXTRACTOR_FILE = path.join(REPO_ROOT, "scripts", "contract", "extract-messages.mjs");
const INBOUND_MODULE_FILE = path.join(REPO_ROOT, "scripts", "contract", "lib", "inbound.mjs");

/** One inbound guard fixture: an `is<Type>` function comparing `type`. */
const GUARD_FIXTURE =
  "export function isFixtureCommand(value: unknown): value is FixtureCommand {\n" +
  '  if (!value || typeof value !== "object") return false;\n' +
  "  const command = value as { type?: unknown };\n" +
  '  return command.type === "fixture_command";\n' +
  "}\n";

/** @type {ReturnType<typeof createTypeIndex>} */
let index;
/** @type {ReturnType<typeof extractMessages>} */
let result;
const ENGINE_AVAILABLE = existsSync(path.join(ENGINE_ROOT, "src", "types"));

/**
 * Engine-bound suites skip themselves in a clean clone: the pinned mirror is
 * not committed, and a clean-clone `verify` must stay green.
 * Run them where `_research/haruyuki` exists; the string-fixture suites below
 * cover the pure helpers without the mirror.
 */
const describeWithEngine = ENGINE_AVAILABLE ? describe : describe.skip;

beforeAll(() => {
  if (!ENGINE_AVAILABLE) {
    return;
  }
  index = createTypeIndex(ENGINE_ROOT);
  result = extractMessages({ engineRoot: ENGINE_ROOT });
});

describeWithEngine("extract-messages: the WsProtocolMessage union", () => {
  it("reads 127 union members and keeps every raw member reference", () => {
    expect(result.union.name).toBe(MESSAGE_UNION);
    expect(result.counts.unionMembers).toBe(127);
    expect(result.union.refs).toHaveLength(127);
  });

  it("reports the union home as protocol_v2.ts:2574", () => {
    expect(result.union.file).toBe(PROTOCOL_TYPES_FILE);
    expect(result.union.line).toBe(2574);
  });

  it("keeps the namespace member forms in the member references", () => {
    expect(result.union.refs).toContain("CwdProtocol.SetBootWorkingDirectoryResponseMessage");
    expect(result.union.refs).toContain("EmbeddingProtocol.EmbeddingStatusResponseMessage");

    const namespaceRefs = result.union.refs.filter((/** @type {string} */ ref) =>
      /^[A-Za-z_$][\w$]*\./.test(ref),
    );

    expect(namespaceRefs.length).toBeGreaterThanOrEqual(17);
  });

  it("keeps the one import-typed member", () => {
    expect(result.union.refs).toContain(
      'import("./queue-update-protocol").ResumeQueueResponseMessage',
    );

    const record = result.messages.find(
      (/** @type {object} */ message) => message.wire === "resume_queue_response",
    );

    expect(
      record,
      JSON.stringify(result.messages.map((/** @type {object} */ m) => m.wire)),
    ).toBeDefined();
    expect(record.home).toBe("src/types/queue-update-protocol.ts:21");
  });

  it("turns 127 members into 136 wire records by expanding the cron alias", () => {
    expect(result.counts).toEqual({ unionMembers: 127, wireMessages: 136 });
    expect(result.messages).toHaveLength(136);
    expect(result.aliases).toHaveLength(1);
    expect(result.aliases[0]).toEqual({
      type: "CronProtocolResponseMessage",
      home: "src/types/schedule-protocol.ts:289",
      members: [
        "CronListResponseMessage",
        "CronAddResponseMessage",
        "CronGetResponseMessage",
        "CronRunsResponseMessage",
        "CronTriggerResponseMessage",
        "CronPauseResponseMessage",
        "CronResumeResponseMessage",
        "CronUpdateResponseMessage",
        "CronDeleteResponseMessage",
        "CronDeleteAllResponseMessage",
      ],
    });

    const wires = result.messages.map((/** @type {object} */ message) => message.wire);

    expect(wires).toContain("cron_list_response");
    expect(wires).toContain("cron_delete_all_response");
    expect(wires).not.toContain(null);
  });

  it("keeps one record per wire, sorted by wire then type", () => {
    const wires = result.messages.map((/** @type {object} */ message) => message.wire);
    const sorted = [...wires].sort();

    expect(wires).toEqual(sorted);
    expect(new Set(wires).size).toBe(wires.length);
    expect(
      result.health.coarse.filter((/** @type {string} */ item) => item.includes("duplicate-wire")),
    ).toEqual([]);
  });

  it("emits exactly the frozen record keys in the frozen order", () => {
    const record = result.messages.find(
      (/** @type {object} */ message) => message.wire === "input_accepted",
    );

    expect(record).toBeDefined();
    expect(Object.keys(record)).toEqual([
      "wire",
      "type",
      "home",
      "fields",
      "shapeFingerprint",
      "health",
    ]);
    expect(record.type).toBe("InputAcceptedResponseMessage");
    expect(record.home).toBe("src/types/protocol_v2.ts:720");
    expect(record.shapeFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(record.health).toBe("ok");
    expect(Object.hasOwn(record, "inbound")).toBe(false);
    expect(Object.hasOwn(record, "fieldLevel")).toBe(false);
  });

  it("gives every record a posix home, a fingerprint and a known health", () => {
    for (const message of result.messages) {
      expect(message.home, message.wire).toMatch(/^src\/types\/[A-Za-z0-9._/-]+:\d+$/);
      expect(message.shapeFingerprint, message.wire).toMatch(/^[0-9a-f]{12}$/);
      expect(["ok", "coarse"], message.wire).toContain(message.health);
    }
  });

  it("sorts fields by name, keeps raw type text and flags only when true", () => {
    const record = result.messages.find(
      (/** @type {object} */ message) => message.wire === "input_accepted",
    );
    const names = record.fields.map((/** @type {object} */ field) => field.name);

    expect(names).toEqual(["accepted", "disposition", "error", "request_id", "runtime", "type"]);

    const disposition = record.fields.find(
      (/** @type {object} */ field) => field.name === "disposition",
    );

    expect(disposition).toEqual({
      name: "disposition",
      type: '"started" | "queued"',
      optional: true,
    });

    for (const field of record.fields) {
      expect(Object.keys(field)[0]).toBe("name");
      expect(Object.hasOwn(field, "nested")).toBe(false);
      expect(Object.hasOwn(field, "readonly")).toBe(false);
    }
  });

  it("folds the RuntimeEnvelope base into every inherited message (P4-1)", () => {
    const inherited = result.messages.filter((/** @type {object} */ message) =>
      ["stream_delta", "turn_finished", "update_subagent_state"].includes(message.wire),
    );

    expect(inherited).toHaveLength(3);

    for (const message of inherited) {
      const names = message.fields.map((/** @type {object} */ field) => field.name);

      expect(names, message.wire).toContain("runtime");
      expect(names, message.wire).toContain("event_seq");
      expect(names, message.wire).toContain("emitted_at");
      expect(names, message.wire).toContain("idempotency_key");
    }

    const delta = result.messages.find(
      (/** @type {object} */ message) => message.wire === "stream_delta",
    );

    expect(delta.fields).toHaveLength(7);
  });

  it("marks a nested field nested and never emits readonly on this engine", () => {
    const record = result.messages.find(
      (/** @type {object} */ message) => message.wire === "runtime_start_response",
    );
    const created = record.fields.find((/** @type {object} */ field) => field.name === "created");

    expect(created.nested).toBe(true);
    expect(created.type).toBe("{ agent: boolean; conversation: boolean }");

    const readonlyFields = result.messages.flatMap((/** @type {object} */ message) =>
      message.fields.filter((/** @type {object} */ field) => field.readonly === true),
    );

    expect(readonlyFields).toEqual([]);
  });

  it("recovers the intersection member's wire but marks its fields coarse", () => {
    const record = result.messages.find(
      (/** @type {object} */ message) => message.wire === "launch_subagent_response",
    );

    expect(record, "launch_subagent_response is the intersection alias").toBeDefined();
    expect(record.type).toBe("LaunchSubagentResponse");
    expect(record.home).toBe("src/types/subagent-protocol.ts:47");
    expect(record.fields).toEqual([]);
    expect(record.health).toBe("coarse");
    expect(result.health.coarse).toHaveLength(1);
    expect(result.health.coarse[0]).toContain("src/types/subagent-protocol.ts:47");
    expect(result.health.coarse[0]).toContain("LaunchSubagentResponse");
  });

  it("accepts an injected index so snapshot assembly can reuse one parse of src/types", () => {
    const reused = extractMessages({ engineRoot: ENGINE_ROOT, index });

    expect(reused.counts).toEqual(result.counts);
    expect(reused.inbound.accepted).toEqual(result.inbound.accepted);
    expect(reused.special).toEqual(result.special);
  });

  it("is not degraded and has no unparsed member on the pinned engine", () => {
    expect(result.health.degraded).toBe(false);
    expect(result.health.unparsed).toEqual([]);
  });
});

describeWithEngine("extract-messages: the inbound accepted set", () => {
  it("reads 124 OR-chain items out of parseServerMessage", () => {
    expect(result.inbound.file).toBe(INBOUND_FILE);
    expect(result.inbound.function).toBe(INBOUND_FUNCTION);
    expect(result.inbound.guardCount).toBe(124);
    expect(result.inbound.items).toHaveLength(124);
  });

  it("accepts 124 distinct wires, deduplicated and sorted", () => {
    const accepted = result.inbound.accepted;

    expect(accepted).toHaveLength(124);
    expect(accepted).toEqual([...accepted].sort());
    expect(new Set(accepted).size).toBe(accepted.length);
    expect(new Set(result.inbound.items.map((/** @type {object} */ item) => item.wire))).toEqual(
      new Set(accepted),
    );
  });

  it("resolves every guard through the type index, none through a guard body", () => {
    expect(result.inbound.unresolved).toEqual([]);
    expect(
      result.inbound.items.filter((/** @type {object} */ item) => item.via !== "index"),
    ).toEqual([]);
  });

  it("finds every accepted wire in the type index again", () => {
    for (const item of result.inbound.items) {
      const resolved = index.resolveTypeRef(item.type, PROTOCOL_TYPES_FILE);

      expect(resolved.ok, `${item.guard}: ${resolved.code ?? ""}`).toBe(true);
      expect(resolved.entry.typeLiteral, item.guard).toBe(item.wire);
    }
  });

  it("keeps the first and last items of the chain in source order", () => {
    expect(result.inbound.items[0]).toEqual({
      guard: "isInputCommand",
      type: "InputCommand",
      wire: "input",
      via: "index",
    });
    expect(result.inbound.items[result.inbound.items.length - 1].guard).toBe(
      "isUsageAggregateCommand",
    );
  });
});

describeWithEngine("extract-messages: the file_ops special case", () => {
  it("reports file_ops in both directions", () => {
    expect(result.special.fileOps).toEqual({ wire: FILE_OPS_WIRE, directions: ["c2s", "s2c"] });
    expect(result.special.fileOps.directions).toEqual(
      [...result.special.fileOps.directions].sort(),
    );
  });

  it("keeps exactly one file_ops message record and one file_ops command member", () => {
    const messages = result.messages.filter(
      (/** @type {object} */ message) => message.wire === FILE_OPS_WIRE,
    );

    expect(messages).toHaveLength(1);

    const union = index.resolveUnion("WsProtocolCommand", PROTOCOL_TYPES_FILE);
    const commands = union.members.filter(
      (/** @type {object} */ member) => member.ok && member.entry.typeLiteral === FILE_OPS_WIRE,
    );

    expect(union.ok, JSON.stringify(union)).toBe(true);
    expect(commands).toHaveLength(1);
    expect(messages[0].home).toMatch(/^src\/types\/.*:\d+$/);
  });
});

describeWithEngine("extract-messages: guard lookup through the real index", () => {
  it("reverse-looks-up is<Name> through the index", () => {
    expect(lookupGuardType(index, "isInputCommand", PROTOCOL_TYPES_FILE)).toEqual({
      ok: true,
      type: "InputCommand",
      wire: "input",
      home: "src/types/protocol_v2.ts:712",
    });
    expect(lookupGuardType(index, "isNoSuchCommand", PROTOCOL_TYPES_FILE)).toMatchObject({
      ok: false,
      type: "NoSuchCommand",
      code: "unresolved-symbol",
    });
    expect(lookupGuardType(index, "notAGuard", PROTOCOL_TYPES_FILE)).toMatchObject({
      ok: false,
      code: GUARD_CODES.GUARD_NAME_INVALID,
    });
    // The evaluator rejects a missing index explicitly ("a type index with
    // resolveTypeRef is required", GUARD_NAME_INVALID), but its JSDoc `@param`
    // declares a required object. The annotation is narrower than the
    // behaviour this line pins, so the call is suppressed; an unused directive
    // (TS2578) will flag it once the JSDoc learns about `null`.
    // @ts-expect-error - null index is handled at run time (see above).
    expect(lookupGuardType(null, "isInputCommand", PROTOCOL_TYPES_FILE)).toMatchObject({
      ok: false,
      code: GUARD_CODES.GUARD_NAME_INVALID,
    });
  });
});

describe("extract-messages: pure helpers on string fixtures", () => {
  it("collects the is<Name> calls of an OR chain in source order", () => {
    const chain = [
      "if (",
      "  isAlphaCommand(parsed) ||",
      "  isBetaCommand(parsed) ||",
      "  isGammaCommand(parsed)",
      ") {",
      "  return parsed as WsProtocolCommand;",
      "}",
    ].join("\n");

    expect(collectGuardNames(chain)).toEqual(["isAlphaCommand", "isBetaCommand", "isGammaCommand"]);
  });

  it("returns one item fewer when a chain fixture is missing a guard", () => {
    const complete = [
      "if (",
      "  isAlphaCommand(parsed) ||",
      "  isBetaCommand(parsed) ||",
      "  isGammaCommand(parsed)",
      ") {",
      "  return parsed;",
      "}",
    ].join("\n");
    const missing = [
      "if (",
      "  isAlphaCommand(parsed) ||",
      "  isGammaCommand(parsed)",
      ") {",
      "  return parsed;",
      "}",
    ].join("\n");

    expect(() => collectGuardNames(missing)).not.toThrow();
    expect(collectGuardNames(missing)).toHaveLength(collectGuardNames(complete).length - 1);
    expect(collectGuardNames(missing)).toEqual(["isAlphaCommand", "isGammaCommand"]);
  });

  it("ignores guards inside comments and string literals", () => {
    const chain = [
      "// isCommentedCommand(parsed) ||",
      'const note = "isStringCommand(parsed)";',
      "if (isRealCommand(parsed)) {",
      "  return parsed;",
      "}",
    ].join("\n");

    expect(collectGuardNames(chain)).toEqual(["isRealCommand"]);
    expect(collectGuardNames("")).toEqual([]);
  });

  it("reads a function body text and returns null for a missing function", () => {
    expect(readFunctionBodyText(GUARD_FIXTURE, "isFixtureCommand")).toContain(
      'command.type === "fixture_command"',
    );
    expect(readFunctionBodyText(GUARD_FIXTURE, "isNotThere")).toBeNull();
    expect(readFunctionBodyText("", "isFixtureCommand")).toBeNull();
  });

  it("parses a guard body into one wire id and fails softly otherwise", () => {
    const body = '{ return command.type === "fixture_command"; }';

    expect(parseGuardWire(body)).toEqual({ ok: true, wire: "fixture_command" });
    expect(parseGuardWire("{}")).toMatchObject({ ok: false, code: GUARD_CODES.GUARD_WIRE_MISSING });
    expect(parseGuardWire('{ return a.type === "one" || b.type === "two"; }')).toMatchObject({
      ok: false,
      code: GUARD_CODES.GUARD_WIRE_AMBIGUOUS,
    });
  });

  it("finds a guard function inside a file text by name", () => {
    expect(findGuardWire(GUARD_FIXTURE, "isFixtureCommand")).toEqual({
      ok: true,
      wire: "fixture_command",
    });
    expect(findGuardWire(GUARD_FIXTURE, "isMissingCommand")).toMatchObject({
      ok: false,
      code: GUARD_CODES.GUARD_NOT_FOUND,
    });
  });

  it("reads a wire literal out of an intersection body and fails softly", () => {
    expect(
      readWireLiteralFromTypeText(
        'FixtureBase & {\n  type: "fixture_message";\n  request_id: string;\n}',
      ),
    ).toEqual({ ok: true, wire: "fixture_message" });
    expect(readWireLiteralFromTypeText("| Alpha\n  | Beta")).toMatchObject({
      ok: false,
      code: WIRE_CODES.WIRE_LITERAL_MISSING,
    });
    expect(() => readWireLiteralFromTypeText("NotParsable ((( ")).not.toThrow();
  });

  it("falls back to a guard body only when the index cannot answer", () => {
    const blind = {
      resolveTypeRef: () => ({ ok: false, code: "unresolved-symbol", message: "not indexed" }),
    };
    const sources = [{ file: "src/websocket/listener/fixture-inbound.ts", text: GUARD_FIXTURE }];

    expect(resolveInboundGuard(blind, "isFixtureCommand", sources, PROTOCOL_TYPES_FILE)).toEqual({
      ok: true,
      item: {
        guard: "isFixtureCommand",
        type: "FixtureCommand",
        wire: "fixture_command",
        via: "guard-body",
      },
    });

    const failure = resolveInboundGuard(blind, "isMissingCommand", sources, PROTOCOL_TYPES_FILE);

    assertFailure(failure, "resolveInboundGuard on a guard that is not in the chain");
    expect(failure.unresolved.code).toBe("unresolved-symbol");
    expect(failure.unresolved.message).toContain("guard-not-found");
    expect(resolveInboundGuard(blind, "isMissingCommand", [], PROTOCOL_TYPES_FILE)).toMatchObject({
      ok: false,
    });
  });

  it("rejects a missing engine root and a missing engine tree explicitly", () => {
    expect(() => extractMessages({})).toThrow(/engineRoot must be a non-empty string/);
    expect(() =>
      extractMessages({ engineRoot: path.join(REPO_ROOT, "_research", "no-such-engine") }),
    ).toThrow(/engine type directory not found/);
  });

  it("keeps both extractor sources ASCII only", () => {
    for (const file of [EXTRACTOR_FILE, INBOUND_MODULE_FILE]) {
      expect(readFileSync(file, "utf8"), file).toMatch(/^[\x00-\x7F]*$/);
    }
  });
});
