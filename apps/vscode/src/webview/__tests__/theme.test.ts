/** @vitest-environment jsdom */
/**
 * Following the editor's theme.
 *
 * Three properties are under test, and each one is a way the wiring can look
 * finished while being wrong:
 *
 * - the editor's `body` class decides the combination, including the light
 *   high-contrast kind that has no separate mode;
 * - a switch is noticed without an event, because the editor only swaps a class;
 * - a second call is free -- one stylesheet, one observer -- and a disposed
 *   binding really is inert, otherwise a re-mounted panel leaks a listener per
 *   mount and nobody sees it until the panel is slow.
 *
 * The last test is about the shape of the result rather than its values: this
 * adapter may only write slots the token layer declares. A slot name invented
 * here would render as an empty value and look like a styling choice.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALL_TOKEN_SLOTS,
  THEME_CONTRAST_ATTRIBUTE,
  THEME_MODE_ATTRIBUTE,
  VSCODE_TOKEN_MAP,
  themeCss,
} from "@haruyuki/ui";

import { applyShellTheme, type ShellTheme } from "../theme.js";

/** Bindings opened by a test, disposed afterwards so state never crosses tests. */
const opened: ShellTheme[] = [];

/**
 * Bind the ambient document, remembering the handle for cleanup.
 *
 * @returns the binding
 */
function bind(): ShellTheme {
  const shell = applyShellTheme(document);

  opened.push(shell);

  return shell;
}

/**
 * Read one token as the document resolves it.
 *
 * @param name token name including the leading `--`
 * @returns the computed value, trimmed
 */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Wait for the observer to deliver the pending mutation.
 *
 * The observer is asynchronous by contract, so a synchronous assertion after a
 * class change would pass for the wrong reason.
 *
 * @returns once a macrotask has run
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  for (const shell of opened.splice(0)) shell.dispose();

  document.body.className = "";
  document.body.removeAttribute("style");
});

describe("the editor's class becomes a theme combination", () => {
  it("follows light, dark and both high-contrast kinds", () => {
    const cases = [
      ["vscode-light", "light", "normal"],
      ["vscode-dark", "dark", "normal"],
      ["vscode-high-contrast", "dark", "high"],
      ["vscode-high-contrast-light", "light", "high"],
    ] as const;

    for (const [className, mode, contrast] of cases) {
      document.body.className = className;
      bind();

      expect(document.documentElement.getAttribute(THEME_MODE_ATTRIBUTE), className).toBe(mode);
      expect(document.documentElement.getAttribute(THEME_CONTRAST_ATTRIBUTE), className).toBe(
        contrast,
      );
    }
  });

  it("falls back to the default combination for an unrecognised host", () => {
    document.body.className = "some-other-editor";

    bind();

    expect(document.documentElement.getAttribute(THEME_MODE_ATTRIBUTE)).toBe("light");
    expect(document.documentElement.getAttribute(THEME_CONTRAST_ATTRIBUTE)).toBe("normal");
  });
});

describe("host variables reach the token slots", () => {
  it("copies an editor variable onto its slot and follows a new value", () => {
    document.body.className = "vscode-dark";
    document.body.style.setProperty("--vscode-editor-background", "#101418");

    const shell = bind();

    expect(token("--ui-color-surface-1")).toBe("#101418");

    document.body.style.setProperty("--vscode-editor-background", "#202428");
    shell.refresh();

    expect(token("--ui-color-surface-1")).toBe("#202428");
  });

  it("drops a slot whose editor variable disappeared", () => {
    // The editor changes which variables it publishes, not only their values.
    // Keeping the old value would pin the previous theme's colour forever.
    document.body.className = "vscode-dark";
    document.body.style.setProperty("--vscode-editor-background", "#101418");

    const shell = bind();

    expect(token("--ui-color-surface-1")).toBe("#101418");

    document.body.style.removeProperty("--vscode-editor-background");
    shell.refresh();

    expect(token("--ui-color-surface-1")).not.toBe("#101418");
  });

  it("re-maps the slots when the editor swaps its class", async () => {
    document.body.className = "vscode-light";
    document.body.style.setProperty("--vscode-editor-background", "#ffffff");

    bind();

    document.body.className = "vscode-dark";
    document.body.style.setProperty("--vscode-editor-background", "#181818");

    await settle();

    expect(document.documentElement.getAttribute(THEME_MODE_ATTRIBUTE)).toBe("dark");
    expect(token("--ui-color-surface-1")).toBe("#181818");
  });
});

describe("the binding is idempotent", () => {
  it("attaches one observer however often it is called", () => {
    document.body.className = "vscode-dark";

    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const shells = [bind(), bind(), bind()];

    // Count only the observations of `body`: another observer in the document is
    // not this module's business, and counting it would make the assertion lie.
    const watched = observe.mock.calls.filter(([target]) => target === document.body);

    observe.mockRestore();

    expect(watched).toHaveLength(1);
    expect(new Set(shells).size).toBe(1);
  });

  it("installs one token stylesheet however often it is called", () => {
    document.body.className = "vscode-dark";

    bind();

    const sheets = document.head.querySelectorAll("style").length;

    bind();
    bind();

    expect(document.head.querySelectorAll("style").length).toBe(sheets);
  });
});

describe("dispose stops the binding", () => {
  it("ignores a class change after dispose", async () => {
    document.body.className = "vscode-dark";

    const shell = bind();

    expect(document.documentElement.getAttribute(THEME_MODE_ATTRIBUTE)).toBe("dark");

    shell.dispose();

    document.body.className = "vscode-light";

    await settle();

    // The point is the absence of an update, not a value: a disposed binding
    // that still fired would repaint the panel one theme behind the editor.
    expect(document.documentElement.getAttribute(THEME_MODE_ATTRIBUTE)).toBe("dark");
    expect(document.documentElement.getAttribute(THEME_CONTRAST_ATTRIBUTE)).toBe("normal");
  });

  it("can be disposed twice", () => {
    document.body.className = "vscode-light";

    const shell = bind();

    shell.dispose();
    shell.dispose();

    expect(() => {
      shell.dispose();
    }).not.toThrow();
  });

  it("still refreshes explicitly after dispose", () => {
    // A caller that has stopped the observer may still be waiting for the first
    // paint; refresh is not tied to the observation.
    document.body.className = "vscode-dark";

    const shell = bind();

    shell.dispose();

    document.body.className = "vscode-light";

    expect(shell.refresh()).toEqual({ mode: "light", contrast: "normal" });
    expect(document.documentElement.getAttribute(THEME_MODE_ATTRIBUTE)).toBe("light");
  });
});

describe("no second set of tokens", () => {
  it("writes only slots the token layer declares", () => {
    document.body.className = "vscode-dark";
    document.body.style.setProperty("--vscode-editor-background", "#101418");
    document.body.style.setProperty("--vscode-editor-foreground", "#d4d4d4");
    document.body.style.setProperty("--vscode-font-family", "Consolas, monospace");

    bind();

    const written = [...document.documentElement.style].filter((name) => name.startsWith("--ui-"));

    expect(written.length).toBeGreaterThan(0);

    for (const name of written) {
      expect(ALL_TOKEN_SLOTS, name).toContain(name);
    }
  });

  it("declares no token name outside the inventory", () => {
    // Whitelist comparison against the token layer's own list: a name that only
    // this shell declares is a slot no theme supplies, and it would resolve to
    // an empty value on every component that read it.
    bind();

    const declared = new Set<string>();

    for (const sheet of document.querySelectorAll("style")) {
      for (const match of (sheet.textContent ?? "").matchAll(/^\s*(--[\w-]+)\s*:/gm)) {
        declared.add(match[1] ?? "");
      }
    }

    expect([...declared].sort()).toEqual([...ALL_TOKEN_SLOTS].sort());
  });

  it("maps every adapter slot to a declared token", () => {
    for (const slot of Object.keys(VSCODE_TOKEN_MAP)) {
      expect(ALL_TOKEN_SLOTS, slot).toContain(slot);
    }
  });

  it("keeps the stylesheet monotonic in the token inventory", () => {
    // A name added to one theme but not the others would only appear when that
    // theme is active, which no single screenshot can catch.
    const names = new Set<string>();

    for (const match of themeCss().matchAll(/^\s*(--[\w-]+)\s*:/gm)) {
      names.add(match[1] ?? "");
    }

    expect([...names].sort()).toEqual([...ALL_TOKEN_SLOTS].sort());
  });
});
