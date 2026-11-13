/**
 * i18n runtime tests.
 *
 * Covers the behaviours the requirement makes testable here. The static
 * properties of the catalogues (key sets equal, ICU valid, placeholders agree)
 * belong to `i18n:check` in the gate: a test that parses the catalogues would
 * duplicate it, and duplicating it is how the two drift apart.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  CATALOGUES,
  FALLBACK_LOCALE,
  MESSAGE_KEY_PATTERN,
  MESSAGE_NAMESPACES,
  SUPPORTED_LOCALES,
  createTranslator,
  diagnostics,
  formatMessage,
  resetDiagnostics,
  resolveLocale,
} from "./index.js";
import { en } from "./locales/en.js";

afterEach(() => {
  resetDiagnostics();
});

describe("locale resolution", () => {
  it("accepts an exact supported tag", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("en")).toBe("en");
  });

  it("is case-insensitive and accepts an underscore separator", () => {
    expect(resolveLocale("ZH-cn")).toBe("zh-CN");
    expect(resolveLocale("zh_CN")).toBe("zh-CN");
  });

  it("maps a bare language to its default region", () => {
    expect(resolveLocale("zh")).toBe("zh-CN");
    expect(resolveLocale("zh-Hans-CN")).toBe("zh-CN");
  });

  it("falls back to English instead of throwing on an unknown tag", () => {
    // A host that asks for Klingon gets English and a working screen; taking
    // the renderer down over a locale tag would be the wrong trade.
    expect(resolveLocale("tlh")).toBe(FALLBACK_LOCALE);
    expect(resolveLocale("")).toBe(FALLBACK_LOCALE);
    expect(resolveLocale(undefined)).toBe(FALLBACK_LOCALE);
  });
});

describe("formatting", () => {
  it("returns a plain message unchanged", () => {
    expect(formatMessage("en", "common.action.cancel")).toBe("Cancel");
    expect(formatMessage("zh-CN", "common.action.cancel")).toBe("取消");
  });

  it("interpolates a named argument", () => {
    expect(formatMessage("en", "error.withCode", { code: "E42" })).toBe("An error occurred (E42)");
    expect(formatMessage("zh-CN", "error.withCode", { code: "E42" })).toBe("出错了（E42）");
  });

  it("selects the English plural branch for one and for many", () => {
    const t = createTranslator("en");

    expect(t("component.list.selectedCount", { count: 1 })).toBe("1 item selected");
    expect(t("component.list.selectedCount", { count: 5 })).toBe("5 items selected");
  });

  it("uses the only-branch Chinese plural for one and for many", () => {
    // Confirmed against Intl.PluralRules: zh selects `other` for every count,
    // so a `one` branch would be dead code.
    const t = createTranslator("zh-CN");

    expect(t("component.list.selectedCount", { count: 1 })).toBe("已选 1 项");
    expect(t("component.list.selectedCount", { count: 5 })).toBe("已选 5 项");
  });

  it("formats a zero count through the plural rule, not string concatenation", () => {
    // The whole point of ICU over concatenation: English says "0 items", and no
    // code path had to special-case it.
    expect(createTranslator("en")("component.list.selectedCount", { count: 0 })).toBe(
      "0 items selected",
    );
  });
});

describe("missing interpolation values", () => {
  it("throws in a development build, before anything renders", () => {
    // A missing value throws under a development build. Vitest runs
    // with import.meta.env.DEV true, so this is the development path.
    expect(() => formatMessage("en", "error.withCode", {})).toThrow(
      /missing interpolation value\(s\) for "error\.withCode"/,
    );
  });

  it("counts the missing value even though it throws", () => {
    // The counter is incremented before the throw so a production build, which
    // does not throw, and a development build, which does, both leave a signal.
    expect(() => formatMessage("en", "error.withCode", {})).toThrow();

    expect(diagnostics.missingParams).toBe(1);
  });

  it("names the missing argument in the error", () => {
    expect(() => formatMessage("en", "error.withCode", {})).toThrow(/code/);
  });

  it("does not count a value that is present but zero or empty", () => {
    formatMessage("en", "component.list.selectedCount", { count: 0 });
    formatMessage("en", "error.withCode", { code: "" });

    expect(diagnostics.missingParams).toBe(0);
  });

  it("does not count a supplied value that is explicitly undefined-free", () => {
    // Only presence matters, not truthiness: a count of 0 must not look missing.
    formatMessage("zh-CN", "component.list.selectedCount", { count: 0 });

    expect(diagnostics.missingParams).toBe(0);
  });
});

describe("catalogues", () => {
  it("ships a catalogue for every supported locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(CATALOGUES[locale], `missing catalogue for ${locale}`).toBeDefined();
    }
  });

  it("gives every English key a non-empty value in every locale", () => {
    // The compile-time check catches a missing key in zh-CN; this catches an
    // empty string, which type-checks fine and renders as nothing.
    for (const locale of SUPPORTED_LOCALES) {
      const catalogue = CATALOGUES[locale];

      for (const key of Object.keys(en)) {
        expect(catalogue[key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });

  it("never uses the key itself as the value", () => {
    // A value equal to its key is the classic untranslated placeholder and is
    // invisible in review because it looks like an id.
    for (const locale of SUPPORTED_LOCALES) {
      const catalogue = CATALOGUES[locale];

      for (const [key, value] of Object.entries(catalogue)) {
        expect(value, `${locale} ${key}`).not.toBe(key);
      }
    }
  });

  it("keys follow the frozen pattern and use a frozen namespace", () => {
    for (const key of Object.keys(en)) {
      expect(MESSAGE_KEY_PATTERN.test(key), key).toBe(true);

      const namespace = key.split(".")[0] as string;

      expect(MESSAGE_NAMESPACES as readonly string[], key).toContain(namespace);
    }
  });

  it("keeps the same argument set on both sides of a translated message", () => {
    const namesIn = (message: string): string[] =>
      [...message.matchAll(/\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*[,}]/g)]
        .map((match) => match[1] as string)
        .sort();

    for (const key of Object.keys(en)) {
      const english = en[key as keyof typeof en];
      const chinese = CATALOGUES["zh-CN"][key] as string;

      expect(namesIn(chinese), `${key} placeholder drift`).toEqual(namesIn(english));
    }
  });

  it("keeps both catalogues free of trailing or leading whitespace", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, value] of Object.entries(CATALOGUES[locale])) {
        expect(value, `${locale} ${key}`).toBe((value as string).trim());
      }
    }
  });

  it("gives Chinese only an `other` plural branch", () => {
    // A `one` branch in zh is unreachable: Intl.PluralRules("zh").select(1)
    // returns `other`, so the branch can never be selected. It is still harmful,
    // because a translator will fill it in and a reviewer will approve it, and
    // the two branches will then silently diverge. Behaviour testing cannot
    // catch this -- both spellings render identically -- so it is asserted
    // structurally.
    const chinesePlurals = Object.entries(CATALOGUES["zh-CN"]).filter(([, value]) =>
      (value as string).includes(", plural,"),
    );

    expect(chinesePlurals.length).toBeGreaterThan(0);

    for (const [key, value] of chinesePlurals) {
      expect(value as string, key).not.toMatch(/\bone\s*\{/);
      expect(value as string, key).not.toMatch(/\btwo\s*\{/);
      expect(value as string, key).not.toMatch(/\bfew\s*\{/);
      expect(value as string, key).not.toMatch(/\bmany\s*\{/);
    }
  });

  it("lets English use the branches its plural rule actually selects", () => {
    // The mirror of the rule above: English selects `one` for 1, so a plural
    // without a `one` branch would render "1 items".
    expect(CATALOGUES.en["component.list.selectedCount"]).toMatch(/\bone\s*\{/);
    expect(CATALOGUES.en["component.list.selectedCount"]).toMatch(/\bother\s*\{/);
  });
});

describe("translator", () => {
  it("exposes the locale it formats in", () => {
    expect(createTranslator("zh-CN").locale).toBe("zh-CN");
    expect(createTranslator("nonsense").locale).toBe(FALLBACK_LOCALE);
  });

  it("is a stable function per call, so it can be memoised", () => {
    const t = createTranslator("en");

    expect(t("common.action.save")).toBe(t("common.action.save"));
  });
});
