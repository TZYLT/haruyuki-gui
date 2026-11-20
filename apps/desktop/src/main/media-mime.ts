/**
 * Which file types the media channel may serve, and as what.
 *
 * The table is the security boundary of this item. Viewing the user's own files
 * needs no approval step and is bounded by OS permissions, and the readable set is
 * only a convenience range -- so the only thing standing between a user's file
 * and an executable document is this table plus the render-side rule that content
 * never reaches `innerHTML`.
 *
 * Two rules make it a table rather than a set of preferences:
 *
 *   **No default branch.** Every extension is listed explicitly, including the
 *   ones that are refused. An unknown extension is refused by falling off the end
 *   of the map, not by a catch-all returning `application/octet-stream`, because a
 *   guess is exactly where a mislabelled script becomes a document. The coverage test asserts
 *   this with a sentinel: an unknown extension must produce "refused", never a MIME.
 *
 *   **Four MIME types are never produced.** `text/html`, `application/javascript`,
 *   `image/svg+xml` and `application/wasm` are absent from every value. Note what
 *   this forbids: it forbids a *MIME*, not a *file*. `.html`, `.js` and `.svg` are
 *   served as `text/plain` source text, which is what lets a user read their own
 *   project's files without the browser interpreting them. That distinction is the
 *   one most easily lost in review -- "we don't serve html" is false; "we never
 *   claim a file is html" is true.
 *
 * Why a `Map` and an explicit lookup function rather than an object literal: the
 * `satisfies` idiom that keeps the locale catalogues honest does not help here,
 * because the risk is not a missing key, it is a *silent fallback*. A `Map` has no
 * prototype to inherit from and `get` returning `undefined` is the refusal path.
 */

import path from "node:path";

import type { MediaTypePolicy } from "./media-protocol.js";

/** Charset appended to text types. One constant so the strings cannot drift. */
const TEXT = "text/plain; charset=utf-8";

/**
 * Extension to content type.
 *
 * Grouped by family with a comment per group, because a reviewer's question is
 * always "is this extension in the right family" rather than "what does this line
 * say".
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  // Images. `.svg` is deliberately absent: SVG is a document format that can carry
  // script and external references, so it belongs with the source-text group.
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".avif", "image/avif"],

  // Fonts, for the math renderer and for documents that embed their own faces.
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],

  // Audio and video. These are the reason the channel streams: a 500 MB video must
  // not pass through IPC or through the main process's memory.
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".ogv", "video/ogg"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".flac", "audio/flac"],

  // PDF. Served with `application/pdf` so Chromium's viewer takes it, and with
  // `nosniff` so nothing else can reinterpret it. Whether the viewer actually
  // draws content is a separate, unresolved question -- see doc 29 `T-16`: on the
  // development Electron the viewer is empty for every source, including ones that
  // never touch this channel.
  [".pdf", "application/pdf"],

  // Text and source. Everything here is served as `text/plain` and must reach the
  // DOM only through a text node, never `innerHTML`.
  [".txt", TEXT],
  [".md", TEXT],
  [".markdown", TEXT],
  [".json", TEXT],
  [".jsonl", TEXT],
  [".jsonc", TEXT],
  [".log", TEXT],
  [".csv", TEXT],
  [".tsv", TEXT],
  [".xml", TEXT],
  [".yaml", TEXT],
  [".yml", TEXT],
  [".toml", TEXT],
  [".ini", TEXT],
  [".conf", TEXT],
  [".env", TEXT],
  [".diff", TEXT],
  [".patch", TEXT],

  // Source code, served as text. `.js`/`.mjs`/`.cjs` are here rather than in a
  // "javascript" group on purpose: the file is readable, the browser must not run
  // it. `.wasm` is text-only for the same reason -- nothing in this item executes
  // a user's binary.
  [".js", TEXT],
  [".mjs", TEXT],
  [".cjs", TEXT],
  [".jsx", TEXT],
  [".ts", TEXT],
  [".mts", TEXT],
  [".cts", TEXT],
  [".tsx", TEXT],
  [".html", TEXT],
  [".htm", TEXT],
  [".xhtml", TEXT],
  [".css", TEXT],
  [".scss", TEXT],
  [".sass", TEXT],
  [".less", TEXT],
  [".py", TEXT],
  [".rb", TEXT],
  [".go", TEXT],
  [".rs", TEXT],
  [".java", TEXT],
  [".kt", TEXT],
  [".c", TEXT],
  [".h", TEXT],
  [".cc", TEXT],
  [".cpp", TEXT],
  [".hpp", TEXT],
  [".cs", TEXT],
  [".php", TEXT],
  [".swift", TEXT],
  [".sh", TEXT],
  [".bash", TEXT],
  [".zsh", TEXT],
  [".ps1", TEXT],
  [".bat", TEXT],
  [".cmd", TEXT],
  [".sql", TEXT],
  [".graphql", TEXT],
  [".gql", TEXT],
  [".proto", TEXT],

  // Document and data formats that are markup, not script, and that a viewer can
  // show as text without executing anything.
  [".svg", TEXT],
  [".wasm", TEXT],
  [".rtf", TEXT],
  [".tex", TEXT],
]);

/**
 * The type for a path, or `null`.
 *
 * `null` covers three cases that are deliberately one answer to the caller:
 *
 *   - an extension that is explicitly not previewable (`.exe`, `.dll`, `.so`, ...)
 *   - an extension nobody has decided about
 *   - no extension at all
 *
 * Rolling them together is right because the user-facing outcome is identical
 * ("this kind of file cannot be previewed") and the *decision* is what the table
 * records. The refusal reasons are not distinguished in the table because
 * distinguishing them would mean a second list to keep in step; the log keeps the
 * extension itself, which is the part a maintainer needs.
 *
 * Executable and archive formats are not listed at all. They are therefore refused
 * by the same code path as an unknown extension, and there is no line of the table
 * that says "this is fine to open" about a binary.
 *
 * @param filePath path whose extension decides the answer
 */
export function mediaContentTypeFor(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();

  // No extension: refused, and not by falling back to `application/octet-stream`.
  if (extension === "") return null;

  return CONTENT_TYPES.get(extension) ?? null;
}

/** The policy the media handler consumes. */
export const MEDIA_TYPE_POLICY: MediaTypePolicy = {
  contentTypeFor: mediaContentTypeFor,
};

/**
 * Every extension the table decides about, sorted. For tests that assert
 * coverage: each listed extension must be actually exercised,
 * and that requires being able to enumerate them.
 */
export function decidedExtensions(): string[] {
  return [...CONTENT_TYPES.keys()].sort();
}

/**
 * The MIME types this channel may ever claim.
 *
 * Exported for the negative assertion: not one of the four forbidden
 * types may appear in this set. A test that only checks "`.html` maps to
 * `text/plain`" would pass while some other extension quietly claimed
 * `text/html`.
 */
export function claimedContentTypes(): string[] {
  return [...new Set(CONTENT_TYPES.values())].sort();
}
