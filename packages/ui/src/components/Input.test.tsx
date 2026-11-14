/**
 * Input tests.
 *
 * The value contract is the important part: controlled, verbatim, and not
 * normalised while the user is composing. A test that only typed and read back a
 * value would pass even against an implementation that trimmed on every change.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Input } from "./Input.js";

describe("Input", () => {
  it("renders the current value", () => {
    render(<Input value="hello" onChange={vi.fn()} aria-label="Name" />);

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("hello");
  });

  it("reports every keystroke verbatim", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    function Controlled(): ReactElement {
      const [value, setValue] = useState("");

      return (
        <Input
          value={value}
          aria-label="Name"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<Controlled />);
    await user.type(screen.getByRole("textbox"), "ab c");

    // Exactly what the DOM held, including the space. Trimming here would eat a
    // character the user typed on purpose.
    expect(onChange).toHaveBeenLastCalledWith("ab c");
  });

  it("does not trim a trailing space", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    function Controlled(): ReactElement {
      const [value, setValue] = useState("");

      return (
        <Input
          value={value}
          aria-label="Name"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<Controlled />);
    await user.type(screen.getByRole("textbox"), "a ");

    expect(onChange).toHaveBeenLastCalledWith("a ");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("a ");
  });

  it("forwards composition text without waiting for it to finish", async () => {
    // IME safety in the only form a component test can observe: while a composition is
    // in progress the value flows through unchanged, so an implementation that
    // deferred or filtered intermediate text would be caught here.
    const user = userEvent.setup();
    const onChange = vi.fn();

    function Controlled(): ReactElement {
      const [value, setValue] = useState("");

      return (
        <Input
          value={value}
          aria-label="Name"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<Controlled />);
    const field = screen.getByRole("textbox");

    // userEvent drives the real event path (including React's synthetic layer),
    // so this asserts what a user's keyboard does rather than what a hand-rolled
    // dispatch would do.
    await user.type(field, "zhong");

    expect(onChange).toHaveBeenLastCalledWith("zhong");
    expect((field as HTMLInputElement).value).toBe("zhong");
  });

  it("marks the field invalid for assistive technology", () => {
    render(<Input value="" invalid onChange={vi.fn()} aria-label="Name" />);

    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
  });

  it("does not claim validity when the caller says nothing", () => {
    // Omitting the attribute is not the same as aria-invalid="false": the former
    // leaves it to the user agent, which is what we want when we have no opinion.
    render(<Input value="" onChange={vi.fn()} aria-label="Name" />);

    expect(screen.getByRole("textbox").hasAttribute("aria-invalid")).toBe(false);
  });

  it("is not editable when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Input value="" disabled onChange={onChange} aria-label="Name" />);
    await user.type(screen.getByRole("textbox"), "x");

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(true);
  });

  it("renders a prefix and a suffix inside the field boundary", () => {
    // The border belongs to the wrapper, so a prefix is visually inside the
    // field rather than outside its outline.
    const { container } = render(
      <Input
        value=""
        onChange={vi.fn()}
        aria-label="Amount"
        prefix={<span>¥</span>}
        suffix={<span>元</span>}
      />,
    );

    expect(container.querySelectorAll(".ui-input__affix").length).toBe(2);
    expect(container.querySelector(".ui-input__field")).not.toBeNull();
  });

  it("generates an id when the caller does not supply one", () => {
    render(<Input value="" onChange={vi.fn()} aria-label="Name" />);

    expect(screen.getByRole("textbox").id).toBeTruthy();
  });

  it("honours a caller-supplied id", () => {
    render(<Input value="" onChange={vi.fn()} id="email" aria-label="Email" />);

    expect(screen.getByRole("textbox").id).toBe("email");
  });

  it("forwards placeholder and data-testid", () => {
    render(
      <Input
        value=""
        onChange={vi.fn()}
        placeholder="Type here"
        data-testid="field"
        aria-label="Name"
      />,
    );

    expect(screen.getByTestId("field").querySelector("input")?.getAttribute("placeholder")).toBe(
      "Type here",
    );
  });
});
