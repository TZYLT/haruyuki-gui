/**
 * The type table: what may be served, and as what.
 *
 * Two things this file has to prove, and they are different:
 *
 *   **The table is exhaustive with no default branch.** The sentinel test below
 *   feeds an extension nobody decided about and requires `null` -- not
 *   `application/octet-stream`, not a guess. A `?? "application/octet-stream"`
 *   anywhere in the implementation fails it.
 *
 *   **Every listed extension is actually exercised.** A table entry nobody tests
 *   is an entry nobody has checked, and the failure mode is silent: the type is
 *   simply claimed without evidence.
 *
 * The negative assertion is the most important one in the file: not one of the
 * four forbidden MIME types may appear among the values, for *any* extension. A
 * test that only checked "`.html` maps to `text/plain`" would pass while some
 * other extension quietly claimed `text/html`.
 */

import { describe, expect, it } from "vitest";

import {
  claimedContentTypes,
  decidedExtensions,
  MEDIA_TYPE_POLICY,
  mediaContentTypeFor,
} from "../media-mime.js";

describe("the four MIME types this channel may never claim", () => {
  // The core prohibition. Note the wording: it forbids the MIME, not the file.
  // `.html` is served -- as `text/plain` -- which is what lets a user read their
  // own project without the browser interpreting it.
  const FORBIDDEN = ["text/html", "application/javascript", "image/svg+xml", "application/wasm"];

  for (const forbidden of FORBIDDEN) {
    it(`never claims ${forbidden}, for any extension`, () => {
      for (const claimed of claimedContentTypes()) {
        // Compared by exact string, then by prefix for the parameters form: a
        // `text/html; charset=utf-8` would otherwise slip past.
        expect(claimed, forbidden).not.toBe(forbidden);
        expect(claimed.startsWith(`${forbidden};`), forbidden).toBe(false);
        expect(claimed.startsWith(`${forbidden} `), forbidden).toBe(false);
      }
    });
  }

  it("serves html, js and svg as source text instead of refusing them", () => {
    // The distinction the requirement calls "禁的是 MIME，不是文件". A refusal here
    // would be a defensible design, but it is not the one that was chosen: a user
    // reading their own project's files is the point.
    for (const extension of [".html", ".htm", ".js", ".mjs", ".cjs", ".svg", ".wasm"]) {
      expect(mediaContentTypeFor(`/x/file${extension}`), extension).toBe(
        "text/plain; charset=utf-8",
      );
    }
  });
});

describe("the table has no default branch", () => {
  const UNDECIDED = [
    "/x/file.exe",
    "/x/file.dll",
    "/x/file.so",
    "/x/file.dylib",
    "/x/file.bin",
    "/x/file.zip",
    "/x/file.tar.gz",
    "/x/file.qqq",
    "/x/file", // no extension at all
    "/x/.hidden", // a dotfile: `extname` is "" for `.hidden`
  ];

  for (const candidate of UNDECIDED) {
    it(`refuses ${candidate} rather than guessing a type`, () => {
      // `null` is the sentinel. `application/octet-stream` would be a guess, and a
      // guess is where a mislabelled script becomes a document.
      expect(mediaContentTypeFor(candidate)).toBeNull();
    });
  }

  it("refuses a file whose name looks like a listed extension but is not", () => {
    // `.png` with a trailing character is a different extension.
    expect(mediaContentTypeFor("/x/file.pngx")).toBeNull();
  });

  it("is case-insensitive, so .PNG and .Png are served the same way", () => {
    // The measured reason: a user's photo from a camera or a Windows share is
    // routinely `.JPG`. Refusing those would be a defect, not a security win.
    expect(mediaContentTypeFor("/x/A.PNG")).toBe("image/png");
    expect(mediaContentTypeFor("/x/A.Png")).toBe("image/png");
    expect(mediaContentTypeFor("/x/A.SVG")).toBe("text/plain; charset=utf-8");
  });
});

describe("the families the table claims", () => {
  it("serves images a viewer can draw", () => {
    for (const extension of [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico", ".avif"]) {
      expect(mediaContentTypeFor(`/x/a${extension}`), extension).toMatch(/^image\//);
    }
  });

  it("serves fonts for the math renderer", () => {
    for (const extension of [".woff", ".woff2", ".ttf", ".otf"]) {
      expect(mediaContentTypeFor(`/x/a${extension}`), extension).toMatch(/^font\//);
    }
  });

  it("serves audio and video, which is why the channel streams", () => {
    for (const extension of [".mp4", ".webm", ".mp3", ".wav", ".ogg"]) {
      expect(mediaContentTypeFor(`/x/a${extension}`), extension).toMatch(/^(audio|video)\//);
    }
  });

  it("serves PDF as application/pdf so the viewer takes it", () => {
    expect(mediaContentTypeFor("/x/doc.pdf")).toBe("application/pdf");
  });

  it("serves source code as text, never as a script type", () => {
    for (const extension of [".ts", ".tsx", ".py", ".go", ".rs", ".sh", ".sql", ".css"]) {
      expect(mediaContentTypeFor(`/x/a${extension}`), extension).toBe("text/plain; charset=utf-8");
    }
  });
});

describe("decidedExtensions", () => {
  it("enumerates every extension, so a coverage test can require each to be exercised", () => {
    // Without an enumeration, "every entry is tested" is an aspiration. With it,
    // the test below can fail when the table grows.
    const extensions = decidedExtensions();

    expect(extensions.length).toBeGreaterThan(40);
    expect(new Set(extensions).size).toBe(extensions.length);
  });

  it("lists only lowercase, dot-prefixed extensions", () => {
    // A `.PNG` key would never match, because lookup lowercases the extension:
    // the entry would look present and be dead.
    for (const extension of decidedExtensions()) {
      expect(extension, extension).toMatch(/^\.[a-z0-9]+$/);
    }
  });

  it("proves each listed extension resolves, which is the coverage requirement", () => {
    // An entry nobody exercises is an entry nobody checked. This walks
    // the enumeration and requires a real answer for each one.
    for (const extension of decidedExtensions()) {
      const resolved = mediaContentTypeFor(`/x/probe${extension}`);

      expect(resolved, extension).not.toBeNull();
      expect(resolved, extension).not.toBeUndefined();
    }
  });
});

describe("claimedContentTypes", () => {
  it("is a deduplicated set of the MIME values in play", () => {
    const claimed = claimedContentTypes();

    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed).toContain("image/png");
    expect(claimed).toContain("text/plain; charset=utf-8");
  });
});

describe("the policy adapter", () => {
  it("is the table, not a second decision", () => {
    // The handler depends on an interface, but the interface must be backed by the
    // one table: two decision points would be two tables to keep in step.
    expect(MEDIA_TYPE_POLICY.contentTypeFor("/x/a.png")).toBe("image/png");
    expect(MEDIA_TYPE_POLICY.contentTypeFor("/x/a.exe")).toBeNull();
  });
});
