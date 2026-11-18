/**
 * The CommonJS anchor the main bundle cannot live without, asserted so that
 * removing it fails here instead of at the next bare launch.
 *
 * `@haruyuki/core`'s engine transport reaches the websocket client through
 * `createRequire(import.meta.url)`. The main process bundle is CommonJS, where
 * `import.meta` is rewritten to an empty object, so that expression becomes
 * `createRequire(undefined)` and throws `ERR_INVALID_ARG_VALUE` while the module
 * is still loading -- before the window, before the logger, before any error
 * code the diagnostics panel could show. The visible symptom is a process that
 * exits without ever presenting a window, which is the least diagnosable shape
 * a failure can have.
 *
 * The build config therefore replaces that one property with a literal built
 * from `packages/core`'s location. Deleting that replacement has been tried:
 * two bare launches, two identical traces, no window either time. So the
 * replacement is load bearing, and the point of this test is that the next
 * person who reads the config and concludes it looks redundant finds a red
 * test with the reason attached rather than a shell that quietly cannot start.
 *
 * This is a source-level assertion on purpose. The alternative -- launching
 * Electron and looking for a window -- needs a display and several seconds per
 * case, and `verify` runs on machines that have neither. The expensive check
 * belongs in `verify:gui-host`; what is checked here is the one-line condition
 * that made it pass, so a regression is caught in a millisecond.
 *
 * `dist/main/main.cjs` is asserted too when a build exists, because the source
 * can be right while the replacement never reached the output (a config that
 * is not the one the build loads, an output path that moved). It skips without
 * a build, matching the rule the neighbouring build-path test follows: the gate
 * must not require an artifact a clean checkout has not produced yet.
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

describe("the main bundle anchors import.meta.url", () => {
  it("replaces import.meta.url in the build config", () => {
    const source = readFileSync(VITE_MAIN, "utf8");

    // The define key is quoted in a Vite config, so the plain substring is the
    // unambiguous spelling; a comment mentioning it does not satisfy this
    // because the check below requires the replacement's shape as well.
    expect(source, "vite.main.mts no longer defines import.meta.url").toContain(
      '"import.meta.url"',
    );

    // The value must be an expression that yields a URL string, not the literal
    // `import.meta.url` -- defining a property to itself would compile and then
    // leave the runtime throwing exactly as if the define were absent.
    const defined = /"import\.meta\.url"\s*:\s*([^\n]+)/.exec(source);

    expect(defined, 'vite.main.mts has no value for "import.meta.url"').not.toBeNull();
    expect(defined![1]).toContain("pathToFileURL");

    // Anchored at the package whose `node_modules` holds the websocket client.
    // A path to anywhere else resolves or throws, and neither is the client.
    expect(source).toContain("packages/core/package.json");
  });

  it("has no bare import.meta.url left in the built bundle", () => {
    if (!existsSync(MAIN_BUNDLE)) return;

    const bundle = readFileSync(MAIN_BUNDLE, "utf8");

    // The strings `import.meta` in comments and in `import.meta.env` mentions
    // are not expressions; what must not survive is the property access that
    // becomes `undefined` under CommonJS. `{}.url` is how the transform shows up
    // when the replacement is missing, so both spellings are refused.
    expect(bundle, "the bundle still evaluates import.meta.url at load").not.toContain(
      "createRequire({}.url)",
    );
    expect(bundle).not.toMatch(/createRequire\(\s*import\.meta\.url\s*\)/);
  });
});
