/**
 * Vitest configuration for the gate self-tests       .
 *
 * Only the gate self-tests live under `scripts/**` and end in `.test.ts`. The
 * fixture trees are deliberately malformed, oversized or cyclic, so they must
 * never be collected as tests; `fixtures/**` is therefore excluded explicitly.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts"],
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
