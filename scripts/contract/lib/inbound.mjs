/**
 * inbound.mjs - the `parseServerMessage` OR chain and its guard bodies.
 *
 * Input (read only, pinned engine source, v0.6.0 @ 1641a4f):
 *   src/websocket/listener/protocol-inbound.ts  the `parseServerMessage` OR chain
 *   src/websocket/listener/**\/*-inbound.ts     guard bodies (fallback only)
 *
 * Output: the `inbound` slice of the message extraction
 *
 *   {
 *     file:       "src/websocket/listener/protocol-inbound.ts",
 *     function:   "parseServerMessage",
 *     guardCount: 124,                 // OR-chain items, source order
 *     items:      [{guard, type, wire, via}],
 *     accepted:   [wire, ...],         // deduplicated, sorted
 *     unresolved: [{guard, code, message}],
 *   }
 *
 * The inbound set is a *command* set: `parseServerMessage` returns
 * `WsProtocolCommand`, so the 124 OR-chain items resolve to command wire ids.
 * The message union is a different set and is never used to fill it.
 *
 * Resolution order (route doc 08 section 3.2 item 4, seam fact 3):
 *   1. `is<Name>` -> `<Name>` -> type index. The guard files are never passed
 *      to `resolveTypeRef` as `fromFile`, because they live outside `src/types`
 *      and the index answers `unsupported-ref` for them.
 *   2. Only when the index cannot answer, the guard function bodies of
 *      `*-inbound.ts` are scanned for `value.type === "<literal>"` comparisons.
 *   3. Both fail: the guard goes to `unresolved` and the extraction degrades.
 *
 * Failure semantics: I/O problems throw. A missing parser file or a missing
 * `parseServerMessage` body never throws; the slice goes empty, `health.degraded`
 * turns true and `health.unparsed` carries a single-line English reason, so a
 * degraded extraction cannot look like a normal one. The same holds when the
 * chain yields no guard call at all (`guards.some(...)` or any other rewritten
 * layout): a command union with an empty accepted set is never a normal
 * extraction (P5-2). Because a resolved guard always contributes one wire, an
 * empty accepted set can only mean "no guard call" or "every guard unresolved",
 * and both now degrade. A guard call whose argument is not a bare identifier is
 * recorded in `health.coarse` instead of being dropped silently, so a partial
 * chain is visible without by itself turning the slice degraded.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

/** Failure codes reported for an inbound slice that cannot be trusted. */
export const INBOUND_CODES = Object.freeze({
  CHAIN_EMPTY: "inbound-chain-empty",
  GUARD_ARGUMENT_NOT_IDENTIFIER: "guard-argument-is-not-a-bare-identifier",
});

/** File that declares `parseServerMessage`. */
export const INBOUND_FILE = "src/websocket/listener/protocol-inbound.ts";

/** Function whose OR chain is the inbound accepted set. */
export const INBOUND_FUNCTION = "parseServerMessage";

/** Directory that may hold guard functions, engine-root relative posix. */
export const GUARD_DIRECTORY = "src/websocket/listener";

/** Guard files inside `GUARD_DIRECTORY` (`*.test.ts` does not match). */
export const GUARD_FILE_SUFFIX = "-inbound.ts";

/** `is<TypeName>` guard naming convention. */
const GUARD_NAME = /^is[A-Z][A-Za-z0-9_]*$/;

/** Prefix stripped from a guard name to get the type name. */
const GUARD_PREFIX = "is";

/** Synthetic file name for a fragment parsed only to read literals. */
const FRAGMENT_FILE = "__contract-fragment.ts";

/** Failure codes returned by the guard helpers. */
export const GUARD_CODES = Object.freeze({
  GUARD_NAME_INVALID: "guard-name-invalid",
  GUARD_NOT_FOUND: "guard-not-found",
  GUARD_WIRE_MISSING: "guard-wire-missing",
  GUARD_WIRE_AMBIGUOUS: "guard-wire-ambiguous",
});

/**
 * @typedef {{
 *   degraded: boolean,
 *   coarse: string[],
 *   unparsed: string[],
 * }} InboundHealth
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
 * Create the health accumulator, in `snapshot.health` shape.
 *
 * @returns {InboundHealth}
 */
function createHealth() {
  return { degraded: false, coarse: [], unparsed: [] };
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
 * True for the `type` member access of an arbitrary receiver.
 *
 * Covers `value.type` and `value["type"]`, the two shapes the guard functions
 * use.
 *
 * @param {import("typescript").Expression} node
 * @returns {boolean}
 */
function isTypeAccess(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "type";
  }

  return (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "type"
  );
}

/**
 * Collect guard calls from an OR chain text, keeping unreadable calls visible.
 *
 * Accepts a chain fragment (`isA(parsed) || isB(parsed)`), a block or a whole
 * file, because the fragment is parsed as ordinary statements. Comments and
 * string literals cannot contribute a match: only a real call expression whose
 * callee is an `is<UpperCamel>` identifier is collected. Bare-identifier
 * arguments become `names` in source order; a guard call written with any other
 * argument (`isA(parsed.value)`) is returned as a `coarse` entry
 * (`{reason, text, line}`) rather than dropped, because a silently shortened
 * OR chain is exactly the drift this extractor must not hide (P5-2).
 *
 * @param {string} sourceText OR chain text, function body or whole file
 * @returns {{names: string[], coarse: {reason: string, text: string, line: number}[]}}
 */
export function collectGuardCalls(sourceText) {
  /** @type {string[]} */
  const names = [];
  /** @type {{reason: string, text: string, line: number}[]} */
  const coarse = [];

  if (typeof sourceText !== "string" || sourceText.trim().length === 0) {
    return { names, coarse };
  }

  const sourceFile = parseText(FRAGMENT_FILE, sourceText);

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
      return;
    }

    const guard = node.expression.text;

    if (!GUARD_NAME.test(guard)) {
      return;
    }

    if (node.arguments.length === 1 && ts.isIdentifier(node.arguments[0])) {
      names.push(guard);

      return;
    }

    coarse.push({
      reason: INBOUND_CODES.GUARD_ARGUMENT_NOT_IDENTIFIER,
      text: guard,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    });
  });

  return { names, coarse };
}

/**
 * Collect only the guard names of an OR chain text, in source order.
 *
 * Kept as the narrow reader `extract-messages` tests and callers use; the
 * coarse entries of rewritten calls are available through `collectGuardCalls`.
 *
 * @param {string} sourceText OR chain text, function body or whole file
 * @returns {string[]} guard names in source order, duplicates included
 */
export function collectGuardNames(sourceText) {
  return collectGuardCalls(sourceText).names;
}

/**
 * Read the source text of one top-level function declaration, braces included.
 *
 * @param {string} sourceText file text
 * @param {string} functionName declared name
 * @returns {string | null} body text, or null when the function is absent
 */
export function readFunctionBodyText(sourceText, functionName) {
  if (typeof sourceText !== "string" || typeof functionName !== "string") {
    return null;
  }

  const sourceFile = parseText(FRAGMENT_FILE, sourceText);

  /** @type {string | null} */
  let body = null;

  walk(sourceFile, (node) => {
    if (
      body === null &&
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.name.text === functionName &&
      node.body !== undefined
    ) {
      body = node.body.getText(sourceFile);
    }
  });

  return body;
}

/**
 * Read the wire literal out of one guard function body.
 *
 * The body is scanned for `<receiver>.type === "<literal>"` (and the `==` and
 * `["type"]` variants) comparisons. Exactly one distinct literal is a wire id;
 * zero or several are structured failures, never guesses.
 *
 * @param {string} bodyText guard function body text
 * @returns {{ok: true, wire: string} | {ok: false, code: string, message: string}}
 */
export function parseGuardWire(bodyText) {
  const source = typeof bodyText === "string" ? bodyText : "";

  if (source.trim().length === 0) {
    return {
      ok: false,
      code: GUARD_CODES.GUARD_WIRE_MISSING,
      message: "empty guard body",
    };
  }

  /** @type {string[]} */
  const literals = [];

  walk(parseText(FRAGMENT_FILE, source), (node) => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
      isTypeAccess(node.left) &&
      ts.isStringLiteral(node.right)
    ) {
      literals.push(node.right.text);
    }
  });

  const unique = uniqueSorted(literals);

  if (unique.length === 0) {
    return {
      ok: false,
      code: GUARD_CODES.GUARD_WIRE_MISSING,
      message: "guard body compares no `type` field against a string literal",
    };
  }

  if (unique.length > 1) {
    return {
      ok: false,
      code: GUARD_CODES.GUARD_WIRE_AMBIGUOUS,
      message: `guard body accepts multiple wire literals: ${unique.join(", ")}`,
    };
  }

  return { ok: true, wire: unique[0] };
}

/**
 * Find one guard function in a guard file text and read its wire literal.
 *
 * @param {string} sourceText guard file text
 * @param {string} guardName declared guard name, e.g. `isInputCommand`
 * @returns {{ok: true, wire: string} | {ok: false, code: string, message: string}}
 */
export function findGuardWire(sourceText, guardName) {
  const body = readFunctionBodyText(sourceText, guardName);

  if (body === null) {
    return {
      ok: false,
      code: GUARD_CODES.GUARD_NOT_FOUND,
      message: `guard function ${guardName} was not found`,
    };
  }

  return parseGuardWire(body);
}

/**
 * Reverse-lookup one OR-chain guard through the type index.
 *
 * `is<Name>` becomes `<Name>`, `<Name>` is resolved from the injected
 * `fromFile`, and its `type` literal becomes the wire id. The guard files are
 * deliberately not used as `fromFile`: they are outside `src/types`, so the
 * index would answer `unsupported-ref`.
 *
 * @param {{resolveTypeRef?: (ref: string, fromFile: string) => object}} index type index
 * @param {string} guardName guard name as written in the OR chain
 * @param {string} fromFile any indexed file; the union file by convention
 * @returns {{ok: true, type: string, wire: string, home: string}
 *   | {ok: false, type: string, code: string, message: string}}
 */
export function lookupGuardType(index, guardName, fromFile) {
  if (index === null || typeof index !== "object" || typeof index.resolveTypeRef !== "function") {
    return {
      ok: false,
      type: "",
      code: GUARD_CODES.GUARD_NAME_INVALID,
      message: "a type index with resolveTypeRef is required",
    };
  }

  if (typeof guardName !== "string" || !GUARD_NAME.test(guardName)) {
    return {
      ok: false,
      type: "",
      code: GUARD_CODES.GUARD_NAME_INVALID,
      message: `${String(guardName)} is not an is<Name> guard name`,
    };
  }

  const typeName = guardName.slice(GUARD_PREFIX.length);
  const resolved = index.resolveTypeRef(typeName, fromFile);

  if (!resolved.ok) {
    return {
      ok: false,
      type: typeName,
      code: resolved.code,
      message: resolved.message,
    };
  }

  const entry = resolved.entry;

  if (typeof entry.typeLiteral === "string" && entry.typeLiteral.length > 0) {
    return {
      ok: true,
      type: entry.name,
      wire: entry.typeLiteral,
      home: `${entry.file}:${entry.line}`,
    };
  }

  return {
    ok: false,
    type: entry.name,
    code: GUARD_CODES.GUARD_WIRE_MISSING,
    message: `${entry.file}:${entry.line} ${entry.name} has no type literal`,
  };
}

/**
 * Resolve one OR-chain guard to a wire id.
 *
 * The index is asked first (the normal path). Only when the index cannot answer
 * is the guard body scanned, because the guard files live outside `src/types`
 * and the index cannot be pointed at them.
 *
 * @param {object} index type index
 * @param {string} guard guard name as written in the OR chain
 * @param {{file: string, text: string}[]} [guardSources] guard files, sorted
 * @param {string} [fromFile] indexed anchor file for the reverse lookup
 * @returns {{ok: true, item: {guard: string, type: string, wire: string, via: string}}
 *   | {ok: false, unresolved: {guard: string, code: string, message: string}}}
 */
export function resolveInboundGuard(index, guard, guardSources = [], fromFile = "") {
  const viaIndex = lookupGuardType(index, guard, fromFile);

  if (viaIndex.ok) {
    return { ok: true, item: { guard, type: viaIndex.type, wire: viaIndex.wire, via: "index" } };
  }

  let failure = { code: viaIndex.code, message: "no guard file was scanned" };

  for (const source of guardSources) {
    const found = findGuardWire(source.text, guard);

    if (found.ok) {
      return {
        ok: true,
        item: { guard, type: viaIndex.type, wire: found.wire, via: "guard-body" },
      };
    }

    failure = { code: found.code, message: found.message };
  }

  return {
    ok: false,
    unresolved: {
      guard,
      code: viaIndex.code,
      message: `${viaIndex.message}; guard body: ${failure.code} ${failure.message}`,
    },
  };
}

/**
 * List the guard files of one engine tree, sorted.
 *
 * @param {string} root absolute engine root
 * @returns {{file: string, text: string}[]}
 */
function loadGuardSources(root) {
  const directory = path.join(root, ...GUARD_DIRECTORY.split("/"));

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((name) => name.endsWith(GUARD_FILE_SUFFIX))
    .sort(compareStrings)
    .map((name) => ({
      file: `${GUARD_DIRECTORY}/${name}`,
      text: readFileSync(path.join(directory, name), "utf8"),
    }));
}

/**
 * Resolve the inbound accepted set out of `parseServerMessage`.
 *
 * `fromFile` is the indexed anchor used for the `is<Name>` reverse lookup:
 * `extract-messages.mjs` passes the union file, so a bare guard name is looked
 * up globally with the same-file preference the index applies everywhere.
 *
 * @param {object} index type index
 * @param {string} engineRoot engine checkout root
 * @param {string} fromFile indexed anchor file for the reverse lookup
 * @returns {{inbound: object, health: InboundHealth}}
 */
export function extractInboundSet(index, engineRoot, fromFile) {
  const root = path.resolve(engineRoot);
  const health = createHealth();
  /** @type {object} */
  const empty = {
    file: INBOUND_FILE,
    function: INBOUND_FUNCTION,
    guardCount: 0,
    items: [],
    accepted: [],
    unresolved: [],
  };
  const inboundPath = path.join(root, ...INBOUND_FILE.split("/"));

  if (!existsSync(inboundPath)) {
    health.degraded = true;
    health.unparsed.push(
      unparsedLine(INBOUND_FILE, INBOUND_FILE, "file-not-found", "inbound parser file is missing"),
    );

    return { inbound: empty, health };
  }

  const body = readFunctionBodyText(readFileSync(inboundPath, "utf8"), INBOUND_FUNCTION);

  if (body === null) {
    health.degraded = true;
    health.unparsed.push(
      unparsedLine(
        INBOUND_FUNCTION,
        INBOUND_FILE,
        "function-not-found",
        `function ${INBOUND_FUNCTION} is not declared`,
      ),
    );

    return { inbound: empty, health };
  }

  const calls = collectGuardCalls(body);
  const guards = calls.names;

  for (const entry of calls.coarse) {
    health.coarse.push({
      file: INBOUND_FILE,
      line: entry.line,
      symbol: entry.text,
      reason: entry.reason,
    });
  }

  if (guards.length === 0) {
    health.degraded = true;
    health.unparsed.push(
      unparsedLine(
        INBOUND_FUNCTION,
        INBOUND_FILE,
        INBOUND_CODES.CHAIN_EMPTY,
        "the OR chain holds no is<Name>(argument) guard call; the accepted set would be empty",
      ),
    );
  }

  const guardSources = loadGuardSources(root);
  /** @type {object[]} */
  const items = [];
  /** @type {object[]} */
  const unresolved = [];
  const accepted = new Set();

  for (const guard of guards) {
    const result = resolveInboundGuard(index, guard, guardSources, fromFile);

    if (result.ok) {
      items.push(result.item);
      accepted.add(result.item.wire);

      continue;
    }

    unresolved.push(result.unresolved);
    health.degraded = true;
    health.unparsed.push(
      unparsedLine(
        result.unresolved.guard,
        INBOUND_FILE,
        result.unresolved.code,
        result.unresolved.message,
      ),
    );
  }

  return {
    inbound: {
      file: INBOUND_FILE,
      function: INBOUND_FUNCTION,
      guardCount: guards.length,
      items,
      accepted: uniqueSorted([...accepted]),
      unresolved,
    },
    health,
  };
}
