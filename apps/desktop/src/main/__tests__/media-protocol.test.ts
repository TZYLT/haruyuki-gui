/**
 * The media channel's transport half: URL shape, boundary, ranges, streaming.
 *
 * What these tests are really pinning, as opposed to the type table (``transport.ts``):
 *
 *   The path is *one opaque segment*. Traversal is unrepresentable rather than
 *   filtered, so a payload like `..%2f..%2fetc%2fpasswd` decodes to a string that
 *   is not an absolute path and is refused for that reason -- not because a
 *   blacklist happened to catch it.
 *
 *   The containment predicate is the shared one. A second copy would be a second
 *   boundary and the weaker one would win, so there is a test that the module
 *   imports rather than reimplements.
 *
 *   A range is answered or refused, never half-answered. A partial implementation
 *   of ranges is how a seek ends up silently wrong instead of visibly broken.
 */

import { describe, expect, it } from "vitest";

import {
  createMediaHandler,
  MEDIA_HOST,
  MEDIA_PRIVILEGES,
  MEDIA_SCHEME,
  mediaHeaders,
  mediaUrlFor,
  parseRange,
  pathFromMediaUrl,
  resolveWithinRoot,
  toWebStream,
  type MediaTypePolicy,
} from "../media-protocol.js";

/** A policy that serves everything as text, for tests about transport only. */
const TEXT_ONLY: MediaTypePolicy = { contentTypeFor: () => "text/plain; charset=utf-8" };

/** A policy that refuses everything, for tests about the seams. */
const REFUSE_ALL: MediaTypePolicy = { contentTypeFor: () => null };

describe("the scheme's frozen shape", () => {
  it("is named exactly what the contract froze", () => {
    expect(MEDIA_SCHEME).toBe("haruyuki-media");
    expect(MEDIA_HOST).toBe("local");
  });

  it("keeps supportFetchAPI false, which is why fetch never settles", () => {
    // The frozen value, not a preference. A renderer `fetch` of this scheme hangs
    // rather than rejecting, so the channel is only ever consumed by elements and
    // navigations.
    expect(MEDIA_PRIVILEGES.supportFetchAPI).toBe(false);
  });

  it("streams, which is what lets a large file be read in pieces", () => {
    expect(MEDIA_PRIVILEGES.stream).toBe(true);
  });

  it("cannot bypass the CSP, because that would make the CSP advisory", () => {
    expect(MEDIA_PRIVILEGES.bypassCSP).toBe(false);
  });
});

describe("mediaUrlFor", () => {
  const ROOT = process.platform === "win32" ? "C:\\work" : "/work";
  const INSIDE = process.platform === "win32" ? "C:\\work\\shot.png" : "/work/shot.png";
  const OUTSIDE = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd";

  it("encodes the whole path as one segment", () => {
    const result = mediaUrlFor(INSIDE, [ROOT]);

    expect(result.ok).toBe(true);
    // One segment: no path separators survive unencoded, so there is no
    // relative-path syntax for a payload to abuse.
    expect(result.url).toBe(`${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(INSIDE)}`);
    expect(result.url?.split("/").length).toBe(4);
  });

  it("refuses a path outside the readable set", () => {
    const result = mediaUrlFor(OUTSIDE, [ROOT]);

    expect(result).toEqual({ ok: false, reason: "outside-allowed-set" });
  });

  it("refuses everything when nothing has been authorised yet", () => {
    // An empty set is the honest answer for "the user has picked nothing", and it
    // must not be mistaken for "no restriction".
    expect(mediaUrlFor(INSIDE, []).ok).toBe(false);
  });

  it("skips only the set check when the user trusts all paths", () => {
    const trusted = mediaUrlFor(OUTSIDE, [], true);

    // The switch exists to widen the *location* the user may read. It does not
    // and cannot widen what types are served: that decision happens in the type
    // policy, which never sees this flag.
    expect(trusted.ok).toBe(true);
  });

  it("still refuses a relative path even when everything is trusted", () => {
    // A caller passing a relative path is a bug in the caller, not an
    // authorisation question, so the flag must not cover it.
    expect(mediaUrlFor("shot.png", [], true)).toEqual({ ok: false, reason: "bad-path" });
  });

  it("refuses a NUL byte, which truncates in layers below this one", () => {
    expect(mediaUrlFor(`${INSIDE}\0.png`, [ROOT]).ok).toBe(false);
  });

  it("accepts a root that is the file's parent, not only an ancestor by prefix", () => {
    // `/work2/shot.png` starts with the text "/work" but is not inside it. A
    // prefix test would let it through; the shared predicate does not.
    const sibling = process.platform === "win32" ? "C:\\work2\\shot.png" : "/work2/shot.png";

    expect(mediaUrlFor(sibling, [ROOT]).ok).toBe(false);
  });
});

describe("pathFromMediaUrl", () => {
  const ABS = process.platform === "win32" ? "C:\\a\\b.png" : "/a/b.png";

  /** Build a URL the way the renderer would receive it. */
  function urlFor(absolute: string): string {
    return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(absolute)}`;
  }

  it("round-trips the encoded path", () => {
    expect(pathFromMediaUrl(urlFor(ABS))).toEqual({ ok: true, absolutePath: ABS });
  });

  it("decodes exactly once, so a double-encoded space stays encoded", () => {
    // `%2520` is one decode away from `%20`, which is a literal filename rather
    // than a space. A second decode would silently name a different file.
    const literal = process.platform === "win32" ? "C:\\a b\\x%2520y.txt" : "/a b/x%2520y.txt";
    const recovered = pathFromMediaUrl(urlFor(literal));

    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.absolutePath).toBe(literal);
  });

  it("refuses an unknown host, which shares the scheme but not the origin", () => {
    expect(pathFromMediaUrl(`${MEDIA_SCHEME}://elsewhere/${encodeURIComponent(ABS)}`).ok).toBe(
      false,
    );
  });

  it("refuses a malformed escape instead of passing the percent signs through", () => {
    // Passing `%zz` through would alias a real file whose name begins with `%`.
    expect(pathFromMediaUrl(`${MEDIA_SCHEME}://${MEDIA_HOST}/%zz`).ok).toBe(false);
  });

  it("refuses an encoded NUL", () => {
    expect(
      pathFromMediaUrl(`${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(`${ABS}\0`)}`).ok,
    ).toBe(false);
  });

  it("refuses a non-absolute decode, which no caller of this item produces", () => {
    expect(pathFromMediaUrl(`${MEDIA_SCHEME}://${MEDIA_HOST}/relative.png`).ok).toBe(false);
  });

  it("refuses a URL that does not parse", () => {
    expect(pathFromMediaUrl("not a url").ok).toBe(false);
  });
});

describe("the traversal matrix", () => {
  // Eight payloads, the same shapes D1 already tests against `app://`, because a
  // channel that is safe against five of them is not safe.
  const PAYLOADS = [
    "..%2f..%2fpackage.json",
    "%2e%2e%2f%2e%2e%2fpackage.json",
    "%252e%252e%252fpackage.json",
    "..%5c..%5cpackage.json",
    "C%3A%5cWindows%5cwin.ini",
    "%2fetc%2fpasswd",
    "..%2f..%2f..%2f..%2fetc%2fpasswd",
    "%00%2e%2e%2fpackage.json",
  ];

  for (const payload of PAYLOADS) {
    it(`refuses ${payload}`, () => {
      const result = pathFromMediaUrl(`${MEDIA_SCHEME}://${MEDIA_HOST}/${payload}`);

      // Two different refusals are acceptable and both are correct: the decode
      // produces something that is not absolute, or it produces an absolute path
      // that is not inside the readable set (refused later by the handler). What
      // must not happen is acceptance.
      const acceptedHere = result.ok;
      if (acceptedHere) {
        const inside = mediaUrlFor(result.absolutePath, [
          process.platform === "win32" ? "C:\\work" : "/work",
        ]);
        expect(inside.ok).toBe(false);
      } else {
        expect(result.reason).toBe("bad-path");
      }
    });
  }
});

describe("parseRange", () => {
  it("answers null when there is no range, meaning serve everything", () => {
    expect(parseRange(null, 100)).toBeNull();
  });

  it("reads a closed range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });

  it("reads an open-ended range as far as the file goes", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("reads a suffix range as the last n bytes", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("returns the whole file for a suffix longer than the file", () => {
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("clamps an end past the file rather than refusing the tail", () => {
    // A player asking for more than exists is asking for the tail. Refusing would
    // break seeking on a file whose size changed under it.
    expect(parseRange("bytes=0-99999", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("refuses a start at or past the end", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("invalid");
    expect(parseRange("bytes=2000-3000", 1000)).toBe("invalid");
  });

  it("refuses a backwards range", () => {
    expect(parseRange("bytes=500-100", 1000)).toBe("invalid");
  });

  it("refuses multiple ranges instead of answering one of them", () => {
    // Answering the first would be a partial implementation presented as one that
    // works: the player would get half its request and no complaint.
    expect(parseRange("bytes=0-99,200-299", 1000)).toBe("invalid");
  });

  it("refuses a unit other than bytes", () => {
    expect(parseRange("items=0-99", 1000)).toBe("invalid");
  });

  it("refuses a range that names no bytes", () => {
    expect(parseRange("bytes=-", 1000)).toBe("invalid");
    expect(parseRange("bytes=-0", 1000)).toBe("invalid");
  });
});

describe("toWebStream", () => {
  it("produces something with getReader, which a Response body requires", () => {
    // The measured failure mode: a Node stream behind a type assertion compiles
    // and then fails every request with ERR_FAILED (-2), at request time rather
    // than at construction.
    const { Readable } = require("node:stream") as typeof import("node:stream");
    const web = toWebStream(Readable.from([Buffer.from("x")]));

    expect(typeof web.getReader).toBe("function");
  });
});

describe("a file is never read into memory", () => {
  it("streams every response body and never materialises the whole file", async () => {
    // A 500 MB video must not become a 500 MB buffer in
    // the main process. The behavioural half of that (no event-loop stall) is
    // measured in a real Electron by `verify-media.mjs`; this is the structural
    // half, and it is the one that can be checked mechanically.
    //
    // `readFile` anywhere in this module would break the claim regardless of how
    // the streaming path looks, so the assertion is on its absence rather than on
    // the presence of `createReadStream`: a future refactor could add a buffered
    // branch next to the streaming one, and only the absence check notices.
    const { readFile } = require("node:fs/promises") as typeof import("node:fs/promises");
    const { join } = require("node:path") as typeof import("node:path");

    const source = await readFile(join(import.meta.dirname, "..", "media-protocol.ts"), "utf8");

    // The import list specifically, because a call would have to come through it.
    expect(source).not.toMatch(/import[^;]*\breadFile\b/);
    expect(source).not.toMatch(/\bwriteFile\b/);
  });

  it("uses the streaming read for both the whole-file and the ranged path", async () => {
    const { readFile } = require("node:fs/promises") as typeof import("node:fs/promises");
    const { join } = require("node:path") as typeof import("node:path");

    const source = await readFile(join(import.meta.dirname, "..", "media-protocol.ts"), "utf8");

    // Two call sites: one for 200, one for 206. One missing means one of the two
    // paths buffers.
    expect(source.match(/createReadStream\(/g)?.length).toBe(2);
  });
});

describe("the containment predicate is shared, not copied", () => {
  it("re-exports resolveInside's answer instead of reimplementing it", () => {
    const root = process.platform === "win32" ? "C:\\work" : "/work";

    // The same three answers `protocol.ts` gives, reached through this module.
    expect(resolveWithinRoot(root, "/a.png").ok).toBe(true);
    expect(resolveWithinRoot(root, "/../outside.png").ok).toBe(false);
    expect(resolveWithinRoot(root, "/%zz").ok).toBe(false);
  });
});

describe("the boundary has exactly one definition", () => {
  it("declares resolveInside once in the shell, and imports it everywhere else", () => {
    // The grep assertion. A second containment implementation would be a
    // second boundary, and the weaker one wins.
    //
    // Scoped to `apps/desktop/src` on purpose: `packages/core` has its own
    // `isInsideRoot` for the headless port and the test doubles. Those are a
    // different function answering a different question (a single injected root,
    // no URL decoding), so counting them here would make the assertion about
    // naming rather than about duplication.
    const { readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");

    /** Every `.ts` file under a directory, recursively. */
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return full.endsWith(".ts") ? [full] : [];
      });
    }

    const srcRoot = join(import.meta.dirname, "..", "..");
    const declarations: string[] = [];

    for (const file of walk(srcRoot)) {
      // Tests are excluded: a test that declares its own predicate is checking a
      // local rule, not establishing a boundary the product uses.
      if (file.includes("__tests__") || file.endsWith(".test.ts")) continue;

      const text = readFileSync(file, "utf8");
      if (/export function resolveInside\(/.test(text)) declarations.push(file);
    }

    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toContain(join("main", "protocol.ts"));
  });

  it("imports it into the media channel rather than restating it", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");

    const text = readFileSync(join(import.meta.dirname, "..", "media-protocol.ts"), "utf8");

    expect(text).toMatch(/from "\.\/protocol\.js"/);
  });
});

describe("mediaHeaders", () => {
  it("carries nosniff, inline and no-store on every response", () => {
    const headers = mediaHeaders("text/plain; charset=utf-8");

    expect(headers["content-type"]).toBe("text/plain; charset=utf-8");
    // The second lock: even a wrong type decision must not be sniffed into
    // something executable.
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-disposition"]).toBe("inline");
    expect(headers["cache-control"]).toBe("no-store");
  });

  it("advertises range support, which seeking depends on", () => {
    expect(mediaHeaders("image/png")["accept-ranges"]).toBe("bytes");
  });

  it("does not add a CSP of its own", () => {
    // The page's policy governs what may load; a per-response policy would be a
    // second one to keep in step with `csp.ts`.
    expect(Object.keys(mediaHeaders("image/png"))).not.toContain("content-security-policy");
  });
});

describe("the handler's refusals", () => {
  /** Build a handler over one root with a fixed policy. */
  function handlerWith(policy: MediaTypePolicy, roots: string[], trust = false) {
    const failures: string[] = [];

    const handler = createMediaHandler({
      types: policy,
      readableRoots: () => roots,
      trustAllPaths: () => trust,
      onFailure: (error) => failures.push(error.code),
    });

    return { handler, failures };
  }

  const ROOT = process.platform === "win32" ? "C:\\work" : "/work";

  it("answers 403 for a path outside the readable set, and reports its own code", async () => {
    const { handler, failures } = handlerWith(TEXT_ONLY, [ROOT]);
    const outside = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd";

    const response = await handler(
      new Request(`${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(outside)}`),
    );

    expect(response.status).toBe(403);
    // A boundary refusal reuses the existing code rather than adding a second
    // one with the same meaning.
    expect(failures).toContain("APP_PROTOCOL_DENIED");
  });

  it("answers 415 for a refused type, with the one code this item adds", async () => {
    const { handler, failures } = handlerWith(REFUSE_ALL, [ROOT]);
    const inside = process.platform === "win32" ? "C:\\work\\a.exe" : "/work/a.exe";

    const response = await handler(
      new Request(`${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(inside)}`),
    );

    expect(response.status).toBe(415);
    expect(failures).toContain("MEDIA_TYPE_DENIED");
  });

  it("depends on the type policy, not on the trust switch", async () => {
    // The trust switch widens where a file may come from. It must not widen what
    // may be served, so a refusal survives even with everything trusted.
    const { handler } = handlerWith(REFUSE_ALL, [], true);
    const anywhere = process.platform === "win32" ? "C:\\any\\a.exe" : "/any/a.exe";

    const response = await handler(
      new Request(`${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(anywhere)}`),
    );

    expect(response.status).toBe(415);
  });

  it("answers 404 for a path this item never generates", async () => {
    const { handler, failures } = handlerWith(TEXT_ONLY, [ROOT]);

    const response = await handler(new Request(`${MEDIA_SCHEME}://${MEDIA_HOST}/relative.png`));

    expect(response.status).toBe(404);
    expect(failures).toContain("APP_PROTOCOL_NOT_FOUND");
  });

  it("answers 404 for a file that is not there", async () => {
    const { handler } = handlerWith(TEXT_ONLY, [ROOT]);
    const missing = process.platform === "win32" ? "C:\\work\\nope.png" : "/work/nope.png";

    const response = await handler(
      new Request(`${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(missing)}`),
    );

    expect(response.status).toBe(404);
  });

  it("answers 416 with the size when a range cannot be honoured", async () => {
    // Reached through a real file so the size is known; `parseRange` itself is
    // unit-tested above and this pins the wiring between them.
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { writeFileSync, mkdtempSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "d2-range-"));
    const file = join(dir, "small.txt");
    writeFileSync(file, "0123456789");

    const { handler } = handlerWith(TEXT_ONLY, [dir]);

    const response = await handler(
      new Request(`${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(file)}`, {
        headers: { range: "bytes=100-200" },
      }),
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  });

  it("serves a whole file with its length when no range is asked", async () => {
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { writeFileSync, mkdtempSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "d2-whole-"));
    const file = join(dir, "whole.txt");
    writeFileSync(file, "hello");

    const { handler } = handlerWith(TEXT_ONLY, [dir]);
    const response = await handler(
      new Request(`${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(file)}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // A body that can be read in pieces is the whole point of `stream: true`.
    expect(response.body).not.toBeNull();
    expect(await response.text()).toBe("hello");
  });

  it("serves a partial file with 206 and a content-range", async () => {
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { writeFileSync, mkdtempSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "d2-part-"));
    const file = join(dir, "part.txt");
    writeFileSync(file, "0123456789");

    const { handler } = handlerWith(TEXT_ONLY, [dir]);
    const response = await handler(
      new Request(`${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(file)}`, {
        headers: { range: "bytes=2-4" },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(response.headers.get("content-length")).toBe("3");
    expect(await response.text()).toBe("234");
  });
});
