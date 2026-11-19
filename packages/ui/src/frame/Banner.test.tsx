// @vitest-environment jsdom
/**
 * The frame's notice bar.
 *
 * The component is a thin policy layer over `Alert`, so what is worth asserting
 * is the policy: the scene-to-tone table the frame reads, the ARIA role that
 * follows from the tone, and that the action button only appears when it can
 * actually do something.
 */

import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";

import { BANNER_SCENE_TONE, Banner } from "./Banner.js";

/** @param ui the banner to render */
function show(ui: ReactElement) {
  return render(<LocaleProvider locale="en">{ui}</LocaleProvider>);
}

describe("Banner", () => {
  it("uses the tone table for the four scenes", () => {
    expect(BANNER_SCENE_TONE).toEqual({
      layout: "warning",
      hiddenTabs: "info",
      unknownPages: "warning",
      engineOffline: "danger",
    });
  });

  it("renders the message with the role its tone implies", () => {
    show(<Banner tone="info" message="Two tabs are hidden" />);
    expect(screen.getByRole("status").textContent).toContain("Two tabs are hidden");

    show(<Banner tone="danger" message="The engine is not connected" />);
    expect(screen.getByRole("alert").textContent).toContain("The engine is not connected");
  });

  it("renders the action only when a handler is supplied", () => {
    const onAction = vi.fn();

    show(<Banner tone="warning" message="Layout is read-only" actionLabel="Reload" />);
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();

    show(
      <Banner
        tone="warning"
        message="Layout is read-only"
        actionLabel="Reload"
        onAction={onAction}
      />,
    );
    screen.getByRole("button", { name: "Reload" }).click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("dismisses through a button with a translated accessible name", () => {
    const onDismiss = vi.fn();

    show(<Banner tone="info" message="Two tabs are hidden" onDismiss={onDismiss} />);
    screen.getByRole("button", { name: "Dismiss alert" }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
