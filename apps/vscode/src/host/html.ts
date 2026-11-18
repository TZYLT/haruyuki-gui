/**
 * The document one panel is shown, assembled once per panel.
 *
 * Four things the build cannot know go into it, and each of them has to be in
 * the document rather than in a message:
 *
 * - The Content-Security-Policy, because the panel's own origin is a property of
 *   the panel instance, not of this build. It is written as a `meta` tag because
 *   a webview's HTML is the only response this shell controls: there is no
 *   header hook to put the policy on.
 * - The resource URIs. A webview can load a file only through `asWebviewUri`,
 *   and that method answers per instance with that instance's origin, so the
 *   entry script and the stylesheet are resolved against the panel that is about
 *   to show them. A `file:` URL is not merely refused: it names a location the
 *   webview has no origin for.
 * - The version facts, because the document is produced once while the bridge is
 *   replayed on every return to visibility. A fact that does not change does not
 *   belong on the replay path.
 * - The editor's language tag, because the panel has to render in the same
 *   language as the editor it is embedded in.
 *
 * The template is the built one (`dist/webview/index.html`) rather than a
 * skeleton written here: the bundler hashes the asset names, and a second copy
 * of those two tag shapes would go stale on the next build. This module rewrites
 * the template's own relative references through the caller's resolver and adds
 * the parts above, so exactly one document is authored per panel.
 *
 * Everything is injected: the template, the resolver and the version facts. That
 * keeps this a pure string-in, string-out function, which is why its test needs
 * neither an editor nor a build tree.
 */

/**
 * The frozen policy.
 *
 * `default-src 'none'` denies everything first and each line below grants one
 * capability back, so a resource type nobody thought about fails closed.
 *
 * `script-src` names the panel's origin and nothing else: no `'unsafe-inline'`
 * and no nonce. The entry script is a file this shell ships, loaded through that
 * origin, so there is no inline script to permit -- and permitting one would
 * turn any injected markup into code execution.
 *
 * `style-src` also allows `'unsafe-inline'`, and that is the one concession
 * here. The dock library this panel renders injects its own stylesheet into the
 * document head at import time and exposes no nonce to label it with, so inline
 * styles are the only way it can paint. Styling is not a script-execution path,
 * which is why the concession stops at this directive.
 *
 * `img-src`/`font-src` add `data:` for inlined images and fonts; everything else
 * travels over the panel's origin. `connect-src 'none'` because the panel's only
 * channel to the extension host is `postMessage`, not `fetch`.
 *
 * @param cspSource the origin the editor reports for this panel
 * @returns the policy as one header value
 */
export function createWebviewCsp(cspSource: string): string {
  return [
    "default-src 'none'",
    `script-src ${cspSource}`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    "connect-src 'none'",
  ].join("; ");
}

/** The relative reference the bundler writes for its own assets. */
const RELATIVE_ASSET = /(\b(?:src|href))="\.\/([^"]+)"/g;

/** The document's opening element, which is where the injected attributes go. */
const DOCUMENT_OPEN = /<html(\s[^>]*)?>/i;

/** A `lang` the template may carry: the host's answer replaces it. */
const DOCUMENT_LANG = /\s+lang\s*=\s*"[^"]*"/i;

/** The head the policy is inserted at the top of. */
const DOCUMENT_HEAD = /<head(\s[^>]*)?>/i;

/** The mount point the webview entry looks up; a document without it is blank. */
const ROOT_ELEMENT = /\bid\s*=\s*"root"/i;

/** Everything {@link createWebviewHtml} needs; each member is a plain value. */
export interface WebviewHtmlOptions {
  /** The built document (`dist/webview/index.html`), with its relative asset refs. */
  readonly template: string;
  /** The panel's origin; `webview.cspSource`. */
  readonly cspSource: string;
  /**
   * Resolve one template reference (`assets/index-x.js`) to a loadable URI.
   *
   * The caller binds it to the panel's `asWebviewUri`, because that method's
   * answer belongs to the instance showing the document.
   */
  readonly resolveAsset: (relativePath: string) => string;
  /** Version of this shell, reported for support and shown in diagnostics. */
  readonly appVersion: string;
  /** The message family version the panel's bridge compares for equality. */
  readonly bridgeVersion: string;
  /** The frame envelope version the panel builds its receiver against. */
  readonly frameProtocolVersion: number;
  /**
   * `vscode.env.language`, exactly as the editor spells it (`zh-cn`, `en`, `ja`).
   *
   * Written verbatim on purpose: which locales this shell supports is answered in
   * one place, and normalizing here as well would be a second table that drifts
   * from it. An empty value means the editor reported none, and then both the
   * `lang` and the `data-locale` attribute are left off rather than written empty.
   */
  readonly language: string;
}

/**
 * Build the document for one panel.
 *
 * @param options the template, the origin, the resolver and the version facts
 * @returns the complete HTML document
 * @throws when the template is missing the parts this shell depends on, because
 *   a partial document would render a blank panel with no error to explain it
 */
export function createWebviewHtml(options: WebviewHtmlOptions): string {
  requirePart(
    options.template,
    ROOT_ELEMENT,
    "a #root element",
    "the entry module would mount into nothing",
  );
  requirePart(options.template, DOCUMENT_HEAD, "<head>", "the policy would have nowhere to go");
  requirePart(options.template, DOCUMENT_OPEN, "<html>", "there would be no root element to label");

  // The two references are rewritten first, so a relative path can never survive
  // into the document a webview loads.
  let html = options.template.replace(
    RELATIVE_ASSET,
    (_match: string, attribute: string, relative: string) => {
      return `${attribute}="${escapeAttribute(options.resolveAsset(relative))}"`;
    },
  );

  html = insertPolicy(html, createWebviewCsp(options.cspSource));
  html = mergeDocumentAttributes(html, documentAttributes(options));

  return html;
}

/**
 * Put the policy on the document as a `meta` tag.
 *
 * A `meta` policy applies from the point it is parsed, which is why it goes at
 * the top of the head rather than anywhere in it: an element that managed to
 * load before the policy arrived would have loaded unpoliced.
 *
 * @param html the document so far
 * @param csp the policy value
 * @returns the document with the policy in its head
 */
function insertPolicy(html: string, csp: string): string {
  return html.replace(DOCUMENT_HEAD, (tag: string) => {
    return `${tag}\n    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}" />`;
  });
}

/**
 * The attributes the host writes on the root element.
 *
 * `data-locale` is authoritative and `lang` is its mirror for the browser and
 * for assistive technology; both carry the editor's raw tag, and the panel
 * resolves it. The version facts are `data-*` rather than a script because a
 * document may not carry an inline script at all under this policy.
 *
 * @param options the facts to write
 * @returns the attributes, in a stable order
 */
function documentAttributes(options: WebviewHtmlOptions): string[] {
  const attributes: string[] = [];

  if (options.language.trim() !== "") {
    const raw = escapeAttribute(options.language);

    attributes.push(`lang="${raw}"`, `data-locale="${raw}"`);
  }

  attributes.push(
    `data-app-version="${escapeAttribute(options.appVersion)}"`,
    `data-bridge-version="${escapeAttribute(options.bridgeVersion)}"`,
    `data-frame-protocol-version="${String(options.frameProtocolVersion)}"`,
  );

  return attributes;
}

/**
 * Merge attributes into the document's opening element.
 *
 * A `lang` the template carries is dropped first: the editor is the source of
 * truth, and a template default left in place would either contradict the host's
 * answer or survive as a stale `lang="en"` when the editor reported none.
 *
 * @param html the document so far
 * @param attributes the attributes to add
 * @returns the document with the root element carrying them
 */
function mergeDocumentAttributes(html: string, attributes: string[]): string {
  return html.replace(DOCUMENT_OPEN, (tag: string) => {
    const kept = tag.replace(DOCUMENT_LANG, "").slice(0, -1).trimEnd();

    return `${kept} ${attributes.join(" ")}>`;
  });
}

/**
 * Refuse to build a document the panel cannot render.
 *
 * @param template the template to check
 * @param part the pattern the template must contain
 * @param name what the missing part is, for the sentence
 * @param consequence what rendering it anyway would look like
 */
function requirePart(template: string, part: RegExp, name: string, consequence: string): void {
  if (part.test(template)) return;

  throw new Error(`the webview template has no ${name}, so ${consequence}`);
}

/**
 * Escape one value for a double-quoted HTML attribute.
 *
 * The values here are version numbers, a URL and a language tag, so this is a
 * guard rather than a renderer: an unescaped quote would end the attribute early
 * and let the rest of the value become markup.
 *
 * @param value the raw value
 * @returns the value safe to place inside `"..."` in an attribute
 */
function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
