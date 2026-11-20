/**
 * extract-messages.mjs - the server message union and the `file_ops`
 * special case. The inbound OR chain lives in `lib/inbound.mjs`.
 *
 * Input (read only, pinned engine source, v0.6.0 @ 1641a4f):
 *   src/types/**\/*.ts        the type index
 *   src/types/protocol_v2.ts  `WsProtocolMessage` / `WsProtocolCommand`
 *
 * Output, shaped like `extract-commands.mjs` so snapshot assembly consumes both
 * identically:
 *   {
 *     messages: [{ wire, type, home, fields, shapeFingerprint, health }],
 *     counts:   { unionMembers, wireMessages },
 *     union:    { name, file, line, refs } | null,
 *     aliases:  [{ type, home, members }],
 *     inbound:  { file, function, guardCount, items, accepted, unresolved },
 *     special:  { fileOps: { wire, directions } },
 *     health:   { degraded, coarse, unparsed },
 *   }
 *
 * Frozen details worth calling out:
 *   - `WsProtocolMessage` has 127 members, but one of them is the
 *     `CronProtocolResponseMessage` union alias that expands into ten concrete
 *     response wires. The message records therefore number 136: `counts.unionMembers`
 *     keeps the member metric (`counts.messages`), while the record array keeps
 *     one row per wire, because the snapshot validator rejects an empty or
 *     duplicated `wire` (schema.mjs `checkDuplicateWires`).
 *   - Fields follow the command-record convention: top-level properties only, sorted by
 *     name, raw type text, `optional` always present, `nested` / `readonly`
 *     only when true. `inbound` and `fieldLevel` are deliberately absent;
 *     snapshot assembly adds them.
 *   - `file_ops` is dual direction: the same wire literal lives in
 *     `WsProtocolCommand` (c2s) and in `WsProtocolMessage` (s2c). Both
 *     directions are derived from declaration evidence, never assumed, and the
 *     loss of either one is reported as degraded because F-07 is a locked fact.
 *
 * Failure semantics (mirrors `extract-commands.mjs`): I/O problems throw (a
 * missing `src/types` comes from `createTypeIndex`). A missing union or an
 * unresolvable member never throws and never disappears silently: the slice
 * goes empty, `health.degraded` turns true and `health.unparsed` carries a
 * single-line English reason. An ambiguous member keeps a `coarse` record with
 * `wire: null`; the frozen snapshot validator rejects that null wire on
 * purpose, so a degraded extraction cannot produce a plausible snapshot.
 *
 * Seam for the contract gate: `readWireLiteralFromTypeText` here and the guard helpers in
 * `lib/inbound.mjs` only take text (or an injected index), never the file
 * system, so a string fixture can drive the red cases without a real engine
 * checkout.
 */

import path from "node:path";

import ts from "typescript";

import { shapeFingerprint } from "./lib/fingerprint.mjs";
import { extractInboundSet } from "./lib/inbound.mjs";
import { FAILURE_CODES, createTypeIndex } from "./lib/scan.mjs";

/** The server message union (127 members, `protocol_v2.ts:2574`). */
export const MESSAGE_UNION = "WsProtocolMessage";

/** File that declares both unions. */
export const PROTOCOL_TYPES_FILE = "src/types/protocol_v2.ts";

/** Wire literal that is valid in both directions (F-07). */
export const FILE_OPS_WIRE = "file_ops";

/** Client-to-server direction marker. */
const C2S = "c2s";

/** Server-to-client direction marker. */
const S2C = "s2c";

/** The client command union, read only as `file_ops` c2s evidence. */
const COMMAND_UNION = "WsProtocolCommand";

/** Longest alias chain to follow before calling it `unparsed`. */
const MAX_UNION_DEPTH = 4;

/** Synthetic file name for a fragment parsed only to read literals. */
const FRAGMENT_FILE = "__contract-fragment.ts";

/** Synthetic alias name used to wrap a type body text for parsing. */
const PROBE_ALIAS = "__ContractProbe";

/** Failure codes returned by the wire literal helper. */
export const WIRE_CODES = Object.freeze({
  WIRE_LITERAL_MISSING: "wire-literal-missing",
  WIRE_LITERAL_AMBIGUOUS: "wire-literal-ambiguous",
});

/**
 * @typedef {{
 *   name: string,
 *   type: string,
 *   optional: boolean,
 *   nested?: boolean,
 *   readonly?: boolean,
 * }} SnapshotField
 */

/**
 * @typedef {{
 *   wire: string | null,
 *   type: string,
 *   home: string,
 *   fields: SnapshotField[],
 *   shapeFingerprint: string,
 *   health: "ok" | "coarse",
 * }} MessageRecord
 */

/**
 * @typedef {{
 *   degraded: boolean,
 *   coarse: string[],
 *   unparsed: string[],
 * }} Health
 */

/**
 * Code-unit string comparison, so sorting never depends on the host locale.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deduplicate and sort a string array.
 *
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqueSorted(values) {
  return [...new Set(values)].sort(compareStrings);
}

/**
 * Create the extraction health accumulator, in `snapshot.health` shape.
 *
 * @returns {Health}
 */
function createHealth() {
  return { degraded: false, coarse: [], unparsed: [] };
}

/**
 * Merge one health accumulator into another, without losing a degradation.
 *
 * @param {Health} target
 * @param {Health} source
 * @returns {void}
 */
function mergeHealth(target, source) {
  target.degraded = target.degraded || source.degraded;
  target.coarse.push(...source.coarse);
  target.unparsed.push(...source.unparsed);
}

/**
 * One single-line English coarse entry: `<type>@<home>: <reason>`.
 *
 * @param {string} type
 * @param {string} home
 * @param {string} reason
 * @returns {string}
 */
function coarseLine(type, home, reason) {
  return `${type}@${home || "unknown"}: ${reason}`;
}

/**
 * One single-line English unparsed entry: `<ref>@<fromFile>: <code>: <message>`.
 *
 * @param {string} ref
 * @param {string} fromFile
 * @param {string} code
 * @param {string} message
 * @returns {string}
 */
function unparsedLine(ref, fromFile, code, message) {
  return `${ref}@${fromFile}: ${code}: ${message}`;
}

/**
 * Strip namespace and `import("./module").` decoration from a raw member ref.
 * Used only when no entry could be resolved, so the type name is still useful
 * in a coarse record.
 *
 * @param {string} ref raw member text, e.g. `Ns.Type`
 * @returns {string}
 */
function refShortName(ref) {
  if (typeof ref !== "string") {
    return "";
  }

  const normalized = ref.replace(/\s+/g, " ").trim();
  const importMatch = /^import\(["'][^"']+["']\)\.(.+)$/.exec(normalized);
  const qualified = importMatch ? importMatch[1] : normalized;
  const segments = qualified.split(".");
  const last = segments[segments.length - 1];

  return last ?? "";
}

/**
 * Parse one TypeScript text with the frozen syntax-only settings.
 *
 * @param {string} fileName
 * @param {string} text
 * @returns {import("typescript").SourceFile}
 */
function parseText(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * Visit a node and all of its descendants, parents excluded.
 *
 * @param {import("typescript").Node} node
 * @param {(node: import("typescript").Node) => void} visit
 */
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Read the single `type: "<literal>"` string out of a type body text.
 *
 * Wraps the body in a synthetic alias so an object type, an intersection or a
 * bare type literal all parse. Used for a message whose wire literal is not a
 * top-level interface property (`SubagentLaunchResult & { type: "..." }`).
 *
 * @param {string} typeText alias body text, e.g. `A & { type: "x"; }`
 * @returns {{ok: true, wire: string} | {ok: false, code: string, message: string}}
 */
export function readWireLiteralFromTypeText(typeText) {
  const source = typeof typeText === "string" ? typeText.trim() : "";

  if (source.length === 0) {
    return {
      ok: false,
      code: WIRE_CODES.WIRE_LITERAL_MISSING,
      message: "empty type body",
    };
  }

  const sourceFile = parseText(FRAGMENT_FILE, `type ${PROBE_ALIAS} = ${source};`);
  const alias = sourceFile.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === PROBE_ALIAS,
  );

  if (alias === undefined) {
    return {
      ok: false,
      code: WIRE_CODES.WIRE_LITERAL_MISSING,
      message: "type body does not parse as a type expression",
    };
  }

  /** @type {string[]} */
  const literals = [];

  walk(alias.type, (node) => {
    if (
      ts.isPropertySignature(node) &&
      node.name !== undefined &&
      node.name.getText(sourceFile) === "type" &&
      node.type !== undefined &&
      ts.isLiteralTypeNode(node.type) &&
      ts.isStringLiteral(node.type.literal)
    ) {
      literals.push(node.type.literal.text);
    }
  });

  const unique = uniqueSorted(literals);

  if (unique.length === 0) {
    return {
      ok: false,
      code: WIRE_CODES.WIRE_LITERAL_MISSING,
      message: 'type body has no `type: "..."` property',
    };
  }

  if (unique.length > 1) {
    return {
      ok: false,
      code: WIRE_CODES.WIRE_LITERAL_AMBIGUOUS,
      message: `type body has multiple wire literals: ${unique.join(", ")}`,
    };
  }

  return { ok: true, wire: unique[0] };
}

/**
 * Project scan-level fields onto the snapshot field shape.
 *
 * Scan fields carry `{name, type, optional, readonly, nested}` with booleans
 * always present. The snapshot treats `readonly` / `nested` as optional keys and
 * only records the true case, so the JSON stays small and a false flag cannot
 * masquerade as a deliberate `false`. Key order follows the frozen schema order
 * (`name, type, optional, nested, readonly`).
 *
 * @param {object[]} fields scan-level fields
 * @returns {SnapshotField[]}
 */
function canonicalFields(fields) {
  return (Array.isArray(fields) ? fields : [])
    .filter((field) => field !== null && typeof field === "object")
    .map((field) => {
      /** @type {SnapshotField} */
      const canonical = {
        name: typeof field.name === "string" ? field.name : String(field.name ?? ""),
        type: typeof field.type === "string" ? field.type : "",
        optional: Boolean(field.optional),
      };

      if (field.nested) {
        canonical.nested = true;
      }

      if (field.readonly) {
        canonical.readonly = true;
      }

      return canonical;
    })
    .sort((left, right) => compareStrings(left.name, right.name));
}

/**
 * Flatten one union into concrete entries, following alias members.
 *
 * A member that is itself a union alias (the command side has
 * `CronProtocolCommand`, the message side has `CronProtocolResponseMessage`)
 * contributes no wire of its own, so it is expanded in place against the file
 * that declares the alias. Resolved entries keep declaration order; the alias
 * list is reported separately so `counts.unionMembers` and the wire record
 * count can differ visibly.
 *
 * Failure handling is the command-extraction one: an ambiguous member is returned in
 * `unresolved` (it keeps a coarse record), everything else drops to
 * `health.unparsed` and marks the extraction degraded.
 *
 * @param {object} index type index
 * @param {{members: object[]}} union result of `resolveUnion`
 * @param {Health} health shared accumulator
 * @returns {{entries: object[], aliases: object[], unresolved: object[]}}
 */
function flattenUnion(index, union, health) {
  /** @type {object[]} */
  const entries = [];
  /** @type {object[]} */
  const aliases = [];
  /** @type {object[]} */
  const unresolved = [];
  const visited = new Set();

  /**
   * @param {object} member resolved or failed union member
   * @param {number} depth alias nesting depth
   */
  function visitMember(member, depth) {
    if (!member || member.ok !== true || !member.entry) {
      if (member && member.code === FAILURE_CODES.AMBIGUOUS_SYMBOL) {
        unresolved.push(member);

        return;
      }

      health.degraded = true;
      health.unparsed.push(
        unparsedLine(
          String(member?.ref ?? "unknown"),
          PROTOCOL_TYPES_FILE,
          String(member?.code ?? FAILURE_CODES.UNRESOLVED_SYMBOL),
          String(member?.message ?? "member could not be resolved"),
        ),
      );

      return;
    }

    const entry = member.entry;
    const isAlias =
      entry.kind === "type" && Array.isArray(entry.unionMembers) && entry.unionMembers.length > 0;

    if (!isAlias) {
      entries.push(entry);

      return;
    }

    if (depth >= MAX_UNION_DEPTH) {
      health.degraded = true;
      health.unparsed.push(
        unparsedLine(
          entry.name,
          entry.file,
          "union-depth",
          `alias nesting exceeds ${MAX_UNION_DEPTH}`,
        ),
      );

      return;
    }

    const key = `${entry.file}:${entry.line}:${entry.qualifiedName ?? entry.name}`;

    if (visited.has(key)) {
      health.degraded = true;
      health.unparsed.push(
        unparsedLine(entry.name, entry.file, "union-cycle", `union alias ${entry.name} is cyclic`),
      );

      return;
    }

    visited.add(key);
    aliases.push({
      type: entry.name,
      home: `${entry.file}:${entry.line}`,
      members: [...entry.unionMembers],
    });

    for (const innerRef of entry.unionMembers) {
      visitMember(index.resolveTypeRef(innerRef, entry.file), depth + 1);
    }
  }

  for (const member of union.members) {
    visitMember(member, 0);
  }

  return { entries, aliases, unresolved };
}

/**
 * Read the wire literal of one resolved entry.
 *
 * @param {object} entry type-index entry
 * @returns {{ok: true, wire: string} | {ok: false, code: string, message: string}}
 */
function resolveRecordWire(entry) {
  if (typeof entry.typeLiteral === "string" && entry.typeLiteral.length > 0) {
    return { ok: true, wire: entry.typeLiteral };
  }

  return readWireLiteralFromTypeText(entry.bodyText);
}

/**
 * Build one `coarse` record for a member that resolved ambiguously.
 *
 * `wire` is null on purpose: the frozen snapshot validator rejects it, so the
 * degradation cannot slip into a snapshot as if it were fine.
 *
 * @param {{ref?: string, candidates?: string[]}} member
 * @returns {MessageRecord}
 */
function buildUnresolvedMessageRecord(member) {
  const candidates = Array.isArray(member.candidates) ? member.candidates : [];

  return {
    wire: null,
    type: refShortName(member.ref ?? ""),
    home: candidates[0] ?? "",
    fields: [],
    shapeFingerprint: shapeFingerprint(""),
    health: "coarse",
  };
}

/**
 * Derive the `file_ops` special case from declaration evidence.
 *
 * c2s evidence: the wire literal is a member of `WsProtocolCommand`.
 * s2c evidence: the wire literal is one of the extracted message records.
 * Neither direction is hard-coded (F-07 is a fact to re-derive, not to copy).
 * Command-side member problems belong to `extract-commands.mjs`, so a scratch
 * health accumulator swallows them; only the union itself is reported here.
 *
 * @param {object} index type index
 * @param {MessageRecord[]} messages extracted message records
 * @param {Health} health shared accumulator
 * @returns {{wire: string, directions: string[]}}
 */
function resolveFileOps(index, messages, health) {
  const commandUnion = index.resolveUnion(COMMAND_UNION, PROTOCOL_TYPES_FILE);
  const commandWires = new Set();

  if (commandUnion.ok) {
    for (const entry of flattenUnion(index, commandUnion, createHealth()).entries) {
      if (typeof entry.typeLiteral === "string") {
        commandWires.add(entry.typeLiteral);
      }
    }
  } else {
    health.degraded = true;
    health.unparsed.push(
      unparsedLine(
        COMMAND_UNION,
        PROTOCOL_TYPES_FILE,
        String(commandUnion.code ?? FAILURE_CODES.UNION_NOT_FOUND),
        String(commandUnion.message ?? "union could not be resolved"),
      ),
    );
  }

  /** @type {string[]} */
  const directions = [];

  if (commandWires.has(FILE_OPS_WIRE)) {
    directions.push(C2S);
  }

  if (messages.some((message) => message.wire === FILE_OPS_WIRE)) {
    directions.push(S2C);
  }

  directions.sort(compareStrings);

  if (directions.length !== 2) {
    health.degraded = true;
    health.coarse.push(
      coarseLine(
        FILE_OPS_WIRE,
        PROTOCOL_TYPES_FILE,
        `direction evidence covers ${directions.length === 0 ? "neither direction" : directions.join(" only")}`,
      ),
    );
  }

  return { wire: FILE_OPS_WIRE, directions };
}

/**
 * Extract the message union and `file_ops` from one engine tree.
 *
 * `index` is optional so snapshot assembly can reuse one index for commands,
 * messages and parity instead of parsing `src/types` three times. The inbound OR
 * chain is
 * delegated to `lib/inbound.mjs` and merged back, so this module stays the one
 * entry point snapshot assembly calls.
 *
 * @param {{engineRoot?: string, index?: object | null}} [options]
 * @returns {{
 *   messages: MessageRecord[],
 *   counts: {unionMembers: number, wireMessages: number},
 *   union: {name: string, file: string, line: number, refs: string[]} | null,
 *   aliases: {type: string, home: string, members: string[]}[],
 *   inbound: object,
 *   special: {fileOps: {wire: string, directions: string[]}},
 *   health: Health,
 * }} see the module header for the exact shape
 */
export function extractMessages({ engineRoot, index = null } = {}) {
  if (typeof engineRoot !== "string" || engineRoot.length === 0) {
    throw new TypeError("extractMessages: engineRoot must be a non-empty string");
  }

  const root = path.resolve(engineRoot);
  const typeIndex = index ?? createTypeIndex(root);
  const health = createHealth();
  const union = typeIndex.resolveUnion(MESSAGE_UNION, PROTOCOL_TYPES_FILE);
  /** @type {MessageRecord[]} */
  const messages = [];
  /** @type {object[]} */
  let aliases = [];

  if (!union.ok) {
    health.degraded = true;
    health.unparsed.push(
      unparsedLine(
        MESSAGE_UNION,
        PROTOCOL_TYPES_FILE,
        String(union.code ?? FAILURE_CODES.UNION_NOT_FOUND),
        String(union.message ?? "union could not be resolved"),
      ),
    );
  } else {
    const flat = flattenUnion(typeIndex, union, health);
    aliases = flat.aliases;

    for (const entry of flat.entries) {
      const wire = resolveRecordWire(entry);

      if (!wire.ok) {
        health.degraded = true;
        health.unparsed.push(unparsedLine(entry.name, entry.file, wire.code, wire.message));

        continue;
      }

      // An interface body flattens into fields directly; anything else (today
      // the `SubagentLaunchResult & {...}` alias) keeps the recovered wire but
      // cannot report fields, which route doc 08 section 3.2 item 5 calls coarse.
      const recordHealth = entry.kind === "interface" ? "ok" : "coarse";
      const home = `${entry.file}:${entry.line}`;

      if (recordHealth === "coarse") {
        health.coarse.push(
          coarseLine(entry.name, home, `fields are not flattened from a ${entry.kind} alias`),
        );
      }

      // A base class that could not be merged hides fields; the scan index holds
      // the reason, and repeating it here ties the line to a real record.
      for (const problem of Array.isArray(entry.heritageProblems) ? entry.heritageProblems : []) {
        health.coarse.push(problem);
      }

      messages.push({
        wire: wire.wire,
        type: entry.name,
        home,
        fields: canonicalFields(entry.fields),
        shapeFingerprint: shapeFingerprint(entry.bodyText),
        health: recordHealth,
      });
    }

    for (const member of flat.unresolved) {
      const record = buildUnresolvedMessageRecord(member);

      health.coarse.push(
        coarseLine(
          record.type,
          record.home,
          `${String(member.code ?? FAILURE_CODES.AMBIGUOUS_SYMBOL)}: ${String(
            member.message ?? "member resolved ambiguously",
          )}`,
        ),
      );
      messages.push(record);
    }
  }

  messages.sort((left, right) => {
    const byWire = compareStrings(left.wire ?? "", right.wire ?? "");

    return byWire === 0 ? compareStrings(left.type, right.type) : byWire;
  });

  const wireHomes = new Map();

  for (const message of messages) {
    if (message.wire === null) {
      continue;
    }

    const seen = wireHomes.get(message.wire);

    if (seen === undefined) {
      wireHomes.set(message.wire, message.home);
    } else {
      health.coarse.push(
        coarseLine(message.type, message.home, `duplicate wire ${message.wire}, also at ${seen}`),
      );
    }
  }

  const inbound = extractInboundSet(typeIndex, root, PROTOCOL_TYPES_FILE);
  mergeHealth(health, inbound.health);

  const fileOps = resolveFileOps(typeIndex, messages, health);

  health.coarse.sort(compareStrings);
  health.unparsed.sort(compareStrings);

  return {
    messages,
    counts: {
      unionMembers: union.ok ? union.members.length : 0,
      wireMessages: messages.length,
    },
    union: union.ok
      ? {
          name: union.name,
          file: union.fromFile,
          line: union.line,
          refs: union.members.map((member) => member.ref),
        }
      : null,
    aliases,
    inbound: inbound.inbound,
    special: { fileOps },
    health,
  };
}
