/**
 * Locale resolution, as the shell reaches it.
 *
 * The interesting claims are not "the resolver works" -- the shared UI package
 * already tests that -- but that this shell has exactly one answer: the tag on
 * the document, the tag the host wrote and the tag the provider receives all
 * resolve through one table, so the two sides of the panel cannot disagree.
 *
 * No DOM is needed: the read path takes anything with `getAttribute`, which is
 * also what keeps this file runnable in the gate's node environment.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SUPPORTED_LOCALES as UI_SUPPORTED_LOCALES, resolveLocale } from "@haruyuki/ui/i18n/core";

import {
  FALLBACK_LOCALE,
  LANG_ATTRIBUTE,
  LOCALE_ATTRIBUTE,
  SUPPORTED_LOCALES,
  applyElementLocale,
  readElementLocale,
  readLocaleTag,
  resolveShellLocale,
} from "../i18n.js";

/** `apps/vscode/src/shared/__tests__` -> `apps/vscode`. */
const PACKAGE_DIR = path.resolve(import.meta.dirname, "..", "..", "..");

/** `apps/vscode` -> repository root. */
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

/** The shell's source tree, which is what the single-source claim is about. */
const SHELL_SRC = path.join(PACKAGE_DIR, "src");

/**
 * A document root with nothing but the two attributes this module reads.
 *
 * @param attributes the attributes to install
 * @returns an object with the two members {@link readLocaleTag} uses
 */
function fakeRoot(attributes: Record<string, string> = {}): {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
} {
  const values = new Map(Object.entries(attributes));

  return {
    getAttribute(name: string): string | null {
      return values.get(name) ?? null;
    },
    setAttribute(name: string, value: string): void {
      values.set(name, value);
    },
  };
}

/**
 * Every `.ts`/`.tsx` file under the shell's sources, tests excluded.
 *
 * @param dir the directory to walk
 * @returns the file paths
 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);

    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;

      found.push(...sourceFiles(full));
      continue;
    }

    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) found.push(full);
  }

  return found;
}

describe("locale resolution", () => {
  it("normalises the tags an editor reports", () => {
    // `vscode.env.language` reports the platform spelling, which is lower-case
    // for the region; the catalogues are keyed by `zh-CN`. Both must land on
    // the same supported locale, or the panel would translate one way and
    // announce another.
    expect(resolveShellLocale("zh-cn")).toBe("zh-CN");
    expect(resolveShellLocale("zh-CN")).toBe("zh-CN");
    expect(resolveShellLocale("en")).toBe("en");
    expect(resolveShellLocale("en-US")).toBe("en");
  });

  it("falls back to English for a language the shell does not ship", () => {
    // A Japanese editor gets an English panel rather than a blank one: this
    // shell ships two catalogues, and a missing translation is not an error the
    // user can act on.
    expect(resolveShellLocale("ja")).toBe(FALLBACK_LOCALE);
    expect(resolveShellLocale("ja-JP")).toBe(FALLBACK_LOCALE);
  });

  it("treats a missing or empty tag as absent", () => {
    expect(resolveShellLocale("")).toBe(FALLBACK_LOCALE);
    expect(resolveShellLocale("   ")).toBe(FALLBACK_LOCALE);
    expect(resolveShellLocale(null)).toBe(FALLBACK_LOCALE);
    expect(resolveShellLocale(undefined)).toBe(FALLBACK_LOCALE);
  });

  it("resolves a padded tag the same way the document path does", () => {
    // The shared resolver compares the whole string, so an untrimmed tag
    // resolved to English through one entry point and to `zh-CN` through the
    // other. Both paths now trim, so a host that writes `" zh-cn "` still gets
    // a Chinese panel.
    expect(resolveShellLocale(" zh-cn ")).toBe("zh-CN");
    expect(readElementLocale(fakeRoot({ [LOCALE_ATTRIBUTE]: " zh-cn " }))).toBe("zh-CN");
  });
});

describe("document attributes", () => {
  it("prefers data-locale over lang", () => {
    // The contract with the host: `data-locale` is authoritative because `lang`
    // is written for the browser and may be rewritten by anything.
    const root = fakeRoot({ [LOCALE_ATTRIBUTE]: "zh-cn", [LANG_ATTRIBUTE]: "en" });

    expect(readLocaleTag(root)).toBe("zh-cn");
    expect(readElementLocale(root)).toBe("zh-CN");
  });

  it("falls back to lang when the authoritative attribute is absent", () => {
    // A document produced by an older host carries only `lang`; reading only
    // `data-locale` would leave that panel in English for no reason.
    const root = fakeRoot({ [LANG_ATTRIBUTE]: "zh-cn" });

    expect(readLocaleTag(root)).toBe("zh-cn");
    expect(readElementLocale(root)).toBe("zh-CN");
  });

  it("treats a blank attribute as absent", () => {
    const root = fakeRoot({ [LOCALE_ATTRIBUTE]: "   ", [LANG_ATTRIBUTE]: "" });

    expect(readLocaleTag(root)).toBeUndefined();
    expect(readElementLocale(root)).toBe(FALLBACK_LOCALE);
  });

  it("mirrors the resolved locale into lang", () => {
    const root = fakeRoot({ [LOCALE_ATTRIBUTE]: "zh-cn", [LANG_ATTRIBUTE]: "en" });

    expect(applyElementLocale(root)).toBe("zh-CN");
    expect(root.getAttribute(LANG_ATTRIBUTE)).toBe("zh-CN");
  });

  it("leaves an already-correct lang alone", () => {
    const root = fakeRoot({ [LOCALE_ATTRIBUTE]: "en", [LANG_ATTRIBUTE]: "en" });
    let writes = 0;

    applyElementLocale({
      getAttribute: (name) => root.getAttribute(name),
      setAttribute: (name, value) => {
        writes += 1;
        root.setAttribute(name, value);
      },
    });

    expect(writes).toBe(0);
  });
});

describe("one locale table", () => {
  it("re-exports the shared table instead of copying it", () => {
    // Identity, not equality: equality would also hold for a second array that
    // happens to list the same tags today and drifts tomorrow.
    expect(SUPPORTED_LOCALES).toBe(UI_SUPPORTED_LOCALES);
    expect(SUPPORTED_LOCALES).toContain(FALLBACK_LOCALE);
  });

  it("declares no second locale table in the shell's sources", () => {
    // A literal list is what a second source of truth looks like. Attribute
    // names and single tags in prose are fine; an array literal of tags is not,
    // and neither is a `const ... = ["en", ...]` anywhere but the shared package.
    const offenders: string[] = [];

    for (const file of sourceFiles(SHELL_SRC)) {
      const text = readFileSync(file, "utf8");

      if (/\[\s*["'`]en["'`]/.test(text) || /["'`]zh-CN["'`]\s*,\s*["'`]/.test(text)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("resolves the same raw tag identically on both sides", () => {
    // The host writes the raw tag and the panel resolves it, so the risk is not
    // that one side is wrong but that they disagree. Every tag an editor can
    // report is fed to the shared resolver and to the document read path, and
    // the two answers must be the same one.
    for (const raw of ["zh-cn", "zh-CN", "en", "en-US", "ja", ""]) {
      expect(readElementLocale(fakeRoot({ [LOCALE_ATTRIBUTE]: raw }))).toBe(
        resolveShellLocale(raw),
      );
      expect(resolveShellLocale(raw)).toBe(resolveLocale(raw));
    }
  });
});
