/**
 * Generator + map checks tests.
 *
 * The suite has two halves:
 *
 *   1. the artifact produced from the committed truth sources
 *      (`packages/protocol/src/contract/snapshot.json` +
 *      `capabilities.json`), asserted for shape (68 entries, 68 union
 *      literals, 67 detail entries), determinism, ASCII-only output, quote
 *      escaping, and - the frozen promise of risk R-11 - a clean
 *      `prettier --check` and `tsc --strict` run;
 *
 *   2. one synthetic red case per rule, so each can fail on its own:
 *      missing / orphan entry, duplicate name, dangling fallback, unknown wire,
 *      since ahead, pending without proposal, both coverage directions,
 *      degraded health (red) and coarse health (warning only), plus the
 *      `contract-stale` comparison in both its missing and edited forms.
 *
 * A minimal in-memory fixture (`MINI_*`) keeps each red case single-caused. The
 * committed data is only used where the point is the committed data itself.
 *
 * The generated text is written to a file under `fs.mkdtemp(os.tmpdir())`; only
 * the single files this suite creates are deleted, never the directory
 * (discipline 03 section 1.1). Nothing here writes into the repository, touches
 * the network or starts the engine.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CAPABILITIES_FILE,
  SNAPSHOT_FILE,
  checkMap,
  generateMap,
  parseGeneratedNames,
} from "./contract/map.mjs";
import { requireCapabilities, requireSnapshot } from "./contract/lib/map-checks.mjs";
import { defined } from "./lib/test-assert.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRETTIER_BIN = path.join(REPO_ROOT, "node_modules", "prettier", "bin", "prettier.cjs");
const PRETTIER_CONFIG = path.join(REPO_ROOT, ".prettierrc.json");
const TSC_BIN = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

const SNAPSHOT_PATH = path.join(REPO_ROOT, ...SNAPSHOT_FILE.split("/"));
const CAPABILITIES_PATH = path.join(REPO_ROOT, ...CAPABILITIES_FILE.split("/"));

/** Locked facts for the committed data. */
const LOCKED_TOTAL = 68;
const LOCKED_DETAIL = 67;

/** @type {any} */
const SNAPSHOT = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
/** @type {any} */
const CAPABILITIES = JSON.parse(readFileSync(CAPABILITIES_PATH, "utf8"));

/** Smallest snapshot that still exercises the rules: one field-level command. */
const MINI_SNAPSHOT = {
  schemaVersion: 1,
  engine: { version: "0.6.0", commit: "1641a4f" },
  commands: [
    { wire: "agent_list", fieldLevel: true },
    { wire: "file_ops", fieldLevel: false },
  ],
  health: { degraded: false, coarse: [], unparsed: [] },
};

/**
 * One capability entry accepted by the fixture builder.
 *
 * Every field is optional except `name` because the red cases each set only
 * what the rule under test reads.
 */
type FixtureCapability = {
  name: string;
  wire?: string;
  since?: string;
  scope?: string;
  shape?: string;
  detail?: boolean;
  legacy?: boolean;
  pending?: boolean;
  proposal?: string;
  fallback?: string;
  notes?: string;
};

/**
 * Minimal capability table: `agent.list` carries the field-level wire, so the
 * coverage closure is satisfied by default and a red case can add exactly one
 * violation.
 *
 * Typed in TS, not JSDoc: a JSDoc `@param` is ignored in a `.ts` file, so the
 * `extra = []` default inferred `never[]` and every capability literal passed
 * here was rejected as "not assignable to type 'never'".
 *
 * @param extra capability entries appended after the base fixture
 * @returns a capabilities table shaped like `capabilities.json`
 */
function miniCapabilities(extra: FixtureCapability[] = []): {
  schemaVersion: number;
  capabilities: FixtureCapability[];
} {
  return {
    schemaVersion: 1,
    capabilities: [
      {
        name: "agent.list",
        wire: "agent_list",
        since: "0.6.0",
        scope: "none",
        shape: "request-response",
        detail: true,
        notes: "mini fixture",
      },
      ...extra,
    ],
  };
}

/** @param {unknown} value */
function deepClone(value) {
  return structuredClone(value);
}

/**
 * Assert `generateMap` produced an artifact and narrow it to the success arm.
 *
 * `generateMap` returns `{code: 0, text, violations} | {code: 1, violations}`;
 * `expect(result.code).toBe(0)` tells the compiler nothing, so every
 * success-only `text` read below would be "does not exist on type". The
 * assertion signature narrows without a cast, and the failure message still
 * names the violations.
 *
 * @param result value returned by `generateMap`
 * @param context what was being generated, echoed in the failure message
 */
function expectGeneratedMap(
  result: ReturnType<typeof generateMap>,
  context: string,
): asserts result is Extract<ReturnType<typeof generateMap>, { code: 0 }> {
  expect(result.code, `${context}: ${JSON.stringify(result.violations)}`).toBe(0);

  if (result.code !== 0) {
    throw new Error(`${context}: expected code 0, got ${result.code}`);
  }
}

/** @param {{violations: {code: string}[]}} result */
function codesOf(result) {
  return result.violations.map((entry) => entry.code);
}

/** @param {{severity: string}[]} violations */
function errorsOf(violations) {
  return violations.filter((entry) => entry.severity === "error");
}

/**
 * Members of the `CapabilityName` union literal, unescaped.
 *
 * @param {string} text
 * @returns {string[]}
 */
function capabilityNameUnion(text) {
  const anchor = "export type CapabilityName =";
  const start = text.indexOf(anchor);
  const end = text.indexOf("\n\nexport interface CapabilityMeta", start);
  const block = start === -1 ? "" : text.slice(start, end === -1 ? undefined : end);

  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`));
}

/**
 * Names declared by the `CAPABILITY_META` object literal.
 *
 * @param {string} text
 * @returns {string[]}
 */
function metaNames(text) {
  const start = text.indexOf("export const CAPABILITY_META = {");
  const end = text.indexOf("} as const satisfies Record<CapabilityName, CapabilityMeta>;", start);
  const block = start === -1 ? "" : text.slice(start, end === -1 ? undefined : end);

  return [...block.matchAll(/^ {2}"((?:[^"\\]|\\.)*)": \{/gm)].map((match) =>
    JSON.parse(`"${match[1]}"`),
  );
}

/**
 * Run `prettier --check` the way the pre-commit hook does, from the repository
 * root with the repository config.
 *
 * `pnpm exec` is preferred (that is what a contributor runs); when the pnpm
 * shim is unavailable the same Prettier entry point is executed with
 * `process.execPath`, so the check never passes or fails for the wrong reason.
 *
 * @param {string} file
 * @returns {{ok: boolean, output: string}}
 */
function prettierCheck(file) {
  const command = [
    "pnpm exec prettier --check",
    `"${file}"`,
    "--config",
    `"${PRETTIER_CONFIG}"`,
  ].join(" ");
  const viaPnpm = spawnSync(command, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: true,
  });

  if (viaPnpm.status === 0) {
    return { ok: true, output: `${viaPnpm.stdout ?? ""}${viaPnpm.stderr ?? ""}` };
  }

  const direct = spawnSync(
    process.execPath,
    [PRETTIER_BIN, "--check", file, "--config", PRETTIER_CONFIG],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );

  return {
    ok: direct.status === 0,
    output: [
      `pnpm status: ${String(viaPnpm.status)}`,
      String(viaPnpm.stderr ?? ""),
      `direct status: ${String(direct.status)}`,
      String(direct.stdout ?? ""),
      String(direct.stderr ?? ""),
    ].join("\n"),
  };
}

/**
 * Type-check the artifact with the repository's strict flags (R-11).
 *
 * @param {string} file
 * @returns {{ok: boolean, output: string}}
 */
function typecheck(file) {
  const result = spawnSync(
    process.execPath,
    [
      TSC_BIN,
      "--noEmit",
      "--strict",
      "--verbatimModuleSyntax",
      "--exactOptionalPropertyTypes",
      "--noUncheckedIndexedAccess",
      "--target",
      "ES2023",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--skipLibCheck",
      file,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Temp directory and artifact path created once for the suite. */
let tempDirectory = "";
let artifactPath = "";
/** Files this suite creates, removed in `afterAll`. */
const tempFiles: string[] = [];

/** @param {string} name */
function createTempFile(name) {
  const file = path.join(tempDirectory, name);

  if (!tempFiles.includes(file)) {
    tempFiles.push(file);
  }

  return file;
}

/** The generated text for the committed data, computed once. */
let generatedText = "";

beforeAll(() => {
  tempDirectory = mkdtempSync(path.join(os.tmpdir(), "contract-map-"));
  artifactPath = createTempFile("command-map.generated.ts");
  const generated = generateMap({ snapshot: SNAPSHOT, capabilities: CAPABILITIES });

  expectGeneratedMap(generated, "the committed data");
  generatedText = generated.text;
  writeFileSync(artifactPath, generatedText);
});

afterAll(() => {
  for (const file of tempFiles) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }
});

describe("generated artifact", () => {
  it("registers every capability once, sorted, with 67 detail entries", () => {
    const wireNames = parseGeneratedNames(generatedText);
    const unionNames = capabilityNameUnion(generatedText);
    const metaBlockNames = metaNames(generatedText);

    expect(wireNames).not.toBeNull();
    expect(wireNames).toHaveLength(LOCKED_TOTAL);
    expect(unionNames).toHaveLength(LOCKED_TOTAL);
    expect(metaBlockNames).toHaveLength(LOCKED_TOTAL);
    expect(new Set(wireNames).size).toBe(LOCKED_TOTAL);
    expect(unionNames).toEqual([...unionNames].sort((left, right) => (left < right ? -1 : 1)));
    expect(unionNames).toEqual(wireNames);
    expect(metaBlockNames).toEqual(wireNames);

    const declaredDetail = CAPABILITIES.capabilities.filter(
      /** @param {any} entry */ (entry) => entry.detail === true,
    ).length;
    expect(declaredDetail).toBe(LOCKED_DETAIL);
    expect(generatedText.match(/detail: true/g) ?? []).toHaveLength(LOCKED_DETAIL);
  });

  it("exports exactly the frozen shape and carries the three header lines", () => {
    expect(
      generatedText.startsWith("// AUTO-GENERATED by scripts/contract/map.mjs - DO NOT EDIT.\n"),
    ).toBe(true);
    expect(generatedText).toContain("// source: snapshot.json@sha256:");
    expect(generatedText).toContain("+ capabilities.json@sha256:");
    expect(generatedText).toContain(
      `// engine: ${SNAPSHOT.engine.version} @ ${SNAPSHOT.engine.commit}`,
    );
    expect(generatedText.match(/^export /gm) ?? []).toHaveLength(7);
    expect(generatedText).toContain(
      'export const CAPABILITY_SNAPSHOT_ENGINE = { version: "0.6.0", commit: "1641a4f" } as const;',
    );
    expect(generatedText.endsWith("\n")).toBe(true);
    expect(generatedText.endsWith("\n\n")).toBe(false);
  });

  it("is byte-identical across two runs", () => {
    const first = generateMap({ snapshot: SNAPSHOT, capabilities: CAPABILITIES });
    const second = generateMap({ snapshot: SNAPSHOT, capabilities: CAPABILITIES });

    expectGeneratedMap(first, "the first run");
    expectGeneratedMap(second, "the second run");
    expect(second.text).toBe(first.text);
    expect(first.text).toBe(generatedText);
  });

  it("is byte-identical when the JSON key order changes", () => {
    const reordered = {
      capabilities: CAPABILITIES.capabilities.map((/** @type {any} */ entry) =>
        Object.fromEntries(Object.entries(entry).reverse()),
      ),
      schemaVersion: CAPABILITIES.schemaVersion,
    };
    const generated = generateMap({ snapshot: SNAPSHOT, capabilities: reordered });

    expectGeneratedMap(generated, "the reordered-key table");
    expect(generated.text).toBe(generatedText);
  });

  it("contains ASCII only", () => {
    expect(/^[\t\n\r\x20-\x7e]*$/.test(generatedText)).toBe(true);
  });

  it("escapes quotes and backslashes in notes as JSON string literals", () => {
    const note = 'he said "hello" from C:\\tmp\\note';
    const table = miniCapabilities();
    defined(table.capabilities[0], "capabilities[0]").notes = note;
    const generated = generateMap({ snapshot: MINI_SNAPSHOT, capabilities: table });

    expectGeneratedMap(generated, "the escaped-note table");
    expect(generated.text).toContain(JSON.stringify(note));
    expect(generated.text).not.toContain(note);
  });

  it("passes prettier --check at the repository settings", () => {
    const result = prettierCheck(artifactPath);

    expect(result.ok, result.output).toBe(true);
  });

  it("type-checks under strict + verbatimModuleSyntax + exactOptionalPropertyTypes", () => {
    const result = typecheck(artifactPath);

    expect(result.ok, result.output).toBe(true);
  });
});

describe("contract-map rules", () => {
  it("reds a capability that is missing from the generated map", () => {
    const table = miniCapabilities([
      {
        name: "file.ops",
        wire: "file_ops",
        since: "0.6.0",
        scope: "none",
        shape: "bidirectional",
        legacy: true,
      },
    ]);
    const generated = generateMap({
      snapshot: MINI_SNAPSHOT,
      capabilities: table,
      generatedNames: ["agent.list"],
    });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toContain("missing-capability");
  });

  it("reds a generated-map entry that no capability declares", () => {
    const generated = generateMap({
      snapshot: MINI_SNAPSHOT,
      capabilities: miniCapabilities(),
      generatedNames: ["agent.list", "ghost.entry"],
    });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toContain("orphan-capability");
  });

  it("reds a duplicated capability name", () => {
    const table = miniCapabilities([
      { name: "agent.list", wire: "file_ops", since: "0.6.0", scope: "none", shape: "raw" },
    ]);
    const generated = generateMap({ snapshot: MINI_SNAPSHOT, capabilities: table });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toContain("duplicate-name");
  });

  it("reds two capabilities that register the same wire (P6-F2)", () => {
    const table = miniCapabilities([
      {
        name: "agent.listAlias",
        wire: "agent_list",
        since: "0.6.0",
        scope: "none",
        shape: "request-response",
      },
    ]);
    const generated = generateMap({ snapshot: MINI_SNAPSHOT, capabilities: table });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toEqual(["duplicate-wire"]);
    expect(generated.violations[0].rule).toBe("contract-map");
    expect(generated.violations[0].message).toContain('wire "agent_list"');
    expect(generated.violations[0].message).toContain('"agent.listAlias"');
  });

  it("does not double-report a repeated name as a duplicate wire", () => {
    const table = miniCapabilities([
      {
        name: "agent.list",
        wire: "agent_list",
        since: "0.6.0",
        scope: "none",
        shape: "request-response",
        detail: true,
      },
    ]);
    const generated = generateMap({ snapshot: MINI_SNAPSHOT, capabilities: table });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toEqual(["duplicate-name"]);
  });

  it("reds a fallback that points at an undeclared name", () => {
    const table = miniCapabilities();
    defined(table.capabilities[0], "capabilities[0]").fallback = "agent.missing";
    const generated = generateMap({ snapshot: MINI_SNAPSHOT, capabilities: table });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toContain("dangling-fallback");
  });

  it("reds a wire that is not in the pinned snapshot", () => {
    const table = miniCapabilities([
      { name: "agent.other", wire: "not_a_wire", since: "0.6.0", scope: "none", shape: "raw" },
    ]);
    const generated = generateMap({ snapshot: MINI_SNAPSHOT, capabilities: table });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toContain("unknown-wire");
  });

  it("reds a since newer than the pinned engine", () => {
    const table = miniCapabilities();
    defined(table.capabilities[0], "capabilities[0]").since = "9.9.9";
    const generated = generateMap({ snapshot: MINI_SNAPSHOT, capabilities: table });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toContain("since-ahead");
  });

  it("reds a pending entry without a proposal", () => {
    const table = miniCapabilities([
      {
        name: "context.pending",
        wire: "context_pending",
        since: "0.7.0",
        scope: "conversation",
        shape: "request-response",
        pending: true,
        fallback: "agent.list",
      },
    ]);
    const generated = generateMap({ snapshot: MINI_SNAPSHOT, capabilities: table });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toEqual(["pending-without-proposal"]);
  });

  it("accepts a pending entry with a proposal and exempts it from wire/since", () => {
    const table = miniCapabilities([
      {
        name: "context.pending",
        wire: "context_pending",
        since: "0.7.0",
        scope: "conversation",
        shape: "request-response",
        proposal: "P-02",
        pending: true,
        fallback: "agent.list",
      },
    ]);
    const generated = generateMap({ snapshot: MINI_SNAPSHOT, capabilities: table });

    expect(generated.violations).toEqual([]);
    expectGeneratedMap(generated, "the pending-with-proposal table");
    expect(generated.text).toContain("pending: true");
    expect(generated.text).toContain('proposal: "P-02"');
    expect(generated.text).toContain('fallback: "agent.list"');
  });
});

describe("contract-cover closure", () => {
  it("reds a detail wire that the snapshot does not record at field level", () => {
    const table = miniCapabilities([
      {
        name: "file.ops",
        wire: "file_ops",
        since: "0.6.0",
        scope: "none",
        shape: "bidirectional",
        detail: true,
      },
    ]);
    const generated = generateMap({ snapshot: MINI_SNAPSHOT, capabilities: table });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toEqual(["detail-without-fields"]);
    expect(generated.violations[0].rule).toBe("contract-cover");
  });

  it("reds a field-level command that no detail capability registers", () => {
    const snapshot = deepClone(MINI_SNAPSHOT);

    snapshot.commands[1].fieldLevel = true;
    const generated = generateMap({ snapshot, capabilities: miniCapabilities() });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toEqual(["fields-without-detail"]);
    expect(generated.violations[0].rule).toBe("contract-cover");
  });

  it("closes the loop on the committed data (67 == 67)", () => {
    const fieldLevel = SNAPSHOT.commands.filter(
      /** @param {any} command */ (command) => command.fieldLevel === true,
    );

    expect(fieldLevel).toHaveLength(LOCKED_DETAIL);
    expect(
      errorsOf(generateMap({ snapshot: SNAPSHOT, capabilities: CAPABILITIES }).violations),
    ).toEqual([]);
  });
});

describe("contract-health", () => {
  it("reds a degraded snapshot", () => {
    const snapshot = deepClone(MINI_SNAPSHOT);

    snapshot.health.degraded = true;
    const generated = generateMap({ snapshot, capabilities: miniCapabilities() });

    expect(generated.code).toBe(1);
    expect(codesOf(generated)).toEqual(["degraded-snapshot"]);
    expect(generated.violations[0].rule).toBe("contract-health");
    expect(generated.violations[0].severity).toBe("error");
  });

  it("only warns about coarse entries", () => {
    const snapshot = deepClone(MINI_SNAPSHOT);

    snapshot.health.coarse = ["SomeType@src/types/x.ts:1: shape not flattened"];
    const generated = generateMap({ snapshot, capabilities: miniCapabilities() });

    expect(generated.code).toBe(0);
    expect(generated.violations).toHaveLength(1);
    expect(generated.violations[0].code).toBe("coarse-fields");
    expect(generated.violations[0].severity).toBe("warning");
  });
});

describe("schema version guard (P6-F6)", () => {
  it("rejects a snapshot written for another schema version", () => {
    expect(() => requireSnapshot({ ...SNAPSHOT, schemaVersion: 2 })).toThrow(
      /snapshot\.json schemaVersion 2 is not supported \(expected 1\)/,
    );
  });

  it("rejects a capability table written for another schema version", () => {
    expect(() => requireCapabilities({ ...CAPABILITIES, schemaVersion: 2 })).toThrow(
      /capabilities\.json schemaVersion 2 is not supported \(expected 1\)/,
    );
  });
});

describe("checkMap against the artifact on disk", () => {
  it("passes on a freshly generated artifact and reports the counts", () => {
    const result = checkMap({
      snapshotPath: SNAPSHOT_PATH,
      capabilitiesPath: CAPABILITIES_PATH,
      generatedPath: artifactPath,
    });

    expect(errorsOf(result.violations)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({
      capabilities: LOCKED_TOTAL,
      detail: LOCKED_DETAIL,
      pending: 0,
      fieldLevel: LOCKED_DETAIL,
      generated: LOCKED_TOTAL,
      errors: 0,
      warnings: 1,
    });
  });

  it("reds a one-line hand edit of the artifact", () => {
    const editedPath = createTempFile("edited.generated.ts");
    const edited = generatedText.replace(
      '"agent.create": "agent_create",',
      '"agent.create": "agent_created",',
    );

    writeFileSync(editedPath, edited);
    const result = checkMap({
      snapshotPath: SNAPSHOT_PATH,
      capabilitiesPath: CAPABILITIES_PATH,
      generatedPath: editedPath,
    });

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("stale-artifact");
    const stale = result.violations.find(
      (/** @type {any} */ entry) => entry.code === "stale-artifact",
    );
    expect(stale.rule).toBe("contract-stale");
    expect(stale.message).toMatch(/differs from a fresh generation at line \d+/);

    // Repairing the artifact turns the suite green again without a restart.
    writeFileSync(editedPath, generatedText);
    expect(
      checkMap({
        snapshotPath: SNAPSHOT_PATH,
        capabilitiesPath: CAPABILITIES_PATH,
        generatedPath: editedPath,
      }).ok,
    ).toBe(true);
  });

  it("reds an artifact that lost one capability line", () => {
    const truncatedPath = createTempFile("truncated.generated.ts");
    const truncated = generatedText.replace('  "agent.delete": "agent_delete",\n', "");

    writeFileSync(truncatedPath, truncated);
    const result = checkMap({
      snapshotPath: SNAPSHOT_PATH,
      capabilitiesPath: CAPABILITIES_PATH,
      generatedPath: truncatedPath,
    });

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("missing-capability");
  });

  it("reds a missing artifact", () => {
    const result = checkMap({
      snapshotPath: SNAPSHOT_PATH,
      capabilitiesPath: CAPABILITIES_PATH,
      generatedPath: path.join(tempDirectory, "nope.generated.ts"),
    });

    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("missing-artifact");
  });

  it("throws when a truth source is unreadable (exit 2 territory)", () => {
    expect(() =>
      checkMap({
        snapshotPath: path.join(tempDirectory, "nope.json"),
        capabilitiesPath: CAPABILITIES_PATH,
        generatedPath: artifactPath,
      }),
    ).toThrow(/cannot read snapshot/);
  });

  it("keeps every message English and single line", () => {
    const result = checkMap({
      snapshotPath: SNAPSHOT_PATH,
      capabilitiesPath: CAPABILITIES_PATH,
      generatedPath: path.join(tempDirectory, "nope.generated.ts"),
    });

    for (const entry of result.violations) {
      expect(entry.message).not.toContain("\n");
      expect(/^[\t\r\x20-\x7e]*$/.test(entry.message)).toBe(true);
    }
  });
});
