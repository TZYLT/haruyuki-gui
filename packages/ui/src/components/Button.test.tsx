/**
 * Button tests.
 *
 * Behaviour and accessibility only. Appearance is asserted through `data-`
 * attributes rather than computed styles, because jsdom performs no layout: a
 * test that read a computed padding would be reading the token string back and
 * proving nothing about what a browser draws.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./Button.js";

describe("Button", () => {
  it("renders its label as the accessible name", () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("defaults to type=button so it cannot submit a form by accident", () => {
    // The single most common HTML footgun: a button inside a form submits it
    // unless told otherwise.
    const { container } = render(<Button>Save</Button>);

    expect(container.querySelector("button")?.getAttribute("type")).toBe("button");
  });

  it("lets a caller opt into submit", () => {
    const { container } = render(<Button type="submit">Save</Button>);

    expect(container.querySelector("button")?.getAttribute("type")).toBe("submit");
  });

  it("calls onClick when pressed", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole("button"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is not clickable when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    await user.click(screen.getByRole("button"));

    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });

  it("refuses clicks while loading and says so to assistive technology", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button");

    await user.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("reflects the variant and size as data attributes, not classes", () => {
    // A consumer's own class must not be able to select a variant by accident.
    const { container } = render(
      <Button variant="danger" size="sm">
        Delete
      </Button>,
    );
    const button = container.querySelector("button");

    expect(button?.getAttribute("data-variant")).toBe("danger");
    expect(button?.getAttribute("data-size")).toBe("sm");
  });

  it("merges a caller className with its own", () => {
    const { container } = render(<Button className="caller">Save</Button>);

    expect(container.querySelector("button")?.getAttribute("class")).toBe("ui-button caller");
  });

  it("forwards data-testid", () => {
    render(<Button data-testid="save-button">Save</Button>);

    expect(screen.getByTestId("save-button")).toBeDefined();
  });

  it("renders icons on both sides without changing the accessible name", () => {
    // Icons are decorative here: the label already names the button, so an
    // announced icon would make the name read twice.
    render(
      <Button iconLeft="add" iconRight="chevronDown">
        Add
      </Button>,
    );

    expect(screen.getByRole("button", { name: "Add" })).toBeDefined();
  });

  it("is reachable by keyboard", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(<Button onClick={onClick}>Save</Button>);
    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole("button"));

    await user.keyboard("{Enter}");

    expect(onClick).toHaveBeenCalled();
  });

  it("injects its stylesheet exactly once across many renders", () => {
    render(
      <div>
        <Button>One</Button>
        <Button>Two</Button>
        <Button>Three</Button>
      </div>,
    );

    expect(document.querySelectorAll("#haruyuki-ui-components").length).toBe(1);
    expect(document.querySelectorAll("#haruyuki-ui-tokens").length).toBe(1);
  });
});
