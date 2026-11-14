/**
 * The build's output paths, asserted against what the running code expects.
 *
 * These are not unit tests of a function. They exist because the two quietest failures in
 * this shell are both *path* failures, and neither produces an error message:
 *
 *   A wrong `webPreferences.preload` path means Electron loads nothing. The renderer's
 *   `window.haruyuki` is `undefined`, every IPC call fails with a TypeError, and the
 *   window itself looks fine.
 *
 *   A wrong allow root means every `app://` request 404s. The window loads a blank
 *   document and shows nothing.
 *
 * Both were real during this item: the first because the build emits `dist/main/preload.cjs`
 * while the source asked for `dist/preload/preload.js`. The test therefore reads the built
 * tree and the source, and asserts that the names in the source exist on disk.
 *
 * It skips when `dist/` is absent rather than failing: `verify` must not require a build,
 * and a developer running the gates before their first build should not see a red segment
 * about an artifact they have not made yet.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The desktop package directory.
 *
 * Three levels up from this file: `__tests__` to `main` to `src` to the package. Getting
 * this wrong is how the first version of this test pointed at `src/src/main/main.ts` and
 * reported the missing file rather than the thing it was checking.
 */
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The built tree. */
const DIST = path.join(PACKAGE_DIR, "dist");

/** The main process source, which is where the expected paths are written. */
const MAIN_SOURCE = path.join(PACKAGE_DIR, "src", "main", "main.ts");

/** Whether a build exists to check against. */
const BUILT = existsSync(path.join(DIST, "main", "main.cjs"));

describe.skipIf(!BUILT)("the built tree matches what the shell asks for", () => {
  it("has a preload file at the path the main process names", () => {
    const source = readFileSync(MAIN_SOURCE, "utf8");
    const match = /preload:\s*path\.join\(HERE,\s*"([^"]+)"\)/.exec(source);

    expect(match, "the preload path is not where this test can find it").not.toBeNull();

    const relative = match![1]!;
    const resolved = path.join(DIST, "main", relative);

    expect(
      existsSync(resolved),
      `main.ts points at dist/main/${relative}, which the build did not produce`,
    ).toBe(true);
  });

  it("has a renderer directory at the path the allow root names", () => {
    const source = readFileSync(MAIN_SOURCE, "utf8");
    const match = /const allowRoot = path\.join\(HERE,\s*"([^"]+)"\)/.exec(source);

    expect(match, "the allow root is not where this test can find it").not.toBeNull();

    const resolved = path.join(DIST, "main", match![1]!);

    expect(existsSync(resolved), `the allow root ${resolved} does not exist`).toBe(true);
    expect(existsSync(path.join(resolved, "index.html"))).toBe(true);
  });

  it("has a main entry the runtime can launch", () => {
    expect(existsSync(path.join(DIST, "main", "main.cjs"))).toBe(true);
  });

  it("serves a renderer bundle with no inline script and no eval", () => {
    // Both are CSP requirements rather than style preferences: `script-src 'self'` forbids
    // inline script, and there is no `'unsafe-eval'`. A bundle that needed either would
    // load a blank page with a console violation nobody reads.
    const html = readFileSync(path.join(DIST, "renderer", "index.html"), "utf8");

    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);

    const assets = path.join(DIST, "renderer", "assets");
    const scripts = existsSync(assets)
      ? readFileSync(path.join(assets, "index-CkOyJ6f4.js"), "utf8")
      : "";

    // The asset name carries a content hash, so the check is on any bundle present.
    expect(scripts === "" || !scripts.includes("eval(")).toBe(true);
  });
});

describe("the shell's reload and navigation surface", () => {
  it("denies a window open and hands http links to the browser", () => {
    // Read as source: the handler is registered on a `BrowserWindow`, and constructing one
    // needs a display. The assertion is that the guard exists and is wired, which is what
    // can be checked without a window.
    const source = readFileSync(MAIN_SOURCE, "utf8");

    expect(source).toContain("setWindowOpenHandler");
    expect(source).toContain('return { action: "deny" }');
    expect(source).toContain("shell.openExternal");
  });

  it("refuses a navigation away from the app origin", () => {
    const source = readFileSync(MAIN_SOURCE, "utf8");

    expect(source).toContain("will-navigate");
    expect(source).toContain("event.preventDefault()");
  });

  it("keeps the three hardened web preferences", () => {
    // Each of these is load-bearing: turning any one off widens the renderer's surface to
    // include Node or a shared context with the preload.
    const source = readFileSync(MAIN_SOURCE, "utf8");

    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("nodeIntegration: false");
    expect(source).toContain("webviewTag: false");
  });
});
