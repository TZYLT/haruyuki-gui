// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";
import { TopBar } from "./TopBar.js";

/** @param overrides props to merge @returns the rendered top bar */
function view(overrides: Partial<React.ComponentProps<typeof TopBar>> = {}) {
  return render(
    <LocaleProvider locale="en">
      <TopBar hasSettings={false} hasUpdates={false} {...overrides} />
    </LocaleProvider>,
  );
}

describe("TopBar", () => {
  it("hides settings and updates when their targets are absent", () => {
    view();

    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  });

  it("shows the software actions that have a target", () => {
    view({
      hasSettings: true,
      hasUpdates: true,
      onOpenSettings: vi.fn(),
      onCheckUpdates: vi.fn(),
      onExportDiagnostics: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export diagnostics" })).toBeTruthy();
  });

  it("offers no about entry of its own", async () => {
    // The requirement names one way into the about window, and it is the Help
    // menu's item that opens the real, read-only window. This bar also had one -
    // a dialog showing a version and nothing else - so two entries led to two
    // different answers under the same name. A user found the thin one first and
    // reported the build as broken, which from where they stood it was.
    view({ onResetLayout: () => undefined });

    await userEvent.click(screen.getByRole("button", { name: "Help" }));

    expect(screen.queryByRole("menuitem", { name: "About" })).toBeNull();
  });

  it("routes edit actions and closes the menu", async () => {
    const onEditAction = vi.fn();
    view({ onEditAction });

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Undo" }));

    expect(onEditAction).toHaveBeenCalledWith("undo");
    expect(screen.queryByRole("menuitem", { name: "Undo" })).toBeNull();
  });
});
