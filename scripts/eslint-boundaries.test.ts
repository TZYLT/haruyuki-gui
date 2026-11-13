/**
 * Gate self-test for the ESLint layer of the package-boundary rules (P1-6,
 * P1-8): the fast, editor-facing first pass in eslint.config.mjs.
 *
 * The suite drives the real ESLint installation with the real config. Each
 * probe is linted as virtual text with a file path inside the package directory,
 * so the per-package `files` blocks match without writing into the repository.
 * Nothing here is mocked: deleting one `no-restricted-imports` pattern from
 * eslint.config.mjs turns the matching case red, which is exactly the property
 * this suite exists to guarantee.
 *
 * Coverage:
 *   - all 20 non-diagonal matrix cells, as a value import and as an
 *     `import type` (which is where `allowTypeImports` semantics live);
 *   - host APIs (R2/R3/R5/R12) and Node builtins (R4), including the deprecated
 *     bare `sys` alias (P1-8);
 *   - deep paths on the type-only edges;
 *   - the layer split: ESLint's core `no-restricted-imports` visits
 *     import/export declarations only. TypeScript type-position `import()`,
 *     `require()`, `createRequire()`, `module.require()` and non-literal
 *     dynamic `import()` are covered by scripts/check-boundaries.mjs, and the
 *     assertions below pin that division of labour explicitly.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Permission = "allow" | "type" | "forbid";

/**
 * The authoritative permission matrix, duplicated on
 * purpose: this is the spec side of a gate self-test, so it must not be imported
 * from the code under test.
 */
const MATRIX: Record<string, Record<string, Permission>> = {
  protocol: { core: "forbid", ui: "forbid", desktop: "forbid", vscode: "forbid" },
  core: { protocol: "allow", ui: "forbid", desktop: "forbid", vscode: "forbid" },
  ui: { protocol: "type", core: "type", desktop: "forbid", vscode: "forbid" },
  desktop: { protocol: "allow", core: "allow", ui: "allow", vscode: "forbid" },
  vscode: { protocol: "allow", core: "allow", ui: "allow", desktop: "forbid" },
};

/** Rule id per restricted matrix edge; the spec copy of the ESLint wiring. */
const RULE_BY_EDGE: Record<string, string> = {
  "protocol->core": "R1",
  "protocol->ui": "R1",
  "protocol->desktop": "R1",
  "protocol->vscode": "R1",
  "core->ui": "R10",
  "core->desktop": "R10",
  "core->vscode": "R10",
  "ui->core": "R6",
  "ui->protocol": "R7",
  "ui->desktop": "R11",
  "ui->vscode": "R11",
  "desktop->vscode": "R8",
  "vscode->desktop": "R9",
};

/** Workspace directory of each matrix package. */
const PACKAGE_DIR: Record<string, string> = {
  protocol: "packages/protocol",
  core: "packages/core",
  ui: "packages/ui",
  desktop: "apps/desktop",
  vscode: "apps/vscode",
};

const PACKAGES = Object.keys(MATRIX);

interface Edge {
  from: string;
  to: string;
  key: string;
}

/** All 20 non-diagonal matrix cells. */
const EDGES: Edge[] = PACKAGES.flatMap((from) =>
  PACKAGES.filter((to) => to !== from).map((to) => ({ from, to, key: `${from}->${to}` })),
);

const eslint = new ESLint({ cwd: REPO_ROOT });

/**
 * Absolute probe path inside one package. The file is never written: ESLint
 * lints the text and only uses the path to select the per-package config block.
 *
 * @param pkg matrix package name
 * @param label unique probe label
 * @returns absolute file path below the package directory
 */
function probePath(pkg: string, label: string): string {
  const directory = PACKAGE_DIR[pkg];

  if (directory === undefined) {
    throw new Error(`no workspace directory for package "${pkg}"`);
  }

  return path.join(REPO_ROOT, directory, "src", `__boundary_probe_${label}__.ts`);
}

/**
 * Rule ids (`R1`...`R12`) mentioned by the lint messages.
 *
 * @param messages ESLint messages
 * @returns distinct rule ids in first-seen order
 */
function ruleIds(messages: readonly { message: string }[]): string[] {
  const ids = messages
    .map((entry) => entry.message.match(/\bR(?:1[0-2]|[1-9])\b/)?.[0])
    .filter((id): id is string => id !== undefined);

  return [...new Set(ids)];
}

/**
 * Lint one probe with the real config.
 *
 * @param pkg matrix package the probe file belongs to
 * @param code probe source
 * @param label unique probe label
 * @returns distinct boundary rule ids reported
 */
async function lint(pkg: string, code: string, label: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: probePath(pkg, label) });

  return ruleIds(result?.messages ?? []);
}

/**
 * @param specifier import specifier
 * @returns a value-import probe
 */
function valueImport(specifier: string): string {
  return `import { probe } from ${JSON.stringify(specifier)};\nexport const value = probe;\n`;
}

/**
 * @param specifier import specifier
 * @returns a type-only import probe
 */
function typeImport(specifier: string): string {
  return `import type { Probe } from ${JSON.stringify(specifier)};\nexport type Alias = Probe;\n`;
}

/**
 * Expected boundary rule ids for one cell and import form.
 *
 * @param from importing package
 * @param to imported package
 * @param form value or type-only import
 * @returns expected rule ids
 */
function expectedRules(from: string, to: string, form: "value" | "type"): string[] {
  const permission = MATRIX[from]?.[to];
  const rule = RULE_BY_EDGE[`${from}->${to}`];

  if (permission === undefined) {
    throw new Error(`no matrix cell for ${from} -> ${to}`);
  }

  if (permission === "forbid") {
    return rule === undefined ? [] : [rule];
  }

  if (permission === "type") {
    return form === "type" || rule === undefined ? [] : [rule];
  }

  return [];
}

describe("ESLint boundary rules: the 20 non-diagonal matrix cells", () => {
  it.each(EDGES)("value import $from -> $to", async ({ from, to, key }) => {
    const ids = await lint(from, valueImport(`@haruyuki/${to}`), `${key}-value`);

    expect(ids).toEqual(expectedRules(from, to, "value"));
  });

  it.each(EDGES)("type-only import $from -> $to", async ({ from, to, key }) => {
    const ids = await lint(from, typeImport(`@haruyuki/${to}`), `${key}-type`);

    expect(ids).toEqual(expectedRules(from, to, "type"));
  });
});

/** Host API probes: each package must not touch the listed module. */
const HOST_API_CASES: Array<{ from: string; specifier: string; expected: string[] }> = [
  { from: "protocol", specifier: "electron", expected: ["R3"] },
  { from: "protocol", specifier: "vscode", expected: ["R3"] },
  { from: "core", specifier: "electron", expected: ["R2"] },
  { from: "core", specifier: "vscode", expected: ["R2"] },
  { from: "ui", specifier: "electron", expected: ["R5"] },
  { from: "ui", specifier: "vscode", expected: ["R5"] },
  { from: "desktop", specifier: "vscode", expected: ["R12"] },
  // Each shell may import its own host API.
  { from: "desktop", specifier: "electron", expected: [] },
  { from: "vscode", specifier: "electron", expected: ["R12"] },
  { from: "vscode", specifier: "electron/main", expected: ["R12"] },
  { from: "vscode", specifier: "vscode", expected: [] },
];

/** Node builtin probes: R4 is the renderer-only rule. */
const BUILTIN_CASES: Array<{ from: string; specifier: string; expected: string[] }> = [
  { from: "ui", specifier: "node:fs", expected: ["R4"] },
  { from: "ui", specifier: "fs", expected: ["R4"] },
  { from: "ui", specifier: "path", expected: ["R4"] },
  // The deprecated bare alias must stay in the deny list (P1-8).
  { from: "ui", specifier: "sys", expected: ["R4"] },
  // R4 is scoped to the renderer; core and the shells may use Node builtins.
  { from: "core", specifier: "sys", expected: [] },
  { from: "desktop", specifier: "node:fs", expected: [] },
];

describe("ESLint boundary rules: host APIs (R2, R3, R5, R12)", () => {
  it.each(HOST_API_CASES)("$from importing $specifier", async ({ from, specifier, expected }) => {
    const ids = await lint(
      from,
      valueImport(specifier),
      `host-${from}-${specifier.replaceAll("/", "-")}`,
    );

    expect(ids).toEqual(expected);
  });
});

describe("ESLint boundary rules: Node builtins (R4, P1-8)", () => {
  it.each(BUILTIN_CASES)("$from importing $specifier", async ({ from, specifier, expected }) => {
    const ids = await lint(
      from,
      valueImport(specifier),
      `builtin-${from}-${specifier.replaceAll(":", "-")}`,
    );

    expect(ids).toEqual(expected);
  });
});

describe("ESLint boundary rules: allowTypeImports semantics", () => {
  it("accepts `import type` on R6 (ui -> core)", async () => {
    const ids = await lint("ui", typeImport("@haruyuki/core"), "r6-type");

    expect(ids).toEqual([]);
  });

  it("accepts the inline type specifier form on R7 (ui -> protocol)", async () => {
    const ids = await lint(
      "ui",
      'import { type Probe } from "@haruyuki/protocol";\nexport type Alias = Probe;\n',
      "r7-inline-type",
    );

    expect(ids).toEqual([]);
  });

  it("still rejects a mixed clause on R6 (it executes the module)", async () => {
    const ids = await lint(
      "ui",
      'import { type Probe, probe } from "@haruyuki/core";\n' +
        "export const value = probe;\nexport type Alias = Probe;\n",
      "r6-mixed",
    );

    expect(ids).toEqual(["R6"]);
  });

  it("covers deep paths on both forms of the type-only edge", async () => {
    expect(await lint("ui", valueImport("@haruyuki/core/internal"), "r6-deep-value")).toEqual([
      "R6",
    ]);
    expect(await lint("ui", typeImport("@haruyuki/core/internal"), "r6-deep-type")).toEqual([]);
  });
});

describe("ESLint layer scope: forms the boundary script owns", () => {
  it("does not visit a TypeScript type-position import() (P1-1, script layer)", async () => {
    const ids = await lint(
      "protocol",
      'export type Leaked = import("@haruyuki/core").Core;\n',
      "scope-type-position",
    );

    // scripts/check-boundaries.mjs collects ImportTypeNode; ESLint's core rule
    // does not. If this ever changes, update the layering note in both files.
    expect(ids).toEqual([]);
  });

  it("does not visit require()/createRequire()/module.require() (P1-4, script layer)", async () => {
    expect(
      await lint(
        "ui",
        'const { probe } = require("@haruyuki/core");\nexport const value = probe;\n',
        "scope-require",
      ),
    ).toEqual([]);

    expect(
      await lint(
        "ui",
        "declare function createRequire(url: string): (id: string) => unknown;\n" +
          'export const value = createRequire(import.meta.url)("@haruyuki/core");\n',
        "scope-create-require",
      ),
    ).toEqual([]);

    expect(
      await lint(
        "ui",
        "declare const module: { require: (id: string) => unknown };\n" +
          'export const value = module.require("@haruyuki/core");\n',
        "scope-module-require",
      ),
    ).toEqual([]);
  });
});
