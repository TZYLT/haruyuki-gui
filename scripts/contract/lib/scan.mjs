/**
 * scan.mjs - syntax-only AST scan and type index for the pinned engine source.
 *
 * Scope (frozen by A2-D03 / A2-D04):
 *   - Only TypeScript files below `src/types` are indexed, recursively.
 *   - `*.d.ts` and `*.test.ts` / `*.spec.ts` are excluded on purpose. Ambient
 *     declaration shims (`md.d.ts`, `txt.d.ts`, `letta-client-augmentations.d.ts`)
 *     describe modules this index never reads, and test files declare local
 *     fixtures; either one can only add a same-name declaration that turns a
 *     real protocol symbol into `ambiguous-symbol` -> `degraded`. A2-D03 indexes
 *     production declarations.
 *   - The indexed extension set is `SOURCE_EXTENSIONS`; `resolveModuleFile` uses
 *     the same set, so a file the walker skips is never resolvable as a module.
 *   - Every file is parsed with
 *       ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
 *     and walked with `forEachChild`. There is no Program, no type checker and
 *     no resolution into `node_modules`; `@letta-ai/*` field types stay opaque
 *     text on purpose. A file with parser diagnostics is still indexed (a
 *     recoverable error can keep later declarations) but is recorded in
 *     `health.unparsed` and marks the index `degraded`, so a syntax-broken file
 *     never disappears without a trace.
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
 *                    // after heritage merge, see below
 *     bodyText,      // fingerprint input: own body plus every merged base body
 *     ownBodyText,   // the raw `{ ... }` slice of the declaration itself
 *     heritageRefs,  // raw `extends A, B` expressions of an interface, else []
 *     heritageProblems, // single-line English reasons a base could not merge
 *     unionMembers,  // raw member texts of `type X = A | B`, else null
 *   }
 *
 * Interface heritage (extends)
 *   A syntax-only index sees `interface StreamDeltaMessage extends RuntimeEnvelope`
 *   as two declarations. Reading only the own members reported 3 fields for a
 *   message that has 7 on the wire and made a base-class edit invisible to the
 *   fingerprint. After every file is parsed, `mergeHeritage` (`lib/heritage.mjs`)
 *   resolves each `extends` expression through this index and folds the base in
 *   recursively:
 *     - base members are merged first, own members win on a name collision;
 *     - the fingerprint input `bodyText` becomes
 *       `extends Base { <base bodyText> } { <own body> }`, recursively, so a
 *       field added to a base changes every descendant fingerprint;
 *     - an unresolvable or non-interface base is a `coarse` line (an external
 *       SDK base is unmergeable by design) and a cycle is `unparsed` plus
 *       `degraded`; neither is silent.
 *
 *   The same merge runs for declarations the protocol unions never emit; snapshot
 *   assembly decides which of those lines reach the snapshot (only the records it
 *   emits).
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

import { mergeHeritage } from "./heritage.mjs";
import { compareStrings } from "./json.mjs";

/** Directory below the engine root that is the only indexed input. */
const TYPE_DIR = "src/types";

/**
 * TypeScript source extensions this index reads. `walkDirectory` and
 * `resolveModuleFile` share this list so "indexed" and "resolvable" cannot drift
 * apart; a file outside it is neither walked nor a valid module target.
 */
export const SOURCE_EXTENSIONS = Object.freeze([".ts", ".mts", ".cts"]);

/** `*.d.ts`, `*.test.ts` and `*.spec.ts` are not protocol declarations. */
const EXCLUDED_FILE_PATTERN =
  /\.(d\.ts|d\.mts|d\.cts|test\.ts|spec\.ts|test\.mts|spec\.mts|test\.cts|spec\.cts)$/;

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

/**
 * Record a file whose parse produced diagnostics.
 *
 * The declarations that did parse stay in the index (a recoverable error keeps
 * later statements), but the file is never silent: the index becomes `degraded`
 * and `health.unparsed` carries one line per broken file.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} file engine-root relative posix path
 * @param {{degraded: boolean, coarse: string[], unparsed: string[]}} health
 */
function collectParseDiagnostics(sourceFile, file, health) {
  const diagnostics = Array.isArray(sourceFile.parseDiagnostics) ? sourceFile.parseDiagnostics : [];

  if (diagnostics.length === 0) {
    return;
  }

  const first = diagnostics[0];
  const message = typeof first?.messageText === "string" ? first.messageText : "descriptive error";

  health.degraded = true;
  health.unparsed.push(
    `${file}: parse-error: ${collapseWhitespace(message)} (${diagnostics.length} diagnostics)`,
  );
}

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
 * List the indexed `src/types` files of an engine root as sorted posix paths.
 *
 * @param {string} engineRoot engine checkout root
 * @returns {string[]} engine-root relative posix paths, lexicographic
 */
export function listTypeFiles(engineRoot) {
  const typesRoot = path.join(path.resolve(engineRoot), ...TYPE_DIR.split("/"));

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
 * True for a file the index reads: an indexed source extension that is not a
 * declaration shim and not a test file.
 *
 * @param {string} name base file name
 * @returns {boolean}
 */
function isIndexedFileName(name) {
  if (EXCLUDED_FILE_PATTERN.test(name)) {
    return false;
  }

  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
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
    } else if (entry.isFile() && isIndexedFileName(entry.name)) {
      out.push(absolute);
    }
  }
}

/**
 * Build the type index for one engine checkout.
 *
 * @param {string} engineRoot engine checkout root
 * @returns {{
 *   engineRoot: string,
 *   files: string[],
 *   stats: { files: number, entries: number, interfaces: number, aliases: number },
 *   health: { degraded: boolean, coarse: string[], unparsed: string[] },
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
  /** @type {object[]} declaration-order list, for the heritage post-pass */
  const allEntries = [];
  /** @type {{degraded: boolean, coarse: string[], unparsed: string[]}} */
  const health = { degraded: false, coarse: [], unparsed: [] };

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

    collectParseDiagnostics(sourceFile, file, health);

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

      allEntries.push(entry);
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
    /** @type {string[]} */
    const candidates = [];

    if (SOURCE_EXTENSIONS.some((extension) => base.endsWith(extension))) {
      candidates.push(base);
    } else if (/\.(js|mjs|cjs)$/.test(base)) {
      // A relative `./x.js` specifier (NodeNext style) points at the emitted file;
      // the indexed source is the same path with an indexed extension.
      const stem = base.replace(/\.(js|mjs|cjs)$/, "");
      const emitted = /\.(mjs|cjs)$/.exec(base);

      candidates.push(`${stem}.ts`);

      if (emitted) {
        candidates.push(`${stem}${emitted[1] === "mjs" ? ".mts" : ".cts"}`);
      }
    } else {
      for (const extension of SOURCE_EXTENSIONS) {
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
   * Pick one entry out of several same-named candidates. Test files and
   * declaration shims are not indexed, so a same-file declaration followed by an
   * honestly reported ambiguity covers every remaining case.
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

  // Fold every `extends` chain now that the whole file set is indexed.
  const heritageHealth = mergeHeritage(allEntries, resolveTypeRef);

  health.degraded = health.degraded || heritageHealth.degraded;
  health.coarse.push(...heritageHealth.coarse);
  health.unparsed.push(...heritageHealth.unparsed);
  health.coarse.sort(compareStrings);
  health.unparsed.sort(compareStrings);

  return {
    engineRoot: toPosix(root),
    files,
    stats: {
      files: files.length,
      entries: interfaceCount + aliasCount,
      interfaces: interfaceCount,
      aliases: aliasCount,
    },
    health,
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
  let ownBodyText;
  let fields = [];
  let ownFields = [];
  let heritageRefs = [];
  let typeLiteral = null;
  let unionMembers = null;

  if (ts.isInterfaceDeclaration(node)) {
    ownBodyText = sourceFile.text.slice(node.members.pos, node.members.end);
    bodyText = ownBodyText;
    ownFields = extractFields(node, sourceFile);
    fields = ownFields;
    heritageRefs = extractHeritageRefs(node, sourceFile);
    typeLiteral = extractTypeLiteral(node);
  } else {
    bodyText = node.type.getText(sourceFile);
    ownBodyText = bodyText;

    if (ts.isUnionTypeNode(node.type)) {
      unionMembers = node.type.types.map((member) =>
        collapseWhitespace(member.getText(sourceFile)),
      );
    } else if (ts.isLiteralTypeNode(node.type) && ts.isStringLiteral(node.type.literal)) {
      typeLiteral = node.type.literal.text;
    }
  }

  return {
    name,
    qualifiedName,
    kind,
    file,
    line,
    typeLiteral,
    fields,
    ownFields,
    bodyText,
    ownBodyText,
    heritageRefs,
    heritageProblems: [],
    unionMembers,
  };
}

/**
 * Read the `extends` operand texts of an interface, in declaration order.
 *
 * @param {import("typescript").InterfaceDeclaration} node
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {string[]} collapsed operand texts, e.g. ["RuntimeEnvelope"]
 */
function extractHeritageRefs(node, sourceFile) {
  const clauses = node.heritageClauses ?? [];
  /** @type {string[]} */
  const refs = [];

  for (const clause of clauses) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }

    for (const type of clause.types) {
      refs.push(collapseWhitespace(type.getText(sourceFile)));
    }
  }

  return refs;
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
