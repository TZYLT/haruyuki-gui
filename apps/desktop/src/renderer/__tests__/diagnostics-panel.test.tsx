/**
 * The diagnostics panel: what it sends, what it shows, and what it does without a bridge.
 *
 * The panel is the user-facing half of a channel with two directions, so every test
 * drives one direction: a click sends a request, an event from main changes the panel.
 * There is no Electron here -- the bridge is a fake with the same two members, which is
 * exactly the seam the preload exists to provide.
 *
 * Appearance is not asserted. The dialog, alert and button are the library's, and their
 * tests already cover what they look like; asserting classes here would be a second,
 * disagreeing copy.
 */

// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "@haruyuki/ui";

import {
  DiagnosticsPanel,
  type DiagnosticsBridge,
  type DiagnosticsPanelProps,
} from "../diagnostics-panel.js";

/** The channel under test, spelled out so a rename is a visible test change. */
const EXPORT_CHANNEL = "bridge:control.diagnostics.export";

/** A fake preload surface plus the two handles a test needs on it. */
interface FakeBridge {
  invoke: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  /** Deliver one main-to-renderer message to the panel's listener. */
  emit: (payload: unknown) => void;
}

/**
 * Install a fake `window.haruyuki` that records calls and lets a test push events.
 *
 * @returns the recording bridge
 */
function installBridge(): FakeBridge {
  const unsubscribe = vi.fn();
  let listener: (payload: unknown) => void = () => undefined;

  const invoke = vi.fn(() => Promise.resolve({ ok: true }));
  const on = vi.fn((_channel: string, next: (payload: unknown) => void) => {
    listener = next;

    return unsubscribe;
  });

  setBridge({ invoke, on });

  return {
    invoke,
    unsubscribe,
    emit: (payload) => {
      listener(payload);
    },
  };
}

/**
 * Put a bridge on the window, or remove the one a previous test left.
 *
 * The cast is the test's way in: the renderer declares only the members it calls, and
 * the fake is installed through that narrowing rather than instead of it.
 *
 * @param bridge the fake, or `null` to simulate a preload that failed to load
 */
function setBridge(bridge: DiagnosticsBridge | null): void {
  const target = window as unknown as { haruyuki?: DiagnosticsBridge };

  if (bridge === null) {
    delete target.haruyuki;

    return;
  }

  target.haruyuki = bridge;
}

/**
 * Render the panel in English, open unless a test says otherwise.
 *
 * @param props overrides
 * @returns the render result
 */
function renderPanel(props: Partial<DiagnosticsPanelProps> = {}) {
  return render(
    <LocaleProvider locale="en">
      <DiagnosticsPanel initialOpen {...props} />
    </LocaleProvider>,
  );
}

/**
 * @param name accessible-name pattern
 * @returns the checkbox input
 */
function checkbox(name: RegExp): HTMLInputElement {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

afterEach(() => {
  setBridge(null);
});

describe("DiagnosticsPanel", () => {
  it("starts with both options unchecked and sends the default pair", async () => {
    // `32` section 4.8: the default bundle carries neither session content nor a
    // minidump, so the two unchecked boxes are the contract, not a coincidence.
    const bridge = installBridge();
    const user = userEvent.setup();

    renderPanel();

    expect(checkbox(/most recent 200 messages/).checked).toBe(false);
    expect(checkbox(/crash dump/).checked).toBe(false);

    await user.click(screen.getByRole("button", { name: "Export" }));

    expect(bridge.invoke).toHaveBeenCalledWith(EXPORT_CHANNEL, {
      kind: "start",
      options: { includeSessionContent: false, includeMinidump: false },
    });
  });

  it("sends the options the user ticked", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();

    renderPanel();

    await user.click(checkbox(/most recent 200 messages/));
    await user.click(checkbox(/crash dump/));
    await user.click(screen.getByRole("button", { name: "Export" }));

    expect(bridge.invoke).toHaveBeenCalledWith(EXPORT_CHANNEL, {
      kind: "start",
      options: { includeSessionContent: true, includeMinidump: true },
    });
  });

  it("shows progress and disables the options while an export runs", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();

    renderPanel();

    await user.click(screen.getByRole("button", { name: "Export" }));

    act(() => {
      bridge.emit({ kind: "progress", phase: "compress", done: 3, total: 10 });
    });

    expect(screen.getByText("Compressing the bundle")).toBeDefined();
    expect(screen.getByText("Working: 3 of 10")).toBeDefined();

    const bar = screen.getByRole("progressbar");

    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(checkbox(/most recent 200 messages/).disabled).toBe(true);
    expect(checkbox(/crash dump/).disabled).toBe(true);
  });

  it("shows the path and size of the bundle main wrote", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();

    renderPanel();

    await user.click(screen.getByRole("button", { name: "Export" }));

    act(() => {
      bridge.emit({
        kind: "done",
        path: "C:/Users/example/Downloads/haruyuki-diagnostics.zip",
        bytes: 2048,
        omitted: [],
      });
    });

    expect(screen.getByText(/Exported to .*haruyuki-diagnostics\.zip.*2048 bytes/)).toBeDefined();
  });

  it("shows a readable failure and lets the user retry", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();

    renderPanel();

    await user.click(screen.getByRole("button", { name: "Export" }));

    act(() => {
      bridge.emit({ kind: "failed", code: "DIAGNOSTIC_EXPORT_FAILED", detail: "the disk is full" });
    });

    expect(screen.getByText("Export failed")).toBeDefined();
    expect(screen.getByText("the disk is full")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(bridge.invoke).toHaveBeenCalledTimes(2);
    expect(bridge.invoke).toHaveBeenLastCalledWith(EXPORT_CHANNEL, {
      kind: "start",
      options: { includeSessionContent: false, includeMinidump: false },
    });
  });

  it("asks main to cancel and returns to idle on the terminal event", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();

    renderPanel();

    await user.click(screen.getByRole("button", { name: "Export" }));

    act(() => {
      bridge.emit({ kind: "progress", phase: "collect", done: 1, total: 4 });
    });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(bridge.invoke).toHaveBeenLastCalledWith(EXPORT_CHANNEL, { kind: "cancel" });

    act(() => {
      bridge.emit({ kind: "cancelled" });
    });

    expect(screen.queryByText(/Working:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Export" })).toBeDefined();
    expect(checkbox(/crash dump/).disabled).toBe(false);
  });

  it("opens on the open event and tells the truth about the session", async () => {
    // A direct load has no session fact, so the note must not appear until main says
    // there is nothing to include.
    const bridge = installBridge();

    render(
      <LocaleProvider locale="en">
        <DiagnosticsPanel sessionAvailable />
      </LocaleProvider>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("No active session")).toBeNull();

    act(() => {
      bridge.emit({ kind: "open", sessionAvailable: false });
    });

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("No active session")).toBeDefined();
    expect(screen.getByText(/empty placeholder/)).toBeDefined();
  });

  it("unsubscribes when it unmounts", () => {
    const bridge = installBridge();
    const view = renderPanel();

    expect(bridge.unsubscribe).not.toHaveBeenCalled();

    view.unmount();

    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reports a missing bridge instead of throwing", async () => {
    setBridge(null);

    expect(() => renderPanel()).not.toThrow();

    expect(
      await screen.findByText(
        "The diagnostics bridge is unavailable, so the bundle cannot be exported",
      ),
    ).toBeDefined();

    // Export cannot work without the bridge, and a button that looks available and
    // does nothing is worse than one that says so.
    expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
