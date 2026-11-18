/**
 * Build configuration for the webview document.
 *
 * The webview is a normal Vite web build rooted at `src/webview/`, the package
 * that declares the dependencies it needs (`react`, `react-dom`) and reaches the
 * shared UI through `@haruyuki/ui`. Nothing is aliased: pnpm's strict layout
 * means a config rooted at the repository root (or in `packages/ui`) resolves
 * neither of those, so the root is the source tree itself.
 *
 * `base` is `"./"` because the panel loads the document through a webview URI
 * rather than from a directory: relative asset URLs resolve against the
 * document's own origin, which is the only origin the extension host controls.
 *
 * The document ships no inline script and no CSP meta tag of its own. The policy
 * is injected by the host side that creates the panel, because that side is the
 * only one that knows the panel's origin and its resource roots; a second copy
 * written here would diverge from it silently.
 */

import path from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/webview"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/webview"),
    emptyOutDir: true,
    // The side a user waits for, and the one whose size the shell budgets.
    minify: true,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(import.meta.dirname, "src/webview/index.html"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  // `warn`, not `info`: `build.mjs` prints every artifact path and its byte
  // count itself, so a second rendering of the same sizes under a different
  // format reads as two numbers for one file. Warnings still reach the log.
  logLevel: "warn",
});
