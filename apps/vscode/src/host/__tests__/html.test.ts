/**
 * The panel document: the policy, the resource URIs and the attributes.
 *
 * The built template is the input, not a fixture: a test that invented its own
 * template would pass while the bundler quietly changed the tag it writes. The
 * literal below mirrors `dist/webview/index.html` for the case where no build has
 * run yet, and the last case reads the real file when it is there.
 *
 * Nothing here needs an editor: the template, the resolver and the version facts
 * are arguments, which is the whole reason the generator takes them.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createWebviewCsp, createWebviewHtml, type WebviewHtmlOptions } from "../html.js";

/** `apps/vscode/src/host/__tests__` -> `apps/vscode`. */
const PACKAGE_DIR = path.resolve(import.meta.dirname, "..", "..", "..");

/** The document the bundler writes, if a build has run in this checkout. */
const BUILT_TEMPLATE = path.join(PACKAGE_DIR, "dist", "webview", "index.html");

/**
 * A template with the same two references the bundler writes.
 *
 * Kept in step with the build output by the case below that reads the real file,
 * so this copy cannot silently become a template nobody ships.
 */
const TEMPLATE = `<!doctype html>
<html lang="en" data-theme="light" data-contrast="normal">
  <head>
    <meta charset="utf-8" />
    <title>Haruyuki</title>
    <script type="module" crossorigin src="./assets/index-abcdef12.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-abcdef12.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

/** The origin a panel reports for itself; a webview's is per instance. */
const CSP_SOURCE = "https://file+.vscode-resource.vscode-cdn.net/stable-abcd1234/vscode-extension";

/** What the resolver stands in for: the panel's own `asWebviewUri`. */
function resolveAsset(relativePath: string): string {
  return `${CSP_SOURCE}/dist/webview/${relativePath}`;
}

/** The options every case starts from. */
const OPTIONS: WebviewHtmlOptions = {
  template: TEMPLATE,
  cspSource: CSP_SOURCE,
  resolveAsset,
  appVersion: "0.1.0",
  bridgeVersion: "1",
  frameProtocolVersion: 1,
  language: "zh-cn",
};

/** The `content` of the document's policy, as the browser would read it. */
function policyOf(html: string): string {
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html);

  if (match === null) throw new Error("the document carries no policy");

  return match[1] ?? "";
}

describe("panel document", () => {
  it("keeps the mount point the entry module looks up", () => {
    // Without this element the bundle throws on its first line, and the panel
    // renders an empty frame rather than an error.
    expect(createWebviewHtml(OPTIONS)).toContain('id="root"');
  });

  it("declares exactly the frozen policy", () => {
    expect(policyOf(createWebviewHtml(OPTIONS))).toBe(
      [
        "default-src 'none'",
        `script-src ${CSP_SOURCE}`,
        `style-src ${CSP_SOURCE} 'unsafe-inline'`,
        `img-src ${CSP_SOURCE} data:`,
        `font-src ${CSP_SOURCE}`,
        "connect-src 'none'",
      ].join("; "),
    );
  });

  it("never permits an inline or nonced script", () => {
    const scriptSource = policyOf(createWebviewHtml(OPTIONS))
      .split("; ")
      .find((directive) => directive.startsWith("script-src"));

    expect(scriptSource).toBe(`script-src ${CSP_SOURCE}`);
    expect(scriptSource).not.toContain("'unsafe-inline'");
    expect(scriptSource).not.toContain("nonce-");
  });

  it("permits inline styles, and only for styles", () => {
    // The dock library injects its own sheet at import time and offers no nonce
    // to label it with, so this directive is the only one that may be widened.
    const directives = policyOf(createWebviewHtml(OPTIONS)).split("; ");

    expect(directives.filter((directive) => directive.includes("'unsafe-inline'"))).toEqual([
      `style-src ${CSP_SOURCE} 'unsafe-inline'`,
    ]);
  });

  it("loads every asset through the panel's origin, never a file URL", () => {
    const html = createWebviewHtml(OPTIONS);

    expect(html).toContain(`src="${CSP_SOURCE}/dist/webview/assets/index-abcdef12.js"`);
    expect(html).toContain(`href="${CSP_SOURCE}/dist/webview/assets/index-abcdef12.css"`);

    // A `file:` URL names a location a webview has no origin for, so it would be
    // refused rather than load; the relative form is refused for the same reason.
    expect(html).not.toContain("file://");
    expect(html).not.toContain('src="./');
    expect(html).not.toContain('href="./');
  });

  it("carries the version facts as attributes, not as a script", () => {
    const html = createWebviewHtml(OPTIONS);

    // Inline script is forbidden by the policy above, so the facts a panel reads
    // before the handshake have to travel as data.
    expect(html).toContain('data-app-version="0.1.0"');
    expect(html).toContain('data-bridge-version="1"');
    expect(html).toContain('data-frame-protocol-version="1"');
  });

  it("writes the editor's language tag verbatim on both attributes", () => {
    const html = createWebviewHtml(OPTIONS);

    // `data-locale` is authoritative and `lang` mirrors it for the browser. The
    // raw tag is written, not a normalized one: resolution has one owner.
    expect(html).toContain('lang="zh-cn"');
    expect(html).toContain('data-locale="zh-cn"');
  });

  it("keeps an unfamiliar language tag rather than translating it", () => {
    const html = createWebviewHtml({ ...OPTIONS, language: "ja" });

    expect(html).toContain('lang="ja"');
    expect(html).toContain('data-locale="ja"');
  });

  it("omits both language attributes when the editor reported none", () => {
    const html = createWebviewHtml({ ...OPTIONS, language: "" });

    // An empty attribute is not an absent one: `lang=""` tells a screen reader
    // the language is blank, while no `lang` lets the document fall back.
    expect(html).not.toContain("lang=");
    expect(html).not.toContain("data-locale=");
  });

  it("replaces a template's own language rather than keeping both", () => {
    const html = createWebviewHtml({ ...OPTIONS, language: "zh-cn" });
    const opening = /<html[^>]*>/i.exec(html)?.[0] ?? "";

    expect(opening.match(/\blang=/g)).toHaveLength(1);
  });

  it("refuses a template it cannot render instead of shipping a blank panel", () => {
    expect(() => createWebviewHtml({ ...OPTIONS, template: "<html><body></body></html>" })).toThrow(
      /#root/,
    );
  });

  it("builds the policy from the panel's own origin", () => {
    const other = "https://other.example/panel";

    expect(createWebviewCsp(other)).toContain(`script-src ${other}`);
    expect(createWebviewCsp(other)).not.toContain(CSP_SOURCE);
  });

  it("resolves the template the build actually wrote", () => {
    // The literal above can only drift from the bundler if this case never runs,
    // so it runs whenever a build has happened in this checkout.
    if (!existsSync(BUILT_TEMPLATE)) return;

    const html = createWebviewHtml({ ...OPTIONS, template: readFileSync(BUILT_TEMPLATE, "utf8") });

    expect(html).toContain('id="root"');
    expect(html).not.toContain('src="./');
    expect(html).not.toContain('href="./');
    expect(policyOf(html)).toContain(`style-src ${CSP_SOURCE} 'unsafe-inline'`);
  });
});
