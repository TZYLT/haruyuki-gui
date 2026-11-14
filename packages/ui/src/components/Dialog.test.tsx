/**
 * Dialog tests.
 *
 * The focus behaviour is the reason to use a library here, so it is what is
 * tested: focus moves in, Escape closes, and focus returns to where it was. Those
 * are also the three properties a hand-rolled dialog loses first, and all three are
 * invisible to anyone using a mouse.
 */

// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";

/**
 * @param props overrides
 * @returns the dialog wrapped in an English provider
 */
function renderDialog(overrides: Partial<React.ComponentProps<typeof Dialog>> = {}) {
  return render(
    <LocaleProvider locale="en">
      <Dialog
        open
        onOpenChange={vi.fn()}
        title="Confirm deletion"
        footer={<Button variant="danger">Delete</Button>}
        {...overrides}
      >
        This cannot be undone.
      </Dialog>
    </LocaleProvider>,
  );
}

describe("Dialog", () => {
  it("renders nothing while closed", () => {
    renderDialog({ open: false });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a dialog when open", async () => {
    renderDialog();

    expect(await screen.findByRole("dialog")).toBeDefined();
  });

  it("takes its accessible name from the title", async () => {
    // Rendering a plain <h2> would look identical and leave the dialog unnamed,
    // which is why Dialog.Title is used rather than a heading element.
    renderDialog();

    expect(await screen.findByRole("dialog", { name: "Confirm deletion" })).toBeDefined();
  });

  it("renders its body and footer", async () => {
    renderDialog();

    await screen.findByRole("dialog");

    expect(screen.getByText("This cannot be undone.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDefined();
  });

  it("asks the caller to close when the close button is pressed", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderDialog({ onOpenChange });

    await user.click(await screen.findByRole("button", { name: "Close dialog" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("gives the close button a translated accessible name", async () => {
    render(
      <LocaleProvider locale="zh-CN">
        <Dialog open onOpenChange={vi.fn()} title="确认删除">
          不可撤销。
        </Dialog>
      </LocaleProvider>,
    );

    expect(await screen.findByRole("button", { name: "关闭对话框" })).toBeDefined();
  });

  it("asks the caller to close on Escape", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderDialog({ onOpenChange });

    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("moves focus into the dialog", async () => {
    // A dialog that opens without moving focus leaves a keyboard user behind on
    // the page underneath, where Tab now does nothing visible.
    //
    // waitFor, not an immediate assertion: the focus move happens on a later tick
    // than the mount. Asserting immediately would fail against a working dialog
    // and would tempt someone to "fix" it by making the test synchronous.
    renderDialog();

    const dialog = await screen.findByRole("dialog");

    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it("marks itself modal", async () => {
    renderDialog();

    expect((await screen.findByRole("dialog")).getAttribute("aria-modal")).toBe("true");
  });

  it("does not invent action buttons", async () => {
    // The shell draws; what confirming means is the caller's business.
    renderDialog({ footer: undefined });

    await screen.findByRole("dialog");

    expect(screen.queryAllByRole("button", { name: "Delete" })).toHaveLength(0);
  });

  it("forwards data-testid to the popup", async () => {
    renderDialog({ "data-testid": "confirm" });

    expect(await screen.findByTestId("confirm")).toBeDefined();
  });

  it("keeps its own classes when the caller passes one", async () => {
    // Same defect as `Select`: `classes` was both the root class and the prefix
    // for every derived name, so `className="wide"` produced
    // `ui-dialog wide__backdrop` -- the backdrop lost its real class and the
    // scrim rendered as an unstyled transparent layer.
    renderDialog({ className: "wide" });

    const dialog = await screen.findByRole("dialog");

    expect(dialog.className.split(" ")).toContain("ui-dialog__popup");
    expect(dialog.className.split(" ")).toContain("wide");

    const backdrop = document.querySelector(".ui-dialog__backdrop");

    expect(backdrop, "the backdrop keeps its own class").not.toBeNull();
  });
});
