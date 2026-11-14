/**
 * Switch tests.
 *
 * The behaviour worth testing is not this package's: base-ui owns the keyboard
 * handling and the hidden input. What is tested here is that our wiring keeps
 * those properties intact -- a wrapper that swallowed the click or lost the label
 * would break a control that base-ui got right.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Switch } from "./Switch.js";

describe("Switch", () => {
  it("exposes the switch role with its label as the accessible name", () => {
    render(<Switch checked={false} onChange={vi.fn()} label="Enable sync" />);

    expect(screen.getByRole("switch", { name: "Enable sync" })).toBeDefined();
  });

  it("reports the checked state", () => {
    render(<Switch checked onChange={vi.fn()} label="Enable sync" />);

    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("reports the unchecked state", () => {
    render(<Switch checked={false} onChange={vi.fn()} label="Enable sync" />);

    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("asks the caller to turn itself on when clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Switch checked={false} onChange={onChange} label="Enable sync" />);
    await user.click(screen.getByRole("switch"));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("asks the caller to turn itself off when clicked while on", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Switch checked onChange={onChange} label="Enable sync" />);
    await user.click(screen.getByRole("switch"));

    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("stays controlled: it does not flip itself", async () => {
    // The whole point of a controlled component. If the switch changed its own
    // state, the caller's value and the rendered value would disagree.
    const user = userEvent.setup();

    render(<Switch checked={false} onChange={vi.fn()} label="Enable sync" />);
    await user.click(screen.getByRole("switch"));

    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("toggles from the keyboard", async () => {
    // Base UI owns this; the test exists so a wrapper change cannot quietly
    // break keyboard access.
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Switch checked={false} onChange={onChange} label="Enable sync" />);
    await user.tab();
    await user.keyboard(" ");

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not respond when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Switch checked={false} disabled onChange={onChange} label="Enable sync" />);
    await user.click(screen.getByRole("switch"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("lets the label text toggle the switch", async () => {
    // A label beside a control is part of the control as far as a user is
    // concerned; a click on it that does nothing reads as broken.
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Switch checked={false} onChange={onChange} label="Enable sync" />);
    await user.click(screen.getByText("Enable sync"));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("merges a caller className", () => {
    const { container } = render(
      <Switch checked={false} onChange={vi.fn()} label="Enable sync" className="caller" />,
    );

    expect(container.querySelector('[role="switch"]')?.getAttribute("class")).toContain("caller");
  });
});
