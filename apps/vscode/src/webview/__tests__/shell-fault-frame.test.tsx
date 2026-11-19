/** @vitest-environment jsdom */
/**
 * The frame survives a fault.
 *
 * The rule this asserts is that a fault covers the status area and does not
 * replace the workspace: the frame is rendered either way, and the layout
 * document it was handed is neither reset nor dropped. That distinction is the
 * whole reason the fault page is composed beside the frame instead of being
 * returned in its place -- a reconnect that found an empty workspace would be a
 * shell that threw the user's arrangement away to show an error.
 *
 * Mounted through the real entry, so the registry and the frame are the ones the
 * panel actually builds. A stand-in registry here would prove the composition in
 * a tree that never runs.
 */

import { waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/** A no-op observer: jsdom never resizes anything, so nothing has to fire. */
class StubResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  Reflect.set(globalThis, "ResizeObserver", StubResizeObserver);
});

/** Teardown of every tree or container a case created, run in `afterEach`. */
const mounted: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
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

/**
 * Announce the shell, so the panel has a bridge to read a phase from.
 *
 * The entry mounts on import and the transport attaches its listener then, so the
 * handshake has to be dispatched after that; every case awaits the frame first
 * and posts this second.
 */
async function announce(): Promise<void> {
  const { WEBVIEW_BRIDGE_VERSION } = await import("../bridge.js");

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        kind: "boot",
        appVersion: "1.0.0",
        bridgeVersion: WEBVIEW_BRIDGE_VERSION,
        frameProtocolVersion: 1,
      },
    }),
  );
}

/**
 * Report one status, as the host does.
 *
 * @param phase the phase to report
 * @param failure the failure to carry, when the phase is a refusal
 */
function report(phase: string, failure?: unknown): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: failure === undefined ? { kind: "status", phase } : { kind: "status", phase, failure },
    }),
  );
}

describe("the fault page and the frame", () => {
  it("keeps the frame mounted while the fault is shown", async () => {
    const container = createRootContainer();

    // The entry mounts itself into this container on import and keeps no unmount
    // handle, so the container is what a later case can clean up.
    mounted.push(() => container.remove());

    await import("../main.js");

    // The frame first: the mount is asynchronous, and the assertion below is
    // about both being present at once.
    await waitFor(() => {
      expect(container.querySelector(".hz-frame")).not.toBeNull();
    });

    await announce();
    report("failed", {
      kind: "missing-engine",
      detail: "no engine to start",
      searchedPaths: ["/opt/haruyuki"],
    });

    // Both at once: the page says what is wrong and the workspace is still
    // underneath it, not replaced by the message.
    await waitFor(() => {
      expect(container.querySelector(".hz-frame")).not.toBeNull();
      expect(container.querySelector("[data-testid='shell-fault']")).not.toBeNull();
    });

    // And the pages the frame was holding are still in the document, which is
    // what "the layout was not reset" means to a user.
    expect(container.textContent).toContain("Conversation");
  });

  it("shows no page while the shell is running", async () => {
    // `mountWebview` rather than the module's own bootstrap: the entry mounts
    // into `#root` on first import only, and a second case re-importing it would
    // find the cached module and an empty container. The extra root below is
    // there because that first import bootstraps and throws without one when
    // this case runs on its own.
    const bootRoot = createRootContainer();

    mounted.push(() => bootRoot.remove());

    const { mountWebview } = await import("../main.js");
    const container = createRootContainer();
    const unmount = mountWebview(container);

    mounted.push(() => {
      unmount();
      container.remove();
    });

    await waitFor(() => {
      expect(container.querySelector(".hz-frame")).not.toBeNull();
    });

    await announce();

    // The transport is a module singleton, so an earlier case may have left a
    // failure behind. Start from a running shell, then make this case's own
    // fault: asking only that no page is shown at the end would also pass when
    // no page could have been shown at all.
    report("ready");

    await waitFor(() => {
      expect(container.querySelector("[data-testid='shell-fault']")).toBeNull();
    });

    report("failed", { kind: "missing-engine", detail: "no engine to start" });

    await waitFor(() => {
      expect(container.querySelector("[data-testid='shell-fault']")).not.toBeNull();
    });

    report("ready");

    // A page that stayed after the shell recovered would be a page nobody can
    // dismiss.
    await waitFor(() => {
      expect(container.querySelector("[data-testid='shell-fault']")).toBeNull();
    });
  });
});
