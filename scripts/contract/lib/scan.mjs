/**
 * scan.mjs - syntax-only AST scan and type index for the pinned engine source.
 *
 * Scope (frozen by A2-D03 / A2-D04):
 *   - Only TypeScript files below `src/types` are indexed, recursively.
 *   - Every file is parsed with
 *       ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
 *     and walked with `forEachChild`. There is no Program, no type checker and
 *     no resolution into `node_modules`; `@letta-ai/*` field types stay opaque
 *     text on purpose.
 *
 * Entry shape (one entry per interface / type alias declaration):
 *   {
 *     name,          // declared name, without a namespace prefix
 *     qualifiedName, // "Ns.Name" for a declaration inside `namespace Ns`
 *     kind,          // "interface" | "type"
 *     file,          // engine-root relative posix path, e.g. "src/types/protocol_v2.ts"
 *     line,          // 1-based line of the declaration, for "<file>:<line>" homes
 *     typeLiteral,   // the `type: "..."` literal of an interface, else null
 *     fields,        // top-level properties: {name, type, optional, readonly, nested}
 *     bodyText,      // interface body (inside the braces) or the alias type text
 *     unionMembers,  // raw member texts of `type X = A | B`, else null
 *   }
 *
 * Seam for command extraction and message / inbound extraction:
 *
 *   import { createTypeIndex } from "./lib/scan.mjs";
 *
 *   const index = createTypeIndex("_research/haruyuki");
 *
 *   // 1. A union alias. `members` are the raw member texts; counting them is
 *   //    the union-member metric, and each member carries its own resolution.
 *   const union = index.resolveUnion("WsProtocolCommand", "src/types/protocol_v2.ts");
 *   if (!union.ok) {
 *     // "union-not-found" / "not-a-union": record `degraded`, do not throw.
 *   } else {
 *     for (const member of union.members) {
 *       if (member.ok) member.entry.file, member.entry.line, member.entry.typeLiteral;
 *       else member.code; // "unresolved-module" | "unresolved-symbol" | ...
 *     }
 *   }
 *
 *   // 2. A single reference, in all three forms found in the pinned union:
 *   //      "AgentListCommand"
 *   //      "CwdProtocol.SetBootWorkingDirectoryResponseMessage"
 *   //      'import("./queue-update-protocol").ResumeQueueCommand'
 *   const one = index.resolveTypeRef('import("./queue-update-protocol").ResumeQueueCommand',
 *                                    "src/types/protocol_v2.ts");
 *   if (one.ok) {
 *     one.entry.file;        // "src/types/queue-update-protocol.ts"
 *     one.entry.line;        // 14 -> home "src/types/queue-update-protocol.ts:14"
 *     one.entry.typeLiteral; // "resume_queue"
 *     one.entry.fields;      // field-level extraction for `detail` entries
 *     one.entry.bodyText;    // input for shapeFingerprint()
 *   } else {
 *     one.code;              // structured failure, safe to log as a `coarse` reason
 *   }
 *
 *   // 3. A member that is itself a union alias (for example CronProtocolCommand)
 *   //    resolves to entry.kind === "type" with entry.unionMembers populated.
 *   //    Resolve those members against entry.file.
 *
 * Failure semantics: `resolveTypeRef` and `resolveUnion` never throw for an
 * unknown symbol, an ambiguous symbol or an external module. They return
 * `{ ok: false, code, message }` so callers can mark a single entry `coarse` or
 * a whole class `degraded` and keep going. Only index building throws, and only
 * for I/O or a missing `src/types` directory (exit code 2 upstream).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

/** Directory below the engine root that is the only indexed input. */
const TYPE_DIR = "src/types";

/** Failure codes returned instead of throwing. */
export const FAILURE_CODES = Object.freeze({
  EMPTY_REF: "empty-ref",
  UNSUPPORTED_REF: "unsupported-ref",
  UNRESOLVED_MODULE: "unresolved-module",
  UNRESOLVED_SYMBOL: "unresolved-symbol",
  AMBIGUOUS_SYMBOL: "ambiguous-symbol",
  UNION_NOT_FOUND: "union-not-found",
  NOT_A_UNION: "not-a-union",
});

/** `import("./module").Qualifier` (also single quotes; whitespace is collapsed first). */
const IMPORT_TYPE_REF = /^import\("([^"]+)"\)\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/;
const IMPORT_TYPE_REF_SINGLE = /^import\('([^']+)'\)\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/;
/** `NamespaceMember` */
const QUALIFIED_REF = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/;
/** `BareIdentifier` */
const BARE_REF = /^[A-Za-z_$][\w$]*$/;

/**
 * Convert backslashes to posix separators.
 *
 * @param {string} value
 * @returns {string}
 */
function toPosix(value) {
  return value.replaceAll("\\", "/");
}

/**
 * Collapse all whitespace runs to one space and trim.
 *
 * @param {string} value
 * @returns {string}
 */
function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * List `src/types/**\/*.ts` below an engine root as sorted posix paths.
 *
 * @param {string} engineRoot engine checkout root
 * @returns {string[]} engine-root relative posix paths, lexicographic
 */
export function listTypeFiles(engineRoot) {
  const typesRoot = path.join(path.resolve(engineRoot), "src", "types");

  if (!existsSync(typesRoot) || !statSync(typesRoot).isDirectory()) {
    throw new Error(`scan: engine type directory not found: ${toPosix(typesRoot)}`);
  }

  /** @type {string[]} */
  const found = [];
  walkDirectory(typesRoot, found);

  const root = path.resolve(engineRoot);

  return found
    .map((absolute) => toPosix(path.relative(root, absolute)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * @param {string} dir absolute directory
 * @param {string[]} out accumulator of absolute file paths
 */
function walkDirectory(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walkDirectory(absolute, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(absolute);
    }
  }
}

/**
 * True for a test file. Test declarations lose every name collision, because
 * they never describe the protocol contract (A2-D03 indexes the directory, the
 * preference just keeps a local fixture from shadowing a real interface).
 *
 * @param {string} file posix path
 * @returns {boolean}
 */
function isTestFile(file) {
  return /\.(test|spec)\.ts$/.test(file);
}

/**
 * Build the type index for one engine checkout.
 *
 * @param {string} engineRoot engine checkout root
 * @returns {{
 *   engineRoot: string,
 *   files: string[],
 *   stats: { files: number, entries: number, interfaces: number, aliases: number },
 *   resolveTypeRef: (ref: string, fromFile: string) => object,
 *   resolveUnion: (unionName: string, fromFile: string) => object,
 * }}
 */
export function createTypeIndex(engineRoot) {
  const root = path.resolve(engineRoot);
  const files = listTypeFiles(root);
  const fileSet = new Set(files);

  /** @type {Map<string, {namespaces: Map<string,string>, namedImports: Map<string,{module: string, imported: string}>, entries: Map<string, object>}>} */
  const perFile = new Map();
  /** @type {Map<string, object[]>} */
  const byName = new Map();
  /** @type {Map<string, object[]>} */
  const byQualifiedName = new Map();

  let interfaceCount = 0;
  let aliasCount = 0;

  for (const file of files) {
    const text = readFileSync(path.join(root, ...file.split("/")), "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const info = { namespaces: new Map(), namedImports: new Map(), entries: new Map() };
    collectDeclarations(sourceFile, sourceFile, file, info);

    for (const entry of info.entries.values()) {
      const simple = byName.get(entry.name);

      if (simple) {
        simple.push(entry);
      } else {
        byName.set(entry.name, [entry]);
      }

      if (entry.qualifiedName !== entry.name) {
        const qualified = byQualifiedName.get(entry.qualifiedName);

        if (qualified) {
          qualified.push(entry);
        } else {
          byQualifiedName.set(entry.qualifiedName, [entry]);
        }
      }

      if (entry.kind === "interface") {
        interfaceCount += 1;
      } else {
        aliasCount += 1;
      }
    }

    perFile.set(file, info);
  }

  /**
   * Find an entry declared in one file, tolerating a dotted qualifier by
   * falling back to its last segment.
   *
   * @param {string} file posix path
   * @param {string} qualifier
   * @returns {object | null}
   */
  function lookupInFile(file, qualifier) {
    const info = perFile.get(file);

    if (!info) {
      return null;
    }

    const exact = info.entries.get(qualifier);

    if (exact) {
      return exact;
    }

    const segments = qualifier.split(".");
    const last = segments[segments.length - 1];

    return last ? (info.entries.get(last) ?? null) : null;
  }

  /**
   * Resolve a relative module specifier against the importing file.
   *
   * @param {string} fromFile posix path
   * @param {string} specifier
   * @returns {{ file: string } | { code: string, message: string }}
   */
  function resolveModuleFile(fromFile, specifier) {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      return {
        code: FAILURE_CODES.UNRESOLVED_MODULE,
        message: `external module is not indexed: ${specifier}`,
      };
    }

    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    const candidates = [];

    if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(base)) {
      candidates.push(
        base,
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.mjs$/, ".mts"),
        base.replace(/\.cjs$/, ".cts"),
      );
    } else {
      for (const extension of [".ts", ".mts", ".cts"]) {
        candidates.push(`${base}${extension}`, `${base}/index${extension}`);
      }
    }

    for (const candidate of candidates) {
      if (fileSet.has(candidate)) {
        return { file: candidate };
      }
    }

    return {
      code: FAILURE_CODES.UNRESOLVED_MODULE,
      message: `relative module is not indexed: ${specifier} (from ${fromFile})`,
    };
  }

  /**
   * Build a structured failure. Never throws.
   *
   * @param {string} ref
   * @param {string} fromFile
   * @param {string} code
   * @param {string} message
   * @param {string[]} [candidates]
   * @returns {{ ok: false, ref: string, fromFile: string, code: string, message: string, candidates: string[] }}
   */
  function fail(ref, fromFile, code, message, candidates = []) {
    return { ok: false, ref, fromFile, code, message, candidates };
  }

  /**
   * Pick one entry out of several same-named candidates.
   *
   * @param {object[]} candidates
   * @param {string} fromFile
   * @returns {{ entry: object } | { ambiguous: true, candidates: string[] }}
   */
  function pickEntry(candidates, fromFile) {
    if (candidates.length === 0) {
      return { ambiguous: true, candidates: [] };
    }

    if (candidates.length === 1) {
      return { entry: candidates[0] };
    }

    const sameFile = candidates.filter((candidate) => candidate.file === fromFile);

    if (sameFile.length === 1) {
      return { entry: sameFile[0] };
    }

    const production = candidates.filter((candidate) => !isTestFile(candidate.file));

    if (production.length === 1) {
      return { entry: production[0] };
    }

    return {
      ambiguous: true,
      candidates: candidates.map((candidate) => `${candidate.file}:${candidate.line}`).sort(),
    };
  }

  /**
   * Resolve one type reference from one file.
   *
   * @param {string} ref raw reference text, e.g. "AgentListCommand"
   * @param {string} fromFile engine-root relative posix path of the referring file
   * @returns {object} `{ok: true, ref, fromFile, how, entry}` or
   *   `{ok: false, ref, fromFile, code, message, candidates}`
   */
  function resolveTypeRef(ref, fromFile) {
    if (typeof ref !== "string" || typeof fromFile !== "string") {
      return fail(
        String(ref),
        String(fromFile),
        FAILURE_CODES.UNSUPPORTED_REF,
        "ref and fromFile must be strings",
      );
    }

    const normalized = collapseWhitespace(ref);

    if (normalized.length === 0) {
      return fail(ref, fromFile, FAILURE_CODES.EMPTY_REF, "empty type reference");
    }

    if (!perFile.has(fromFile)) {
      return fail(
        normalized,
        fromFile,
        FAILURE_CODES.UNSUPPORTED_REF,
        `referring file is not in the index: ${fromFile}`,
      );
    }

    const importMatch = IMPORT_TYPE_REF.exec(normalized) ?? IMPORT_TYPE_REF_SINGLE.exec(normalized);

    if (importMatch) {
      const specifier = importMatch[1];
      const qualifier = importMatch[2];
      const target = resolveModuleFile(fromFile, specifier);

      if (!target.file) {
        return fail(normalized, fromFile, target.code, target.message);
      }

      const entry = lookupInFile(target.file, qualifier);

      if (!entry) {
        return fail(
          normalized,
          fromFile,
          FAILURE_CODES.UNRESOLVED_SYMBOL,
          `symbol ${qualifier} is not declared in ${target.file}`,
          [target.file],
        );
      }

      return { ok: true, ref: normalized, fromFile, how: "import-type", entry };
    }

    const qualifiedMatch = QUALIFIED_REF.exec(normalized);

    if (qualifiedMatch) {
      const namespace = qualifiedMatch[1];
      const member = qualifiedMatch[2];
      const declaredNamespace = perFile.get(fromFile).namespaces.get(namespace);

      if (declaredNamespace) {
        const target = resolveModuleFile(fromFile, declaredNamespace);

        if (!target.file) {
          return fail(normalized, fromFile, target.code, target.message);
        }

        const entry = lookupInFile(target.file, member);

        if (entry) {
          return { ok: true, ref: normalized, fromFile, how: "namespace-import", entry };
        }

        return fail(
          normalized,
          fromFile,
          FAILURE_CODES.UNRESOLVED_SYMBOL,
          `symbol ${member} is not declared in ${target.file} (namespace ${namespace})`,
          [target.file],
        );
      }

      const nested = lookupInFile(fromFile, normalized);

      if (nested) {
        return { ok: true, ref: normalized, fromFile, how: "namespace-decl", entry: nested };
      }

      const picked = pickEntry(byQualifiedName.get(normalized) ?? [], fromFile);

      if (picked.entry) {
        return {
          ok: true,
          ref: normalized,
          fromFile,
          how: "global-qualified",
          entry: picked.entry,
        };
      }

      return fail(
        normalized,
        fromFile,
        picked.ambiguous && picked.candidates.length > 0
          ? FAILURE_CODES.AMBIGUOUS_SYMBOL
          : FAILURE_CODES.UNRESOLVED_SYMBOL,
        `namespace member ${normalized} is not declared`,
        picked.candidates,
      );
    }

    if (!BARE_REF.test(normalized)) {
      return fail(
        normalized,
        fromFile,
        FAILURE_CODES.UNSUPPORTED_REF,
        `unsupported type reference syntax: ${normalized}`,
      );
    }

    const local = lookupInFile(fromFile, normalized);

    if (local) {
      return { ok: true, ref: normalized, fromFile, how: "local", entry: local };
    }

    const namedImport = perFile.get(fromFile).namedImports.get(normalized);

    if (namedImport) {
      const target = resolveModuleFile(fromFile, namedImport.module);

      if (!target.file) {
        return fail(normalized, fromFile, target.code, target.message);
      }

      const entry = lookupInFile(target.file, namedImport.imported);

      if (entry) {
        return { ok: true, ref: normalized, fromFile, how: "named-import", entry };
      }

      return fail(
        normalized,
        fromFile,
        FAILURE_CODES.UNRESOLVED_SYMBOL,
        `imported symbol ${namedImport.imported} is not declared in ${target.file}`,
        [target.file],
      );
    }

    const picked = pickEntry(byName.get(normalized) ?? [], fromFile);

    if (picked.entry) {
      return { ok: true, ref: normalized, fromFile, how: "global", entry: picked.entry };
    }

    const ambiguous = picked.ambiguous && picked.candidates.length > 0;

    return fail(
      normalized,
      fromFile,
      ambiguous ? FAILURE_CODES.AMBIGUOUS_SYMBOL : FAILURE_CODES.UNRESOLVED_SYMBOL,
      ambiguous
        ? `symbol ${normalized} is declared more than once`
        : `symbol ${normalized} is not declared in the indexed tree`,
      picked.candidates,
    );
  }

  /**
   * Resolve a union alias and every member in it.
   *
   * Members are resolved against the file that declares the union, because
   * namespace aliases and `import("./x")` specifiers are relative to it.
   *
   * @param {string} unionName
   * @param {string} fromFile engine-root relative posix path of the referring file
   * @returns {{ok: true, name: string, fromFile: string, line: number, members: object[]}
   *   | {ok: false, name: string, code: string, message: string}}
   */
  function resolveUnion(unionName, fromFile) {
    const union = resolveTypeRef(unionName, fromFile);

    if (!union.ok) {
      return {
        ok: false,
        name: unionName,
        ref: unionName,
        fromFile,
        code: FAILURE_CODES.UNION_NOT_FOUND,
        message: `union ${unionName} not found: ${union.message}`,
      };
    }

    const entry = union.entry;

    if (entry.kind !== "type" || !entry.unionMembers) {
      return {
        ok: false,
        name: unionName,
        ref: unionName,
        fromFile: entry.file,
        code: FAILURE_CODES.NOT_A_UNION,
        message: `${unionName} is a ${entry.kind} without union members`,
      };
    }

    return {
      ok: true,
      name: unionName,
      fromFile: entry.file,
      line: entry.line,
      members: entry.unionMembers.map((member) => ({
        ref: member,
        ...resolveTypeRef(member, entry.file),
      })),
    };
  }

  return {
    engineRoot: toPosix(root),
    files,
    stats: {
      files: files.length,
      entries: interfaceCount + aliasCount,
      interfaces: interfaceCount,
      aliases: aliasCount,
    },
    resolveTypeRef,
    resolveUnion,
  };
}

/**
 * Collect namespace aliases, named imports and declarations of one source file.
 *
 * @param {import("typescript").Node} node
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} file engine-root relative posix path
 * @param {{namespaces: Map<string,string>, namedImports: Map<string,{module: string, imported: string}>, entries: Map<string, object>}} info
 * @param {string} [namespace] enclosing `namespace` prefix
 */
function collectDeclarations(node, sourceFile, file, info, namespace = "") {
  if (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    node.importClause
  ) {
    const clause = node.importClause;
    const bindings = clause.namedBindings;

    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        info.namespaces.set(bindings.name.text, node.moduleSpecifier.text);
      } else if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          info.namedImports.set(element.name.text, {
            module: node.moduleSpecifier.text,
            imported: element.propertyName ? element.propertyName.text : element.name.text,
          });
        }
      }
    }

    return;
  }

  if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name) && node.body) {
    const nested = namespace ? `${namespace}.${node.name.text}` : node.name.text;

    node.body.forEachChild((child) => collectDeclarations(child, sourceFile, file, info, nested));

    return;
  }

  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    const entry = makeEntry(node, sourceFile, file, namespace);

    info.entries.set(entry.qualifiedName, entry);

    return;
  }

  node.forEachChild((child) => collectDeclarations(child, sourceFile, file, info, namespace));
}

/**
 * Build one index entry from an interface or type alias declaration.
 *
 * @param {import("typescript").InterfaceDeclaration | import("typescript").TypeAliasDeclaration} node
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} file
 * @param {string} namespace
 * @returns {object}
 */
function makeEntry(node, sourceFile, file, namespace) {
  const kind = ts.isInterfaceDeclaration(node) ? "interface" : "type";
  const name = node.name.text;
  const qualifiedName = namespace ? `${namespace}.${name}` : name;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  let bodyText;
  let fields = [];
  let typeLiteral = null;
  let unionMembers = null;

  if (ts.isInterfaceDeclaration(node)) {
    bodyText = sourceFile.text.slice(node.members.pos, node.members.end);
    fields = extractFields(node, sourceFile);
    typeLiteral = extractTypeLiteral(node);
  } else {
    bodyText = node.type.getText(sourceFile);

    if (ts.isUnionTypeNode(node.type)) {
      unionMembers = node.type.types.map((member) =>
        collapseWhitespace(member.getText(sourceFile)),
      );
    } else if (ts.isLiteralTypeNode(node.type) && ts.isStringLiteral(node.type.literal)) {
      typeLiteral = node.type.literal.text;
    }
  }

  return { name, qualifiedName, kind, file, line, typeLiteral, fields, bodyText, unionMembers };
}

/**
 * Read the top-level properties of an interface. Nested object literals are
 * flagged, never expanded; methods, call signatures and index signatures are
 * skipped (the snapshot only records data properties).
 *
 * @param {import("typescript").InterfaceDeclaration} node
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {{name: string, type: string, optional: boolean, readonly: boolean, nested: boolean}[]}
 */
function extractFields(node, sourceFile) {
  const fields = [];

  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || !member.name) {
      continue;
    }

    const name = propertyNameText(member.name);

    if (name === null) {
      continue;
    }

    fields.push({
      name,
      type: member.type ? member.type.getText(sourceFile) : "",
      optional: Boolean(member.questionToken),
      readonly: hasReadonlyModifier(member),
      nested: member.type ? ts.isTypeLiteralNode(member.type) : false,
    });
  }

  return fields;
}

/**
 * @param {import("typescript").PropertyName} name
 * @returns {string | null} property name text, or null for a computed name
 */
function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return null;
}

/**
 * @param {import("typescript").Node} node
 * @returns {boolean}
 */
function hasReadonlyModifier(node) {
  if (!node.modifiers) {
    return false;
  }

  return node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
}

/**
 * Read the `type: "<wire id>";` literal of an interface.
 *
 * @param {import("typescript").InterfaceDeclaration} node
 * @returns {string | null}
 */
function extractTypeLiteral(node) {
  for (const member of node.members) {
    if (
      ts.isPropertySignature(member) &&
      member.name &&
      member.name.text === "type" &&
      member.type &&
      ts.isLiteralTypeNode(member.type) &&
      ts.isStringLiteral(member.type.literal)
    ) {
      return member.type.literal.text;
    }
  }

  return null;
}
