// @vitest-environment jsdom
/**
 * Frame smoke tests.
 *
 * Dockview itself is mocked: these tests are about the contract at the seam --
 * which components the frame registers, when it applies a document, and when it
 * refuses to apply one. The real mount is covered by the Electron probe and the
 * manual engine-crash-record/renderer-recovery-sequence checks.
 */

import { render, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDoc } from "@haruyuki/protocol";

import { LocaleProvider } from "../i18n/index.js";

const state = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  fromJSON: vi.fn(),
  toJSON: vi.fn(),
  layoutListener: null as null | (() => void),
}));

vi.mock("dockview-react", () => ({
  DockviewReact: (props: Record<string, unknown>) => {
    const started = useRef(false);

    state.props = props;

    useEffect(() => {
      if (started.current) return;

      started.current = true;
      const onReady = props["onReady"] as (event: unknown) => void;

      onReady({
        api: {
          fromJSON: state.fromJSON,
          toJSON: state.toJSON,
          onDidLayoutChange: (listener: () => void) => {
            state.layoutListener = listener;
          },
          panels: [],
          getPanel: () => undefined,
          addPanel: vi.fn(),
        },
      });
    }, [props]);

    return <div data-testid="dock" />;
  },
}));

import { AppFrame } from "./AppFrame.js";
import { badgeText, createActivityStore } from "./activity.js";
import { createPageRegistry } from "./registry.js";
import { conversationPage, navPage, treePage } from "./pages/index.js";

const doc: LayoutDoc = {
  version: 1,
  root: {
    type: "split",
    orientation: "horizontal",
    children: [
      { type: "panel", id: "nav", tabs: [{ tabId: "nav", pageId: "nav" }] },
      {
        type: "panel",
        id: "main",
        tabs: [{ tabId: "conversation", pageId: "conversation" }],
      },
      { type: "panel", id: "tree", tabs: [{ tabId: "tree", pageId: "tree" }] },
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

describe("AppFrame", () => {
  beforeEach(() => {
    state.fromJSON.mockClear();
    state.toJSON.mockReturnValue({
      grid: {
        root: {
          type: "branch",
          data: [
            {
              type: "leaf",
              data: { id: "main", views: ["conversation"], activeView: "conversation" },
            },
          ],
        },
        width: 1200,
        height: 800,
        orientation: "HORIZONTAL",
      },
      panels: {
        conversation: {
          id: "conversation",
          contentComponent: "__page__",
          params: { pageId: "conversation" },
        },
      },
    });
  });

  it("registers the page host and the custom tab", () => {
    render(
      <LocaleProvider locale="en">
        <AppFrame registry={registry()} doc={doc} revision={1} onLayoutChange={vi.fn()} />
      </LocaleProvider>,
    );

    expect(state.props).not.toBeNull();
    expect(state.props?.["components"]).toHaveProperty("__page__");
    expect(state.props?.["tabComponents"]).toHaveProperty("__tab__");
    expect(state.fromJSON).toHaveBeenCalledTimes(1);
  });

  it("does not re-apply an identical document on a later render", async () => {
    const { rerender } = render(
      <LocaleProvider locale="en">
        <AppFrame registry={registry()} doc={doc} revision={1} onLayoutChange={vi.fn()} />
      </LocaleProvider>,
    );

    rerender(
      <LocaleProvider locale="en">
        <AppFrame registry={registry()} doc={doc} revision={1} onLayoutChange={vi.fn()} />
      </LocaleProvider>,
    );

    await waitFor(() => expect(state.fromJSON).toHaveBeenCalledTimes(1));
  });
});

describe("activity badge", () => {
  it("prefers approvals over streaming over unread", () => {
    expect(badgeText({ streaming: true, approvals: 2, unread: 5 })).toBe("2");
    expect(badgeText({ streaming: true, approvals: 0, unread: 5 })).toBe("…");
    expect(badgeText({ streaming: false, approvals: 0, unread: 5 })).toBe("5");
    expect(badgeText({ streaming: false, approvals: 0, unread: 0 })).toBeNull();
  });

  it("clears unread without disturbing the other fields", () => {
    const store = createActivityStore();
    store.set("tab", { streaming: true, unread: 3 });

    expect(store.get("tab")).toEqual({ streaming: true, approvals: 0, unread: 3 });
    store.clearUnread("tab");
    expect(store.get("tab")).toEqual({ streaming: true, approvals: 0, unread: 0 });
  });
});
