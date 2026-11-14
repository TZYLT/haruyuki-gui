/**
 * Build configuration for the main process and the preload script.
 *
 * Both are built here because they share every decision that matters: Node target,
 * external `electron`, CommonJS output, no minification. Splitting them into two
 * configs would duplicate those four choices and let them drift.
 *
 * The renderer is separate (`vite.renderer.mts`) because it is the opposite in all
 * four: browser target, no external, ESM, minified.
 *
 * Decisions that are specific to this side:
 *
 *   `format: "cjs"` and `.cjs` output. The preload runs with `sandbox: true`, which
 *   means no ESM loader and no `require` polyfill beyond what Electron provides. A
 *   `.mjs` preload is silently not loaded under sandbox, which presents as "the
 *   bridge is undefined" rather than as a build error.
 *
 *   `electron` is external. Bundling it would inline the API stubs; the real module
 *   is provided by the runtime.
 *
 *   No minification. A stack trace from a production crash should name the function
 *   it came from, and these files are a few kilobytes.
 */

import { builtinModules } from "node:module";
import path from "node:path";

import { defineConfig } from "vite";

/** Node built-ins plus the Electron module, all provided by the runtime. */
const EXTERNAL = ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

export default defineConfig({
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/main"),
    emptyOutDir: true,
    // Source maps are kept: a production crash report that points at line 1, col 40000
    // is not a crash report.
    sourcemap: true,
    minify: false,
    target: "node24",
    lib: {
      entry: {
        main: path.resolve(import.meta.dirname, "src/main/main.ts"),
        preload: path.resolve(import.meta.dirname, "src/preload/preload.ts"),
      },
      formats: ["cjs"],
      fileName: (_format, entryName) => `${entryName}.cjs`,
    },
    rollupOptions: {
      external: EXTERNAL,
      output: {
        // One file per entry, no shared chunk: the preload and the main process are
        // loaded by different runtimes and a shared chunk between them would be
        // resolvable from one and not the other.
        inlineDynamicImports: false,
        entryFileNames: "[name].cjs",
        chunkFileNames: "chunks/[name]-[hash].cjs",
      },
    },
  },
  // The main process has no `index.html`; without this Vite looks for one.
  appType: "custom",
  logLevel: "info",
});
