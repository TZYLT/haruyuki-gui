/**
 * check-module-ownership.mjs - gate: module ownership boundaries and no barrel forwarding.
 *
 * Usage:
 *   node scripts/check-module-ownership.mjs               # scan packages, apps, scripts
 *   node scripts/check-module-ownership.mjs --root <dir>  # scan another tree (self-tests only)
 *   node scripts/check-module-ownership.mjs --verbose     # diagnostics on stderr only
 *
 * Two checks share one pass over the tree. Parsing and path resolution live in
 * ./lib/module-ownership-sources.mjs; this file owns the policy and the verdicts.
 *
 *   A. module-ownership
 *      Every dependency edge is resolved to a real repo-relative path. If the
 *      resolved target matches a `modules[].path` domain, the importing file must
 *      match one of that entry's `allowedImporters` globs, otherwise the edge is a
 *      violation. Matching happens on resolved paths, not on the specifier, so a
 *      relative import such as ../../core/src/engine/x.ts is caught exactly like
 *      @haruyuki/core/src/engine/x.ts. An edge whose importer also lives inside the
 *      same domain is always allowed, so a domain never has to allow-list itself.
 *
 *   B. barrel
 *      A pure forwarding module is a violation unless `barrels.allow` matches its
 *      path. A file is a barrel when it has at least one forwarding export
 *      (`export * from "x"` / `export {...} from "x"`) and every statement is a
 *      forwarding export, an import or an empty statement. Any local declaration
 *      (function, class, const, type, interface, enum, namespace), any executable
 *      statement, `export {a}` without `from`, `export default`, `export =` and
 *      `export {}` all disqualify the file, so
 *      `export * from "./a"; export const own = 1;` is NOT a barrel and the current
 *      placeholder index.ts files (one exported const each) are NOT barrels.
 *      Declaration files (*.d.ts / *.d.mts / *.d.cts) are excluded.
 *
 * Config: scripts/module-ownership.json, read from the scanned root.
 *   The file must exist: a missing policy is a script failure (exit 2), never an
 *   empty one, because a gate that silently stops protecting anything is worse than
 *   a red gate. A `--root` self-test tree therefore has to create its own copy at
 *   <root>/scripts/module-ownership.json. Unknown keys are rejected so a typo cannot
 *   silently disable a rule; keys prefixed with "_" are documentation and ignored.
 *
 * Resolution boundary (stated so a miss is visible rather than assumed; details in
 * ./lib/module-ownership-sources.mjs)
 *   in-repo   Relative specifiers and workspace package specifiers. They must
 *             resolve; a failure becomes an "unresolved" violation.
 *   external  Node builtins and bare names installed in a node_modules directory.
 *   else      Unresolved: an in-repo specifier matching nothing, a path escaping the
 *             root, or a bare name that is neither workspace, builtin nor installed.
 *             --verbose lists each one, and a non-empty config adds one `unresolved`
 *             violation, because a blind resolver disables check A without saying so.
 *
 * Scope
 *   Directories: packages, apps, scripts.
 *   Extensions:  .ts .tsx .mts .cts .js .mjs .cjs. Declaration files are scanned for
 *   ownership edges but excluded from check B.
 *   Skipped dirs (any depth): node_modules, dist, out, build, coverage, fixtures,
 *   _research, docs. Symbolic links are skipped.
 *
 * Failure policy (exit 2, never a pass)
 *   Missing, unreadable or malformed config, unknown config keys, a bad --root, zero
 *   source files, or a workspace package.json that does not parse.
 *
 * Output
 *   One violation per line: <file>:<line> <rule> <message>. Paths are posix and every
 *   message is English. Rules: module-ownership, barrel, unresolved.
 *
 * Exit codes: 0 = pass, 1 = violation, 2 = the script or its configuration is broken.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { runGate, toPosix } from "./lib/gate-cli.mjs";
import {
  analyzeSource,
  isDeclarationFile,
  isDirectory,
  loadWorkspacePackages,
  parseSource,
  resolveDependency,
  SOURCE_EXTENSIONS,
} from "./lib/module-ownership-sources.mjs";

/** Repo-relative location of the policy file. */
const CONFIG_PATH = "scripts/module-ownership.json";

/** Top-level directories that belong to this gate. */
const SCAN_DIRS = ["packages", "apps", "scripts"];

/** Directory names skipped at any depth. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  "fixtures",
  "_research",
  "docs",
]);

await runGate(collectViolations, { flags: ["verbose"] });

/**
 * Gate body: scan once, run both checks, return every violation.
 *
 * @param {{ root: string, flags: Record<string, boolean> }} args
 * @returns {import("./lib/gate-cli.mjs").Violation[]}
 */
function collectViolations({ root, flags }) {
  const verbose = flags.verbose === true;
  const config = readConfig(root);
  const files = scanSourceFiles(root);
  const workspace = loadWorkspacePackages(root);

  if (verbose) {
    console.error(
      `config: ${CONFIG_PATH} (${config.modules.length} module rule(s), ` +
        `barrels.forbid=${String(config.barrels.forbid)}, ${config.barrels.allow.length} allowed barrel(s))`,
    );
    console.error(`scanned: ${files.length} source file(s) under ${root}`);
  }

  /** @type {import("./lib/gate-cli.mjs").Violation[]} */
  const violations = [];
  /** @type {{ file: string, line: number, specifier: string, form: string }[]} */
  const unresolved = [];
  /** @type {number[]} */
  const matchedByRule = config.modules.map(() => 0);
  /** @type {string[]} */
  const barrels = [];
  let repoEdges = 0;
  let externalEdges = 0;

  for (const file of files) {
    const text = readFileSync(path.posix.join(root, file), "utf8");
    const analysis = analyzeSource(parseSource(file, text));

    // Check B: a pure forwarding module hides ownership.
    if (
      config.barrels.forbid &&
      analysis.isBarrel &&
      !isDeclarationFile(file) &&
      !matchesAny(config.barrels.allowGlobs, file)
    ) {
      barrels.push(file);
      violations.push({
        file,
        line: analysis.firstForwardingLine,
        rule: "barrel",
        message:
          `pure forwarding module: ${analysis.forwarding} re-export statement(s) and no local ` +
          `declaration; import from the defining module instead, or add the path to ` +
          `"barrels.allow" in ${CONFIG_PATH}`,
      });
    }

    // Check A: a protected module may only be imported by its allow list.
    for (const dependency of analysis.dependencies) {
      const resolution = resolveDependency(root, file, dependency.specifier, workspace);

      if (resolution.kind === "external") {
        externalEdges += 1;
        continue;
      }

      if (resolution.kind === "unresolved") {
        unresolved.push({
          file,
          line: dependency.line,
          specifier: dependency.specifier,
          form: dependency.form,
        });
        continue;
      }

      repoEdges += 1;

      for (const [index, rule] of config.modules.entries()) {
        if (!rule.pathRegExp.test(resolution.file)) {
          continue;
        }

        matchedByRule[index] += 1;

        // Inside the same domain is the normal case and needs no allow entry.
        if (rule.pathRegExp.test(file) || matchesAny(rule.importerGlobs, file)) {
          continue;
        }

        const allowed =
          rule.allowedImporters.length === 0 ? "(nobody)" : rule.allowedImporters.join(", ");
        const reason = rule.reason === "" ? "" : `; reason: ${rule.reason}`;

        violations.push({
          file,
          line: dependency.line,
          rule: "module-ownership",
          message:
            `${dependency.form} "${dependency.specifier}" resolves to ${resolution.file}, a protected ` +
            `module; allowed importers: ${allowed}${reason}`,
        });
      }
    }
  }

  if (verbose) {
    for (const item of unresolved) {
      console.error(`unresolved: ${item.file}:${item.line} "${item.specifier}" (${item.form})`);
    }

    for (const [index, rule] of config.modules.entries()) {
      if (matchedByRule[index] === 0) {
        console.error(
          `warning: modules[${index}].path "${rule.path}" matched no imported file; ` +
            "the rule protects nothing in this tree",
        );
      }
    }

    console.error(
      `edges: ${repoEdges} in-repo, ${externalEdges} external, ${unresolved.length} unresolved; ` +
        `barrels: ${barrels.length === 0 ? "none" : barrels.join(", ")}`,
    );
  }

  // A resolver that cannot resolve an in-repo import is a blind check, so the
  // failure itself is reported instead of being dropped.
  if (unresolved.length > 0 && isConfigActive(config)) {
    const shown = unresolved
      .slice(0, 5)
      .map((item) => `"${item.specifier}" in ${item.file}:${item.line}`)
      .join(", ");
    const more = unresolved.length > 5 ? ` (+${unresolved.length - 5} more)` : "";

    violations.push({
      file: unresolved[0].file,
      line: unresolved[0].line,
      rule: "unresolved",
      message:
        `${unresolved.length} in-repo import(s) do not resolve to a repository path: ${shown}${more}; ` +
        "an unresolved import makes this gate blind, so fix the specifier or declare the dependency",
    });
  }

  return violations;
}

/**
 * Read and validate the policy file.
 *
 * Anything unexpected throws: the caller maps it to exit code 2, so a broken policy
 * can never be mistaken for a clean tree.
 *
 * @param {string} root
 * @returns {{ modules: { path: string, pathRegExp: RegExp, allowedImporters: string[], importerGlobs: { pattern: string, regexp: RegExp }[], reason: string }[], barrels: { forbid: boolean, allow: string[], allowGlobs: { pattern: string, regexp: RegExp }[] } }}
 */
function readConfig(root) {
  const configFile = path.posix.join(root, CONFIG_PATH);
  let text;

  try {
    text = readFileSync(configFile, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${CONFIG_PATH} under ${root}: ${messageOf(error)}; ` +
        "a gate without a policy file must not report PASS",
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Node repeats "is not valid JSON" at the end of its SyntaxError message.
    const detail = messageOf(error).replace(/\s*is not valid JSON$/i, "");

    throw new Error(`${CONFIG_PATH} is not valid JSON: ${detail}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object`);
  }

  rejectUnknownKeys(parsed, ["modules", "barrels"], CONFIG_PATH);

  if (!Array.isArray(parsed.modules)) {
    throw new Error(`${CONFIG_PATH}: "modules" must be an array`);
  }

  const modules = parsed.modules.map((entry, index) => readModuleEntry(entry, index));
  const barrels = parsed.barrels;

  if (!isRecord(barrels)) {
    throw new Error(`${CONFIG_PATH}: "barrels" must be an object with "forbid" and "allow"`);
  }

  rejectUnknownKeys(barrels, ["forbid", "allow"], `${CONFIG_PATH}: barrels`);

  if (typeof barrels.forbid !== "boolean") {
    throw new Error(`${CONFIG_PATH}: "barrels.forbid" must be a boolean`);
  }

  const allow = barrels.allow === undefined ? [] : barrels.allow;

  if (!Array.isArray(allow)) {
    throw new Error(`${CONFIG_PATH}: "barrels.allow" must be an array of globs`);
  }

  return {
    modules,
    barrels: {
      forbid: barrels.forbid,
      allow: allow.map((pattern, index) => readPattern(pattern, `barrels.allow[${index}]`)),
      allowGlobs: readGlobList(allow, "barrels.allow"),
    },
  };
}

/**
 * Validate one entry of `modules`.
 *
 * @param {unknown} entry
 * @param {number} index
 * @returns {{ path: string, pathRegExp: RegExp, allowedImporters: string[], importerGlobs: { pattern: string, regexp: RegExp }[], reason: string }}
 */
function readModuleEntry(entry, index) {
  const where = `modules[${index}]`;

  if (!isRecord(entry)) {
    throw new Error(`${CONFIG_PATH}: ${where} must be an object`);
  }

  rejectUnknownKeys(entry, ["path", "allowedImporters", "reason"], `${CONFIG_PATH}: ${where}`);

  const pattern = readPattern(entry.path, `${where}.path`);

  if (!Array.isArray(entry.allowedImporters)) {
    throw new Error(`${CONFIG_PATH}: ${where}.allowedImporters must be an array of globs`);
  }

  const allowedImporters = entry.allowedImporters.map((item, itemIndex) =>
    readPattern(item, `${where}.allowedImporters[${itemIndex}]`),
  );

  if (entry.reason !== undefined && typeof entry.reason !== "string") {
    throw new Error(`${CONFIG_PATH}: ${where}.reason must be a string when present`);
  }

  return {
    path: pattern,
    pathRegExp: compileGlob(pattern),
    allowedImporters,
    importerGlobs: allowedImporters.map((item) => ({ pattern: item, regexp: compileGlob(item) })),
    reason: entry.reason ?? "",
  };
}

/**
 * Validate an array of glob strings.
 *
 * @param {unknown[]} values
 * @param {string} where
 * @returns {{ pattern: string, regexp: RegExp }[]}
 */
function readGlobList(values, where) {
  return values.map((value, index) => {
    const pattern = readPattern(value, `${where}[${index}]`);

    return { pattern, regexp: compileGlob(pattern) };
  });
}

/**
 * Validate one repo-relative posix glob string.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {string}
 */
function readPattern(value, where) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${CONFIG_PATH}: ${where} must be a non-empty string`);
  }

  if (value.includes("\\")) {
    throw new Error(`${CONFIG_PATH}: ${where} contains backslashes; use posix "/" separators`);
  }

  let pattern = value.trim();

  while (pattern.startsWith("./")) {
    pattern = pattern.slice(2);
  }

  if (pattern.startsWith("/")) {
    throw new Error(`${CONFIG_PATH}: ${where} must be repo-relative, not absolute`);
  }

  if (pattern.split("/").includes("..")) {
    throw new Error(`${CONFIG_PATH}: ${where} must not climb out of the repository with ".."`);
  }

  return pattern;
}

/**
 * Compile a repo-relative posix glob into an anchored regular expression.
 *
 * Supported: "?" (one non-slash character), "*" (any run inside one segment), "**"
 * (any run across segments) and "**\/" (zero or more leading segments, so "**\/*.ts"
 * also matches a file at the repository root).
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function compileGlob(pattern) {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }

      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${source}$`);
}

/**
 * List repo-relative posix paths of every in-scope source file.
 *
 * @param {string} root
 * @returns {string[]}
 */
function scanSourceFiles(root) {
  /** @type {string[]} */
  const files = [];

  for (const dirName of SCAN_DIRS) {
    const directory = path.posix.join(root, dirName);

    if (!isDirectory(directory)) {
      continue;
    }

    walk(directory, root, files);
  }

  files.sort();

  if (files.length === 0) {
    throw new Error(
      `no source files found under ${SCAN_DIRS.join(", ")} in ${root}; ` +
        "refusing to report PASS without inspecting anything",
    );
  }

  return files;
}

/**
 * Depth-first walk collecting in-scope files as repo-relative posix paths.
 *
 * @param {string} directory Absolute posix directory.
 * @param {string} root Absolute posix scan root.
 * @param {string[]} files Accumulator.
 * @returns {void}
 */
function walk(directory, root, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.posix.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        walk(absolute, root, files);
      }

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!SOURCE_EXTENSIONS.has(path.posix.extname(entry.name).toLowerCase())) {
      continue;
    }

    files.push(toPosix(path.posix.relative(root, absolute)));
  }
}

/**
 * True when at least one check is enabled by the config.
 *
 * @param {{ modules: unknown[], barrels: { forbid: boolean } }} config
 * @returns {boolean}
 */
function isConfigActive(config) {
  return config.modules.length > 0 || config.barrels.forbid;
}

/**
 * @param {{ pattern: string, regexp: RegExp }[]} globs
 * @param {string} file
 * @returns {boolean}
 */
function matchesAny(globs, file) {
  return globs.some((glob) => glob.regexp.test(file));
}

/**
 * Reject keys that are neither expected nor documentation ("_" prefix).
 *
 * @param {Record<string, unknown>} record
 * @param {string[]} allowed
 * @param {string} where
 * @returns {void}
 */
function rejectUnknownKeys(record, allowed, where) {
  const known = new Set(allowed);

  for (const key of Object.keys(record)) {
    if (key.startsWith("_") || known.has(key)) {
      continue;
    }

    throw new Error(`${where}: unknown key "${key}"; expected one of ${allowed.join(", ")}`);
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
