/**
 * Vitest configuration for the gate self-tests and package unit tests.
 *
 * Gate self-tests live under `scripts/**` and end in `.test.ts`; package unit
 * tests are co-located next to their sources under each package's `src` tree.
 * The fixture trees are deliberately malformed, oversized or cyclic, so they
 * must never be collected as tests; `fixtures/**` is therefore excluded.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts", "packages/*/src/**/*.test.ts"],
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
