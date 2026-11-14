/**
 * Build configuration for the engine smoke probe.
 *
 * The probe has to run inside a real Electron main process, and the code it exercises
 * (`@haruyuki/core`) is TypeScript resolved through source exports -- there is no
 * `dist` to import and no transpiler in the runtime. So the probe is bundled like the
 * rest of the main process, and the smoke script launches the bundle.
 *
 * Three findings from making this actually run, all of which cost a rebuild:
 *
 *   CJS, not ESM. Electron's ESM loader does not provide named exports for its own
 *   module: `import { app } from "electron"` fails with "does not provide an export named
 *   'app'". A CJS bundle that does `require("electron")` is the shape Electron itself
 *   expects, and it is what the real main process build uses too.
 *
 *   `import.meta.url` is therefore not available, and `@haruyuki/core` needs it to call
 *   `createRequire`. The build replaces it with a `__filename`-based value (see the
 *   `define` below), which is the correct analogue in a CJS module.
 *
 *   `ws` stays external and is resolved from `packages/core`, because pnpm's strict
 *   layout puts it under `packages/core/node_modules` and the bundle lands in
 *   `apps/desktop/dist/probe/`, where that name does not resolve. `__WS_REQUIRE_FROM__`
 *   carries the anchor.
 *
 * The probe is a test artifact, so it goes to its own directory: a production package
 * must not ship it, and `dist/main` must stay exactly the two files the shell loads.
 */

import { builtinModules } from "node:module";
import path from "node:path";

import { defineConfig } from "vite";

/** This package directory, used to resolve `ws` from where it actually is. */
const PACKAGE_DIR = import.meta.dirname;

/** Repository root, three levels up from `apps/desktop`. */
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

/** Node built-ins plus Electron, all provided by the runtime. */
const EXTERNAL = ["electron", "ws", ...builtinModules, ...builtinModules.map((n) => `node:${n}`)];

export default defineConfig({
  build: {
    outDir: path.resolve(PACKAGE_DIR, "dist/probe"),
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    target: "node24",
    lib: {
      entry: path.resolve(PACKAGE_DIR, "scripts/engine-probe.ts"),
      formats: ["cjs"],
      fileName: () => "engine-probe.cjs",
    },
    rollupOptions: {
      external: EXTERNAL,
      output: { entryFileNames: "engine-probe.cjs" },
    },
  },
  define: {
    // `@haruyuki/core` resolves `ws` through `createRequire(import.meta.url)`, and that
    // has to be anchored where `ws` actually is -- `packages/core` -- not where the
    // bundle landed. Anchoring at the bundle was the first attempt and failed at module
    // load with `Cannot find module 'ws'`, because pnpm keeps it under
    // `packages/core/node_modules` and the bundle sits in `apps/desktop/dist/probe/`.
    //
    // In a CJS bundle `import.meta` is `{}`, so without this define the module throws
    // before doing anything at all.
    "import.meta.url": `require("node:url").pathToFileURL(${JSON.stringify(
      path.join(REPO_ROOT, "packages", "core", "package.json"),
    )}).href`,
    // The anchor the probe asserts before starting an engine.
    __WS_REQUIRE_FROM__: JSON.stringify(path.join(REPO_ROOT, "packages", "core", "package.json")),
  },
  appType: "custom",
  logLevel: "info",
});
