/**
 * Test setup for the renderer package.
 *
 * Registered as `test.setupFiles` in `vitest.config.mts`. It runs for **every**
 * test file in the repository, including the gate tests under `scripts/**`, which
 * are plain Node with no DOM at all. So the first thing it does is check whether a
 * document exists -- an unguarded `document.body` access here fails 38 tests that
 * have nothing to do with the DOM.
 *
 * Two jobs for the files that do have a document, and the second one was
 * discovered the hard way.
 *
 * 1. **Cleanup.** `@testing-library/react` only auto-cleans when a global
 *    `afterEach` exists, which requires `globals: true`. We do not enable globals
 *    -- every test imports what it uses -- so auto-cleanup silently does nothing
 *    and the DOM accumulates. Calling `cleanup()` explicitly restores it.
 *
 * 2. **Detached portals.** `cleanup()` unmounts the React tree, but a component
 *    that portals its popup -- a dialog, a select -- leaves those nodes behind,
 *    because they were never children of the container `cleanup()` removes. The
 *    leftover nodes are not inert: a stale `[role="listbox"]` makes the next
 *    test's `queryByRole("listbox")` return a node before anything opened it, so
 *    the test fails, or worse, passes for the wrong reason.
 *
 * Emptying `body` after cleanup is therefore not tidiness, it is correctness.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/** Whether this test file has a DOM. Gate tests under `scripts/**` do not. */
const HAS_DOM = typeof document !== "undefined";

afterEach(() => {
  if (!HAS_DOM) return;

  cleanup();

  // Removing the container's children is not enough: a portal mounts beside the
  // container, not inside it.
  document.body.replaceChildren();
});
