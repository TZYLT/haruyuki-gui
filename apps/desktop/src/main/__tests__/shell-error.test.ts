/**
 * The shell's error taxonomy.
 *
 * Requirement doc section 6.3 names five codes and calls the table the only
 * source for turning a shell failure into user-facing text. The set is closed:
 * every code is expected to acquire a message, and a code with no message is a
 * string that ends up in front of a user untranslated.
 *
 * Two things these tests are really pinning:
 *
 *   The codes are six, and `ENGINE_PROBE_FAILED` is one of them. It subdivides
 *   further using B1's `EngineErrorCode`s, and a second taxonomy for the
 *   subdivision is the mistake section 6.3 forbids by name.
 *
 *   The code-to-message-key mapping is total. A code added to the list without a
 *   key is a compile error via `satisfies`, but a *key* that does not exist in
 *   the catalogue is a runtime error, so that direction needs a test.
 */

import { describe, expect, it } from "vitest";

import { ENGINE_ERROR_CODES, type EngineErrorCode } from "@haruyuki/core";
import { en } from "@haruyuki/ui/i18n/core";

import {
  SHELL_ERROR_CODES,
  isShellErrorCode,
  messageKeyOf,
  shellError,
  toShellError,
  type ShellErrorCode,
} from "../../shared/shell-error.js";

describe("the shell error codes", () => {
  it("is exactly the ten the three requirement waves name", () => {
    // Asserted as literals rather than by importing something, because the point
    // is that this list is frozen. Changing it is a contract change.
    expect([...SHELL_ERROR_CODES]).toEqual([
      "APP_PROTOCOL_DENIED",
      "APP_PROTOCOL_NOT_FOUND",
      "BRIDGE_CHANNEL_DENIED",
      "SHELL_SETTINGS_CORRUPT",
      "ENGINE_PROBE_FAILED",
      "ENGINE_CRASHED",
      "DIAGNOSTIC_EXPORT_FAILED",
      "STALE_ENGINE_FOUND",
      "STALE_ENGINE_CLEAN_FAILED",
      // The one addition this item makes: the media channel's type refusal. The
      // other two media refusals reuse existing codes (doc 29 section 6.4 pins
      // the taxonomy at one addition).
      "MEDIA_TYPE_DENIED",
    ]);
  });

  it("has no duplicate", () => {
    expect(new Set(SHELL_ERROR_CODES).size).toBe(SHELL_ERROR_CODES.length);
  });
});

describe("messageKeyOf", () => {
  it("maps every code into the error.shell namespace", () => {
    for (const code of SHELL_ERROR_CODES) {
      expect(messageKeyOf(code), code).toMatch(/^error\.shell\.[a-z][a-zA-Z0-9]*$/);
    }
  });

  it("gives each code its own key", () => {
    const keys = SHELL_ERROR_CODES.map((code) => messageKeyOf(code));

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names only keys the catalogue actually declares", () => {
    // The compile-time guard covers "a code with no key". This covers "a key that
    // is not in the catalogue", which would render as a hole at runtime.
    for (const code of SHELL_ERROR_CODES) {
      expect(en, String(code)).toHaveProperty(messageKeyOf(code));
    }
  });
});

describe("shellError", () => {
  it("carries the code, the detail and the derived key", () => {
    const error = shellError("APP_PROTOCOL_DENIED", "path escaped the allow root");

    expect(error.code).toBe("APP_PROTOCOL_DENIED");
    expect(error.detail).toBe("path escaped the allow root");
    expect(error.messageKey).toBe("error.shell.resourceDenied");
  });

  it("derives the key rather than accepting one", () => {
    // Two callers reporting the same code must not pick two different messages.
    // The way to guarantee that is to give them no choice, which is why the
    // function takes two arguments and not three.
    expect(shellError.length).toBe(2);
  });

  it("keeps the detail ASCII, since it is not a message", () => {
    // The detail is for logs and for the failure page's secondary line. It is
    // never translated, so a non-ASCII detail would be a message that escaped the
    // catalogue rather than a translation.
    const error = shellError("SHELL_SETTINGS_CORRUPT", "unexpected token at position 12");

    for (const character of error.detail) {
      expect(character.charCodeAt(0), character).toBeLessThan(128);
    }
  });

  it("accepts every code in the set, with the right key each time", () => {
    const seen = new Set<string>();

    for (const code of SHELL_ERROR_CODES as readonly ShellErrorCode[]) {
      const error = shellError(code, "detail");

      expect(error.code).toBe(code);
      seen.add(error.messageKey);
    }

    expect(seen.size).toBe(SHELL_ERROR_CODES.length);
  });
});

describe("toShellError", () => {
  it("maps every B1 start/connect code to ENGINE_PROBE_FAILED", () => {
    for (const code of ENGINE_ERROR_CODES) {
      expect(toShellError(code), code).toBe("ENGINE_PROBE_FAILED");
    }
  });

  it("never invents ENGINE_CRASHED from a start failure", () => {
    // Crash detection is D4's runtime observation (`state === "failed"` after
    // `ready`), not a translation of B1's probe code. Mixing them would put the
    // crash page in front of an engine that simply did not start.
    for (const code of ENGINE_ERROR_CODES) {
      expect(toShellError(code)).not.toBe("ENGINE_CRASHED");
    }
  });

  it("returns only codes the shell set declares", () => {
    for (const code of ENGINE_ERROR_CODES) {
      expect(SHELL_ERROR_CODES).toContain(toShellError(code));
    }
  });

  it("falls back for a code from a newer B1 instead of throwing", () => {
    // The code crosses a module/process boundary and must not turn a diagnostics
    // path into a second failure while it reports the first.
    expect(() => toShellError("FUTURE_B1_CODE" as EngineErrorCode)).not.toThrow();
    expect(toShellError("FUTURE_B1_CODE" as EngineErrorCode)).toBe("ENGINE_PROBE_FAILED");
  });
});

describe("isShellErrorCode", () => {
  it("accepts each real code", () => {
    for (const code of SHELL_ERROR_CODES) {
      expect(isShellErrorCode(code), code).toBe(true);
    }
  });

  it("refuses anything else", () => {
    // The code arrives as data at the renderer boundary: set as a property by
    // whoever raised it, validated by nothing. A cast there would let an unknown
    // code reach the catalogue lookup and render as a hole.
    for (const bogus of [
      "",
      "APP_PROTOCOL_DENIED ",
      "app_protocol_denied",
      42,
      null,
      undefined,
      {},
    ]) {
      expect(isShellErrorCode(bogus), JSON.stringify(bogus)).toBe(false);
    }
  });
});
