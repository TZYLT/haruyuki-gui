/**
 * The launch-locale decision.
 *
 * This had no test at all until the review, which is exactly why its bug
 * survived: `parseSettings` returned `"en"` for a first launch, `chooseLocale`
 * treated any shipped locale as a deliberate choice, so the system-locale branch
 * could never run and a first launch on a Chinese machine opened in English. The
 * requirement said the opposite. Nothing failed, because nothing asked.
 */

import { describe, expect, it } from "vitest";

import { chooseLocale } from "../i18n.js";
import { FALLBACK_LOCALE } from "../settings.js";

describe("chooseLocale", () => {
  it("follows the system locale when the user has never chosen one", () => {
    expect(chooseLocale(null, "zh-CN")).toBe("zh-CN");
    expect(chooseLocale(null, "en-US")).toBe("en");
  });

  it("lets an explicit choice outrank the system locale", () => {
    // The whole point of persisting the field: a user who picked English on a
    // Chinese machine must keep English after a restart.
    expect(chooseLocale("en", "zh-CN")).toBe("en");
    expect(chooseLocale("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("falls back when neither the choice nor the system locale is shipped", () => {
    expect(chooseLocale(null, "fr-FR")).toBe(FALLBACK_LOCALE);
    expect(chooseLocale(null, "")).toBe(FALLBACK_LOCALE);
  });

  it("refuses a persisted value that is not a shipped locale", () => {
    // The settings file is user-editable, so "validated on read" is not a
    // property this function can see. A stale locale must not reach the
    // catalogue as a lookup that misses.
    expect(chooseLocale("fr" as never, "zh-CN")).toBe("zh-CN");
  });
});
