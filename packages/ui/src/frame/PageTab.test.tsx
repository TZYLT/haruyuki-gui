// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";
import { createActivityStore } from "./activity.js";
import { FrameHostProvider, type FrameHost } from "./host-context.js";
import { PageTab } from "./PageTab.js";
import { conversationPage, navPage } from "./pages/index.js";
import { createPageRegistry } from "./registry.js";

/** @returns a registry with a main page and a pinned side page */
function registry() {
  const result = createPageRegistry();
  result.register(conversationPage);
  result.register(navPage);

  return result;
}

/** @param overrides tab api overrides @returns the rendered tab */
function view(overrides: Record<string, unknown> = {}) {
  const activity = createActivityStore();
  activity.set("tab-a", { unread: 3 });
  const close = vi.fn();
  const setActive = vi.fn();
  const other = { id: "tab-b", api: { setActive: vi.fn() } };
  const api = {
    id: "tab-a",
    title: "Conversation",
    isActive: false,
    close,
    setActive,
    group: { panels: [{ id: "tab-a", api: { setActive } }, other] },
    ...overrides,
  };
  const host: FrameHost = {
    registry: registry(),
    activity,
    layoutRevision: 1,
    openPage: () => "tab-a",
    closeTab: close,
    hideTab: vi.fn(),
  };

  render(
    <LocaleProvider locale="en">
      <FrameHostProvider value={host}>
        <PageTab {...({ api, params: { pageId: "conversation" } } as never)} />
      </FrameHostProvider>
    </LocaleProvider>,
  );

  return { close, setActive, other };
}

describe("PageTab", () => {
  it("labels the unread badge for a screen reader", () => {
    view();

    expect(screen.getByLabelText("3 unread")).toBeTruthy();
  });

  it("activates on Enter and closes on Delete", async () => {
    const { close, setActive } = view();
    const tab = screen.getByRole("tab");

    await userEvent.type(tab, "{Enter}");
    expect(setActive).toHaveBeenCalled();

    await userEvent.type(tab, "{Delete}");
    expect(close).toHaveBeenCalled();
  });
});
