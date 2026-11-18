/**
 * The main bundle must never carry a path from the machine that built it.
 *
 * The shipped failure this replaces: the engine transport reaches the websocket
 * client through `createRequire(import.meta.url)`, the main bundle is CommonJS
 * where `import.meta` becomes an empty object, and the build config patched that
 * expression with a literal built from *this checkout's* location. It worked on the
 * build machine and on no other: a packaged application looked the client up under a
 * tree that did not exist there, the module threw while loading, and the process
 * exited before creating a window. Nothing on the user side said why -- the load
 * failure happens before the logger and before any error code exists.
 *
 * The anchor is now resolved at runtime (`process.resourcesPath` when packaged, the
 * sibling package in development), so the artifact no longer names a directory.
 *
 * The assertions are inverted from the interim state on purpose: while the anchor
 * pointed at this checkout, they had to require its presence to keep the shell
 * starting. Now they require its absence, which is what protects the fix. Anyone who
 * reintroduces a build-time absolute path -- a literal, a `resolve.alias`, an inline
 * `replace` -- fails here in milliseconds instead of at the next install.
 *
 * A build is only checked when one exists. The gate must not require an artifact a
 * clean checkout has not produced yet; the neighbouring build-path test follows the
 * same rule.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** The desktop package directory: `__tests__` to `main` to `src` to the package. */
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The build config that produces both main-process entries. */
const VITE_MAIN = path.join(PACKAGE_DIR, "vite.main.mts");

/** The CommonJS bundle the shell actually launches. */
const MAIN_BUNDLE = path.join(PACKAGE_DIR, "dist", "main", "main.cjs");

/**
 * The checkout root, as both a Windows and a POSIX spelling.
 *
 * The bare directory name is useless as a needle: it is two characters here and
 * appears in hashes and identifiers all over a bundle. What must not appear is the
 * path, so the whole absolute prefix is what gets searched for.
 */
const CHECKOUT_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
const CHECKOUT_NEEDLES = [CHECKOUT_ROOT, CHECKOUT_ROOT.replaceAll("\\", "/")];

describe("the main bundle carries no path from the build machine", () => {
  it("resolves the websocket client's package root at runtime, not at build time", () => {
    const source = readFileSync(VITE_MAIN, "utf8");

    // The replacement is still needed -- the facade constructs the transport -- but its
    // value has to be computed by the running process. A literal path here is the bug.
    expect(source, "vite.main.mts no longer anchors import.meta.url").toContain(
      '"import.meta.url"',
    );

    // It must branch on the runtime layout, which is the only thing that differs
    // between a checkout and an installation.
    expect(source).toContain("process.resourcesPath");

    // And it must not name this checkout. `packages/core/package.json` is what the
    // previous version pointed at; the runtime version reaches it through a relative
    // join, so the literal path must be gone from the config.
    expect(source, "vite.main.mts names the checkout's core package again").not.toMatch(
      /path\.resolve\([^)]*packages[\\/,]core/,
    );
  });

  it("has no absolute path in the built bundle", () => {
    if (!existsSync(MAIN_BUNDLE)) return;

    const bundle = readFileSync(MAIN_BUNDLE, "utf8");

    // The reviewer's own search of the packaged archive, applied to the bundle: the
    // absolute checkout path, in either separator spelling.
    for (const needle of CHECKOUT_NEEDLES) {
      expect(bundle, `the bundle embeds the checkout path "${needle}"`).not.toContain(needle);
    }

    // The general shape behind it: a drive-rooted Windows path or a file URL that
    // points into a checkout. Both would resolve on one machine only.
    expect(bundle, "the bundle embeds a Windows drive path").not.toMatch(/[A-Za-z]:\\\\/);
    expect(bundle, "the bundle embeds a checkout file URL").not.toMatch(/file:\/\/\/[A-Za-z]:/);

    // The load-time throw this whole item exists for. `{}.url` is how a missing
    // replacement appears in the output.
    expect(bundle, "the bundle still evaluates import.meta.url at load").not.toContain(
      "createRequire({}.url)",
    );
  });
});
