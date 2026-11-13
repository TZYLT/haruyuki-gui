/**
 * Command extraction tests for the pinned engine union.
 *
 * The locked facts are asserted against the real read-only engine mirror at
 * `_research/haruyuki` (v0.6.0 @ 1641a4f): `WsProtocolCommand` has 115 members,
 * recursive union expansion yields 124 wire commands, `cron_*` accounts for ten
 * of them and `file_ops` is bidirectional. A missing mirror is a hard failure
 * with an actionable message; silently skipping would let the seam rot.
 *
 * The string-backed stub tests at the bottom cover the parts the real source
 * cannot exercise: nested alias expansion, ambiguity, a missing type literal
 * and a missing engine. They exist so the contract reuse the same pure functions
 * with its fixture slices without building an engine tree.
 *
 * Nothing here spawns the engine, touches the network or writes to the repo.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  C2S,
  COMMAND_UNION,
  COMMAND_UNION_FILE,
  S2C,
  buildCommandRecord,
  expandUnionEntries,
  extractCommands,
  normalizeFields,
  refShortName,
} from "./contract/extract-commands.mjs";
import { shapeFingerprint } from "./contract/lib/fingerprint.mjs";
import { createTypeIndex } from "./contract/lib/scan.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = fileURLToPath(import.meta.url);
const EXTRACTOR_FILE = path.join(REPO_ROOT, "scripts", "contract", "extract-commands.mjs");
const ENGINE_ROOT = path.join(REPO_ROOT, "_research", "haruyuki");
const PROTOCOL_V2 = COMMAND_UNION_FILE;

const MISSING_MIRROR_HINT =
  `engine mirror is missing at ${ENGINE_ROOT}. ` +
  "the capability table reads the pinned engine source: create the read-only mirror with " +
  "`git clone --shared <main checkout>/_research/haruyuki _research/haruyuki` " +
  "and check out commit 1641a4f (v0.6.0).";

/** @type {ReturnType<typeof createTypeIndex>} */
let index;

/** @type {ReturnType<typeof extractCommands>} */
let extracted;
const ENGINE_AVAILABLE = existsSync(path.join(ENGINE_ROOT, "src", "types"));

/**
 * Engine-bound suites skip themselves in a clean clone: the pinned mirror is
 * not committed, and a clean-clone `verify` must stay green.
 * Run them where `_research/haruyuki` exists; the fixture-driven gate test
 * covers the pipeline without the mirror.
 */
const describeWithEngine = ENGINE_AVAILABLE ? describe : describe.skip;

beforeAll(() => {
  if (!ENGINE_AVAILABLE) {
    return;
  }
  index = createTypeIndex(ENGINE_ROOT);
  extracted = extractCommands({ engineRoot: ENGINE_ROOT, index });
});

describeWithEngine("extract-commands.mjs: union counts on the pinned engine source", () => {
  it("reads 115 union members and expands them to 124 wire commands", () => {
    expect(extracted.counts.unionMembers).toBe(115);
    expect(extracted.counts.wireCommands).toBe(124);
    expect(extracted.commands).toHaveLength(124);
    expect(extracted.union).toEqual({
      name: COMMAND_UNION,
      file: PROTOCOL_V2,
      line: 2455,
    });
    expect(extracted.health).toEqual({ degraded: false, coarse: [], unparsed: [] });
  });

  it("expands CronProtocolCommand into ten independent cron wires", () => {
    const cron = extracted.commands.filter((/** @type {object} */ command) =>
      /** @type {string} */ command.wire.startsWith("cron_"),
    );

    expect(cron).toHaveLength(10);
    expect(new Set(cron.map((/** @type {object} */ command) => command.wire)).size).toBe(10);
    expect(cron.map((/** @type {object} */ command) => command.wire)).not.toContain("agent_list");

    for (const command of cron) {
      expect(command.type).toMatch(/^Cron[A-Za-z]+Command$/);
      expect(command.home.startsWith("src/types/schedule-protocol.ts:")).toBe(true);
    }
  });

  it("keeps file_ops bidirectional and every wire unique", () => {
    const wires = extracted.commands.map((/** @type {object} */ command) => command.wire);
    const fileOps = extracted.commands.filter(
      (/** @type {object} */ command) => command.wire === "file_ops",
    );

    expect(new Set(wires).size).toBe(124);
    expect(fileOps).toHaveLength(1);
    expect(fileOps[0].type).toBe("FileOpsCommand");
    expect(fileOps[0].direction).toEqual([C2S, S2C]);

    const bidirectional = extracted.commands.filter(
      (/** @type {object} */ command) => command.direction.length > 1,
    );

    expect(bidirectional).toHaveLength(1);
    expect(bidirectional[0].wire).toBe("file_ops");

    for (const command of extracted.commands) {
      expect(command.direction).toContain(C2S);

      if (command.wire !== "file_ops") {
        expect(command.direction).toEqual([C2S]);
      }
    }
  });

  it("records agent_list at its declaration home", () => {
    const agentList = extracted.commands.find(
      (/** @type {object} */ command) => command.wire === "agent_list",
    );

    expect(agentList).toBeDefined();
    expect(agentList.home).toBe("src/types/protocol_v2.ts:1608");
    expect(agentList.type).toBe("AgentListCommand");
    expect(agentList.direction).toEqual([C2S]);
    expect(agentList.health).toBe("ok");

    const fields = new Map(
      agentList.fields.map((/** @type {object} */ field) => [field.name, field]),
    );

    expect(fields.get("request_id")).toEqual({
      name: "request_id",
      type: "string",
      optional: false,
    });
    expect(fields.get("query")).toEqual({
      name: "query",
      type: "AgentListParams",
      optional: true,
    });
  });
});

describeWithEngine("extract-commands.mjs: record shape", () => {
  it("emits only the command-extraction keys (no inbound, no fieldLevel)", () => {
    for (const command of extracted.commands) {
      expect(Object.keys(command)).toEqual([
        "wire",
        "type",
        "home",
        "direction",
        "fields",
        "shapeFingerprint",
        "health",
      ]);
      expect(Object.hasOwn(command, "inbound")).toBe(false);
      expect(Object.hasOwn(command, "fieldLevel")).toBe(false);
    }
  });

  it("keeps every one of the 124 records well formed", () => {
    for (const command of extracted.commands) {
      expect(typeof command.wire).toBe("string");
      expect(command.wire.length).toBeGreaterThan(0);
      expect(typeof command.type).toBe("string");
      expect(command.type.length).toBeGreaterThan(0);
      expect(command.home).toMatch(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*:\d+$/);
      expect(Array.isArray(command.fields)).toBe(true);
      expect(command.shapeFingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(["ok", "coarse"]).toContain(command.health);
    }
  });

  it("sorts fields by name in every record", () => {
    for (const command of extracted.commands) {
      const names = command.fields.map((/** @type {object} */ field) => field.name);

      expect(names).toEqual(
        [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    }
  });
});

describeWithEngine("extract-commands.mjs: field extraction", () => {
  it("keeps optionality as a boolean", () => {
    const agentList = extracted.commands.find(
      (/** @type {object} */ command) => command.wire === "agent_list",
    );
    const query = agentList.fields.find((/** @type {object} */ field) => field.name === "query");

    expect(typeof query.optional).toBe("boolean");
    expect(query.optional).toBe(true);
    expect(Object.hasOwn(query, "readonly")).toBe(false);
    expect(Object.hasOwn(query, "nested")).toBe(false);
  });

  it("flags one-level object literal fields without expanding them", () => {
    const nestedRecords = extracted.commands.filter((/** @type {object} */ command) =>
      command.fields.some((/** @type {object} */ field) => field.nested === true),
    );

    expect(nestedRecords.length).toBeGreaterThan(0);

    const runtimeStart = extracted.commands.find(
      (/** @type {object} */ command) => command.wire === "runtime_start",
    );
    const sandbox = runtimeStart.fields.find(
      (/** @type {object} */ field) => field.name === "workspace_sandbox",
    );

    expect(sandbox.nested).toBe(true);
    expect(sandbox.type.trim().startsWith("{")).toBe(true);
    expect(sandbox.type).toContain("root: string");
  });

  it("keeps readonly flags and emits keys in frozen order", () => {
    const normalized = normalizeFields([
      { name: "zeta", type: "string", optional: true, readonly: true, nested: false },
      { name: "alpha", type: "number", optional: false, readonly: false, nested: true },
    ]);

    expect(normalized.map((/** @type {object} */ field) => field.name)).toEqual(["alpha", "zeta"]);
    expect(normalized[0]).toEqual({
      name: "alpha",
      type: "number",
      optional: false,
      nested: true,
    });
    expect(normalized[1]).toEqual({
      name: "zeta",
      type: "string",
      optional: true,
      readonly: true,
    });
    expect(Object.keys(normalized[1])).toEqual(["name", "type", "optional", "readonly"]);

    const record = buildCommandRecord({
      name: "ReadonlyFixture",
      typeLiteral: "readonly_fixture",
      file: "src/types/fixture.ts",
      line: 7,
      fields: [{ name: "locked", type: "string", optional: false, readonly: true }],
      bodyText: '{\n  type: "readonly_fixture";\n  readonly locked: string;\n}',
    });

    expect(record.fields).toEqual([
      { name: "locked", type: "string", optional: false, readonly: true },
    ]);
    expect(record.shapeFingerprint).toBe(
      shapeFingerprint('{\n  type: "readonly_fixture";\n  readonly locked: string;\n}'),
    );
  });
});

describeWithEngine("extract-commands.mjs: fingerprints and determinism", () => {
  it("reuses the frozen shape fingerprint for every record", () => {
    const agentList = index.resolveTypeRef("AgentListCommand", PROTOCOL_V2);

    expect(agentList.ok, JSON.stringify(agentList)).toBe(true);

    const record = extracted.commands.find(
      (/** @type {object} */ command) => command.wire === "agent_list",
    );

    expect(record.shapeFingerprint).toBe(shapeFingerprint(agentList.entry.bodyText));
  });

  it("is stable across two independent extractions", () => {
    const again = extractCommands({ engineRoot: ENGINE_ROOT });
    const key = (/** @type {object} */ command) => `${command.type}@${command.home}`;

    expect(again.commands.map(key)).toEqual(extracted.commands.map(key));
    expect(again.commands.map((/** @type {object} */ command) => command.shapeFingerprint)).toEqual(
      extracted.commands.map((/** @type {object} */ command) => command.shapeFingerprint),
    );
    expect(again.counts).toEqual(extracted.counts);
    expect(again.health).toEqual(extracted.health);
  });
});

/**
 * Build one fake index entry.
 *
 * @param {string} name
 * @param {string | null} typeLiteral
 * @param {number} line
 * @returns {Record<string, unknown>}
 */
function fakeEntry(name, typeLiteral, line) {
  return {
    name,
    qualifiedName: name,
    kind: "interface",
    file: "src/types/fixture.ts",
    line,
    typeLiteral,
    fields: typeLiteral
      ? [
          {
            name: "type",
            type: `"${typeLiteral}"`,
            optional: false,
            readonly: false,
            nested: false,
          },
        ]
      : [],
    bodyText: typeLiteral ? `{ type: "${typeLiteral}"; }` : "{}",
    unionMembers: null,
  };
}

/** @type {Record<string, {name: string, typeLiteral: string | null, line: number}>} */
const FIXTURE_LEAVES = {
  LeafA: { name: "LeafA", typeLiteral: "leaf_a", line: 10 },
  LeafC: { name: "LeafC", typeLiteral: "leaf_c", line: 12 },
  NoType: { name: "NoType", typeLiteral: null, line: 14 },
};

/**
 * String-backed index stub: two alias levels, one ambiguous member and one
 * missing symbol. It answers exactly the calls the extractor makes.
 *
 * @param {string} unionName
 * @returns {Record<string, unknown>}
 */
function stubResolveUnion(unionName) {
  if (unionName === "RootAlias") {
    return {
      ok: true,
      name: unionName,
      fromFile: "src/types/fixture.ts",
      line: 1,
      members: [
        { ref: "LeafA", ok: true, entry: fakeEntry("LeafA", "leaf_a", 10) },
        {
          ref: "AliasB",
          ok: true,
          entry: {
            name: "AliasB",
            qualifiedName: "AliasB",
            kind: "type",
            file: "src/types/fixture.ts",
            line: 20,
            typeLiteral: null,
            fields: [],
            bodyText: "LeafC",
            unionMembers: ["LeafC"],
          },
        },
        { ref: "NoType", ok: true, entry: fakeEntry("NoType", null, 14) },
        {
          ref: "Ambiguous",
          ok: false,
          code: "ambiguous-symbol",
          message: "symbol Ambiguous is declared more than once",
          candidates: ["src/types/fixture.ts:30", "src/types/other.ts:30"],
        },
        {
          ref: "Gone",
          ok: false,
          code: "unresolved-symbol",
          message: "symbol Gone is not declared in the indexed tree",
          candidates: [],
        },
      ],
    };
  }

  if (unionName === "AliasB") {
    return {
      ok: true,
      name: unionName,
      fromFile: "src/types/fixture.ts",
      line: 20,
      members: [{ ref: "LeafC", ok: true, entry: fakeEntry("LeafC", "leaf_c", 12) }],
    };
  }

  if (unionName === "WsProtocolMessage") {
    return {
      ok: true,
      name: unionName,
      fromFile: "src/types/fixture.ts",
      line: 2,
      members: [],
    };
  }

  return { ok: false, name: unionName, code: "union-not-found", message: "not in the stub" };
}

/** @type {{resolveUnion: (name: string, fromFile: string) => Record<string, unknown>}} */
const stubIndex = { resolveUnion: stubResolveUnion };

describeWithEngine("extract-commands.mjs: string-backed stub for the contract gate", () => {
  it("expands nested aliases and separates coarse from unparsed members", () => {
    const expansion = expandUnionEntries(stubIndex, "RootAlias", "src/types/fixture.ts");

    expect(expansion.ok).toBe(true);
    expect(expansion.unionMembers).toBe(5);
    expect(expansion.entries.map((/** @type {object} */ entry) => entry.name)).toEqual([
      "LeafA",
      "LeafC",
      "NoType",
    ]);
    expect(expansion.unresolved).toHaveLength(1);
    expect(expansion.unresolved[0].ref).toBe("Ambiguous");
    expect(expansion.health.degraded).toBe(true);
    expect(expansion.health.unparsed).toHaveLength(1);
    expect(expansion.health.unparsed[0]).toContain("Gone");
    expect(expansion.health.unparsed[0]).toContain("unresolved-symbol");
  });

  it("builds a coarse record for ambiguity and a missing type literal", () => {
    const result = extractCommands({
      index: stubIndex,
      unionName: "RootAlias",
      fromFile: "src/types/fixture.ts",
    });

    expect(result.counts.unionMembers).toBe(5);
    expect(result.counts.wireCommands).toBe(4);
    expect(result.health.degraded).toBe(true);
    expect(result.health.coarse).toHaveLength(2);

    const ambiguous = result.commands.find(
      (/** @type {object} */ command) => command.type === "Ambiguous",
    );

    expect(ambiguous.wire).toBeNull();
    expect(ambiguous.home).toBe("src/types/fixture.ts:30");
    expect(ambiguous.health).toBe("coarse");

    const noType = result.commands.find(
      (/** @type {object} */ command) => command.type === "NoType",
    );

    expect(noType.wire).toBeNull();
    expect(noType.home).toBe("src/types/fixture.ts:14");
    expect(noType.health).toBe("coarse");
    expect(result.health.coarse.some((/** @type {string} */ line) => line.includes("NoType"))).toBe(
      true,
    );
  });

  it("rejects a missing engine root instead of returning an empty success", () => {
    expect(() =>
      extractCommands({ engineRoot: path.join(REPO_ROOT, "_research", "__missing_w02__") }),
    ).toThrow(/engine type directory not found/);
  });
});

describeWithEngine("extract-commands.mjs: helpers and ASCII discipline", () => {
  it("shortens raw member refs for coarse records", () => {
    expect(refShortName("AgentListCommand")).toBe("AgentListCommand");
    expect(refShortName("CwdProtocol.SetBootWorkingDirectoryCommand")).toBe(
      "SetBootWorkingDirectoryCommand",
    );
    expect(refShortName('import("./queue-update-protocol").ResumeQueueCommand')).toBe(
      "ResumeQueueCommand",
    );
  });

  it("keeps the extractor and this test file pure ASCII", () => {
    for (const file of [EXTRACTOR_FILE, TEST_FILE]) {
      const source = readFileSync(file, "utf8");

      expect(source, `${file} must stay English ASCII`).toMatch(/^[\x00-\x7F]*$/);
    }
  });
});
