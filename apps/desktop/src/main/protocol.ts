/**
 * The `app://` protocol: path resolution and the response handler.
 *
 * Two things live here and they are deliberately the only copies of each:
 *
 *   `resolveInside`  the boundary check. Every way a URL path can name a file
 *                    goes through it, including the D2 adapter's local-resource
 *                    resolver, so a second implementation would be a second
 *                    boundary and the weaker one wins.
 *   `createProtocolHandler`  the handler itself: resolve, read, respond.
 *
 * The scheme is `app` and the host is `haruyuki`, so pages load from
 * `app://haruyuki/index.html` and the renderer has a real origin instead of a
 * `file://` path. That origin is what makes `'self'` in the CSP meaningful.
 *
 * What this module does NOT do: decide what a miss looks like to the user, and
 * build the CSP header. Those are `bootstrap-error.ts` and `csp.ts`.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** The scheme registered for the shell's own assets. A rename is a contract change. */
export const APP_SCHEME = "app" as const;

/** The host. Part of the origin, so it is part of the contract. */
export const APP_HOST = "haruyuki" as const;

/**
 * Privileges passed to `registerSchemesAsPrivileged`.
 *
 * `standard` gives the scheme an origin and normal URL parsing, without it
 * relative URLs do not resolve and `'self'` matches nothing. `secure` keeps the
 * page out of the mixed-content and insecure-origin paths. `supportFetchAPI`
 * lets the renderer `fetch()` its own assets, which the router needs.
 *
 * `bypassCSP` is false because a scheme that can opt out of CSP makes the CSP
 * advisory. `stream` is false because nothing here serves partial content.
 */
export const APP_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  bypassCSP: false,
  stream: false,
} as const;

/** Why a path was refused. Distinguishing them keeps the log useful. */
export type RefusalReason = "outside-root" | "bad-path" | "not-a-file";

/** The result of resolving a URL path against the allow root. */
export interface ResolveResult {
  ok: boolean;
  /** Present only when `ok` is false. */
  reason?: RefusalReason;
  /** Absolute path, present only when `ok` is true. */
  absolutePath?: string;
}

/**
 * Resolve a URL pathname to an absolute path inside `root`, or refuse.
 *
 * The input is a URL pathname, so it arrives percent-decoded and with a leading
 * slash. It is untrusted: `..` segments, encoded separators and absolute paths
 * all reach here from a page that may already be compromised.
 *
 * The containment test is `path.relative` plus a prefix check on the *separator*,
 * not `startsWith("..")`. That distinction is not cosmetic: the relative path
 * from `/srv/app` to `/srv/app/..../x` is `..../x`, which `startsWith("..")`
 * calls an escape. A legal file named `....` would become unreachable, and the
 * refusal would look like a security success.
 *
 * @param root absolute allow root; the only directory that may be read
 * @param urlPathname decoded pathname from the request URL, leading slash or not
 */
export function resolveInside(root: string, urlPathname: string): ResolveResult {
  // A NUL byte truncates the string in several layers below this one (`open`,
  // the Windows path parser), so `index.html\0.png` can pass a suffix check and
  // still open `index.html`. Refusing outright is cheaper than reasoning about
  // which layer truncates first.
  if (urlPathname.includes("\0")) {
    return { ok: false, reason: "bad-path" };
  }

  // Strip the query and fragment defensively. A pathname from `new URL` has
  // neither, but this function is also called with hand-built strings in tests
  // and by D2's resource resolver.
  const withoutQuery = urlPathname.split("?")[0]?.split("#")[0] ?? "";

  // Remove the leading separators *before* the absolute-path test. A URL path
  // always begins with `/`, and on Windows `path.win32.isAbsolute("/x")` is
  // true, so testing first would call every legal path absolute and refuse it.
  // What is left is the part that could still name a volume.
  const relative = withoutQuery.replace(/^[/\\]+/, "");

  if (relative === "") {
    return { ok: true, absolutePath: path.resolve(root) };
  }

  // `C:\Windows\...` survived the strip, so it is a volume, not a file name.
  // `path.resolve` would honour it and leave the root.
  if (path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) {
    return { ok: false, reason: "outside-root" };
  }

  // `path.join` normalises, so `a/../../b` collapses before the containment
  // test rather than after it.
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relative);

  if (!isInside(rootAbs, target)) {
    return { ok: false, reason: "outside-root" };
  }

  return { ok: true, absolutePath: target };
}

/**
 * Whether `target` is `root` or below it.
 *
 * Exported because D2's local-resource resolver needs the same answer for paths
 * it did not obtain from a URL, and because the test asserts the five cases
 * directly instead of through the handler.
 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);

  if (rel === "") return true;

  // `rel` starting with `..` plus a separator is the only form that climbs out.
  // A bare `..` is the parent itself. An absolute `rel` means the two paths are
  // on different volumes, which is never "inside".
  if (rel.startsWith(".." + path.sep)) return false;
  if (rel === "..") return false;

  return !path.isAbsolute(rel);
}

/** Content types for the extensions the shell actually ships. */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".wasm", "application/wasm"],
  [".txt", "text/plain; charset=utf-8"],
]);

/**
 * The content type for a path.
 *
 * Defaults to `application/octet-stream` rather than guessing: a mislabelled
 * script served as `text/html` is a cross-site scripting primitive, and an
 * unknown extension is exactly where a guess would be wrong.
 */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

/** The subset of `Response` this module needs, so tests can read what it returns. */
export interface HandlerDeps {
  /** Absolute allow root. Exactly one per process. */
  readonly allowRoot: string;
  /** Build the response headers, so the CSP stays in `csp.ts`. */
  readonly headersFor: (contentType: string) => Record<string, string>;
}

/**
 * Build the `protocol.handle` callback for `app://`.
 *
 * Behaviour on a miss is a plain 404 with no body: the renderer shows its own
 * error surface, and a handler that renders HTML here would be a second error
 * page kept in step with `bootstrap-error.ts` by hand.
 *
 * The returned function is async because the handler contract is async; errors
 * become responses instead of rejections, because a rejection in `protocol.handle`
 * surfaces as a failed load with no status, which is much harder to diagnose
 * than a 404 or a 403 in the log.
 */
export function createProtocolHandler(deps: HandlerDeps) {
  return async (request: Request): Promise<Response> => {
    let url: URL;

    try {
      url = new URL(request.url);
    } catch {
      return new Response(null, { status: 400 });
    }

    // Only the registered host is served. `app://elsewhere/...` shares the
    // scheme but not the origin the CSP is written for.
    if (url.host !== APP_HOST) {
      return new Response(null, { status: 404 });
    }

    const resolved = resolveInside(deps.allowRoot, url.pathname);

    if (!resolved.ok || resolved.absolutePath === undefined) {
      // 403 for a boundary refusal, 404 for a malformed path. The distinction is
      // for the log; the page sees a failure either way.
      return new Response(null, { status: resolved.reason === "outside-root" ? 403 : 404 });
    }

    const filePath = resolved.absolutePath;

    // A directory would otherwise be read as a file and fail obscurely. The
    // entry document is named explicitly, never inferred, so no index magic.
    let isFile = false;

    try {
      const info = await stat(filePath);
      isFile = info.isFile();
    } catch {
      return new Response(null, { status: 404 });
    }

    if (!isFile) return new Response(null, { status: 404 });

    let body: Buffer;

    try {
      body = await readFile(filePath);
    } catch {
      return new Response(null, { status: 404 });
    }

    const contentType = contentTypeFor(filePath);

    return new Response(new Uint8Array(body), {
      status: 200,
      headers: deps.headersFor(contentType),
    });
  };
}
