// @vitest-environment jsdom
/**
 * The side rail and its compact substitute.
 *
 * The strip is pure rendering, so the tests assert the contract the frame relies
 * on: which pages it lists, what the toggle announces, and that a click reports
 * the page id rather than moving anything itself.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";

import { CompactSideRail, SideRail } from "./SideRail.js";
import type { PageDefinition } from "./types.js";

/** @returns a minimal side-zone definition */
function page(id: string): PageDefinition {
  return {
    id,
    titleKey: "page.frame.picker.side",
    icon: "file",
    zone: "side",
    defaultSide: "left",
    minWidth: 240,
    component: () => null,
  };
}

describe("SideRail", () => {
  it("lists the pages of its side and reports the one clicked", () => {
    const onOpen = vi.fn();

    render(
      <LocaleProvider locale="en">
        <SideRail
          side="left"
          pages={[page("nav"), page("tree")]}
          collapsed={false}
          onToggle={vi.fn()}
          onOpen={onOpen}
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole("navigation", { name: "Left rail" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);

    screen.getAllByRole("button")[2]?.click();
    expect(onOpen).toHaveBeenCalledWith("tree");
  });

  it("collapses to icons and reports the toggle", () => {
    const onToggle = vi.fn();

    const { rerender } = render(
      <LocaleProvider locale="en">
        <SideRail
          side="right"
          pages={[page("tree")]}
          collapsed={false}
          onToggle={onToggle}
          onOpen={vi.fn()}
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole("button", { name: "Collapse side rail" })).toBeTruthy();
    screen.getByRole("button", { name: "Collapse side rail" }).click();
    expect(onToggle).toHaveBeenCalledWith("right");

    rerender(
      <LocaleProvider locale="en">
        <SideRail
          side="right"
          pages={[page("tree")]}
          collapsed
          onToggle={onToggle}
          onOpen={vi.fn()}
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole("button", { name: "Expand side rail" })).toBeTruthy();
    expect(screen.queryByText("Side rail")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand side rail" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("says so when the side has no pages instead of rendering an empty list", () => {
    render(
      <LocaleProvider locale="en">
        <SideRail side="left" pages={[]} collapsed={false} onToggle={vi.fn()} onOpen={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByText("No pages on this side yet.")).toBeTruthy();
  });
});

describe("CompactSideRail", () => {
  it("groups both sides and opens a page into the main area", () => {
    const onOpen = vi.fn();

    render(
      <LocaleProvider locale="en">
        <CompactSideRail left={[page("nav")]} right={[]} onOpen={onOpen} />
      </LocaleProvider>,
    );

    expect(screen.getByText("Left rail")).toBeTruthy();
    expect(screen.getByText("Right rail")).toBeTruthy();
    expect(screen.getByText("No pages on this side yet.")).toBeTruthy();

    screen.getByRole("button", { name: "Side rail" }).click();
    expect(onOpen).toHaveBeenCalledWith("nav");
  });
});
