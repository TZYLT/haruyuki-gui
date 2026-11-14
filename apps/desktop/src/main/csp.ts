/**
 * The Content-Security-Policy for everything the shell serves.
 *
 * One string, ten directives, declared once. The handler puts it on
 * responses and `webRequest.onHeadersReceived` puts it on anything the handler
 * missed; both read this constant, so "the CSP" is never ambiguous.
 *
 * Why the specific values:
 *
 *   `default-src 'none'`            deny by default. Every capability below is
 *                                   granted explicitly, so a resource type nobody
 *                                   thought about fails closed. The cost is that a
 *                                   new type (a worker, a video) needs a line
 *                                   added here rather than working by accident.
 *   `script-src 'self'`             no `'unsafe-inline'`, no `'unsafe-eval'`.
 *                                   Measured, not assumed: the bundled renderer
 *                                   contains zero `eval` and zero `new Function`
 *                                   (route doc §2.2 fact 10), so nothing needs
 *                                   them.
 *   `style-src 'self' 'unsafe-inline'`
 *                                   inline styles are allowed, inline scripts are
 *                                   not. Styling is where the component library,
 *                                   the token layer and the math renderer all need
 *                                   to inject rules; `'unsafe-inline'` there does
 *                                   not create a script-execution path.
 *   `img-src 'self' data:`          `data:` for inlined icons and generated
 *                                   diagrams.
 *   `font-src 'self' data:`         `data:` so the math renderer may inline its
 *                                   fonts; `'self'` for anything copied into the
 *                                   allow root.
 *   `connect-src 'self'`            the page talks to its own assets. Engine
 *                                   traffic goes over the preload bridge, not
 *                                   `fetch`, so no other origin is needed.
 *   `object-src 'none'`             no plugins.
 *   `base-uri 'none'`               a page cannot retarget every relative URL by
 *                                   injecting a `<base>`.
 *   `form-action 'none'`            nothing navigates away on submit.
 *   `frame-ancestors 'none'`        the shell is never framed.
 */

/** The frozen CSP, joined as a single header value. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The directives in order, for a test that asserts the set and its size. */
export const CSP_DIRECTIVES: readonly string[] = CSP.split("; ");

/**
 * Headers every `app://` response carries.
 *
 * `nosniff` is here rather than only in the handler because a browser that
 * sniffs a `.txt` into HTML would undo the content-type map in `protocol.ts`.
 * `no-referrer` keeps the app URL out of any outbound request, which matters
 * once an external link opens.
 *
 * @param contentType the type the handler decided on
 */
export function headersFor(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

/**
 * Whether a URL should receive the fallback CSP.
 *
 * `onHeadersReceived` fires for every request the session makes, including the
 * engine's WebSocket upgrade and any future external image. Adding a CSP header
 * to a response that already has one is harmless, but adding it to a WebSocket
 * handshake is noise, and rewriting someone else's headers is not this
 * function's job. The filter is therefore narrow: only the shell's own scheme.
 *
 * Scoped to `app:` and not to the host, because a request for
 * `app://haruyuki/../../x` is still the shell's own origin and still deserves
 * the policy that stops it doing anything if it loads.
 *
 * @param url the request URL as Electron reports it
 */
export function shouldApplyFallbackCsp(url: string): boolean {
  return url.startsWith("app://");
}
