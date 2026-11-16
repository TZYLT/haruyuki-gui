/**
 * The read-only media scheme: `haruyuki-media://local/<encoded absolute path>`.
 *
 * Why a second scheme exists at all: `app://` serves the shell's own build output
 * under `script-src 'self'` and its MIME table maps `.html`, `.js`, `.svg`, so a
 * user's project file served from the same origin would land inside `'self'` and
 * be executable. Reading a file is not the same permission as letting the browser
 * interpret it, which is why the media scheme exists with its own rules.
 *
 * What this module owns (the transport half):
 *
 *   the URL shape, the scheme registration and its privileges
 *   the boundary check, by importing `resolveInside` rather than copying it
 *   streaming a file out without buffering it in this process
 *   byte ranges, which `<video>` seeking needs
 *
 * What it does NOT own: which types may be served and what headers they carry.
 * That is `media-mime.ts`, reached through {@link MediaTypePolicy}. The split is
 * split is deliberate and has a cost: two packages edit this module, so the seam
 * `TODO(mime)` and each half can land on its own.
 *
 * Three facts from the route probe shape this file, each of which cost a run:
 *
 *   `protocol.handle` builds a DOM `Response`, so the body must be a **web**
 *   `ReadableStream`. A Node stream behind `as unknown as ReadableStream` compiles
 *   and then fails every request with `ERR_FAILED (-2)`. {@link toWebStream} is
 *   the only place that conversion happens.
 *
 *   `supportFetchAPI` is frozen `false`, and the consequence is stronger than
 *   "fetch is unavailable": a renderer `fetch` of this scheme never settles. No
 *   error, no rejection -- a pending promise. Everything here is therefore shaped
 *   for element loads and navigations, which is all the product needs.
 *
 *   The scheme can only be registered once per process. `registerSchemesAsPrivileged`
 *   is called from `main.ts` before `app.whenReady()`; this module exports the
 *   descriptor and never registers a second one.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { isInside, resolveInside } from "./protocol.js";
import { shellError } from "../shared/shell-error.js";
import type { ShellError } from "../shared/shell-error.js";

/** The scheme. Frozen: a rename is a contract change. */
export const MEDIA_SCHEME = "haruyuki-media" as const;

/** The host. Fixed, because it is part of the origin and the requirement names it. */
export const MEDIA_HOST = "local" as const;

/**
 * Privileges passed to `registerSchemesAsPrivileged`.
 *
 * `standard` gives the scheme an origin and URL parsing; without it relative URLs
 * do not resolve and `'self'` matches nothing. `secure` keeps media out of the
 * mixed-content path.
 *
 * `supportFetchAPI: false` is the frozen value and it is deliberate: this channel
 * is for `<img>`, `<video>`, `<audio>`, `<embed>` and `@font-face`, not for a
 * script pulling bytes. The measured consequence is documented above.
 *
 * `stream: true` is what lets Chromium read a large file in pieces; the route
 * probe measured 103 chunks for a 27 MB image with no event-loop stall.
 *
 * `bypassCSP: false` because a scheme that can opt out of the CSP makes the CSP
 * advisory.
 */
export const MEDIA_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: false,
  bypassCSP: false,
  stream: true,
} as const;

/** Why a media request was refused. Distinct from `protocol.ts`'s reason type. */
export type MediaRefusal = "outside-allowed-set" | "type-not-allowed" | "not-a-file" | "bad-path";

/** The result of turning an absolute path into a media URL. */
export interface MediaUrlResult {
  readonly ok: boolean;
  /** Present only when `ok` is false. */
  readonly reason?: MediaRefusal;
  /** Present only when `ok` is true. */
  readonly url?: string;
}

/**
 * Turn an absolute path into the URL the renderer loads.
 *
 * The path is one opaque segment: `encodeURIComponent` of the whole absolute path.
 * That is what makes traversal unrepresentable rather than merely checked -- there
 * is no relative-path syntax to abuse, so `..` cannot appear as a segment. The
 * boundary check is still done, because a caller can hand in a path outside the
 * readable set.
 *
 * @param absPath absolute path the renderer should load
 * @param readableRoots the set the path must fall inside; empty means nothing is
 *   readable, which is the correct answer for "the user has not authorised anything"
 * @param trustAllPaths the user's position-trust switch; skips only the set check
 */
export function mediaUrlFor(
  absPath: string,
  readableRoots: readonly string[],
  trustAllPaths = false,
): MediaUrlResult {
  if (absPath.includes("\0")) return { ok: false, reason: "bad-path" };

  if (!path.isAbsolute(absPath)) return { ok: false, reason: "bad-path" };

  if (!trustAllPaths) {
    const inside = readableRoots.some((root) =>
      isInside(path.resolve(root), path.resolve(absPath)),
    );

    // The switch exists only to skip this check. Everything else about the
    // response is unchanged, which is why "trust all paths" cannot widen what
    // types are served -- see the `TODO(mime)` seam below.
    if (!inside) return { ok: false, reason: "outside-allowed-set" };
  }

  return { ok: true, url: `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(absPath)}` };
}

/**
 * Recover the absolute path from a media request URL.
 *
 * The inverse of {@link mediaUrlFor}. It decodes **once** and never resolves the
 * result against anything: the encoded segment is an absolute path by
 * construction, so `path.resolve` here would be a second interpretation of the
 * same bytes.
 *
 * @param requestUrl the request URL as Electron reports it
 */
export function pathFromMediaUrl(
  requestUrl: string,
): { ok: true; absolutePath: string } | { ok: false; reason: MediaRefusal } {
  let url: URL;

  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false, reason: "bad-path" };
  }

  // Only the fixed host is served. Another host shares the scheme but not the
  // origin, and answering it would be answering a URL nobody generated.
  if (url.host !== MEDIA_HOST) return { ok: false, reason: "bad-path" };

  let decoded: string;

  try {
    decoded = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    // A malformed escape (`%zz`, a lone `%`) is refused rather than passed
    // through with its percent signs intact: a path we cannot decode is a path we
    // cannot reason about, and passing it through would alias a real file whose
    // name happens to begin with `%`.
    return { ok: false, reason: "bad-path" };
  }

  if (decoded.includes("\0")) return { ok: false, reason: "bad-path" };

  // A decoded value that is not absolute means the URL did not come from
  // `mediaUrlFor`. Refusing keeps the shape honest: exactly one encoding, exactly
  // one absolute path.
  if (!path.isAbsolute(decoded)) return { ok: false, reason: "bad-path" };

  return { ok: true, absolutePath: decoded };
}

/**
 * The type policy, supplied by `media-mime.ts`.
 *
 * An interface rather than a direct import so that the transport half can be
 * tested without the table, and so that "which types are allowed" has exactly one
 * definition (the table must be exhaustive with no default
 * branch).
 */
export interface MediaTypePolicy {
  /**
   * The content type for a path, or `null` to refuse it.
   *
   * `null` is a decision, not a failure: `.exe` and every unknown extension are
   * refused explicitly rather than falling through to a default. There is no
   * "application/octet-stream" fallback anywhere in this item, because a guess is
   * exactly where a mislabelled script becomes an HTML document.
   *
   * @param filePath absolute path whose extension decides the answer
   */
  contentTypeFor(filePath: string): string | null;
}

/** What a media handler needs. Everything injected, so the handler is testable. */
export interface MediaHandlerDeps {
  /** The type policy that decides what may be served. */
  readonly types: MediaTypePolicy;
  /** The readable set at call time. Read per request, never cached across sessions. */
  readableRoots(): readonly string[];
  /** Whether the user has switched the position check off. Read per request. */
  trustAllPaths(): boolean;
  /** Report a refusal, so it reaches the log with a code. */
  readonly onFailure?: (error: ShellError) => void;
}

/** The portion of a byte range this handler serves. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parse a `Range` header against a known size.
 *
 * Only the forms a media element actually sends are supported: `bytes=a-b`,
 * `bytes=a-`, and `bytes=-n` (the last n bytes). Anything else -- multiple
 * ranges, a unit other than bytes -- is refused, because answering a partial
 * implementation of a spec as though it were complete is how a seek ends up
 * silently wrong.
 *
 * @param header the raw header value, or null
 * @param size total bytes available
 * @returns the range to serve, or `null` for "serve everything", or `"invalid"`
 *   for a range that cannot be honoured
 */
export function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (header === null) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return "invalid";

  const startText = match[1] ?? "";
  const endText = match[2] ?? "";

  // `bytes=-` names no range at all.
  if (startText === "" && endText === "") return "invalid";

  if (startText === "") {
    // `bytes=-n`: the last n bytes.
    const suffix = Number(endText);
    if (suffix <= 0) return "invalid";

    // An empty file has no last byte. Without this guard the answer is
    // `{start: 0, end: -1}`, and `createReadStream` throws `ERR_OUT_OF_RANGE` on it --
    // synchronously, inside the protocol handler, which surfaces as a failed load with
    // no status rather than as the 416 this module intends for an unhonourable range.
    if (size === 0) return "invalid";

    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startText);
  const end = endText === "" ? size - 1 : Number(endText);

  if (start >= size || start > end) return "invalid";

  // A request past the end is clamped rather than refused: a player asking for
  // more than exists is asking for the tail, and refusing would break seeking on
  // files whose size changed under it.
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Convert a Node readable into the web stream `Response` requires.
 *
 * One function so the conversion appears once. A Node stream passed to `Response`
 * behind a type assertion compiles and then fails every request with
 * `ERR_FAILED (-2)` -- the request fails, not the construction, which is why the
 * mistake survives a type check and a code review.
 *
 * @param stream the Node stream to adapt
 */
export function toWebStream(stream: Readable): ReadableStream {
  return Readable.toWeb(stream) as ReadableStream;
}

/**
 * Build the `protocol.handle` callback for the media scheme.
 *
 * Refusal codes are chosen for the log, and the page gets a status: 403 for a
 * boundary refusal, 415 for a type refusal, 404 for "no usable file". Collapsing
 * them would make a misconfigured readable set look like a broken build.
 *
 * @param deps what the handler needs, all injected
 */
export function createMediaHandler(deps: MediaHandlerDeps) {
  return async (request: Request): Promise<Response> => {
    const recovered = pathFromMediaUrl(request.url);

    if (!recovered.ok) {
      deps.onFailure?.(
        shellError(
          "APP_PROTOCOL_NOT_FOUND",
          `unusable media URL: ${request.url} (${recovered.reason})`,
        ),
      );

      return new Response(null, { status: 404 });
    }

    const filePath = recovered.absolutePath;

    // The boundary check runs on the decoded absolute path rather than through
    // `resolveInside`: that function takes a URL pathname relative to one root,
    // while a media URL carries an absolute path and may be inside any of several
    // roots. `isInside` is the shared predicate, so there is still one definition
    // of containment.
    if (!deps.trustAllPaths()) {
      const roots = deps.readableRoots();
      const inside = roots.some((root) => isInside(path.resolve(root), filePath));

      if (!inside) {
        deps.onFailure?.(
          shellError("APP_PROTOCOL_DENIED", `path outside the readable set: ${filePath}`),
        );

        return new Response(null, { status: 403 });
      }
    }

    // TODO(mime): the type table lives behind this call. The seam is this line and nothing
    // else, so the two packages never edit the same region of the file.
    const contentType = deps.types.contentTypeFor(filePath);

    if (contentType === null) {
      // Derived, never spelled: `shell-error.ts` is the only source for the
      // code-to-key mapping, and this module spelled the wrong key here for a while --
      // reporting a type refusal under the "you may not read this" message. The
      // logging in `main.ts` prints `messageKey`, so the mistake was that a refusal of
      // one kind was recorded as a refusal of another.
      deps.onFailure?.(
        shellError(
          "MEDIA_TYPE_DENIED",
          `type not served: ${path.extname(filePath).toLowerCase() || "(none)"}`,
        ),
      );

      return new Response(null, { status: 415 });
    }

    let size: number;

    try {
      const info = await stat(filePath);

      if (!info.isFile()) {
        deps.onFailure?.(shellError("APP_PROTOCOL_NOT_FOUND", `not a file: ${filePath}`));

        return new Response(null, { status: 404 });
      }

      size = info.size;
    } catch (error) {
      // A file that exists but cannot be read is "not found" from the page's
      // point of view; the detail keeps the reason, because permissions and a
      // race with a rebuild need different fixes.
      deps.onFailure?.(
        shellError("APP_PROTOCOL_NOT_FOUND", `unreadable: ${filePath} (${String(error)})`),
      );

      return new Response(null, { status: 404 });
    }

    const range = parseRange(request.headers.get("range"), size);

    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }

    if (range !== null) {
      const stream = createReadStream(filePath, {
        start: range.start,
        end: range.end,
        // A large highWaterMark keeps the chunk count low for big media; the
        // probe measured 256 KiB giving 103 chunks for 27 MB.
        highWaterMark: CHUNK_BYTES,
      });

      return new Response(toWebStream(stream), {
        status: 206,
        headers: {
          ...mediaHeaders(contentType),
          "content-length": String(range.end - range.start + 1),
          "content-range": `bytes ${range.start}-${range.end}/${size}`,
        },
      });
    }

    const stream = createReadStream(filePath, { highWaterMark: CHUNK_BYTES });

    return new Response(toWebStream(stream), {
      status: 200,
      headers: {
        ...mediaHeaders(contentType),
        "content-length": String(size),
      },
    });
  };
}

/** Chunk size for streamed responses. Measured, not guessed (route §2.3). */
const CHUNK_BYTES = 256 * 1024;

/**
 * The headers every media response carries.
 *
 * `nosniff` is the second lock: even if the type decision were wrong, the browser
 * must not sniff the bytes into something executable. `inline` keeps a PDF or an
 * image in the page instead of triggering a download. `no-store` because the URL
 * names a user's file and caching it in a shared store is not this item's call.
 *
 * `accept-ranges` is advertised because seeking depends on it.
 *
 * No CSP header here: the page's own policy governs what may load, and adding a
 * second one per response would be a second policy to keep in step.
 *
 * @param contentType the type decided by the policy
 */
export function mediaHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "cache-control": "no-store",
    "accept-ranges": "bytes",
  };
}

/**
 * Resolve a request against a single allowed root, for callers that have one.
 *
 * Exported so the contract test can assert that this module imports the shared
 * resolver rather than carrying its own copy: a second containment
 * implementation would be a second boundary, and the weaker one wins.
 *
 * @param root the allow root
 * @param urlPathname the URL pathname to resolve
 */
export function resolveWithinRoot(root: string, urlPathname: string) {
  return resolveInside(root, urlPathname);
}
