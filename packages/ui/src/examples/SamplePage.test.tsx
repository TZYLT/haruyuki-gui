/**
 * Sample page integration tests.
 *
 * The point of these is not to re-test each component -- that is done elsewhere and
 * would be duplicated here. It is to prove the pieces **compose**: one provider
 * drives every component's text, the token sheet is installed once, and nothing in
 * the assembly throws.
 *
 * There is deliberately no height assertion here. jsdom performs no
 * layout, so measuring a height here returns zero for every element and would pass
 * whatever the CSS said. That check belongs in a real browser, which is what
 * the e2e entry is for.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SamplePage } from "./SamplePage.js";

describe("SamplePage", () => {
  it("renders every component family without throwing", () => {
    // If the ten components did not actually compose, this is where it shows.
    expect(() => render(<SamplePage locale="en" />)).not.toThrow();
  });

  it("installs the token and component sheets exactly once", () => {
    render(<SamplePage locale="en" />);

    expect(document.querySelectorAll("#haruyuki-ui-tokens").length).toBe(1);
    expect(document.querySelectorAll("#haruyuki-ui-components").length).toBe(1);
  });

  it("renders in English", () => {
    render(<SamplePage locale="en" />);

    expect(screen.getAllByText("Save").length).toBeGreaterThan(0);
  });

  it("renders in Chinese from the same tree", () => {
    // The same component code, one prop changed. If any text were hard-coded this
    // would still show English.
    render(<SamplePage locale="zh-CN" />);

    expect(screen.getAllByText("保存").length).toBeGreaterThan(0);
    expect(screen.queryByText("Nothing here yet")).toBeNull();
  });

  it("routes every component's text through the provider", () => {
    // Spot-check one string from a component whose text is not passed in as a
    // prop: the alert's dismiss button and the select's placeholder both come
    // from keys, so a missing provider would leave them English.
    render(<SamplePage locale="zh-CN" />);

    expect(screen.getAllByText("请选择").length).toBeGreaterThan(0);
  });

  it("lets a dialog open and close from the page", async () => {
    const user = userEvent.setup();

    render(<SamplePage locale="en" />);

    // The dialog trigger is the only button whose accessible name comes from
    // component.dialog.title; "Confirm" appears on the switch label too, so a
    // name-based query alone would be ambiguous.
    await user.click(screen.getByTestId("open-dialog"));
    expect(await screen.findByRole("dialog")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // The page closes it through the shell's onOpenChange, which is the wiring
    // most likely to be wrong.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps both locales renderable at the same time", () => {
    // The arrangement the provider exists for: a preview beside an editor.
    render(
      <div>
        <div data-testid="left">
          <SamplePage locale="en" />
        </div>
        <div data-testid="right">
          <SamplePage locale="zh-CN" />
        </div>
      </div>,
    );

    const left = screen.getByTestId("left");
    const right = screen.getByTestId("right");

    expect(left.textContent).toContain("Save");
    expect(right.textContent).toContain("保存");
  });
});
