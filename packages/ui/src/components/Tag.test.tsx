/**
 * Tag tests.
 *
 * The removal control is the part that matters: it must be a real button with a
 * translated accessible name. A clickable span would pass a visual review and
 * fail every keyboard user.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";
import { Tag } from "./Tag.js";

describe("Tag", () => {
  it("renders its text", () => {
    render(<Tag text="TypeScript" />);

    expect(screen.getByText("TypeScript")).toBeDefined();
  });

  it("reflects the tone as a data attribute", () => {
    const { container } = render(<Tag text="Failed" tone="danger" />);

    expect(container.querySelector(".ui-tag")?.getAttribute("data-tone")).toBe("danger");
  });

  it("defaults to the neutral tone", () => {
    const { container } = render(<Tag text="Plain" />);

    expect(container.querySelector(".ui-tag")?.getAttribute("data-tone")).toBe("neutral");
  });

  it("renders no remove button when onClose is absent", () => {
    render(<Tag text="Plain" />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("renders a real button for removal, not a clickable span", () => {
    // A span with onClick looks the same and is invisible to a keyboard.
    render(<Tag text="TypeScript" onClose={vi.fn()} />);

    expect(screen.getByRole("button")).toBeDefined();
  });

  it("gives the remove button a translated accessible name", () => {
    render(
      <LocaleProvider locale="en">
        <Tag text="TypeScript" onClose={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByRole("button", { name: "Remove" })).toBeDefined();
  });

  it("translates the remove label with the active locale", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <Tag text="TypeScript" onClose={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByRole("button", { name: "移除" })).toBeDefined();
  });

  it("calls onClose when the remove button is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<Tag text="TypeScript" onClose={onClose} />);
    await user.click(screen.getByRole("button"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reaches the remove button by keyboard", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<Tag text="TypeScript" onClose={onClose} />);
    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole("button"));
  });

  it("hides no text from a screen reader: the chip text stays readable", () => {
    // The tag text is the content; the icon inside the remove button is
    // decorative and must not replace it.
    render(<Tag text="TypeScript" onClose={vi.fn()} />);

    expect(screen.getByText("TypeScript")).toBeDefined();
  });

  it("forwards data-testid", () => {
    render(<Tag text="TypeScript" data-testid="chip" />);

    expect(screen.getByTestId("chip")).toBeDefined();
  });
});
