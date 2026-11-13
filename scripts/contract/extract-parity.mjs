/**
 * extract-parity.mjs - parity and startup-text extraction.
 *
 * Three frozen facts about the pinned engine are extracted here, all by syntax
 * only (`ts.createSourceFile`, no Program, no type checker, no module
 * resolution), matching the seam policy of A2-D04:
 *
 *   1. `src/websocket/listener/listener-constants.ts`
 *        SUPPORTED_REMOTE_COMMANDS            -> remoteCommands.advertised
 *        REMOTE_COMMANDS_HANDLED_ELSEWHERE    -> remoteCommands.handledElsewhere
 *        UNADVERTISED_REMOTE_COMMAND_ALIASES  -> remoteCommands.unadvertisedAliases
 *
 *   2. `src/websocket/listener/commands.ts`
 *        `case "<id>":` labels of the `switch (command.command_id)` inside
 *        `handleExecuteCommand`             -> remoteCommands.dispatchCases
 *
 *   3. `src/cli/subcommands/app-server.ts`
 *        the `console.log(...)` template literals inside the `onListening`
 *        callback -> startupText.required / startupText.optional
 *
 * The three parity invariants live in `./lib/parity-rules.mjs`; they are copied
 * from the engine's own `commands-dispatch-parity.test.ts`, not invented. This
 * file re-exports the evaluator so the parity seam stays one module.
 *
 * Nothing here hardcodes a count: every number in a report is a length of an
 * extracted array. Regexes for the startup lines are derived from the template
 * literals in `app-server.ts` (see `shapeFromChunks`), so the only pinned
 * vocabulary is the URL token below.
 *
 * Failure semantics (route doc 08 section 3.2 step 8): a missing symbol is a
 * structured `{ ok: false, code }` result, never a thrown exception and never
 * an empty "looks fine" object. Exit code 2 is the caller's decision; single
 * unparseable entries land in `health.coarse` and the rest of the extraction
 * continues.
 *
 * Seam for snapshot assembly and the gate fixtures:
 *
 *   import { extractParity } from "./contract/extract-parity.mjs";
 *
 *   const parity = extractParity({ engineRoot: "_research/haruyuki" });
 *   if (!parity.ok) // parity.code / parity.file / parity.symbol: upstream exit 2
 *   else parity.remoteCommands, parity.startupText, parity.consistency, parity.counts;
 *
 * The pure parsers (`parseRemoteConstants`, `parseDispatchCases`,
 * `parseStartupLines`) take source text, so the contract replay fixture strings
 * without copying the engine tree.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { checkParityConsistency, compareStrings } from "./lib/parity-rules.mjs";

export { checkParityConsistency };

/** Engine-root relative sources, in parse order. */
export const PARITY_SOURCES = Object.freeze({
  constants: "src/websocket/listener/listener-constants.ts",
  commands: "src/websocket/listener/commands.ts",
  startup: "src/cli/subcommands/app-server.ts",
});

/** Symbols the extractor must find. A miss is an upstream exit 2. */
export const PARITY_SYMBOLS = Object.freeze({
  advertised: "SUPPORTED_REMOTE_COMMANDS",
  handledElsewhere: "REMOTE_COMMANDS_HANDLED_ELSEWHERE",
  unadvertisedAliases: "UNADVERTISED_REMOTE_COMMAND_ALIASES",
  dispatchFunction: "handleExecuteCommand",
  dispatchSwitchExpression: "command.command_id",
  startupHandler: "onListening",
});

/** Structured failure codes. None of these is thrown. */
export const PARITY_FAILURE_CODES = Object.freeze({
  INVALID_ENGINE_ROOT: "invalid-engine-root",
  ENGINE_SOURCE_MISSING: "engine-source-missing",
  CONSTANT_NOT_FOUND: "constant-not-found",
  CONSTANT_NOT_ARRAY: "constant-not-array",
  CONSTANT_ELEMENT_NOT_LITERAL: "constant-element-not-literal",
  CONSTANT_NOT_OBJECT: "constant-not-object",
  DISPATCH_FUNCTION_NOT_FOUND: "dispatch-function-not-found",
  DISPATCH_SWITCH_NOT_FOUND: "dispatch-switch-not-found",
  STARTUP_HANDLER_NOT_FOUND: "startup-handler-not-found",
  STARTUP_LINE_NOT_TEXT: "startup-line-not-text",
  STARTUP_LINES_EMPTY: "startup-lines-empty",
});

/**
 * Replacement for an interpolation whose property name ends in `url`.
 *
 * `onListening` receives `AppServerListeningInfo`, whose `url` and `controlUrl`
 * are both built from the `ws://` base URL in `src/websocket/app-server.ts`
 * (`const baseUrl = \`ws://${listen.host}:${address.port}\``). The startup
 * contract therefore pins those to a WebSocket URL token; any other
 * interpolation stays a generic non-space token.
 */
const URL_TOKEN = "ws://\\S+";

/** Replacement for every other interpolation. */
const GENERIC_TOKEN = "\\S+";

/** `console.log` target expression. */
const CONSOLE_OBJECT = "console";
const CONSOLE_METHOD = "log";

/**
 * @param {string} value
 * @returns {string} value with backslashes normalised to posix separators
 */
function toPosix(value) {
  return value.replaceAll("\\", "/");
}

/**
 * @param {string} value
 * @returns {string} every whitespace run collapsed to one space, trimmed
 */
function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Parse one TypeScript source text with the frozen syntax-only settings.
 *
 * @param {string} file engine-root relative posix path, used in messages
 * @param {string} text source text
 * @returns {import("typescript").SourceFile}
 */
function createSourceFile(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * 1-based line of a node, for `coarse` entries.
 *
 * @param {import("typescript").Node} node
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {number}
 */
function lineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Depth-first search for the first node matching a predicate.
 *
 * @param {import("typescript").Node | undefined} root
 * @param {(node: import("typescript").Node) => boolean} predicate
 * @returns {import("typescript").Node | null}
 */
function findNode(root, predicate) {
  /** @type {import("typescript").Node | null} */
  let found = null;

  /**
   * @param {import("typescript").Node} node
   * @returns {void}
   */
  function visit(node) {
    if (found !== null) {
      return;
    }

    if (predicate(node)) {
      found = node;
      return;
    }

    node.forEachChild(visit);
  }

  if (root) {
    visit(root);
  }

  return found;
}

/**
 * Strip wrappers that do not change the value of an initializer.
 *
 * @param {import("typescript").Expression | undefined} node
 * @returns {import("typescript").Expression | undefined}
 */
function unwrapExpression(node) {
  let current = node;

  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }

  return current;
}

/**
 * `"a" + "b"` style concatenation, evaluated to the flat string.
 *
 * @param {import("typescript").Expression | undefined} node
 * @returns {string | null} `null` when the expression is not a literal concat
 */
function evaluateStringExpression(node) {
  const expression = unwrapExpression(node);

  if (!expression) {
    return null;
  }

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateStringExpression(expression.left);
    const right = evaluateStringExpression(expression.right);

    if (left === null || right === null) {
      return null;
    }

    return left + right;
  }

  return null;
}

/**
 * Property name of an object member, or `null` for a computed name.
 *
 * @param {import("typescript").PropertyName | undefined} name
 * @returns {string | null}
 */
function propertyNameText(name) {
  if (!name) {
    return null;
  }

  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return null;
}

/**
 * Find `const <name> = ...` (or `let` / `var`).
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} name
 * @returns {import("typescript").VariableDeclaration | null}
 */
function findVariableDeclaration(sourceFile, name) {
  const node = findNode(
    sourceFile,
    (candidate) =>
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === name,
  );

  return node ? /** @type {import("typescript").VariableDeclaration} */ (node) : null;
}

/**
 * Build the structured failure every parser returns instead of throwing.
 *
 * @param {string} code
 * @param {{file?: string, symbol?: string, message?: string}} [detail]
 * @returns {{
 *   ok: false, code: string, file: string, symbol: string, message: string,
 *   health: { degraded: true, coarse: object[], unparsed: {file: string, symbol: string}[] },
 * }}
 */
function failure(code, detail = {}) {
  const file = detail.file ?? "";
  const symbol = detail.symbol ?? "";

  return {
    ok: false,
    code,
    file,
    symbol,
    message: detail.message ?? `parity extraction failed: ${code}`,
    health: {
      degraded: true,
      coarse: [],
      unparsed: symbol || file ? [{ file, symbol }] : [],
    },
  };
}

/**
 * Read the `readonly string[]` initializer of one constant.
 *
 * Order is preserved: the advertised list is a declaration-order fact, so it is
 * never sorted here. A non-literal element is a failure, because silently
 * dropping it would shrink a list that gates client controls.
 *
 * @param {import("typescript").VariableDeclaration} declaration
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} file
 * @param {string} symbol
 * @returns {{ ok: true, values: string[] } | ReturnType<typeof failure>}
 */
function readStringArray(declaration, sourceFile, file, symbol) {
  const initializer = unwrapExpression(declaration.initializer);

  if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
    return failure(PARITY_FAILURE_CODES.CONSTANT_NOT_ARRAY, {
      file,
      symbol,
      message: `${symbol} is not initialised with an array literal`,
    });
  }

  /** @type {string[]} */
  const values = [];

  for (const element of initializer.elements) {
    const value = evaluateStringExpression(element);

    if (value === null) {
      const line = lineOf(element, sourceFile);

      return failure(PARITY_FAILURE_CODES.CONSTANT_ELEMENT_NOT_LITERAL, {
        file,
        symbol,
        message: `${symbol} has a non-literal element at ${file}:${line}: ${collapseWhitespace(element.getText(sourceFile))}`,
      });
    }

    values.push(value);
  }

  return { ok: true, values };
}

/**
 * Read the `Record<string, string>` initializer of one constant.
 *
 * Values are flattened and whitespace-collapsed to a single line, so the
 * snapshot does not inherit the engine's line wrapping. A value that is not a
 * literal concatenation keeps its key but is recorded in `coarse` instead of
 * disappearing.
 *
 * @param {import("typescript").VariableDeclaration} declaration
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} file
 * @param {string} symbol
 * @returns {{ ok: true, record: Record<string, string>, coarse: object[] } | ReturnType<typeof failure>}
 */
function readReasonRecord(declaration, sourceFile, file, symbol) {
  const initializer = unwrapExpression(declaration.initializer);

  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    return failure(PARITY_FAILURE_CODES.CONSTANT_NOT_OBJECT, {
      file,
      symbol,
      message: `${symbol} is not initialised with an object literal`,
    });
  }

  /** @type {Record<string, string>} */
  const record = {};
  /** @type {object[]} */
  const coarse = [];

  for (const property of initializer.properties) {
    if (!ts.isPropertyAssignment(property)) {
      coarse.push({
        file,
        line: lineOf(property, sourceFile),
        symbol,
        reason: "property-is-not-an-assignment",
        text: collapseWhitespace(property.getText(sourceFile)),
      });
      continue;
    }

    const key = propertyNameText(property.name);

    if (key === null) {
      coarse.push({
        file,
        line: lineOf(property, sourceFile),
        symbol,
        reason: "computed-property-name",
        text: collapseWhitespace(property.getText(sourceFile)),
      });
      continue;
    }

    const value = evaluateStringExpression(property.initializer);

    if (value === null) {
      coarse.push({
        file,
        line: lineOf(property, sourceFile),
        symbol,
        key,
        reason: "value-is-not-a-string-literal",
        text: collapseWhitespace(property.initializer.getText(sourceFile)),
      });
      record[key] = collapseWhitespace(property.initializer.getText(sourceFile));
      continue;
    }

    record[key] = collapseWhitespace(value);
  }

  return { ok: true, record, coarse };
}

/**
 * Parse `listener-constants.ts`.
 *
 * @param {string} text source text of the constants file
 * @param {string} [file] engine-root relative path, for messages
 * @returns {{
 *   ok: true, file: string,
 *   advertised: string[],
 *   handledElsewhere: Record<string, string>,
 *   unadvertisedAliases: Record<string, string>,
 *   coarse: object[],
 * } | ReturnType<typeof failure>}
 */
export function parseRemoteConstants(text, file = PARITY_SOURCES.constants) {
  const sourceFile = createSourceFile(file, text);

  const advertisedNode = findVariableDeclaration(sourceFile, PARITY_SYMBOLS.advertised);

  if (!advertisedNode) {
    return failure(PARITY_FAILURE_CODES.CONSTANT_NOT_FOUND, {
      file,
      symbol: PARITY_SYMBOLS.advertised,
      message: `${PARITY_SYMBOLS.advertised} is not declared in ${file}`,
    });
  }

  const advertised = readStringArray(advertisedNode, sourceFile, file, PARITY_SYMBOLS.advertised);

  if (!advertised.ok) {
    return advertised;
  }

  const handledNode = findVariableDeclaration(sourceFile, PARITY_SYMBOLS.handledElsewhere);

  if (!handledNode) {
    return failure(PARITY_FAILURE_CODES.CONSTANT_NOT_FOUND, {
      file,
      symbol: PARITY_SYMBOLS.handledElsewhere,
      message: `${PARITY_SYMBOLS.handledElsewhere} is not declared in ${file}`,
    });
  }

  const handled = readReasonRecord(handledNode, sourceFile, file, PARITY_SYMBOLS.handledElsewhere);

  if (!handled.ok) {
    return handled;
  }

  const aliasesNode = findVariableDeclaration(sourceFile, PARITY_SYMBOLS.unadvertisedAliases);

  if (!aliasesNode) {
    return failure(PARITY_FAILURE_CODES.CONSTANT_NOT_FOUND, {
      file,
      symbol: PARITY_SYMBOLS.unadvertisedAliases,
      message: `${PARITY_SYMBOLS.unadvertisedAliases} is not declared in ${file}`,
    });
  }

  const aliases = readReasonRecord(
    aliasesNode,
    sourceFile,
    file,
    PARITY_SYMBOLS.unadvertisedAliases,
  );

  if (!aliases.ok) {
    return aliases;
  }

  return {
    ok: true,
    file,
    advertised: advertised.values,
    handledElsewhere: handled.record,
    unadvertisedAliases: aliases.record,
    coarse: [...handled.coarse, ...aliases.coarse],
  };
}

/**
 * Parse the dispatch switch of `handleExecuteCommand`.
 *
 * Only the switch whose expression is `command.command_id` is measured, which
 * is the same scope the engine's parity test pins. `case` labels that are not
 * plain string literals cannot be pinned as wire ids: they are kept out of
 * `dispatchCases` and reported in `coarse` (with their line) instead of being
 * silently stringified.
 *
 * @param {string} text source text of the commands file
 * @param {string} [file] engine-root relative path, for messages
 * @returns {{
 *   ok: true, file: string, dispatchCases: string[], coarse: object[],
 * } | ReturnType<typeof failure>}
 */
export function parseDispatchCases(text, file = PARITY_SOURCES.commands) {
  const sourceFile = createSourceFile(file, text);

  const dispatchFunction = findNode(
    sourceFile,
    (candidate) =>
      ts.isFunctionDeclaration(candidate) &&
      candidate.name !== undefined &&
      candidate.name.text === PARITY_SYMBOLS.dispatchFunction,
  );

  if (!dispatchFunction || !ts.isFunctionDeclaration(dispatchFunction)) {
    return failure(PARITY_FAILURE_CODES.DISPATCH_FUNCTION_NOT_FOUND, {
      file,
      symbol: PARITY_SYMBOLS.dispatchFunction,
      message: `${PARITY_SYMBOLS.dispatchFunction} is not declared in ${file}`,
    });
  }

  const dispatchSwitch = findNode(
    dispatchFunction.body,
    (candidate) =>
      ts.isSwitchStatement(candidate) &&
      collapseWhitespace(candidate.expression.getText(sourceFile)) ===
        PARITY_SYMBOLS.dispatchSwitchExpression,
  );

  if (!dispatchSwitch || !ts.isSwitchStatement(dispatchSwitch)) {
    return failure(PARITY_FAILURE_CODES.DISPATCH_SWITCH_NOT_FOUND, {
      file,
      symbol: PARITY_SYMBOLS.dispatchSwitchExpression,
      message: `no switch (${PARITY_SYMBOLS.dispatchSwitchExpression}) inside ${PARITY_SYMBOLS.dispatchFunction}`,
    });
  }

  /** @type {Set<string>} */
  const cases = new Set();
  /** @type {object[]} */
  const coarse = [];

  for (const clause of dispatchSwitch.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) {
      continue;
    }

    const label = unwrapExpression(clause.expression);

    if (label && (ts.isStringLiteral(label) || ts.isNoSubstitutionTemplateLiteral(label))) {
      cases.add(label.text);
      continue;
    }

    coarse.push({
      file,
      line: lineOf(clause, sourceFile),
      symbol: PARITY_SYMBOLS.dispatchFunction,
      reason: "case-label-is-not-a-string-literal",
      text: collapseWhitespace(clause.expression.getText(sourceFile)),
    });
  }

  return {
    ok: true,
    file,
    dispatchCases: [...cases].sort(compareStrings),
    coarse,
  };
}

/**
 * True for a nested function, so the startup scan never leaves the handler.
 *
 * @param {import("typescript").Node} node
 * @returns {boolean}
 */
function isFunctionNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * @param {import("typescript").Node} node
 * @returns {boolean} true for a `console.log(...)` call expression
 */
function isConsoleLogCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === CONSOLE_OBJECT &&
    node.expression.name.text === CONSOLE_METHOD
  );
}

/**
 * Collect `console.log` calls inside the startup handler, tracking whether each
 * one is guarded by an `if` (that is what makes a startup line optional).
 *
 * @param {import("typescript").Node} root
 * @returns {{ call: import("typescript").CallExpression, conditional: boolean }[]}
 */
function collectStartupCalls(root) {
  /** @type {{ call: import("typescript").CallExpression, conditional: boolean }[]} */
  const calls = [];

  /**
   * @param {import("typescript").Node} node
   * @param {boolean} conditional
   * @returns {void}
   */
  function visit(node, conditional) {
    const guarded = conditional || ts.isIfStatement(node) || ts.isConditionalExpression(node);

    if (isConsoleLogCall(node)) {
      calls.push({ call: node, conditional: guarded });
    }

    node.forEachChild((child) => {
      if (isFunctionNode(child)) {
        return;
      }

      visit(child, guarded);
    });
  }

  visit(root, false);

  return calls;
}

/**
 * Split a startup log argument into literal and interpolation chunks.
 *
 * @param {import("typescript").Expression | undefined} node
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {Array<{ kind: "text", text: string } | { kind: "expression", text: string }> | null}
 */
function templateChunks(node, sourceFile) {
  const expression = unwrapExpression(node);

  if (!expression) {
    return null;
  }

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [{ kind: "text", text: expression.text }];
  }

  if (ts.isTemplateExpression(expression)) {
    const chunks = [{ kind: "text", text: expression.head.text }];

    for (const span of expression.templateSpans) {
      chunks.push({
        kind: "expression",
        text: collapseWhitespace(span.expression.getText(sourceFile)),
      });
      chunks.push({ kind: "text", text: span.literal.text });
    }

    return chunks;
  }

  return null;
}

/**
 * Escape one literal chunk for a regular expression. A whitespace run right
 * after a `:` becomes `\s+` (label separators are allowed to breathe), every
 * other run collapses to one literal space.
 *
 * @param {string} text
 * @returns {string}
 */
function literalToRegex(text) {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (/\s/.test(char)) {
      let end = index;

      while (end < text.length && /\s/.test(text[end])) {
        end += 1;
      }

      out += index > 0 && text[index - 1] === ":" ? "\\s+" : " ";
      index = end;
      continue;
    }

    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }

  return out;
}

/**
 * Escape literal text without the whitespace rule (used for label prefixes).
 *
 * @param {string} text
 * @returns {string}
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Placeholder for one interpolation. A `*url` property is pinned to the
 * WebSocket URL token; anything else is a generic non-space token.
 *
 * @param {string} expressionText raw expression text, e.g. "info.controlUrl"
 * @returns {string}
 */
function placeholderFor(expressionText) {
  const segments = expressionText.split(".");
  const property = segments[segments.length - 1] ?? "";

  return /url$/i.test(property) ? `(${URL_TOKEN})` : `(${GENERIC_TOKEN})`;
}

/**
 * Build the full-shape regex and the label-prefix regex of one startup line.
 *
 * The full shape anchors both ends and replaces every interpolation with a
 * capture group, so `^Listening on (ws://\S+)$` matches the real stdout line.
 * The prefix form keeps only the literal text before the first interpolation
 * (trimmed), which is what the optional line pins: it is emitted behind
 * `--openai-api` and its payload is a derived origin plus a path.
 *
 * @param {Array<{ kind: "text", text: string } | { kind: "expression", text: string }>} chunks
 * @returns {{ full: string, prefix: string }}
 */
function shapeFromChunks(chunks) {
  let full = "^";

  for (const chunk of chunks) {
    full += chunk.kind === "text" ? literalToRegex(chunk.text) : placeholderFor(chunk.text);
  }

  full += "$";

  const first = chunks[0];
  const prefix = `^${first && first.kind === "text" ? escapeRegex(first.text.trimEnd()) : ""}`;

  return { full, prefix };
}

/**
 * Parse the startup declarations of `app-server.ts`.
 *
 * Required lines are the unguarded `console.log` calls inside `onListening`;
 * the optional ones are the calls behind an `if`. The frozen contract is two
 * required lines and one optional line, but this function reports whatever the
 * source says - the count is never assumed.
 *
 * @param {string} text source text of the app-server subcommand file
 * @param {string} [file] engine-root relative path, for messages
 * @returns {{
 *   ok: true, file: string, required: string[], optional: string[],
 * } | ReturnType<typeof failure>}
 */
export function parseStartupLines(text, file = PARITY_SOURCES.startup) {
  const sourceFile = createSourceFile(file, text);

  const handler = findNode(
    sourceFile,
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      propertyNameText(candidate.name) === PARITY_SYMBOLS.startupHandler,
  );

  if (!handler || !ts.isPropertyAssignment(handler)) {
    return failure(PARITY_FAILURE_CODES.STARTUP_HANDLER_NOT_FOUND, {
      file,
      symbol: PARITY_SYMBOLS.startupHandler,
      message: `${PARITY_SYMBOLS.startupHandler} is not declared in ${file}`,
    });
  }

  const callback = unwrapExpression(handler.initializer);

  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
    return failure(PARITY_FAILURE_CODES.STARTUP_HANDLER_NOT_FOUND, {
      file,
      symbol: PARITY_SYMBOLS.startupHandler,
      message: `${PARITY_SYMBOLS.startupHandler} is not a function literal`,
    });
  }

  const calls = collectStartupCalls(callback.body);

  if (calls.length === 0) {
    return failure(PARITY_FAILURE_CODES.STARTUP_LINES_EMPTY, {
      file,
      symbol: PARITY_SYMBOLS.startupHandler,
      message: `no console.log call inside ${PARITY_SYMBOLS.startupHandler}`,
    });
  }

  /** @type {string[]} */
  const required = [];
  /** @type {string[]} */
  const optional = [];
  for (const { call, conditional } of calls) {
    const argument = call.arguments[0];
    const chunks = templateChunks(argument, sourceFile);

    if (!chunks) {
      const line = lineOf(call, sourceFile);

      return failure(PARITY_FAILURE_CODES.STARTUP_LINE_NOT_TEXT, {
        file,
        symbol: PARITY_SYMBOLS.startupHandler,
        message: `startup log at ${file}:${line} is not a text literal`,
      });
    }

    const shape = shapeFromChunks(chunks);

    if (conditional) {
      optional.push(shape.prefix);
    } else {
      required.push(shape.full);
    }
  }

  return { ok: true, file, required, optional };
}

/**
 * Read one engine source file, converting an I/O failure into a result.
 *
 * @param {string} engineRoot absolute engine root
 * @param {string} file engine-root relative posix path
 * @returns {{ ok: true, text: string } | { ok: false, message: string }}
 */
function readSource(engineRoot, file) {
  const absolute = path.join(engineRoot, ...file.split("/"));

  if (!existsSync(absolute)) {
    return { ok: false, message: `engine source file not found: ${toPosix(absolute)}` };
  }

  try {
    return { ok: true, text: readFileSync(absolute, "utf8") };
  } catch (error) {
    return {
      ok: false,
      message: `engine source file is unreadable: ${toPosix(absolute)} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/**
 * Extract the parity facts and the startup text shapes from one engine root.
 *
 * @param {{engineRoot?: string}} [options]
 * @returns {object} the frozen extraction shape on success, `failure(...)` on a
 *   missing file or symbol; never throws for engine state
 */
export function extractParity({ engineRoot } = {}) {
  if (typeof engineRoot !== "string" || engineRoot.trim().length === 0) {
    return failure(PARITY_FAILURE_CODES.INVALID_ENGINE_ROOT, {
      message: "engineRoot must be a non-empty string",
    });
  }

  const root = path.resolve(engineRoot);
  /** @type {Record<string, string>} */
  const sources = {};

  for (const file of Object.values(PARITY_SOURCES)) {
    const read = readSource(root, file);

    if (!read.ok) {
      return failure(PARITY_FAILURE_CODES.ENGINE_SOURCE_MISSING, { file, message: read.message });
    }

    sources[file] = read.text;
  }

  const constants = parseRemoteConstants(sources[PARITY_SOURCES.constants]);

  if (!constants.ok) {
    return failure(constants.code, constants);
  }

  const dispatch = parseDispatchCases(sources[PARITY_SOURCES.commands]);

  if (!dispatch.ok) {
    return failure(dispatch.code, dispatch);
  }

  const startup = parseStartupLines(sources[PARITY_SOURCES.startup]);

  if (!startup.ok) {
    return failure(startup.code, startup);
  }

  const remoteCommands = {
    advertised: constants.advertised,
    handledElsewhere: constants.handledElsewhere,
    unadvertisedAliases: constants.unadvertisedAliases,
    dispatchCases: dispatch.dispatchCases,
  };

  const consistency = checkParityConsistency(remoteCommands);

  return {
    ok: true,
    engineRoot: toPosix(root),
    remoteCommands,
    counts: {
      advertisedCommands: remoteCommands.advertised.length,
      handledElsewhere: Object.keys(remoteCommands.handledElsewhere).length,
      unadvertisedAliases: Object.keys(remoteCommands.unadvertisedAliases).length,
      dispatchCases: remoteCommands.dispatchCases.length,
    },
    startupText: {
      required: startup.required,
      optional: startup.optional,
    },
    consistency,
    health: {
      degraded: false,
      coarse: [...constants.coarse, ...dispatch.coarse],
      unparsed: [],
    },
  };
}
