/**
 * Vitest configuration.
 *
 * Two families of tests exist, and they need different collection rules and a
 * different DOM environment:
 *
 *   scripts/**  the gate self-tests and the gate unit tests. Node environment,
 *               no DOM. The fixture trees next to them are deliberately
 *               malformed, oversized or cyclic, so `fixtures/**` is excluded
 *               explicitly.
 *
 *   packages/*\/src/**  product tests, including the renderer's component tests.
 *               These sit next to their sources. The `src/` segment is part of
 *               the pattern on purpose: it keeps a stray file in a package root
 *               from being collected as a test.
 *
 * Both `.test.ts` and `.test.tsx` are collected: the renderer's component tests
 * are TSX. Keeping that list here and in `scripts/verify.mjs` in sync is the
 * point -- a test file nobody collects is a test file that never fails.
 *
 * `environment` is `node` globally, and a DOM file opts in with a
 * `@vitest-environment jsdom` docblock. That way the gate tests keep running
 * without a DOM and cannot accidentally come to depend on one.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "scripts/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
    ],
    // Renderer tests need an explicit cleanup hook: @testing-library/react only
    // auto-cleans when a global `afterEach` exists, and this config deliberately
    // leaves `globals` off. Without this file the DOM accumulates between tests
    // and a second query for the same test id fails. The setup guards itself, so
    // it is inert for the gate tests that have no DOM.
    setupFiles: ["packages/ui/src/test-setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "fixtures/**",
      "_research/**",
      "docs/**",
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
