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
      <TopBar version="1.2.3" hasSettings={false} hasUpdates={false} {...overrides} />
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

  it("routes edit actions and closes the menu", async () => {
    const onEditAction = vi.fn();
    view({ onEditAction });

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Undo" }));

    expect(onEditAction).toHaveBeenCalledWith("undo");
    expect(screen.queryByRole("menuitem", { name: "Undo" })).toBeNull();
  });

  it("opens the about dialog with the version", async () => {
    view();

    await userEvent.click(screen.getByRole("button", { name: "Help" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "About" }));

    expect(await screen.findByText("Version 1.2.3")).toBeTruthy();
  });
});
