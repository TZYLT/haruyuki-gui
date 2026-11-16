/**
 * The crash page: what it parses, what it shows, and what it sends.
 *
 * The page is the renderer half of a route main builds by reloading the window, so
 * every test starts from a URL rather than from props. The bridge is a fake with the
 * one member the page uses; there is no Electron here, which is the same seam the
 * preload exists to provide.
 *
 * Appearance is not asserted. `ErrorState` and `Button` have their own tests; the
 * assertions here are about facts the user must be able to read and actions they
 * must be able to take.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "@haruyuki/ui";

import { CrashPage, parseCrashParams } from "../crash-page.js";

/** The channels under test, spelled out so a rename is a visible test change. */
const EXPORT_CHANNEL = "bridge:control.diagnostics.export";
const RELAUNCH_CHANNEL = "bridge:control.diagnostics.relaunch";
const QUIT_CHANNEL = "bridge:control.diagnostics.quit";

/** The one member of the preload this page calls. */
interface FakeBridge {
  invoke: ReturnType<typeof vi.fn>;
}

/**
 * Install a fake bridge that resolves like main's handlers do.
 *
 * @returns the recording bridge
 */
function installBridge(): FakeBridge {
  const invoke = vi.fn(() => Promise.resolve({ ok: true }));

  setBridge({ invoke });

  return { invoke };
}

/**
 * Put a bridge on the window, or remove the one a previous test left.
 *
 * @param bridge the fake, or `null` to simulate a preload that failed to load
 */
function setBridge(bridge: FakeBridge | null): void {
  const target = window as unknown as { haruyuki?: FakeBridge };

  if (bridge === null) {
    delete target.haruyuki;

    return;
  }

  target.haruyuki = bridge;
}

/**
 * Point the document at a crash route before rendering.
 *
 * @param search the query string, with or without its leading `?`
 */
function setUrl(search: string): void {
  window.history.replaceState(null, "", search === "" ? "/" : `/${search}`);
}

/** Render the page in English, the catalogue the assertions quote. */
function renderPage(): void {
  render(
    <LocaleProvider locale="en">
      <CrashPage />
    </LocaleProvider>,
  );
}

afterEach(() => {
  setBridge(null);
  setUrl("");
});

describe("parseCrashParams", () => {
  it("reads an engine exit code and signal", () => {
    expect(parseCrashParams("?crash=engine&code=1&signal=SIGKILL")).toEqual({
      kind: "engine",
      reason: null,
      signal: "SIGKILL",
      exitCode: 1,
    });
  });

  it("reads a renderer reason and exit code", () => {
    expect(parseCrashParams("?crash=renderer&reason=crashed&code=2")).toEqual({
      kind: "renderer",
      reason: "crashed",
      signal: null,
      exitCode: 2,
    });
  });

  it("accepts the exitCode spelling as well as the helper's code", () => {
    expect(parseCrashParams("?crash=renderer&reason=oom&exitCode=137")?.exitCode).toBe(137);
  });

  it("treats an unknown kind, an empty query and a bad code as unusable", () => {
    expect(parseCrashParams("?crash=ui")).toBeNull();
    expect(parseCrashParams("")).toBeNull();
    expect(parseCrashParams("?crash=engine&code=not-a-number")?.exitCode).toBeNull();
  });
});

describe("CrashPage", () => {
  it("shows an engine crash with its exit code and signal", () => {
    setUrl("?crash=engine&code=1&signal=SIGKILL");
    renderPage();

    expect(screen.getByText("The engine stopped unexpectedly")).toBeDefined();
    expect(screen.getByText(/exit code 1|exited with code 1/)).toBeDefined();
    expect(screen.getByText(/SIGKILL/)).toBeDefined();
  });

  it("shows a renderer crash with its reason and exit code", () => {
    setUrl("?crash=renderer&reason=crashed&code=2");
    renderPage();

    expect(screen.getByText("The interface stopped")).toBeDefined();
    expect(screen.getByText(/crashed/)).toBeDefined();
    expect(screen.getByText(/exit code 2/)).toBeDefined();
  });

  it("says a missing field was not reported instead of showing an empty slot", () => {
    setUrl("?crash=renderer&reason=crashed");
    renderPage();

    expect(screen.getByText(/not reported/)).toBeDefined();
  });

  it("falls back to the generic message for an unrecognised route", () => {
    setUrl("?crash=unknown");
    renderPage();

    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(screen.getByText(/Exporting a diagnostics bundle/)).toBeDefined();
  });

  it("sends the three actions on their own channels", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();

    setUrl("?crash=engine&code=1");
    renderPage();

    await user.click(screen.getByRole("button", { name: "Export diagnostics" }));
    await user.click(screen.getByRole("button", { name: "Restart application" }));
    await user.click(screen.getByRole("button", { name: "Quit application" }));

    expect(bridge.invoke).toHaveBeenNthCalledWith(1, EXPORT_CHANNEL, {
      kind: "open",
      sessionAvailable: false,
    });
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, RELAUNCH_CHANNEL);
    expect(bridge.invoke).toHaveBeenNthCalledWith(3, QUIT_CHANNEL);
  });

  it("shows a readable error when the bridge is absent, and does not throw", async () => {
    const user = userEvent.setup();

    setUrl("?crash=engine&code=1");
    renderPage();

    await user.click(screen.getByRole("button", { name: "Export diagnostics" }));

    expect(
      screen.getByText("The diagnostics bridge is unavailable, so this action cannot run."),
    ).toBeDefined();
  });

  it("shows a readable error when an action is refused", async () => {
    const invoke = vi.fn(() => Promise.reject(new Error("BRIDGE_CHANNEL_DENIED")));
    const user = userEvent.setup();

    setBridge({ invoke });
    setUrl("?crash=engine&code=1");
    renderPage();

    await user.click(screen.getByRole("button", { name: "Quit application" }));
    await Promise.resolve();

    expect(
      await screen.findByText("The diagnostics bridge is unavailable, so this action cannot run."),
    ).toBeDefined();
  });
});
