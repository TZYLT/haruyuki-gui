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
 *   packages/** product tests, including the renderer. These need a DOM; jsdom
 *               is selected per file with a `@vitest-environment jsdom` docblock
 *               rather than globally, so the gate tests keep running without a
 *               DOM and cannot accidentally depend on one.
 *
 * Both extensions `.test.ts` and `.test.tsx` are collected: the renderer's
 * component tests are TSX. Keeping that list here and in `scripts/verify.mjs`
 * in sync is the point  - a test file nobody collects is a test file
 * that never fails.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts", "packages/**/*.test.ts", "packages/**/*.test.tsx"],
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
