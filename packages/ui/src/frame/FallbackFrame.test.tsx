// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { LayoutDoc } from "@haruyuki/protocol";

import { LocaleProvider } from "../i18n/index.js";
import { conversationPage, navPage, treePage } from "./pages/index.js";
import { createPageRegistry } from "./registry.js";
import { FallbackFrame } from "./FallbackFrame.js";

const doc: LayoutDoc = {
  version: 1,
  root: {
    type: "split",
    orientation: "horizontal",
    children: [
      { type: "panel", id: "left", tabs: [{ tabId: "nav", pageId: "nav" }] },
      {
        type: "panel",
        id: "main",
        tabs: [{ tabId: "conversation", pageId: "conversation" }],
      },
      { type: "panel", id: "right", tabs: [{ tabId: "tree", pageId: "tree" }] },
    ],
  },
};

/** @returns a registry with the three sample pages */
function registry() {
  const result = createPageRegistry();
  result.register(navPage);
  result.register(conversationPage);
  result.register(treePage);

  return result;
}

describe("FallbackFrame", () => {
  it("renders both side pages and the main tab", () => {
    render(
      <LocaleProvider locale="en">
        <FallbackFrame registry={registry()} doc={doc} />
      </LocaleProvider>,
    );

    expect(screen.getAllByRole("tab", { name: "Conversation" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Files" }).length).toBeGreaterThan(0);
  });

  it("opens a side page in the main column", async () => {
    render(
      <LocaleProvider locale="en">
        <FallbackFrame registry={registry()} doc={doc} />
      </LocaleProvider>,
    );

    await userEvent.click(screen.getAllByRole("button", { name: "Files" })[0]!);

    expect(screen.getAllByRole("button", { name: "Files" }).length).toBeGreaterThan(0);
  });
});
