/** @vitest-environment jsdom */
/**
 * The webview entry, mounted in a DOM.
 *
 * These tests load the real entry module rather than reimplementing what it
 * does, because the entry's whole job is the mount: importing it has to leave a
 * rendered tree in `#root`, and the only way to know that is to let it run.
 *
 * jsdom gaps are filled here rather than in the source. `ResizeObserver` is the
 * one the dock needs and jsdom does not implement; a source-side polyfill would
 * ship a stub into the webview, which already has the real one.
 */

import { waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

/** A no-op observer: jsdom never resizes anything, so nothing has to fire. */
class StubResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  Reflect.set(globalThis, "ResizeObserver", StubResizeObserver);
});

/**
 * Put a `#root` in the document, the way the HTML template does.
 *
 * @returns the container
 */
function createRootContainer(): HTMLElement {
  const container = document.createElement("div");

  container.id = "root";
  document.body.append(container);

  return container;
}

describe("webview entry", () => {
  it("renders a frame with pages into #root", async () => {
    const container = createRootContainer();

    // The module mounts on import, which is the behaviour under test.
    await import("../main.js");

    // Every claim is a condition to wait for, not an assumption to assert after
    // one. The dock mounts asynchronously: the frame element and its rail labels
    // appear before the page tabs do, so a wait on "something rendered" resolves
    // on a tree that has not drawn the pages yet. Waiting on the last thing that
    // appears is waiting on the mount; waiting on the first is waiting on a
    // coincidence, and under a loaded runner the coincidence goes the other way.
    await waitFor(() => {
      // A wrapper alone is not a mount: the frame has to hold the sample pages.
      expect(container.querySelector(".hz-frame")).not.toBeNull();
      expect(container.textContent).toContain("Conversation");
      expect(container.textContent).toContain("Navigation");
      expect(container.textContent).toContain("Files");
    });
  });

  it("mountWebview mounts into any container and unmounts cleanly", async () => {
    const { mountWebview } = await import("../main.js");
    const container = document.createElement("div");

    document.body.append(container);

    const unmount = mountWebview(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Files");
    });

    unmount();
    expect(container.childElementCount).toBe(0);
  });
});
