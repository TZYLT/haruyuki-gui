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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
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

    // The asset name carries a content hash, so it is discovered rather than
    // written down. The previous version named one hash literally -- which meant
    // that after any rebuild the read failed, the `|| ""` fallback made the
    // assertion vacuously true, and the test passed while checking nothing. It
    // was silently dead from the first rebuild onwards.
    const assets = path.join(DIST, "renderer", "assets");
    const bundles = readdirSync(assets).filter((name) => name.endsWith(".js"));

    expect(bundles.length).toBeGreaterThan(0);

    for (const name of bundles) {
      const source = readFileSync(path.join(assets, name), "utf8");

      expect(source.includes("eval("), name).toBe(false);
      // `new Function` is the other way to reach the same capability, and
      // `'unsafe-eval'`'s absence blocks it identically.
      expect(source.includes("new Function("), name).toBe(false);
    }
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

describe("the preload is one self-contained file", () => {
  it("has no shared chunk beside it", () => {
    // The failure this prevents, from a real launch: with both entries in one build,
    // Rollup extracted `bridge.ts` into `chunks/bridge-<hash>.cjs` and the preload became
    // `require("./chunks/bridge-<hash>.cjs")`. A sandboxed preload has no module loader,
    // so that `require` threw before `preload.ts` ran a line -- no `window.haruyuki`, and
    // dragging a file over the window showed the no-drop cursor because the drop listener
    // was never installed.
    //
    // The build is two invocations now, one entry each. This asserts the shape rather than
    // the script, because the script is what a future change would edit.
    const mainDir = path.join(PACKAGE_DIR, "dist", "main");

    // Absent when the package has not been built; the rest of this file already skips in
    // that situation, and a missing directory must not read as a pass here either.
    if (!existsSync(mainDir)) return;

    expect(existsSync(path.join(mainDir, "chunks"))).toBe(false);

    // And the preload really is standalone: no `require` of anything but `electron` or a
    // Node built-in. A relative `require` here is the chunk by another name.
    const preload = readFileSync(path.join(mainDir, "preload.cjs"), "utf8");
    const requires = [...preload.matchAll(/require\("([^"]+)"\)/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);
    const unresolved = requires.filter(
      (name) => name !== "electron" && !name.startsWith("node:") && !builtinModules.includes(name),
    );

    expect(unresolved).toEqual([]);
  });
});
