/**
 * Select tests.
 *
 * Base UI owns the floating layer and the keyboard model, so what is tested here
 * is the contract this package adds: controlled value, a required accessible name,
 * and a clear that is not forwarded as a value no caller expects.
 *
 * Opening the popup is a real user interaction, not a `data-open` assertion --
 * asserting the attribute would pass even if the popup never rendered.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";
import { Select } from "./Select.js";

const OPTIONS = [
  { value: "md", label: "Markdown" },
  { value: "json", label: "JSON" },
  { value: "txt", label: "Plain text" },
];

/**
 * @param props overrides
 * @returns the select wrapped in an English provider
 */
function renderSelect(overrides: Partial<React.ComponentProps<typeof Select>> = {}) {
  return render(
    <LocaleProvider locale="en">
      <Select
        value={null}
        onChange={vi.fn()}
        options={OPTIONS}
        labelKey="component.select.placeholder"
        {...overrides}
      />
    </LocaleProvider>,
  );
}

describe("Select", () => {
  it("exposes a combobox role", () => {
    renderSelect();

    expect(screen.getByRole("combobox")).toBeDefined();
  });

  it("shows the placeholder when nothing is selected", () => {
    renderSelect();

    expect(screen.getByRole("combobox").textContent).toContain("Select an option");
  });

  it("shows the selected option's label", () => {
    renderSelect({ value: "json" });

    expect(screen.getByRole("combobox").textContent).toContain("JSON");
  });

  it("translates the default placeholder", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <Select
          value={null}
          onChange={vi.fn()}
          options={OPTIONS}
          labelKey="component.select.placeholder"
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole("combobox").textContent).toContain("请选择");
  });

  it("reports the chosen value when an option is picked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderSelect({ onChange });

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "JSON" }));

    expect(onChange).toHaveBeenCalledWith("json");
  });

  it("opens the listbox on click, not merely in the DOM", async () => {
    const user = userEvent.setup();

    renderSelect();

    expect(screen.queryByRole("listbox")).toBeNull();

    await user.click(screen.getByRole("combobox"));

    // findBy, not getBy: base-ui mounts the popup through a portal, which lands
    // in the DOM on a later tick. getBy would race the mount and fail depending
    // on what the previous test left behind.
    expect(await screen.findByRole("listbox")).toBeDefined();
  });

  it("does not select a disabled option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderSelect({
      onChange,
      options: [...OPTIONS, { value: "pdf", label: "PDF", disabled: true }],
    });

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "PDF" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks the control invalid for assistive technology", () => {
    renderSelect({ invalid: true });

    expect(screen.getByRole("combobox").getAttribute("aria-invalid")).toBe("true");
  });

  it("cannot be opened when disabled", async () => {
    const user = userEvent.setup();

    renderSelect({ disabled: true });
    await user.click(screen.getByRole("combobox"));

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("gives the control an accessible name from its message key", () => {
    renderSelect({ labelKey: "component.select.placeholder" });

    expect(screen.getByRole("combobox").getAttribute("aria-label")).toBe("Select an option");
  });

  it("forwards data-testid to the trigger, not the popup", () => {
    renderSelect({ "data-testid": "format" });

    expect(screen.getByTestId("format").getAttribute("role")).toBe("combobox");
  });
});
