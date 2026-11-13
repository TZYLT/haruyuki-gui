/**
 * Test setup for the renderer package.
 *
 * Registered as `test.setupFiles` in `vitest.config.mts`. It does one thing, and
 * that one thing is not optional:
 *
 * @testing-library/react cleans up after each test only when a global `afterEach`
 * exists, which requires `globals: true`. We do not enable globals -- every test
 * imports what it uses, which keeps the origin of `describe` obvious and stops a
 * stray global from masking a missing import. The cost is that auto-cleanup
 * silently stops working, so the DOM accumulates across tests and the second
 * `getByTestId("x")` in a file fails with "found multiple elements".
 *
 * Importing `cleanup` and calling it explicitly restores the behaviour without
 * turning on globals. This file exists so no individual test has to remember it.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
