import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  APP_HOST,
  APP_PRIVILEGES,
  APP_SCHEME,
  contentTypeFor,
  createProtocolHandler,
  isInside,
  resolveInside,
} from "../protocol.js";
import type { ShellError } from "../../shared/shell-error.js";

const ROOT = process.platform === "win32" ? "C:\\srv\\app" : "/srv/app";

describe("resolveInside", () => {
  it("accepts a plain file name and returns an absolute path under the root", () => {
    const result = resolveInside(ROOT, "/index.html");

    expect(result.ok).toBe(true);
    expect(result.absolutePath).toBe(
      ROOT + (process.platform === "win32" ? "\\" : "/") + "index.html",
    );
  });

  it("accepts a nested path", () => {
    const result = resolveInside(ROOT, "/assets/app.js");

    expect(result.ok).toBe(true);
    expect(result.absolutePath).toContain("assets");
  });

  it("accepts a path that leaves and returns inside the root", () => {
    // Normalisation happens before the containment test, so this is the file it
    // names, not an escape.
    const result = resolveInside(ROOT, "/assets/../index.html");

    expect(result.ok).toBe(true);
    expect(result.absolutePath?.endsWith("index.html")).toBe(true);
  });

  it("refuses a path that climbs out of the root", () => {
    const result = resolveInside(ROOT, "/../secrets.txt");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("outside-root");
  });

  it("refuses a path that climbs two levels out", () => {
    const result = resolveInside(ROOT, "/assets/../../secrets.txt");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("outside-root");
  });

  it("refuses an absolute path", () => {
    // `path.resolve(root, "/etc/passwd")` would return `/etc/passwd`, so the
    // absolute case has to be caught before resolution.
    const target = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd";
    const result = resolveInside(ROOT, target);

    expect(result.ok).toBe(false);
    expect(result.reason === "outside-root" || result.reason === "bad-path").toBe(true);
  });

  it("refuses a path containing a NUL byte", () => {
    const result = resolveInside(ROOT, "/index.html\0.png");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad-path");
  });

  it("refuses a sibling directory whose name extends the root's name", () => {
    const result = resolveInside(ROOT, "/../app-secrets/key.txt");

    expect(result.ok).toBe(false);
  });

  it("decodes a percent-encoded name into the file it actually names", () => {
    // The regression: `new URL().pathname` is *not* decoded -- `%20`, `%2f` and
    // every non-ASCII byte survive. Resolving that string looked for a file
    // called `a%20b.js`, so any asset whose name had a space, an accent or a CJK
    // character 404'd. Contract-free filenames are the normal case for a user
    // document name, so this was a real reachability hole, not a curiosity.
    const spaced = resolveInside(ROOT, "/a%20b.js");

    expect(spaced.ok).toBe(true);
    expect(spaced.absolutePath?.endsWith("a b.js")).toBe(true);

    const cjk = resolveInside(ROOT, "/%E4%B8%AD%E6%96%87.png");

    expect(cjk.ok).toBe(true);
    expect(cjk.absolutePath?.endsWith("中文.png")).toBe(true);
  });

  it("decodes before deciding containment, so an encoded traversal is refused", () => {
    // `/..%2f..%2fpackage.json` must be read as the escape it spells. The first
    // version left it encoded, so the handler looked up a file literally named
    // `..%2f..%2fpackage.json` and answered 404 -- safe by accident, and the
    // accident was indistinguishable from a working boundary.
    for (const attempt of ["/..%2f..%2fpackage.json", "/..%2fpackage.json", "/..%5c..%5cx.txt"]) {
      const result = resolveInside(ROOT, attempt);

      expect(result.ok, attempt).toBe(false);
      expect(result.reason, attempt).toBe("outside-root");
    }
  });

  it("refuses a malformed escape rather than passing it through", () => {
    // A lone `%` and `%zz` make `decodeURIComponent` throw. Passing the raw
    // string on would alias a file whose name starts with `%`, which is a
    // different file from the one the URL names.
    for (const bad of ["/%zz.js", "/100%.js"]) {
      const result = resolveInside(ROOT, bad);

      expect(result.ok, bad).toBe(false);
      expect(result.reason, bad).toBe("bad-path");
    }
  });

  it("refuses a NUL byte spelled as an escape", () => {
    const result = resolveInside(ROOT, "/index%00.png");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad-path");
  });

  it.skipIf(process.platform !== "win32")(
    "still refuses a drive-relative path that climbs out",
    () => {
      // `C:..\..\win.ini` is not absolute, so the `isAbsolute` guard misses it,
      // yet `path.resolve` reads it as "the current directory on C:, up two" and
      // lands outside the root. The containment test is the backstop; this pins
      // that it actually fires rather than trusting the reasoning. Windows-only,
      // because the shape does not exist elsewhere.
      const result = resolveInside(ROOT, "/C:..\\..\\win.ini");

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("outside-root");
    },
  );
});

describe("isInside", () => {
  const sep = process.platform === "win32" ? "\\" : "/";

  it("treats the root itself as inside", () => {
    expect(isInside(ROOT, ROOT)).toBe(true);
  });

  it("treats a descendant as inside", () => {
    expect(isInside(ROOT, ROOT + sep + "a" + sep + "b.js")).toBe(true);
  });

  it("treats the parent as outside", () => {
    expect(isInside(ROOT, ROOT + sep + "..")).toBe(false);
  });

  it("keeps a file named with dots reachable", () => {
    // The regression this test exists for: `path.relative` yields `..../x` here,
    // and a `startsWith("..")` containment check refuses a legal file.
    expect(isInside(ROOT, ROOT + sep + "...." + sep + "package.json")).toBe(true);
  });

  it("keeps a file whose name begins with two dots reachable", () => {
    expect(isInside(ROOT, ROOT + sep + "..hidden")).toBe(true);
  });
});

describe("contentTypeFor", () => {
  it("names the types the shell ships", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("app.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("font.woff2")).toBe("font/woff2");
    expect(contentTypeFor("icon.svg")).toBe("image/svg+xml");
  });

  it("is case insensitive about the extension", () => {
    expect(contentTypeFor("APP.JS")).toBe("text/javascript; charset=utf-8");
  });

  it("does not guess for an unknown extension", () => {
    // A guess here would let a `.txt` be served as something executable.
    expect(contentTypeFor("payload.zzz")).toBe("application/octet-stream");
    expect(contentTypeFor("no-extension")).toBe("application/octet-stream");
  });
});

describe("createProtocolHandler", () => {
  const headersFor = (contentType: string): Record<string, string> => ({
    "content-type": contentType,
    "content-security-policy": "test-policy",
  });

  const handler = createProtocolHandler({ allowRoot: ROOT, headersFor });

  it("answers 404 for the wrong host", async () => {
    const response = await handler(new Request("app://elsewhere/index.html"));

    expect(response.status).toBe(404);
  });

  it("never serves a file outside the root, whatever the URL encoding", async () => {
    // Five spellings of the same escape. What they share is that decoding them
    // yields a `..` segment, so `resolveInside` refuses all five -- the
    // assertion is the security property (no content) rather than one status,
    // because the layer that refuses is allowed to change.
    const attempts = [
      `app://${APP_HOST}/%2e%2e/secrets.txt`,
      `app://${APP_HOST}/%2e%2e%2fsecrets.txt`,
      `app://${APP_HOST}/..%2fsecrets.txt`,
      `app://${APP_HOST}/..%5csecrets.txt`,
      `app://${APP_HOST}/a%2f..%2f..%2fx`,
    ];

    for (const url of attempts) {
      const response = await handler(new Request(url));
      const body = await response.text();

      expect(response.status, url).not.toBe(200);
      expect(body, url).toBe("");
    }
  });

  it("answers 403, not 404, for an encoded traversal", async () => {
    // The distinction is the whole point of decoding first: 403 says "you named
    // a path outside the root", 404 says "no such file". Before the decode, an
    // encoded escape was reported as a `404`, which reads like a typo in the
    // caller rather than an attempt.
    const response = await handler(new Request(`app://${APP_HOST}/..%2f..%2fpackage.json`));

    expect(response.status).toBe(403);
  });

  it("serves a file whose name is percent-encoded", async () => {
    // End-to-end proof of the same fix at the layer a user sees: a renderer
    // asking for an asset with a space in its name gets the asset.
    const root = await mkdtemp(path.join(tmpdir(), "app-root-"));
    await writeFile(path.join(root, "a b.js"), "export {};");
    const ownHandler = createProtocolHandler({ allowRoot: root, headersFor });
    const response = await ownHandler(new Request(`app://${APP_HOST}/a%20b.js`));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("export {};");
  });

  it("answers 403 when the decoded path really does climb out", async () => {
    // `resolveInside` is the layer that sees the raw `..`, so this is where the
    // refusal is observable. `isInside` and the matrix above cover the rest.
    expect(resolveInside(ROOT, "/../secrets.txt").reason).toBe("outside-root");
  });

  it("answers 404 for a file that is not there", async () => {
    // The URL survives normalisation, so the handler does the stat and misses.
    const response = await handler(new Request(`app://${APP_HOST}/definitely-absent.js`));

    expect(response.status).toBe(404);
  });

  it("answers 404 for a path naming a directory rather than a file", async () => {
    // Without the stat check this would reach `readFile` and fail with EISDIR,
    // which is a worse error than a 404 and a different status.
    const response = await handler(new Request(`app://${APP_HOST}/`));

    expect(response.status).toBe(404);
  });

  it("reports a boundary refusal with its own code", async () => {
    // A refusal that leaves no trace is indistinguishable from a request that
    // never arrived. The code is what tells "your allow root is wrong" apart from
    // "the file is missing" -- which look identical from the window: nothing.
    const reported: ShellError[] = [];
    const reporting = createProtocolHandler({
      allowRoot: ROOT,
      headersFor,
      onFailure: (error) => reported.push(error),
    });

    await reporting(new Request(`app://${APP_HOST}/%2e%2e%2fsecrets.txt`));

    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("APP_PROTOCOL_DENIED");
    expect(reported[0]?.messageKey).toBe("error.shell.resourceDenied");
  });

  it("reports a missing file for a path inside the root", async () => {
    const reported: ShellError[] = [];
    const reporting = createProtocolHandler({
      allowRoot: ROOT,
      headersFor,
      onFailure: (error) => reported.push(error),
    });

    await reporting(new Request(`app://${APP_HOST}/nope.txt`));

    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("APP_PROTOCOL_NOT_FOUND");
  });

  it("reports a miss for a directory as not-found, not denied", async () => {
    // A directory is inside the root. Reporting it as denied would send the user
    // looking for a permissions problem that does not exist.
    const reported: ShellError[] = [];
    const reporting = createProtocolHandler({
      allowRoot: ROOT,
      headersFor,
      onFailure: (error) => reported.push(error),
    });

    await reporting(new Request(`app://${APP_HOST}/`));

    expect(reported[0]?.code).toBe("APP_PROTOCOL_NOT_FOUND");
  });

  it("reports nothing for a served file", async () => {
    // The absence of a report is the only signal that success is genuinely
    // silent; a handler that reported everything would be noise nobody reads.
    const root = await mkdtemp(path.join(tmpdir(), "app-root-"));

    await writeFile(path.join(root, "index.html"), "<!doctype html>");

    const reported: ShellError[] = [];
    const reporting = createProtocolHandler({
      allowRoot: root,
      headersFor,
      onFailure: (error) => reported.push(error),
    });

    const response = await reporting(new Request(`app://${APP_HOST}/index.html`));

    expect(response.status).toBe(200);
    expect(reported).toHaveLength(0);
  });

  it("does not require a reporter", async () => {
    // The tests above answer questions about responses; a required callback would
    // make every one of them pass a no-op.
    const silent = createProtocolHandler({ allowRoot: ROOT, headersFor });

    await expect(silent(new Request(`app://${APP_HOST}/nope.txt`))).resolves.toBeDefined();
  });
});

describe("frozen shapes", () => {
  it("keeps the scheme and host the contract names", () => {
    expect(APP_SCHEME).toBe("app");
    expect(APP_HOST).toBe("haruyuki");
  });

  it("keeps the five privileges at their frozen values", () => {
    expect(APP_PRIVILEGES).toEqual({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: false,
      stream: false,
    });
  });
});
