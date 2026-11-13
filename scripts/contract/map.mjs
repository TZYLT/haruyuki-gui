/**
 * map.mjs - render `command-map.generated.ts` and compare it with the frozen
 * artifact. Validation lives in `lib/map-checks.mjs`; this module owns
 * bytes, ordering and the read-side checks around them.
 *
 * Pipeline (route doc 08 section 3.1):
 *
 *   snapshot.json + capabilities.json
 *     -> collectViolations() from lib/map-checks.mjs
 *     -> emitMap() renders the frozen export shape (07 section 4.3)
 *     -> checkMap() compares the bytes with the committed artifact
 *
 * The artifact is the only definition of the wire vocabulary: it exports
 * `CapabilityScope`, `CapabilityShape`, `CapabilityName`, `CapabilityMeta`,
 * `CAPABILITY_TO_WIRE`, `CAPABILITY_META` and `CAPABILITY_SNAPSHOT_ENGINE`, and
 * nothing else. Field shapes stay in the snapshot; they are never copied here.
 *
 * Determinism
 *   Names are emitted in code-unit (lexicographic) order, keys inside one meta
 *   object follow the interface order, and the header digests come from a
 *   canonical JSON serialization (object keys sorted recursively) instead of the
 *   raw file bytes. Re-formatting `snapshot.json` or reordering a JSON object
 *   therefore does not dirty the artifact; only a content change does. The
 *   generation path never reads the clock, the locale or the environment.
 *
 * Formatting
 *   The emitter matches Prettier 3 at the repository settings (printWidth 100, 2
 *   spaces, double quotes, trailing commas, LF) byte for byte, because the
 *   artifact must pass `prettier --check` and the pre-commit hook (risk R-11).
 *   When the emitter and Prettier disagree, change the emitter - never the gate.
 *   Long string values are the one place Prettier cannot wrap, so those lines may
 *   exceed 100 columns by construction; Prettier itself makes the same choice.
 *
 * Failure semantics
 *   Broken input (missing file, unparseable JSON, wrong top-level shape) throws:
 *   that is exit code 2 territory, never a violation. Data disagreements are
 *   returned as violations (exit code 1). A missing or hand-edited artifact is a
 *   `contract-stale` violation, because that is the drift this gate must catch.
 *   `generateMap` refuses to emit code while an error is outstanding, so a red
 *   table can never be frozen into the artifact.
 *
 * Nothing here writes to disk. `--write` belongs to the CLI layer (Lead) and the
 * gate wrapper (`check-contract.mjs`) is separate; this module only supplies
 * the generated text and the verdict.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPABILITIES_FILE,
  CAPABILITY_FLAG_KEYS,
  CAPABILITY_SCOPES,
  CAPABILITY_SHAPES,
  MAP_FILE,
  SNAPSHOT_FILE,
  collectViolations,
  compareStrings,
  requireCapabilities,
  requireSnapshot,
  sortViolations,
} from "./lib/map-checks.mjs";

export {
  CAPABILITIES_FILE,
  CAPABILITY_DOMAINS,
  CAPABILITY_SCOPES,
  CAPABILITY_SHAPES,
  MAP_CHECK_CODES,
  MAP_FILE,
  MAP_RULES,
  SNAPSHOT_FILE,
} from "./lib/map-checks.mjs";

/** Repository root, resolved from this module so the gate does not depend on cwd. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Prettier `printWidth` for this repository (`.prettierrc.json`). */
const PRINT_WIDTH = 100;

/** Order of the optional keys inside one `CAPABILITY_META` object (07 section 4.3). */
const META_KEY_ORDER = Object.freeze([
  "wire",
  "since",
  "scope",
  "shape",
  "proposal",
  "pending",
  "fallback",
  "legacy",
  "detail",
  "notes",
]);

/**
 * Convert a path to posix separators.
 *
 * @param {string} value
 * @returns {string}
 */
function toPosix(value) {
  return String(value).replaceAll("\\", "/");
}

/**
 * Repo-relative posix form of a path, or the absolute posix path when the file
 * lives outside the repository (the tests use a temp directory).
 *
 * @param {string} filePath
 * @returns {string}
 */
function displayPath(filePath) {
  const absolute = path.resolve(filePath);
  const relative = toPosix(path.relative(REPO_ROOT, absolute));

  return relative.startsWith("..") ? toPosix(absolute) : relative;
}

/**
 * Default absolute path of one repository artifact.
 *
 * @param {string} repoRelative
 * @returns {string}
 */
function repoPath(repoRelative) {
  return path.join(REPO_ROOT, ...repoRelative.split("/"));
}

/**
 * True for a non-null, non-array object.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON: object keys sorted recursively, arrays kept in order.
 *
 * This is what the header digest hashes, so the artifact stays stable when a
 * JSON file is re-indented or its keys are reordered.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(compareStrings);
    const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",");

    return `{${body}}`;
  }

  return JSON.stringify(value);
}

/**
 * First 12 hex characters of the sha256 of a canonical serialization.
 *
 * @param {unknown} value
 * @returns {string}
 */
function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex").slice(0, 12);
}

/**
 * Read and parse one JSON file, throwing an actionable message on failure.
 *
 * @param {string} filePath
 * @param {string} label
 * @returns {unknown}
 */
function readJsonFile(filePath, label) {
  let text;

  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const reason =
      isPlainObject(error) && typeof error.code === "string" ? error.code : String(error);

    throw new Error(`cannot read ${label} at ${toPosix(filePath)}: ${reason}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(`cannot parse ${label} at ${toPosix(filePath)} as JSON: ${reason}`);
  }
}

/**
 * Emit one string-literal union type, matching Prettier's layout.
 *
 * @param {string} typeName
 * @param {string[]} members Already-quoted literals.
 * @returns {string[]}
 */
function emitUnion(typeName, members) {
  if (members.length === 0) {
    return [`export type ${typeName} = never;`];
  }

  if (members.length === 1) {
    return [`export type ${typeName} = ${members[0]};`];
  }

  const flat = `export type ${typeName} = ${members.join(" | ")};`;

  if (flat.length <= PRINT_WIDTH) {
    return [flat];
  }

  // Prettier's "assignment layout": break after `=`, then try the union flat at
  // one indent level, and fall back to one leading-pipe member per line.
  const indented = `  ${members.join(" | ")};`;

  if (indented.length <= PRINT_WIDTH) {
    return [`export type ${typeName} =`, indented];
  }

  const lines = [`export type ${typeName} =`];

  members.forEach((member, index) => {
    const suffix = index === members.length - 1 ? ";" : "";

    lines.push(`  | ${member}${suffix}`);
  });

  return lines;
}

/**
 * Render one value of a `CapabilityMeta` property.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
function emitMetaValue(key, value) {
  if (CAPABILITY_FLAG_KEYS.includes(key) && value === true) {
    return "true";
  }

  return JSON.stringify(value);
}

/**
 * One `CAPABILITY_META` property, laid out the way Prettier would lay it out.
 *
 * Three shapes are possible, all decided by the 100-column line:
 *   - the whole entry on one line, when it fits;
 *   - one property per line;
 *   - `key:` alone with the value on the next line, when a single property line
 *     is still too long (Prettier does exactly this for long strings).
 *
 * @param {Record<string, unknown>} entry
 * @returns {string[]}
 */
function emitMetaProperty(entry) {
  const key = `${JSON.stringify(String(entry.name))}:`;
  const properties = [];

  for (const name of META_KEY_ORDER) {
    const value = entry[name];

    if (value === undefined) {
      continue;
    }

    properties.push({ name, value: emitMetaValue(name, value) });
  }

  const inline = properties.map((property) => `${property.name}: ${property.value}`);
  const flat = `  ${key} { ${inline.join(", ")} },`;

  if (flat.length <= PRINT_WIDTH) {
    return [flat];
  }

  const lines = [`  ${key} {`];

  for (const property of properties) {
    const single = `    ${property.name}: ${property.value},`;

    if (single.length <= PRINT_WIDTH) {
      lines.push(single);
      continue;
    }

    lines.push(`    ${property.name}:`);
    lines.push(`      ${property.value},`);
  }

  lines.push("  },");

  return lines;
}

/**
 * Emit a record literal (`CAPABILITY_TO_WIRE` or `CAPABILITY_META`).
 *
 * Exactly one of `simpleEntries` / `metaEntries` is non-null, mirroring the two
 * generated constants.
 *
 * @param {string} constName
 * @param {string} typeName `string` or `CapabilityMeta`.
 * @param {{key: string, value: string}[] | null} simpleEntries
 * @param {Record<string, unknown>[] | null} metaEntries
 * @returns {string[]}
 */
function emitRecord(constName, typeName, simpleEntries, metaEntries) {
  const suffix = ` as const satisfies Record<CapabilityName, ${typeName}>;`;
  const empty = `export const ${constName} = {}${suffix}`;

  if (simpleEntries !== null) {
    if (simpleEntries.length === 0) {
      return [empty];
    }

    const body = simpleEntries.map((entry) => `${JSON.stringify(entry.key)}: ${entry.value}`);
    const flat = `export const ${constName} = { ${body.join(", ")} }${suffix}`;

    if (flat.length <= PRINT_WIDTH) {
      return [flat];
    }

    return [
      `export const ${constName} = {`,
      ...simpleEntries.map((entry) => `  ${JSON.stringify(entry.key)}: ${entry.value},`),
      `}${suffix}`,
    ];
  }

  if (metaEntries === null) {
    throw new TypeError(`${constName} needs either simple or meta entries`);
  }

  if (metaEntries.length === 0) {
    return [empty];
  }

  const rendered = metaEntries.map((entry) => emitMetaProperty(entry));

  if (rendered.every((entry) => entry.length === 1)) {
    const inline = rendered.map((entry) => entry[0].slice(2).replace(/,$/, ""));
    const flat = `export const ${constName} = { ${inline.join(", ")} }${suffix}`;

    if (flat.length <= PRINT_WIDTH) {
      return [flat];
    }
  }

  return [`export const ${constName} = {`, ...rendered.flat(), `}${suffix}`];
}

/**
 * Emit the whole artifact text (already Prettier-clean, LF terminated).
 *
 * @param {{snapshot: unknown, capabilities: unknown}} input
 * @returns {string}
 */
function emitMap({ snapshot, capabilities }) {
  const requiredSnapshot = requireSnapshot(snapshot);
  const entries = requireCapabilities(capabilities)
    .slice()
    .sort((left, right) => compareStrings(String(left.name), String(right.name)));
  const engine = requiredSnapshot.engine;
  const engineLine =
    `export const CAPABILITY_SNAPSHOT_ENGINE = { version: ${JSON.stringify(engine.version)},` +
    ` commit: ${JSON.stringify(engine.commit)} } as const;`;

  const lines = [
    "// AUTO-GENERATED by scripts/contract/map.mjs - DO NOT EDIT.",
    `// source: snapshot.json@sha256:${digest(snapshot)} + capabilities.json@sha256:${digest(
      capabilities,
    )}`,
    `// engine: ${engine.version} @ ${engine.commit}`,
    "",
    ...emitUnion(
      "CapabilityScope",
      CAPABILITY_SCOPES.map((value) => JSON.stringify(value)),
    ),
    "",
    ...emitUnion(
      "CapabilityShape",
      CAPABILITY_SHAPES.map((value) => JSON.stringify(value)),
    ),
    "",
    "/** Literal union, lexicographic order; entries are only ever added, never renamed. */",
    ...emitUnion(
      "CapabilityName",
      entries.map((entry) => JSON.stringify(String(entry.name))),
    ),
    "",
    "export interface CapabilityMeta {",
    "  readonly wire: string;",
    "  readonly since: string;",
    "  readonly scope: CapabilityScope;",
    "  readonly shape: CapabilityShape;",
    "  readonly proposal?: string;",
    "  readonly pending?: true;",
    "  readonly fallback?: CapabilityName;",
    "  readonly legacy?: true;",
    "  readonly detail?: true;",
    "  readonly notes?: string;",
    "}",
    "",
    ...emitRecord(
      "CAPABILITY_TO_WIRE",
      "string",
      entries.map((entry) => ({
        key: String(entry.name),
        value: JSON.stringify(String(entry.wire)),
      })),
      null,
    ),
    "",
    ...emitRecord("CAPABILITY_META", "CapabilityMeta", null, entries),
    "",
    engineLine,
  ];

  // The engine constant is emitted flat first; break it like Prettier does when
  // the single line would exceed the print width.
  const last = lines.length - 1;

  if (lines[last].length > PRINT_WIDTH) {
    lines.splice(
      last,
      1,
      "export const CAPABILITY_SNAPSHOT_ENGINE = {",
      `  version: ${JSON.stringify(engine.version)},`,
      `  commit: ${JSON.stringify(engine.commit)},`,
      "} as const;",
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Extract the capability names declared inside `CAPABILITY_TO_WIRE`.
 *
 * The artifact is the second source of truth for the map, so the stale check
 * also verifies that every declared capability survived into it.
 *
 * @param {string} text Artifact bytes.
 * @returns {string[] | null} Names in file order, or null when the block is absent.
 */
export function parseGeneratedNames(text) {
  if (typeof text !== "string") {
    return null;
  }

  const anchor = "export const CAPABILITY_TO_WIRE = ";
  const start = text.indexOf(anchor);

  if (start === -1) {
    return null;
  }

  const open = text.indexOf("{", start);
  const close = text.indexOf("} as const satisfies Record<CapabilityName, string>", open);

  if (open === -1 || close === -1) {
    return null;
  }

  const body = text.slice(open + 1, close);
  const names = [];
  const keyPattern = /"((?:[^"\\]|\\.)*)"\s*:/g;
  let match = keyPattern.exec(body);

  while (match !== null) {
    try {
      names.push(JSON.parse(`"${match[1]}"`));
    } catch {
      return null;
    }

    match = keyPattern.exec(body);
  }

  return names;
}

/**
 * Generate the artifact from the two truth sources.
 *
 * Returns `{code: 0, text, violations}` when nothing is red (violations may
 * still hold warnings) and `{code: 1, violations}` otherwise - never a partial
 * or "plausible looking" file. Inputs are not mutated.
 *
 * `generatedNames` is optional and exists for the stale/consistency path: when
 * the caller passes the names read back from the committed artifact, the
 * missing / orphan checks become meaningful. A plain `contract:generate` call
 * passes nothing.
 *
 * @param {{snapshot: unknown, capabilities: unknown, generatedNames?: string[] | null}} input
 * @returns {{code: 0, text: string, violations: object[]} | {code: 1, violations: object[]}}
 *   Violations follow the `Violation` shape documented in `lib/map-checks.mjs`.
 */
export function generateMap({ snapshot, capabilities, generatedNames = null }) {
  const violations = collectViolations({ snapshot, capabilities, generatedNames });
  const errors = violations.filter((entry) => entry.severity === "error");

  if (errors.length > 0) {
    return { code: 1, violations };
  }

  return { code: 0, text: emitMap({ snapshot, capabilities }), violations };
}

/**
 * 1-based line number where two texts first differ (`length + 1` when one is a
 * prefix of the other).
 *
 * @param {string} actual
 * @param {string} expected
 * @returns {number}
 */
function firstDifferentLine(actual, expected) {
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const limit = Math.min(actualLines.length, expectedLines.length);

  for (let index = 0; index < limit; index += 1) {
    if (actualLines[index] !== expectedLines[index]) {
      return index + 1;
    }
  }

  return limit + 1;
}

/**
 * Read both truth sources and the committed artifact, then produce the verdict.
 *
 * A missing or unreadable snapshot / capability file throws (exit code 2). A
 * missing or hand-edited artifact is a violation (exit code 1), because that is
 * the drift this gate must catch.
 *
 * `violations` includes warnings; gate callers must filter on
 * `severity === "error"` (or read `ok`) before handing the list to `finish()`.
 *
 * @param {{snapshotPath?: string, capabilitiesPath?: string, generatedPath?: string}} [options]
 * @returns {{ok: boolean, violations: object[], summary: Record<string, unknown>}}
 */
export function checkMap({
  snapshotPath = repoPath(SNAPSHOT_FILE),
  capabilitiesPath = repoPath(CAPABILITIES_FILE),
  generatedPath = repoPath(MAP_FILE),
} = {}) {
  const snapshot = readJsonFile(snapshotPath, "snapshot");
  const capabilities = readJsonFile(capabilitiesPath, "capabilities");
  const entries = requireCapabilities(capabilities);
  const requiredSnapshot = requireSnapshot(snapshot);

  let generatedText = null;

  try {
    generatedText = readFileSync(generatedPath, "utf8");
  } catch {
    generatedText = null;
  }

  const generatedNames = generatedText === null ? null : parseGeneratedNames(generatedText);
  const generated = generateMap({ snapshot, capabilities, generatedNames });
  const violations = generated.violations.slice();

  if (generatedText === null) {
    violations.push({
      file: displayPath(generatedPath),
      rule: "contract-stale",
      code: "missing-artifact",
      severity: "error",
      message: "missing-artifact: generated file does not exist; run contract:generate",
    });
  } else if (generated.code === 0 && generatedText !== generated.text) {
    violations.push({
      file: displayPath(generatedPath),
      rule: "contract-stale",
      code: "stale-artifact",
      severity: "error",
      message:
        `stale-artifact: generated file differs from a fresh generation at line ` +
        `${firstDifferentLine(generatedText, generated.text)}; run contract:generate`,
    });
  }

  const sorted = sortViolations(violations);
  const errors = sorted.filter((entry) => entry.severity === "error");
  const warnings = sorted.filter((entry) => entry.severity === "warning");

  return {
    ok: errors.length === 0,
    violations: sorted,
    summary: {
      engine: {
        version: requiredSnapshot.engine.version,
        commit: requiredSnapshot.engine.commit,
      },
      capabilities: entries.length,
      detail: entries.filter((entry) => entry.detail === true).length,
      pending: entries.filter((entry) => entry.pending === true).length,
      fieldLevel: requiredSnapshot.commands.filter((command) => command.fieldLevel === true).length,
      generated: generatedNames === null ? null : generatedNames.length,
      errors: errors.length,
      warnings: warnings.length,
    },
  };
}
