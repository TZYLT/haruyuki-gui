/** @vitest-environment jsdom */
/**
 * The panel's locale seam, mounted in a DOM.
 *
 * What is asserted here is not that the shared catalogue can translate -- the UI
 * package owns that -- but that the value the document carries reaches the
 * provider and the `lang` attribute without being resolved a second time on the
 * way. A panel that rendered Chinese over `<html lang="en">` would be invisible
 * to every other test in this package.
 *
 * The theme attributes and `ResizeObserver` are stubbed or ignored for the same
 * reason as in the entry's own test: jsdom has no dock and no theme classes.
 */

import { waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { LANG_ATTRIBUTE, LOCALE_ATTRIBUTE } from "../../shared/i18n.js";

/** A no-op observer: jsdom never resizes anything, so nothing has to fire. */
class StubResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  Reflect.set(globalThis, "ResizeObserver", StubResizeObserver);
});

/**
 * Put the host's raw tag on the document root, the way the HTML template does.
 *
 * @param raw the tag the editor reported, or `null` to omit both attributes
 */
function setDocumentLocale(raw: string | null): void {
  const root = document.documentElement;

  root.removeAttribute(LOCALE_ATTRIBUTE);
  root.removeAttribute(LANG_ATTRIBUTE);

  if (raw === null) return;

  root.setAttribute(LOCALE_ATTRIBUTE, raw);
  root.setAttribute(LANG_ATTRIBUTE, raw);
}

/**
 * A `#root` for the entry to mount into.
 *
 * @returns the container
 */
function createRootContainer(): HTMLElement {
  const container = document.createElement("div");

  container.id = "root";
  document.body.append(container);

  return container;
}

describe("webview locale", () => {
  it("renders in the language the document names, and says so on <html lang>", async () => {
    // The editor reports the platform spelling; the panel has to render and
    // announce the resolved one.
    setDocumentLocale("zh-cn");

    const container = createRootContainer();

    await import("../main.js");

    await waitFor(() => {
      // The tab titles are the catalogue's, so translated copy here and a
      // Chinese `lang` there are the same fact seen twice.
      expect(container.textContent).toContain("对话");
      expect(container.textContent).toContain("导航");
      expect(container.textContent).toContain("文件");
    });

    expect(document.documentElement.getAttribute(LANG_ATTRIBUTE)).toBe("zh-CN");
  });

  it("falls back to English when the document names no locale", async () => {
    // A host that wrote neither attribute is not a broken panel: the provider's
    // fallback is the same one an unsupported tag gets.
    setDocumentLocale(null);

    const { mountWebview } = await import("../main.js");
    const container = document.createElement("div");

    document.body.append(container);

    mountWebview(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Conversation");
    });

    expect(document.documentElement.getAttribute(LANG_ATTRIBUTE)).toBe("en");
  });

  it("re-reads the document on every mount", async () => {
    // A reload is a new document, so the mount is the only moment the tag is
    // read; a tag left over from an earlier mount must not survive one.
    setDocumentLocale("ja");

    const { mountWebview } = await import("../main.js");
    const container = document.createElement("div");

    document.body.append(container);

    mountWebview(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Conversation");
    });

    expect(document.documentElement.getAttribute(LANG_ATTRIBUTE)).toBe("en");
  });
});
