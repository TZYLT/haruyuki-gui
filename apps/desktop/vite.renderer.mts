/**
 * Build configuration for the renderer.
 *
 * The renderer is a normal Vite web build with two differences:
 *
 *   It lives in `apps/desktop/src/renderer/`, not in `packages/ui`. The build entry
 *   has to sit inside the package that declares the dependencies it needs: `react`
 *   and `react-dom` are declared by `apps/desktop`, and pnpm's strict layout means a
 *   config rooted at the repository (or in `packages/ui`) resolves neither. The
 *   route document records this as D1-R02, with the corrected reason.
 *
 *   The output is loaded over `app://`, not `file://`. That is why `base` is `"./"`
 *   -- relative asset URLs, resolved against the protocol's origin rather than
 *   against a directory that does not exist -- and why the built HTML must not
 *   contain an inline script.
 */

import path from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/renderer"),
  // Assets are addressed relative to the document, which the app:// handler serves.
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    // The renderer is the only side that gets minified: it is the side a user waits
    // for, and the side whose size the CSP and the cold-start budget are stated in.
    minify: true,
    sourcemap: true,
    // Chromium is fixed by the Electron pin, so the target can be stated exactly
    // rather than guessed at from a browser-support matrix.
    target: "chrome156",
    rollupOptions: {
      // Two documents, two entries: the shell's page and the about window's.
      // Separate entries rather than one page with a route, because the two are
      // loaded into different windows and either must work with the other closed.
      // Both are ordinary bundler inputs, so they share nothing but chunks.
      input: {
        index: path.resolve(import.meta.dirname, "src/renderer/index.html"),
        about: path.resolve(import.meta.dirname, "src/renderer/about.html"),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  logLevel: "info",
});
