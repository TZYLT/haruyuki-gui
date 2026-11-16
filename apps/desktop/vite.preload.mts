/**
 * Build configuration for the preload script.
 *
 * Separate from the main process for one non-negotiable reason: a sandboxed
 * preload can `require("electron")` and nothing else. It has no module loader
 * for relative files, so a shared chunk emitted by a multi-entry build fails at
 * preload time with `module not found: ./chunks/...`, and the renderer sees a
 * missing bridge instead of a build error.
 *
 * The decisions match `vite.main.mts` on purpose: CJS, external `electron`, no
 * minification, Node target. `emptyOutDir: false` because the main build owns
 * `dist/main` and runs first.
 */

import { builtinModules } from "node:module";
import path from "node:path";

import { defineConfig } from "vite";

/** Node built-ins plus Electron, all provided by the runtime. */
const EXTERNAL = ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

export default defineConfig({
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/main"),
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    target: "node24",
    lib: {
      entry: path.resolve(import.meta.dirname, "src/preload/preload.ts"),
      formats: ["cjs"],
      fileName: () => "preload.cjs",
    },
    rollupOptions: {
      external: EXTERNAL,
      output: {
        // The whole preload in one file; see the file header.
        inlineDynamicImports: true,
      },
    },
  },
  appType: "custom",
  logLevel: "info",
});
