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
    // Three encodings reach `handle` unchanged because the URL parser only
    // decodes `%2e%2e` into a normalised segment; `%2f` and `%5c` survive as
    // literal characters. None of them escape: `%` is an ordinary filename
    // character, so the path stays inside the root and the read misses. The
    // assertion is the security property, not a status code -- pinning 403 here
    // would have meant asserting a refusal that is not what happens.
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
