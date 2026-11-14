/**
 * Alert tests.
 *
 * The role split is the component's whole reason to exist: an assertive alert for
 * something the user must know now, a polite status for a confirmation. Getting
 * that backwards means either interrupting for trivia or silently swallowing an
 * error, and neither is visible in a screenshot.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";
import { Alert } from "./Alert.js";

describe("Alert", () => {
  it("interrupts for danger", () => {
    render(<Alert tone="danger">Deployment failed</Alert>);

    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("interrupts for warning", () => {
    render(<Alert tone="warning">Disk almost full</Alert>);

    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("waits for a pause for info", () => {
    // Interrupting a screen reader to say "saved" is rude; role=status waits.
    render(<Alert tone="info">Saved</Alert>);

    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("waits for a pause for success", () => {
    render(<Alert tone="success">Done</Alert>);

    expect(screen.getByRole("status")).toBeDefined();
  });

  it("renders a title and body separately", () => {
    render(
      <Alert tone="danger" title="Upload failed">
        Check your connection
      </Alert>,
    );

    expect(screen.getByText("Upload failed")).toBeDefined();
    expect(screen.getByText("Check your connection")).toBeDefined();
  });

  it("renders without a title", () => {
    render(<Alert tone="info">Just a message</Alert>);

    expect(screen.getByText("Just a message")).toBeDefined();
  });

  it("reflects the tone as a data attribute", () => {
    const { container } = render(<Alert tone="warning">Careful</Alert>);

    expect(container.querySelector(".ui-alert")?.getAttribute("data-tone")).toBe("warning");
  });

  it("renders no dismiss button unless asked", () => {
    render(<Alert tone="info">Message</Alert>);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("gives the dismiss button a translated accessible name", () => {
    render(
      <LocaleProvider locale="en">
        <Alert tone="info" onDismiss={vi.fn()}>
          Message
        </Alert>
      </LocaleProvider>,
    );

    expect(screen.getByRole("button", { name: "Dismiss alert" })).toBeDefined();
  });

  it("translates the dismiss label", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <Alert tone="info" onDismiss={vi.fn()}>
          消息
        </Alert>
      </LocaleProvider>,
    );

    expect(screen.getByRole("button", { name: "关闭提示" })).toBeDefined();
  });

  it("calls onDismiss when pressed", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(
      <Alert tone="info" onDismiss={onDismiss}>
        Message
      </Alert>,
    );
    await user.click(screen.getByRole("button"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the icon decorative so the message is not read twice", () => {
    // The tone is already conveyed by the words; an announced icon would make a
    // screen reader say the meaning twice.
    render(<Alert tone="danger">Failed</Alert>);

    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("forwards data-testid", () => {
    render(
      <Alert tone="info" data-testid="banner">
        Message
      </Alert>,
    );

    expect(screen.getByTestId("banner")).toBeDefined();
  });
});
