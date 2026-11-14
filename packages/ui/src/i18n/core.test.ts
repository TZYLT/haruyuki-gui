/**
 * Contract tests for the framework-free i18n entry.
 *
 * Two separate things are under test, and the second one is the point:
 *
 * 1. The behaviour, which must match `index.ts` exactly. A consumer that moved to
 *    the core entry must not discover a formatting difference at runtime.
 *
 * 2. The absence of React. Every one of those assertions would still pass on a
 *    `core.ts` that re-exported `index.ts`, because `index.ts` exports the same
 *    functions -- and the bundle would quietly grow by 68 KB again. So the
 *    module's own source text and its runtime namespace are inspected, not just
 *    its behaviour. This is the only way the file can stop somebody from adding a
 *    React export later.
 *
 * The source is read through `import.meta.glob(..., { query: "?raw" })` rather
 * than `node:fs`. `packages/ui` is the renderer, and R4 forbids Node builtins
 * there -- the boundary gate enforces it on the resolved specifier, so even a
 * test file cannot import `node:fs`. A raw import is compile-time only, which is
 * also why it cannot drift: it reads the file the bundler reads.
 */

import { describe, expect, it } from "vitest";

import {
  CATALOGUES,
  FALLBACK_LOCALE,
  I18N_CORE_LAYER,
  SUPPORTED_LOCALES,
  createTranslator,
  en,
  formatMessage,
  resolveLocale,
  zhCN,
} from "./core.js";

/** The names `provider.tsx` exports, and the exact set this entry must not carry. */
const REACT_ONLY_EXPORTS = [
  "LocaleProvider",
  "LocaleProviderProps",
  "Translator",
  "useLocale",
  "useT",
] as const;

/** The names a non-React consumer is entitled to find here. */
const REQUIRED_EXPORTS = [
  "CATALOGUES",
  "FALLBACK_LOCALE",
  "I18N_CORE_LAYER",
  "MESSAGE_KEY_PATTERN",
  "MESSAGE_NAMESPACES",
  "SUPPORTED_LOCALES",
  "createTranslator",
  "diagnostics",
  "en",
  "formatMessage",
  "resetDiagnostics",
  "resolveLocale",
  "setDevelopmentBuildForTesting",
  "zhCN",
] as const;

/**
 * The two sources this file inspects, as raw text.
 *
 * The pattern list has to be a literal: the plugin rejects a computed glob at
 * build time. `provider.tsx` is read too, so the React-only name list can be
 * checked against the file it claims to describe -- otherwise that list would be
 * an assumption that silently rots.
 */
const SOURCES: Record<string, string> = (
  import.meta as ImportMeta & {
    glob: (
      pattern: string[],
      options: { query: string; import: string; eager: true },
    ) => Record<string, string>;
  }
).glob(["./core.ts", "./provider.tsx"], { query: "?raw", import: "default", eager: true });

/**
 * Read one source file next to this test, as text.
 *
 * @param name file name inside this directory, such as `core.ts`
 * @returns the file's contents
 */
function readSource(name: string): string {
  const text = SOURCES[`./${name}`];

  if (text === undefined) {
    throw new Error(
      `cannot read ${name}; the raw glob returned ${JSON.stringify(Object.keys(SOURCES))}`,
    );
  }

  return text;
}

/**
 * Strip comments so an assertion about code is not satisfied or broken by prose.
 *
 * This matters here: `core.ts` explains in a doc comment *why* it avoids
 * `provider.js`, so a plain substring search for "provider" would flag the very
 * comment that documents the rule. Removing both comment forms leaves the
 * statements, which is what the assertion is about.
 *
 * @param source TypeScript source text
 * @returns the source with block and line comments removed
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("formatMessage through the core entry", () => {
  it("formats a plain message in English", () => {
    expect(formatMessage("en", "common.action.save")).toBe("Save");
    expect(formatMessage("en", "common.action.cancel")).toBe("Cancel");
  });

  it("interpolates a named argument", () => {
    expect(formatMessage("en", "error.withCode", { code: "E42" })).toBe("An error occurred (E42)");
  });

  it("formats in a non-English locale too", () => {
    // Compared against the catalogue rather than a hard-coded string: the point is
    // that the locale argument is honoured, and a literal here would turn a
    // translation edit into a test failure that has nothing to do with this entry.
    const translated = formatMessage("zh-CN", "common.action.save");

    expect(translated).toBe(CATALOGUES["zh-CN"]["common.action.save"]);
    expect(translated).not.toBe(formatMessage("en", "common.action.save"));
  });
});

describe("createTranslator on the core entry", () => {
  it("is callable and formats like formatMessage", () => {
    const t = createTranslator("en");

    expect(typeof t).toBe("function");
    expect(t("common.action.save")).toBe(formatMessage("en", "common.action.save"));
    expect(t("error.withCode", { code: "E42" })).toBe("An error occurred (E42)");
  });

  it("exposes the locale it resolved to", () => {
    expect(createTranslator("en").locale).toBe("en");
    expect(createTranslator("zh-CN").locale).toBe("zh-CN");
  });

  it("resolves an unsupported tag to the fallback locale", () => {
    // The main process passes whatever the OS reports, which may be a language
    // this package does not ship.
    expect(createTranslator("tlh").locale).toBe(FALLBACK_LOCALE);
  });

  it("is enumerable so a caller can read `.locale` back", () => {
    // `createMainTranslator` in the Electron main process reads it to decide the
    // window title, so a non-enumerable property would be an invisible break.
    const t = createTranslator("zh-CN");

    expect(Object.keys(t)).toContain("locale");
  });
});

describe("locale constants", () => {
  it("exports the supported locale set and the fallback", () => {
    expect(SUPPORTED_LOCALES).toContain(FALLBACK_LOCALE);
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "zh-CN"]);
  });

  it("resolves a tag through the core entry", () => {
    expect(resolveLocale("zh")).toBe("zh-CN");
    expect(resolveLocale(undefined)).toBe(FALLBACK_LOCALE);
  });

  it("ships both catalogues", () => {
    expect(Object.keys(en).length).toBeGreaterThan(0);
    expect(Object.keys(zhCN).length).toBe(Object.keys(en).length);
  });
});

describe("the core entry carries no React", () => {
  it("has no React-only name in its runtime namespace", async () => {
    // `index.js` has every one of these. If core ever re-exported index, this is
    // the assertion that fails instead of a reviewer noticing 68 KB.
    const core = await import("./core.js");

    for (const name of REACT_ONLY_EXPORTS) {
      expect(name in core, `${name} must not be exported from i18n/core`).toBe(false);
    }
  });

  it("lists the zero React-only names explicitly", async () => {
    // The same check as a set difference: a name added to `provider.tsx` later
    // should be added to REACT_ONLY_EXPORTS above, and this records the intent.
    const core = await import("./core.js");

    expect(REACT_ONLY_EXPORTS.filter((name) => Object.keys(core).includes(name))).toEqual([]);
  });

  it("keeps the forbidden-name list in step with provider.tsx", () => {
    // Without this, REACT_ONLY_EXPORTS is an assumption. If somebody adds an
    // export to `provider.tsx`, the list above must grow, or this whole block
    // would keep passing while the new React name is unprotected.
    const code = stripComments(readSource("provider.tsx"));

    const declared = [
      ...code.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)/g),
    ]
      .map((match) => match[1] as string)
      .sort();

    expect(declared).toEqual([...REACT_ONLY_EXPORTS].sort());
  });

  it("still exports everything a non-React consumer needs", async () => {
    const core = await import("./core.js");

    for (const name of REQUIRED_EXPORTS) {
      expect(name in core, `${name} must be exported from i18n/core`).toBe(true);
    }
  });

  it("does not mention provider in its own statements", () => {
    // Comments are stripped first: this file documents *why* it avoids
    // `provider.js`, and the documentation must not trip the assertion.
    const code = stripComments(readSource("core.ts"));

    expect(code).not.toMatch(/provider/i);
  });

  it("does not re-export the React-bound index", () => {
    // The tempting shortcut, and the one that silently restores React. Both forms
    // are rejected: the `.js` specifier and the extensionless one.
    const code = stripComments(readSource("core.ts"));

    expect(code).not.toMatch(/from\s+["']\.\/index\.js["']/);
    expect(code).not.toMatch(/from\s+["']\.\/index["']/);
    expect(code).not.toMatch(/from\s+["']\.\/provider\.js["']/);
  });

  it("imports only the React-free modules", () => {
    // A positive assertion, so deleting every import would fail rather than pass
    // the negative checks above.
    const code = stripComments(readSource("core.ts"));

    expect(code).toMatch(/from\s+["']\.\/format\.js["']/);
    expect(code).toMatch(/from\s+["']\.\/types\.js["']/);
    expect(code).toMatch(/from\s+["']\.\/locales\/en\.js["']/);
    expect(code).toMatch(/from\s+["']\.\/locales\/zh-CN\.js["']/);
  });

  it("declares a local constant so it is not a pure forwarding barrel", () => {
    // The ownership gate rejects a module whose every statement is a re-export,
    // and it is right to: such a module owns nothing. This is the local value that
    // makes the entry a real module, asserted so a refactor cannot drop it.
    const code = stripComments(readSource("core.ts"));

    expect(code).toMatch(/export\s+const\s+I18N_CORE_LAYER\s*=/);
    expect(I18N_CORE_LAYER).toBe("i18n/core");
  });
});
