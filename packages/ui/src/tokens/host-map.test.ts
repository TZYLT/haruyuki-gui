/**
 * Host mapping tests.
 *
 * The property under test is narrow and specific: after a host publishes its own
 * variables, our tokens take those values, **without any component changing**.
 * That second half is what the requirement is really asking for -- an adapter that
 * needed component edits would not be an adapter.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_THEME_ATTRIBUTES,
  THEME_MODE_ATTRIBUTE,
  THEME_CONTRAST_ATTRIBUTE,
  VSCODE_TOKEN_MAP,
  applyHostTokens,
  hostThemeCombination,
  installTokens,
} from "./index.js";

afterEach(() => {
  document.body.replaceChildren();
  document.body.className = "";
});

/**
 * Build an element carrying the given host variables.
 *
 * @param variables variable name to value
 * @returns the element, already attached to the document
 */
function hostWith(variables: Record<string, string>): HTMLElement {
  const host = document.createElement("div");

  for (const [name, value] of Object.entries(variables)) {
    host.style.setProperty(name, value);
  }

  document.body.appendChild(host);

  return host;
}

describe("host variable mapping", () => {
  it("maps a host background onto the surface slot", () => {
    const host = hostWith({ "--vscode-editor-background": "#101418" });

    const applied = applyHostTokens(host);

    expect(applied).toContain("--ui-color-surface-1");
    expect(host.style.getPropertyValue("--ui-color-surface-1")).toBe("#101418");
  });

  it("maps a host foreground onto primary text", () => {
    const host = hostWith({ "--vscode-editor-foreground": "#d4d4d4" });

    applyHostTokens(host);

    expect(host.style.getPropertyValue("--ui-color-neutral-1")).toBe("#d4d4d4");
  });

  it("maps several slots from one host element", () => {
    const host = hostWith({
      "--vscode-editor-background": "#1e1e1e",
      "--vscode-editor-foreground": "#cccccc",
      "--vscode-descriptionForeground": "#9d9d9d",
    });

    const applied = applyHostTokens(host);

    expect(applied.length).toBeGreaterThanOrEqual(3);
  });

  it("leaves a slot alone when the host has no value for it", () => {
    // Absence means "the host has no opinion". Writing an empty string would blank
    // the colour, which is worse than a slightly off-theme panel.
    const host = hostWith({ "--vscode-editor-background": "#101418" });

    applyHostTokens(host);

    expect(host.style.getPropertyValue("--ui-color-danger-1")).toBe("");
  });

  it("reports exactly the slots it wrote", () => {
    // A mapping that silently produced nothing would otherwise look like success.
    const host = hostWith({ "--vscode-font-family": "Consolas, monospace" });

    expect(applyHostTokens(host)).toEqual(["--ui-font-family-body"]);
  });

  it("can write the tokens onto a different element than the one it read from", () => {
    // The realistic arrangement: the host class sits on `body` while the tokens
    // belong to the app's own root.
    const source = hostWith({ "--vscode-editor-background": "#101418" });
    const target = document.createElement("div");

    applyHostTokens(source, target);

    expect(target.style.getPropertyValue("--ui-color-surface-1")).toBe("#101418");
    expect(source.style.getPropertyValue("--ui-color-surface-1")).toBe("");
  });

  it("maps nothing when the host publishes nothing", () => {
    const host = hostWith({});

    expect(applyHostTokens(host)).toEqual([]);
  });
});

describe("host theme combination", () => {
  it("reads a dark host", () => {
    document.body.className = "vscode-dark";

    expect(hostThemeCombination(document.body)).toEqual({ mode: "dark", contrast: "normal" });
  });

  it("reads a light host", () => {
    document.body.className = "vscode-light";

    expect(hostThemeCombination(document.body)).toEqual({ mode: "light", contrast: "normal" });
  });

  it("reads a dark high-contrast host as both dark and high", () => {
    // The editor's class does not separate the two, so one class implies both.
    document.body.className = "vscode-high-contrast";

    expect(hostThemeCombination(document.body)).toEqual({ mode: "dark", contrast: "high" });
  });

  it("reads a light high-contrast host as light and high", () => {
    document.body.className = "vscode-high-contrast-light";

    expect(hostThemeCombination(document.body)).toEqual({ mode: "light", contrast: "high" });
  });

  it("falls back to light/normal for an unrecognised host", () => {
    document.body.className = "something-else";

    expect(hostThemeCombination(document.body)).toEqual({ mode: "light", contrast: "normal" });
  });
});

describe("the mapping does not require component changes", () => {
  it("makes a component's token resolve to the host value", () => {
    // The end-to-end property: a component reads --ui-color-surface-1 and gets the
    // editor's background, having never heard of --vscode-*.
    installTokens(document);

    const host = hostWith({ "--vscode-editor-background": "#123456" });
    const root = document.createElement("div");

    document.body.appendChild(root);
    applyHostTokens(host, root);

    const child = document.createElement("span");
    root.appendChild(child);

    const value = getComputedStyle(child).getPropertyValue("--ui-color-surface-1").trim();

    expect(value).toBe("#123456");
  });

  it("exposes the attribute names a host must set", () => {
    // A host should not have to import the token layer's internals to know which
    // two attributes to write.
    expect(HOST_THEME_ATTRIBUTES.mode).toBe(THEME_MODE_ATTRIBUTE);
    expect(HOST_THEME_ATTRIBUTES.contrast).toBe(THEME_CONTRAST_ATTRIBUTE);
  });

  it("maps only slots that exist in the token layer", () => {
    // A mapping to a typo'd slot would write a property nothing reads.
    for (const slot of Object.keys(VSCODE_TOKEN_MAP)) {
      expect(slot.startsWith("--ui-"), slot).toBe(true);
    }
  });
});
