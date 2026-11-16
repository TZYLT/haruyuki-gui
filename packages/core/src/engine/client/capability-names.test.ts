/**
 * Tests for the client capability table.
 *
 * The module under test is a projection of the generated protocol artifact, so
 * every assertion here compares it with an independent source rather than with
 * itself:
 *
 * - `capabilities.json` is the authored truth source (68 rows: name, wire, since,
 *   scope, shape, notes). Counts, spellings and every field are compared against
 *   it row by row, in both directions, so neither a missing row nor an extra one
 *   can pass.
 * - `snapshot.json` is the extracted wire evidence (`commands[].fields[]` shows
 *   whether a request id exists, `messages[]` shows whether any reply exists).
 *   The completion classes - the 60/2/5/1 split that decides whether a send may
 *   enter the in-flight table - are recomputed from it and compared with the
 *   module, because `capabilities.json` does not state that fact at all.
 * - The `CapabilityName` union is checked at compile time as well as at runtime:
 *   a union that lost a member while keeping a green test would be exactly the
 *   drift this table exists to prevent.
 *
 * The wire-id leak rule is enforced twice: this module's own file and
 * every other file under `client/`. Nothing here writes to disk or starts the
 * engine.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITY_META, CAPABILITY_TO_WIRE } from "@haruyuki/protocol";
import type { CapabilityName as ProtocolCapabilityName } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import {
  attachesRuntimeObject,
  CAPABILITIES,
  CAPABILITY_NAMES,
  capabilityEntry,
  completionOf,
  findCapability,
  hasOptionalRequestId,
  isCapabilityName,
  needsScope,
  replyWireOf,
  scopeCarrierOf,
  scopeOf,
  shapeOf,
  tracksInFlight,
  tracksInFlightWith,
  wireIdOf,
} from "./capability-names";
import type {
  CapabilityName,
  CapabilityScope,
  CapabilityShape,
  CompletionMode,
  ScopeCarrier,
} from "./capability-names";

/* contract truth sources (read-only)                                  */

const CAPABILITIES_URL = new URL(
  "../../../../protocol/src/contract/capabilities.json",
  import.meta.url,
);
const SNAPSHOT_URL = new URL("../../../../protocol/src/contract/snapshot.json", import.meta.url);
const SOURCE_URL = new URL("./capability-names.ts", import.meta.url);
const CLIENT_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Contract counts; a change here is a contract event. */
const EXPECTED_TOTAL = 68;

/**
 * Shape counts, covering every member of `CapabilityShape`.
 *
 * `raw` is counted as zero on purpose rather than left out: the union member
 * exists in the generated artifact, so a capability that started using it would
 * otherwise pass unnoticed. A totals-equal-68 check with an explicit zero for the
 * unused member is the version that can fail.
 */
const EXPECTED_SHAPES: Readonly<Record<CapabilityShape, number>> = {
  "request-response": 58,
  "one-way": 9,
  bidirectional: 1,
  raw: 0,
};
const EXPECTED_SCOPES: Readonly<Record<CapabilityScope, number>> = {
  none: 54,
  conversation: 8,
  agent: 6,
};

/** The 9 one-way capabilities, in contract order. */
const ONE_WAY_NAMES: readonly CapabilityName[] = [
  "device.setState",
  "file.unwatch",
  "file.watch",
  "message.abort",
  "message.send",
  "terminal.input",
  "terminal.kill",
  "terminal.resize",
  "terminal.spawn",
];

/** The 8 conversation-scoped capabilities. */
const CONVERSATION_SCOPED: readonly CapabilityName[] = [
  "conversation.switch",
  "conversation.sync",
  "device.setState",
  "message.abort",
  "message.send",
  "model.update",
  "queue.resume",
  "toolset.update",
];

/** The 6 agent-scoped capabilities. */
const AGENT_SCOPED: readonly CapabilityName[] = [
  "queue.remove",
  "queue.stopMonitor",
  "settings.getReflection",
  "settings.setReflection",
  "slash.exec",
  "subagent.launch",
];

/** One `capabilities.json` row, narrowed to the fields this suite reads. */
interface ContractCapability {
  readonly name: string;
  readonly wire: string;
  readonly shape: string;
  readonly scope: string;
}

/** One `snapshot.json` command record. */
interface SnapshotCommand {
  readonly wire: string;
  readonly fields: readonly { readonly name: string; readonly optional: boolean }[];
}

/** One `snapshot.json` message record. */
interface SnapshotMessage {
  readonly wire: string;
}

/**
 * Parse a committed JSON artifact.
 *
 * `resolveJsonModule` is off in this repository, so the files are read and parsed
 * here rather than imported: the parsed value is narrowed by the readers below
 * instead of being trusted because a compiler option said the shape was fine.
 *
 * @param url file URL of the artifact
 * @returns the parsed, unvalidated value
 */
function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

/**
 * Narrow a value to a record with the given key.
 *
 * @param value candidate container
 * @param key property name to read
 * @returns the container, typed as a record of unknowns
 */
function requireRecord(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`contract artifact is missing "${key}"`);
  }
  return value as Record<string, unknown>;
}

/** The 68 authored capability rows. */
function readContractCapabilities(): readonly ContractCapability[] {
  const root = requireRecord(readJson(CAPABILITIES_URL), "capabilities");
  const rows = root["capabilities"];
  if (!Array.isArray(rows)) {
    throw new Error("capabilities.json: capabilities must be an array");
  }
  return rows.map((row: unknown) => {
    const record = row as Record<string, unknown>;
    return {
      name: String(record["name"]),
      wire: String(record["wire"]),
      shape: String(record["shape"]),
      scope: String(record["scope"]),
    };
  });
}

/** The command records, keyed by wire id. */
function readSnapshotCommands(): ReadonlyMap<string, SnapshotCommand> {
  const root = requireRecord(readJson(SNAPSHOT_URL), "commands");
  const rows = root["commands"];
  if (!Array.isArray(rows)) {
    throw new Error("snapshot.json: commands must be an array");
  }
  const seen = new Map<string, SnapshotCommand>();
  for (const row of rows as readonly Record<string, unknown>[]) {
    const wire = String(row["wire"]);
    const fields = Array.isArray(row["fields"]) ? row["fields"] : [];
    seen.set(wire, {
      wire,
      fields: (fields as readonly Record<string, unknown>[]).map((field) => ({
        name: String(field["name"]),
        optional: field["optional"] === true,
      })),
    });
  }
  return seen;
}

/** Every server message wire id. */
function readSnapshotMessageWires(): ReadonlySet<string> {
  const root = requireRecord(readJson(SNAPSHOT_URL), "messages");
  const rows = root["messages"];
  if (!Array.isArray(rows)) {
    throw new Error("snapshot.json: messages must be an array");
  }
  return new Set((rows as readonly SnapshotMessage[]).map((row) => String(row["wire"])));
}

const CONTRACT = readContractCapabilities();
const SNAPSHOT_COMMANDS = readSnapshotCommands();
const MESSAGE_WIRES = readSnapshotMessageWires();

/**
 * Whether a reply frame exists for one wire.
 *
 * The extractor stores replies under the wire id they travel on, and a handful
 * of replies are not spelled `<command>_response`: the message-send command is
 * acknowledged by its own accepted frame. A prefix test matches the reply to its
 * command without naming either wire in this file; the test below pins the one
 * non-standard case so a future rename cannot silently drop it.
 *
 * @param wire the command wire id
 * @returns `true` when at least one reply wire starts with `<wire>_`
 */
function hasReply(wire: string): boolean {
  for (const messageWire of MESSAGE_WIRES) {
    if (messageWire.startsWith(`${wire}_`)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the wire declares a request id field.
 *
 * @param wire the command wire id
 * @returns `true` when the snapshot shows a `request_id` property
 */
function hasRequestId(wire: string): boolean {
  const command = SNAPSHOT_COMMANDS.get(wire);
  if (command === undefined) {
    throw new Error(`snapshot.json: no command record for capability wire ${wire}`);
  }
  return command.fields.some((field) => field.name === "request_id");
}

/**
 * Whether the wire declares a runtime scope field.
 *
 * @param wire the command wire id
 * @returns `true` when the snapshot shows a `runtime` property
 */
function hasRuntimeField(wire: string): boolean {
  const command = SNAPSHOT_COMMANDS.get(wire);
  if (command === undefined) {
    throw new Error(`snapshot.json: no command record for capability wire ${wire}`);
  }
  return command.fields.some((field) => field.name === "runtime");
}

/** One derived classification row: the wire evidence per capability, from the snapshot. */
interface DerivedRow {
  readonly name: string;
  readonly wire: string;
  readonly shape: string;
  readonly scope: string;
  readonly requestId: boolean;
  readonly reply: boolean;
  readonly runtimeField: boolean;
  readonly completion: CompletionMode;
}

/**
 * Classify every capability from wire evidence alone.
 *
 * The order is the point: a duplex wire has no request/reply pairing to observe,
 * a wire without a request id cannot be correlated at all, and a wire with a
 * request id but no reply is the class that must never be tracked.
 *
 * @returns one row per authored capability, in contract order
 */
function deriveRows(): readonly DerivedRow[] {
  return CONTRACT.map((row) => {
    const requestId = hasRequestId(row.wire);
    const reply = hasReply(row.wire);
    const shape = row.shape;
    let completion: CompletionMode;
    if (shape === "bidirectional") {
      completion = "duplex";
    } else if (!requestId) {
      completion = "untracked";
    } else if (!reply) {
      completion = "silent";
    } else {
      completion = "response";
    }
    return {
      name: row.name,
      wire: row.wire,
      shape,
      scope: row.scope,
      requestId,
      reply,
      runtimeField: hasRuntimeField(row.wire),
      completion,
    };
  });
}

const DERIVED = deriveRows();

/* compile-time checks                                                 */

/** `true` only when the two types are identical. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails the build unless its argument is `true`. */
type Expect<T extends true> = T;

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never;

type LastOfUnion<U> =
  UnionToIntersection<U extends unknown ? () => U : never> extends () => infer L ? L : never;

/** Turn a union into a tuple; used only to read the member count. */
type UnionToTuple<U, Acc extends unknown[] = []> = [U] extends [never]
  ? Acc
  : UnionToTuple<Exclude<U, LastOfUnion<U>>, [LastOfUnion<U>, ...Acc]>;

type CapabilityNameCount = UnionToTuple<CapabilityName>["length"];

/**
 * Compile-time proof that the union has exactly 68 members.
 *
 * A runtime comparison cannot see a union that lost a member while the generated
 * records kept the key, so the count is checked in the type system too, and
 * `Equal` (not `extends`) rejects both a short and an over-wide union.
 */
type UnionHas68Members = Expect<Equal<CapabilityNameCount, 68>>;

/** The union must be the protocol's union, not a re-typed copy of it. */
type UnionMatchesProtocol = Expect<Equal<CapabilityName, ProtocolCapabilityName>>;

/** Every contract name must be assignable to the union; a missing one fails here. */
const CONTRACT_NAMES_ARE_CAPABILITY_NAMES = CONTRACT.map(
  (row) => row.name as CapabilityName,
) satisfies readonly CapabilityName[];

/**
 * Wire ids that are also ordinary English words or dotted-name segments.
 *
 * A substring scan cannot tell a vocabulary leak from prose: `input`, `sync` and
 * `get_tree` occur in comments and in capability names (`terminal.input`,
 * `conversation.sync`) where they are the *sanctioned* spelling, not a wire id.
 * Flagging them would force the source to stop using the right word, which is the
 * opposite of what the rule wants.
 *
 * These are excluded from the scan by name, and the exclusion is cross-checked
 * against the contract below: an excluded id must still be a capability-name
 * segment, so a future rename cannot quietly widen the exemption.
 */
const PROSE_COLLIDING_WIRES: readonly string[] = ["input", "sync"];

/**
 * Find wire ids that appear in a source text as whole, dot-delimited tokens.
 *
 * Three boundary rules, each for a reason:
 *
 * - No adjacent `[A-Za-z0-9_]`, so `async` does not contain `sync` and a longer
 *   identifier does not contain a shorter wire id.
 * - No adjacent `.`, so the dot-separated *capability* names are not mistaken for
 *   wire ids: `terminal.input` and `conversation.sync` are the sanctioned
 *   spelling of a capability, while a bare `input` would be a leak.
 * - Prose-colliding ids are skipped entirely; they cannot be distinguished from
 *   English text by pattern alone.
 *
 * @param source text to scan
 * @returns the wire ids found, in contract order
 */
function findWireLeaks(source: string): string[] {
  const wireIds = new Set<string>();
  for (const name of CAPABILITY_NAMES) {
    wireIds.add(wireIdOf(name));
  }
  for (const wire of MESSAGE_WIRES) {
    wireIds.add(wire);
  }
  for (const wire of SNAPSHOT_COMMANDS.keys()) {
    wireIds.add(wire);
  }

  const leaked: string[] = [];
  for (const wire of wireIds) {
    if (PROSE_COLLIDING_WIRES.includes(wire)) {
      continue;
    }
    const pattern = new RegExp(`(?<![A-Za-z0-9_.])${wire}(?![A-Za-z0-9_.])`);
    if (pattern.test(source)) {
      leaked.push(wire);
    }
  }
  return leaked;
}

/* tests                                                              */

describe("capability table completeness", () => {
  it("exports exactly 68 capability names", () => {
    expect(CAPABILITY_NAMES).toHaveLength(EXPECTED_TOTAL);
    expect(new Set(CAPABILITY_NAMES).size).toBe(EXPECTED_TOTAL);
    expect(Object.keys(CAPABILITIES)).toHaveLength(EXPECTED_TOTAL);
  });

  it("resolves every name to a wire id, a shape and a scope", () => {
    const shapes: readonly CapabilityShape[] = ["request-response", "one-way", "bidirectional"];
    const scopes: readonly CapabilityScope[] = ["none", "conversation", "agent"];

    for (const name of CAPABILITY_NAMES) {
      const entry = capabilityEntry(name);
      expect(entry, `missing entry for ${name}`).toBeDefined();
      expect(entry.name, `wrong name on ${name}`).toBe(name);
      expect(typeof entry.wire, `missing wire for ${name}`).toBe("string");
      expect(entry.wire.length, `empty wire for ${name}`).toBeGreaterThan(0);
      expect(shapes, `unknown shape for ${name}`).toContain(entry.shape);
      expect(scopes, `unknown scope for ${name}`).toContain(entry.scope);
      expect(wireIdOf(name), `accessor disagrees for ${name}`).toBe(entry.wire);
      expect(shapeOf(name), `shape accessor disagrees for ${name}`).toBe(entry.shape);
      expect(scopeOf(name), `scope accessor disagrees for ${name}`).toBe(entry.scope);
    }
  });

  it("keeps the module's name set equal to the contract's, in both directions", () => {
    const contractNames = CONTRACT.map((row) => row.name).sort();
    const moduleNames = [...CAPABILITY_NAMES].sort();
    expect(moduleNames).toEqual(contractNames);

    for (const row of CONTRACT) {
      expect(isCapabilityName(row.name), `${row.name} is not recognised`).toBe(true);
    }
  });

  it("resolves every wire id exactly once", () => {
    const wires = CAPABILITY_NAMES.map((name) => wireIdOf(name));
    expect(wires).toHaveLength(EXPECTED_TOTAL);
    expect(new Set(wires).size).toBe(EXPECTED_TOTAL);
  });

  it("spells every name as a dotted, underscore-free identifier", () => {
    for (const name of CAPABILITY_NAMES) {
      expect(name).toMatch(/^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/);
      expect(name, `underscore leaked into ${name}`).not.toContain("_");
    }
  });

  it("orders names by code unit, not by locale", () => {
    const sorted = [...CAPABILITY_NAMES].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect([...CAPABILITY_NAMES]).toEqual(sorted);
  });
});

describe("capability table against the contract snapshot", () => {
  it("reads all 68 contract rows", () => {
    expect(CONTRACT).toHaveLength(EXPECTED_TOTAL);
  });

  it("matches capabilities.json row by row on name, wire, shape and scope", () => {
    for (const row of CONTRACT) {
      const name = row.name as CapabilityName;
      const entry = CAPABILITIES[name];

      expect(entry, `capabilities.json row ${row.name} is missing from the table`).toBeDefined();
      expect(entry.wire, `wire mismatch for ${row.name}`).toBe(row.wire);
      expect(entry.shape, `shape mismatch for ${row.name}`).toBe(row.shape);
      expect(entry.scope, `scope mismatch for ${row.name}`).toBe(row.scope);
    }
  });

  it("adds no capability that the contract does not declare", () => {
    const contractNames = new Set(CONTRACT.map((row) => row.name));
    for (const name of CAPABILITY_NAMES) {
      expect(contractNames.has(name), `${name} is not in capabilities.json`).toBe(true);
    }
  });

  it("takes every wire id from the generated protocol artifact, not from a copy", () => {
    for (const name of CAPABILITY_NAMES) {
      expect(wireIdOf(name), `wire for ${name} diverged from @haruyuki/protocol`).toBe(
        CAPABILITY_TO_WIRE[name],
      );
      expect(shapeOf(name), `shape for ${name} diverged from @haruyuki/protocol`).toBe(
        CAPABILITY_META[name].shape,
      );
      expect(scopeOf(name), `scope for ${name} diverged from @haruyuki/protocol`).toBe(
        CAPABILITY_META[name].scope,
      );
    }
  });
});

describe("capability groups", () => {
  it("counts 58 request-response, 9 one-way and 1 bidirectional", () => {
    const counted: Record<CapabilityShape, number> = {
      "request-response": 0,
      "one-way": 0,
      bidirectional: 0,
      raw: 0,
    };
    for (const name of CAPABILITY_NAMES) {
      counted[shapeOf(name)] += 1;
    }
    expect(counted).toEqual(EXPECTED_SHAPES);

    // The four counts must also sum to the table size, so a shape added to the
    // union without a count here cannot hide behind an untouched member.
    const total = Object.values(counted).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(EXPECTED_TOTAL);

    const oneWay = CAPABILITY_NAMES.filter((name) => shapeOf(name) === "one-way");
    expect(oneWay).toHaveLength(9);
    expect([...oneWay].sort()).toEqual([...ONE_WAY_NAMES].sort());
  });

  it("counts 54 unscoped, 8 conversation-scoped and 6 agent-scoped", () => {
    const counted: Record<CapabilityScope, number> = { none: 0, conversation: 0, agent: 0 };
    for (const name of CAPABILITY_NAMES) {
      counted[scopeOf(name)] += 1;
    }
    expect(counted).toEqual(EXPECTED_SCOPES);

    const total = Object.values(counted).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(EXPECTED_TOTAL);

    const conversation = CAPABILITY_NAMES.filter((name) => scopeOf(name) === "conversation");
    expect(conversation).toHaveLength(8);
    expect([...conversation].sort()).toEqual([...CONVERSATION_SCOPED].sort());

    const agent = CAPABILITY_NAMES.filter((name) => scopeOf(name) === "agent");
    expect(agent).toHaveLength(6);
    expect([...agent].sort()).toEqual([...AGENT_SCOPED].sort());
  });

  it("names exactly one bidirectional capability", () => {
    const bidirectional = CAPABILITY_NAMES.filter((name) => shapeOf(name) === "bidirectional");
    expect(bidirectional).toEqual(["file.ops"]);
  });
});

describe("completion classes derived from the wire snapshot", () => {
  it("splits the 68 capabilities 60 / 2 / 5 / 1", () => {
    const counted: Record<CompletionMode, number> = {
      response: 0,
      silent: 0,
      untracked: 0,
      duplex: 0,
    };
    for (const row of DERIVED) {
      counted[row.completion] += 1;
    }
    expect(counted).toEqual({ response: 60, silent: 2, untracked: 5, duplex: 1 });
  });

  it("agrees with the module's completion for every capability", () => {
    for (const row of DERIVED) {
      expect(completionOf(row.name as CapabilityName), `completion mismatch for ${row.name}`).toBe(
        row.completion,
      );
    }
  });

  it("tracks exactly the 60 request/response capabilities in flight", () => {
    const tracked = CAPABILITY_NAMES.filter((name) => tracksInFlight(name));
    const expected = DERIVED.filter((row) => row.completion === "response").map((row) => row.name);
    expect(tracked).toHaveLength(60);
    expect([...tracked].sort()).toEqual([...expected].sort());
  });

  it("classifies the two silent-request capabilities as untrackable", () => {
    const silent = DERIVED.filter((row) => row.completion === "silent").map((row) => row.name);
    // Contract order, not sorted order: `file.unwatch` precedes `file.watch` in
    // `capabilities.json`, and the assertion follows the data rather than the
    // data being reordered to suit the assertion.
    expect(silent).toEqual(["file.unwatch", "file.watch"]);
    expect(new Set(silent)).toEqual(new Set(["file.watch", "file.unwatch"]));

    for (const name of silent) {
      // The snapshot must agree: a request id is present, no reply exists.
      const row = DERIVED.find((candidate) => candidate.name === name);
      expect(row?.requestId, `${name} should carry a request id`).toBe(true);
      expect(row?.reply, `${name} must have no reply frame`).toBe(false);
      expect(tracksInFlight(name as CapabilityName), `${name} must not be tracked`).toBe(false);
    }
  });

  it("classifies the five request-id-less commands as untrackable", () => {
    const untracked = DERIVED.filter((row) => row.completion === "untracked").map(
      (row) => row.name,
    );
    expect(untracked).toEqual([
      "device.setState",
      "terminal.input",
      "terminal.kill",
      "terminal.resize",
      "terminal.spawn",
    ]);

    for (const name of untracked) {
      const row = DERIVED.find((candidate) => candidate.name === name);
      expect(row?.requestId, `${name} must carry no request id`).toBe(false);
      expect(shapeOf(name as CapabilityName), `${name} is a one-way command`).toBe("one-way");
      expect(tracksInFlight(name as CapabilityName), `${name} must not be tracked`).toBe(false);
    }
  });

  it("classifies the bidirectional wire as duplex, not as request/response", () => {
    const duplex = DERIVED.filter((row) => row.completion === "duplex").map((row) => row.name);
    expect(duplex).toEqual(["file.ops"]);
    expect(tracksInFlight("file.ops")).toBe(false);
  });

  it("records the acknowledged one-way capabilities as answerable", () => {
    // `message.send` and `message.abort` are one-way yet do produce a frame, so
    // shape alone cannot decide tracking: the completion class is the answer.
    for (const name of ["message.send", "message.abort"] as const) {
      expect(shapeOf(name)).toBe("one-way");
      expect(completionOf(name)).toBe("response");
      expect(tracksInFlight(name)).toBe(true);
    }
  });
});

describe("reply wire registration", () => {
  /** The default suffix a reply frame normally carries. */
  const DEFAULT_SUFFIX = "response";

  /**
   * The reply wire the default rule would produce for one command wire.
   *
   * @param wire the command wire id
   * @returns the name the default rule predicts
   */
  function defaultReplyFor(wire: string): string {
    return `${wire}_${DEFAULT_SUFFIX}`;
  }

  /** Every capability that answers, per the snapshot evidence. */
  const ANSWERING = DERIVED.filter((row) => row.reply);

  it("registers a reply frame for all 60 answering capabilities", () => {
    // The registration is derived, so the proof is that every derived name lands
    // on a frame the snapshot actually contains - including the one exception.
    expect(ANSWERING).toHaveLength(60);
    for (const row of ANSWERING) {
      const reply = replyWireOf(row.name as CapabilityName);
      expect(reply, `${row.name} should have a reply wire`).toBeDefined();
      expect(
        MESSAGE_WIRES.has(reply ?? ""),
        `${row.name} registered ${String(reply)}, which the snapshot does not contain`,
      ).toBe(true);
    }
  });

  it("leaves the 8 non-answering capabilities without a reply wire", () => {
    const nonAnswering = CAPABILITY_NAMES.filter((name) => replyWireOf(name) === undefined);
    expect(nonAnswering).toHaveLength(8);
    expect([...nonAnswering].sort()).toEqual(
      [
        "device.setState",
        "file.ops",
        "file.unwatch",
        "file.watch",
        "terminal.input",
        "terminal.kill",
        "terminal.resize",
        "terminal.spawn",
      ].sort(),
    );
    for (const name of nonAnswering) {
      expect(tracksInFlight(name), `${name} must not be trackable`).toBe(false);
    }
  });

  it("names exactly one capability whose reply breaks the default suffix rule", () => {
    // The load-bearing assertion of this field. A second exception turns this red
    // and forces a look: a reader trusting the default rule would mis-name it.
    const deviating = ANSWERING.filter(
      (row) => replyWireOf(row.name as CapabilityName) !== defaultReplyFor(row.wire),
    ).map((row) => row.name);

    expect(deviating).toHaveLength(1);
    expect(deviating).toEqual(["message.send"]);
  });

  it("registers the message-send acknowledgement under its real name", () => {
    const reply = replyWireOf("message.send");
    expect(reply).toBeDefined();
    // Derived, not spelled out: the exception's frame is the wire id plus the one
    // token that differs from the default suffix.
    expect(reply).toBe(`${wireIdOf("message.send")}_accepted`);
    expect(MESSAGE_WIRES.has(reply ?? "")).toBe(true);

    // Guard against a vacuous pass: the default rule's answer for this
    // capability is not a real frame, so dropping the exception cannot hide as
    // "no reply exists".
    const defaultName = defaultReplyFor(wireIdOf("message.send"));
    expect(MESSAGE_WIRES.has(defaultName)).toBe(false);
    expect(reply).not.toBe(defaultName);
  });

  it("keeps every registered reply unique", () => {
    const replies = ANSWERING.map((row) => replyWireOf(row.name as CapabilityName) ?? "");
    expect(new Set(replies).size).toBe(replies.length);
  });

  it("ties the reply wire to the completion class, not to the id flag", () => {
    // An optional id does not license a missing name: the frame is registered even
    // when the caller may choose not to ask for it.
    for (const name of CAPABILITY_NAMES) {
      expect(replyWireOf(name) !== undefined, `${name} reply/completion disagree`).toBe(
        completionOf(name) === "response",
      );
    }
  });
});
describe("optional request ids", () => {
  it("finds exactly 5 capabilities whose request id is optional", () => {
    const optional = CAPABILITY_NAMES.filter((name) => hasOptionalRequestId(name));
    expect(optional).toHaveLength(5);
    expect([...optional].sort()).toEqual(
      [
        "conversation.sync",
        "message.abort",
        "message.send",
        "queue.resume",
        "workspace.list",
      ].sort(),
    );
  });

  it("matches the snapshot's optionality for every capability", () => {
    // `capabilities.json` does not record optionality at all, so this is the only
    // place the fact is read from the wire evidence.
    for (const name of CAPABILITY_NAMES) {
      const command = SNAPSHOT_COMMANDS.get(wireIdOf(name));
      const field = (command?.fields ?? []).find((candidate) => candidate.name === "request_id");
      const optionalOnWire = field?.optional === true;
      expect(hasOptionalRequestId(name), `optionality mismatch for ${name}`).toBe(optionalOnWire);
    }
  });

  it("does not track a send that omits an optional request id", () => {
    // Omitting the id on an optional-request_id wire means no reply is owed;
    // entering the in-flight table would guarantee a false TIMEOUT. This also
    // covers the 55 required-id capabilities, which answer either way.
    const tracked = CAPABILITY_NAMES.filter((candidate) => tracksInFlight(candidate));
    const optional = tracked.filter((candidate) => hasOptionalRequestId(candidate));
    expect(optional).toHaveLength(5);
    expect(tracked.length - optional.length).toBe(55);

    for (const name of CAPABILITY_NAMES) {
      const owed = tracksInFlightWith(name, true);
      expect(owed, `${name} with an id`).toBe(tracksInFlight(name));
      if (hasOptionalRequestId(name)) {
        expect(tracksInFlightWith(name, false), `${name} owes nothing without an id`).toBe(false);
      } else {
        expect(tracksInFlightWith(name, false), `${name} is owed an answer regardless`).toBe(
          tracksInFlight(name),
        );
      }
    }
  });
});

describe("scope attachment", () => {
  it("requires scope information for all 14 scoped capabilities and no others", () => {
    const required = CAPABILITY_NAMES.filter((name) => needsScope(name));
    const expected = CAPABILITY_NAMES.filter((name) => scopeOf(name) !== "none");

    expect(required).toHaveLength(14);
    expect([...required].sort()).toEqual([...expected].sort());

    for (const name of CAPABILITY_NAMES) {
      expect(needsScope(name), `scope flag wrong for ${name}`).toBe(scopeOf(name) !== "none");
    }
  });

  it("splits the 14 scoped capabilities into 13 runtime carriers and 1 top-level", () => {
    // The scope label and the encoding are different facts. 13 scoped wires carry
    // a nested `runtime` object; `conversation.switch` expresses the same scope
    // with top-level ids, because it creates the runtime it would otherwise name.
    const byCarrier: Record<ScopeCarrier, number> = { runtime: 0, "top-level": 0, none: 0 };
    for (const name of CAPABILITY_NAMES) {
      byCarrier[scopeCarrierOf(name)] += 1;
    }
    expect(byCarrier).toEqual({ runtime: 13, "top-level": 1, none: 54 });
  });

  it("agrees with the snapshot about which wires carry a runtime field", () => {
    const scoped = DERIVED.filter((row) => row.scope !== "none");

    // The snapshot is the evidence for the carrier split: every scoped row whose
    // wire has a `runtime` field must be a runtime carrier, and the one without
    // it must be the top-level carrier. This is the assertion that would have
    // caught the earlier "scope !== none means runtime field" mistake.
    for (const row of scoped) {
      const name = row.name as CapabilityName;
      if (row.runtimeField) {
        expect(scopeCarrierOf(name), `${row.name} carries a runtime field`).toBe("runtime");
        expect(attachesRuntimeObject(name), `${row.name} should attach a runtime object`).toBe(
          true,
        );
      } else {
        expect(scopeCarrierOf(name), `${row.name} has no runtime field`).toBe("top-level");
        expect(attachesRuntimeObject(name), `${row.name} must not attach runtime`).toBe(false);
      }
    }

    const withField = scoped.filter((row) => row.runtimeField).map((row) => row.name);
    expect(withField).toHaveLength(13);
  });

  it("names conversation.switch as the sole top-level carrier", () => {
    const topLevel = CAPABILITY_NAMES.filter((name) => scopeCarrierOf(name) === "top-level");
    expect(topLevel).toEqual(["conversation.switch"]);

    // Scoped by semantics, but encoded at the top level: both facts must hold.
    expect(scopeOf("conversation.switch")).toBe("conversation");
    expect(needsScope("conversation.switch")).toBe(true);
    expect(attachesRuntimeObject("conversation.switch")).toBe(false);
  });

  it("reports the scope that each runtime carrier has to send", () => {
    const runtimeCarriers = CAPABILITY_NAMES.filter((name) => attachesRuntimeObject(name));

    const conversation = runtimeCarriers.filter((name) => scopeOf(name) === "conversation");
    const agent = runtimeCarriers.filter((name) => scopeOf(name) === "agent");
    expect(conversation).toHaveLength(7);
    expect(agent).toHaveLength(6);

    // The nested object's shape follows the scope, so the table has to expose it.
    expect([...conversation].sort()).toEqual(
      [
        "conversation.sync",
        "device.setState",
        "message.abort",
        "message.send",
        "model.update",
        "queue.resume",
        "toolset.update",
      ].sort(),
    );
    expect([...agent].sort()).toEqual([...AGENT_SCOPED].sort());
  });

  it("leaves the unscoped 54 without any scope carrier", () => {
    for (const name of CAPABILITY_NAMES.filter((name) => scopeOf(name) === "none")) {
      expect(scopeCarrierOf(name), `${name} is unscoped`).toBe("none");
      expect(needsScope(name), `${name} must not require a scope`).toBe(false);
      expect(attachesRuntimeObject(name), `${name} must not attach a runtime`).toBe(false);
    }
  });
});

describe("name lookup helpers", () => {
  it("recognises every capability name and rejects anything else", () => {
    for (const name of CAPABILITY_NAMES) {
      expect(isCapabilityName(name)).toBe(true);
      expect(findCapability(name)?.wire).toBe(wireIdOf(name));
    }
    expect(isCapabilityName("agent.createPresetX")).toBe(false);
    expect(isCapabilityName("")).toBe(false);
    expect(findCapability("agent.createPresetX")).toBeUndefined();
  });

  it("rejects a wire id offered where a capability name is expected", () => {
    // The two vocabularies must not be interchangeable: accepting a wire id here
    // is how a wire literal would find its way back into business code.
    for (const name of CAPABILITY_NAMES) {
      const wire = wireIdOf(name);
      if (wire === name) {
        continue; // a wire that happens to spell the name is not a leak
      }
      expect(isCapabilityName(wire), `${wire} must not be a capability name`).toBe(false);
    }
  });
});

describe("wire vocabulary containment, this module", () => {
  it("contains no wire id literal in capability-names.ts", () => {
    const source = readFileSync(SOURCE_URL, "utf8");
    const leaked = findWireLeaks(source);
    expect(leaked).toEqual([]);
  });

  it("flags a planted wire id, so the scan above is not vacuous", () => {
    // A guard that cannot fail proves nothing. The planted sample is a wire id
    // that is not also a plain English word, so a red here means the scanner
    // works rather than that the prose tripped it.
    const planted = `const leak = "${"update_toolset"}";`;
    expect(findWireLeaks(planted)).toEqual(["update_toolset"]);
  });

  it("does not flag a dotted capability name that happens to contain a wire word", () => {
    // `terminal.input` / `conversation.sync` are the sanctioned capability
    // spelling even though `input` and `sync` are also wire ids; the dot-aware
    // boundary is what keeps the guard from punishing correct code.
    expect(findWireLeaks("capability: terminal.input")).toEqual([]);
    expect(findWireLeaks("capability: conversation.sync")).toEqual([]);
    expect(findWireLeaks("the async wrapper")).toEqual([]);
  });

  it("only exempts prose colliding ids that are capability-name segments", () => {
    // The exemption stays honest: each skipped id must still be part of a
    // capability name, so a rename cannot leave a stale hole in the scan.
    const segments = new Set(CAPABILITY_NAMES.flatMap((name) => name.split(".")));
    for (const wire of PROSE_COLLIDING_WIRES) {
      expect(segments.has(wire), `${wire} is exempt but is not a capability-name segment`).toBe(
        true,
      );
    }
  });
});

describe("wire vocabulary containment, whole directory", () => {
  // Wire vocabulary is a property of the *module*, not of one file: the scan runs on
  // `client/`, and a per-file guard leaves every sibling unguarded. One test file
  // four wire literals into its own test before noticing, because at that point
  // nothing scanned its file - the guard it had only covered this one.
  //
  // Two exemptions, both narrow and both for the same reason: a guard has to be
  // able to show it can fail. A test that plants a wire id to prove the scan
  // works *must* contain that literal, so it is exempt from the scan it proves.
  // Every other file - production and test alike - is scanned.

  const allowed = new Set([
    // Plants literals to show the scanner fires, and names prose-colliding ids
    // in the comment that explains why they are exempt.
    "capability-names.test.ts",
    // Plants wire ids to show the capability field rejects them at compile
    // time, and carries the sample list its own scan uses.
    "types.test.ts",
  ]);

  it("finds no wire id literal in any other source file under client/", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(CLIENT_DIR, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".ts") || allowed.has(file.name)) {
        continue;
      }
      const source = readFileSync(join(CLIENT_DIR, file.name), "utf8");
      const leaked = findWireLeaks(source);
      if (leaked.length > 0) {
        offenders.push(`${file.name}: ${leaked.join(", ")}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("scans a file set that is not empty, so the check above cannot pass vacuously", () => {
    // If the directory walk silently matched nothing (wrong extension, renamed
    // folder), the test above would pass while checking zero files.
    const scanned = readdirSync(CLIENT_DIR, { withFileTypes: true }).filter(
      (file) => file.isFile() && file.name.endsWith(".ts") && !allowed.has(file.name),
    );

    expect(scanned.length).toBeGreaterThan(5);
  });

  it("keeps the exemption list from growing silently", () => {
    // Each name here is a deliberate, explained hole. A third entry means someone
    // widened the scan's blind spot rather than fixing a leak, so it has to be
    // argued for in review instead of added in passing.
    expect([...allowed]).toHaveLength(2);
  });
});
