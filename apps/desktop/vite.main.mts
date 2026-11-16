/**
 * Build configuration for **one** entry: `main` or `preload`.
 *
 * Two passes, not one build with two inputs, and the reason is a real failure rather than
 * tidiness. Both entries import `bridge.ts` (the preload to build the bridge, the main
 * process for `DROPPED_FILES_CHANNEL`). With both as inputs of a single build, Rollup
 * extracts the shared module to `chunks/bridge-<hash>.cjs` and the preload becomes
 * `require("./chunks/bridge-<hash>.cjs")`.
 *
 * That breaks the preload completely. A sandboxed preload has no module loader, so that
 * `require` fails with `module not found` before the first line of `preload.ts` runs. The
 * symptom is a window where `window.haruyuki` is undefined and dragging a file over it
 * shows the no-drop cursor, because the drop listener never got installed. Nothing says
 * why -- Electron logs "Unable to load preload script" to a console a packaged build does
 * not show.
 *
 * The obvious fix is `inlineDynamicImports` / `codeSplitting: false`, and Rolldown rejects
 * it when there is more than one input. So each entry is built by its own invocation with a
 * single input, where inlining the shared module into the one output is legal. `build:main`
 * runs the two invocations; see `package.json`.
 *
 * Which entry this invocation builds comes from `HARUYUKI_BUILD_ENTRY`, defaulting to
 * `main`. An environment variable rather than two config files, because everything else
 * below is what must not drift between them: Node target, external `electron`, CommonJS
 * `.cjs` output, no minification.
 *
 *   `.cjs`, not `.mjs`. The preload runs with `sandbox: true`, which means no ESM loader
 *   and no `require` polyfill beyond what Electron provides. A `.mjs` preload is silently
 *   not loaded under sandbox, which presents as "the bridge is undefined".
 *
 *   `electron` is external. Bundling it would inline the API stubs; the real module is
 *   provided by the runtime.
 *
 *   No minification. A stack trace from a production crash should name the function it
 *   came from, and these files are a few kilobytes.
 */

import { builtinModules } from "node:module";
import path from "node:path";

import { defineConfig } from "vite";

/** This package directory. */
const PACKAGE_DIR = import.meta.dirname;

/** Node built-ins plus the Electron module, all provided by the runtime. */
const EXTERNAL = ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

/** The two entries, and where each one's source lives. */
const ENTRIES = {
  main: path.resolve(PACKAGE_DIR, "src/main/main.ts"),
  preload: path.resolve(PACKAGE_DIR, "src/preload/preload.ts"),
} as const;

/** Which entry this invocation builds. */
const WHICH: keyof typeof ENTRIES =
  process.env["HARUYUKI_BUILD_ENTRY"] === "preload" ? "preload" : "main";

/**
 * Anchor for `@haruyuki/core`'s `createRequire(import.meta.url)`.
 *
 * The main bundle is CommonJS, so Vite turns `import.meta` into `{}` and
 * `createRequire(undefined)` throws before the first window exists. The probe
 * build already replaces this with the core package location; the main build
 * did not, which is why a green probe suite could not catch the shell failing
 * to launch (`E-128`). This is the same anchor, not a second convention.
 *
 * The absolute path is a development-tree fact. G2's packaged build must copy
 * `ws` next to the bundle or externalise it with a packaged anchor; that is
 * recorded as a packaging debt rather than guessed at here.
 *
 * This is E-132's temporary convergence for the main build. D3 carried a narrower
 * `resolve.alias` for a while ("main only needs core's bridge module"), but D4's
 * supervision code imports core's reclaim/evidence primitives from the package root,
 * so the root import is now correct and the alias is gone. The durable fix is a
 * `"./bridge"` subpath on `@haruyuki/core` for the sender's half, plus a packaged
 * anchor for this define (G2's packaging debt); until then this is the one anchor.
 */
const CORE_PACKAGE_JSON = path.resolve(import.meta.dirname, "../../packages/core/package.json");

export default defineConfig({
  build: {
    outDir: path.resolve(PACKAGE_DIR, "dist/main"),
    // Only the `main` pass clears: the preload pass runs into the directory it filled.
    emptyOutDir: WHICH === "main",
    // Source maps are kept: a production crash report that points at line 1, col 40000
    // is not a crash report.
    sourcemap: true,
    minify: false,
    target: "node24",
    lib: {
      // A single input, so inlining the shared module is legal -- and required: see the
      // file header for what happens otherwise.
      entry: ENTRIES[WHICH],
      formats: ["cjs"],
      fileName: () => `${WHICH}.cjs`,
    },
    rollupOptions: {
      external: EXTERNAL,
      output: {
        inlineDynamicImports: true,
        entryFileNames: "[name].cjs",
      },
    },
  },
  // `@haruyuki/core` resolves `ws` through `createRequire(import.meta.url)`.
  // In this CJS bundle `import.meta` is `{}`, so anchor it where `ws` actually
  // lives (`packages/core`) instead of letting module load throw. The preload
  // build has no such call, but the define is harmless there.
  define: {
    "import.meta.url": `require("node:url").pathToFileURL(${JSON.stringify(
      CORE_PACKAGE_JSON,
    )}).href`,
  },
  // Neither entry has an `index.html`; without this Vite looks for one.
  appType: "custom",
  logLevel: "info",
});
