// @vitest-environment jsdom
/**
 * Frame host tests.
 *
 * Dockview itself is mocked: these tests are about the contract at the seam --
 * which components the frame registers, when it applies a document, when it
 * refuses to, how a compact width changes only the view, and how a page this
 * build does not know is hidden rather than dropped. The real mount is covered
 * by the Electron probe and by hand.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDoc, LayoutNode, LayoutTab } from "@haruyuki/protocol";

import { LocaleProvider } from "../i18n/index.js";

/** One fake dock panel, shaped like the part of `IDockviewPanel` the frame uses. */
interface FakePanel {
  readonly id: string;
  readonly params: { pageId: string };
  readonly api: { close: () => void; setActive: () => void };
  group?: FakeGroup;
}

/** One fake dock group. */
interface FakeGroup {
  readonly id: string;
  readonly panels: FakePanel[];
  readonly api: {
    maximize: () => void;
    exitMaximized: () => void;
    isMaximized: () => boolean;
  };
}

const state = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  fromJSON: vi.fn(),
  toJSON: vi.fn(),
  layoutListener: null as null | (() => void),
  activeListener: null as null | (() => void),
  maximize: vi.fn(),
  exitMaximized: vi.fn(),
  maximized: false,
  addPanel: vi.fn(),
  getGroup: vi.fn(),
  getPanel: vi.fn(),
  groups: [] as unknown[],
  panels: [] as unknown[],
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
          onDidActivePanelChange: (listener: () => void) => {
            state.activeListener = listener;
          },
          get panels() {
            return state.panels;
          },
          get groups() {
            return state.groups;
          },
          get activePanel() {
            return state.panels[1];
          },
          getGroup: state.getGroup,
          getPanel: state.getPanel,
          addPanel: state.addPanel,
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

/** The document the frame starts from: one panel per zone. */
const doc: LayoutDoc = {
  version: 1,
  root: {
    type: "split",
    orientation: "horizontal",
    children: [
      { type: "panel", id: "nav-panel", tabs: [{ tabId: "nav", pageId: "nav" }] },
      {
        type: "panel",
        id: "main-panel",
        tabs: [{ tabId: "conversation", pageId: "conversation" }],
        activeTabId: "conversation",
      },
      { type: "panel", id: "tree-panel", tabs: [{ tabId: "tree", pageId: "tree" }] },
    ],
  },
  activePanelId: "main-panel",
};

/** @param tabs tabs of the main panel @returns the document with those tabs */
function docWithMainTabs(tabs: LayoutTab[]): LayoutDoc {
  const split = doc.root as Extract<LayoutNode, { type: "split" }>;
  const left = split.children[0] as LayoutNode;
  const right = split.children[2] as LayoutNode;

  return {
    ...doc,
    root: {
      ...split,
      children: [left, { type: "panel", id: "main-panel", tabs }, right],
    },
  };
}

/** @param pageId the page @returns a fake panel bound to a group added later */
function makePanel(pageId: string, id = pageId): FakePanel {
  return {
    id,
    params: { pageId },
    api: { close: vi.fn(), setActive: vi.fn() },
  };
}

/** @param id the group id @param panels its panels @returns a fake group */
function makeGroup(id: string, panels: FakePanel[]): FakeGroup {
  return {
    id,
    panels,
    api: {
      maximize: () => {
        state.maximize();
        state.maximized = true;
      },
      exitMaximized: () => {
        state.exitMaximized();
        state.maximized = false;
      },
      isMaximized: () => state.maximized,
    },
  };
}

/** @returns the three panels of the default layout, wired into three groups */
function defaultDock(): { panels: FakePanel[]; groups: FakeGroup[] } {
  const nav = makePanel("nav");
  const conversation = makePanel("conversation");
  const tree = makePanel("tree");
  const panels = [nav, conversation, tree];
  const groups = [
    makeGroup("nav-panel", [nav]),
    makeGroup("main-panel", [conversation]),
    makeGroup("tree-panel", [tree]),
  ];

  for (const group of groups) {
    for (const panel of group.panels) panel.group = group;
  }

  state.panels = panels;
  state.groups = groups;
  state.getGroup.mockImplementation((id: string) => groups.find((group) => group.id === id));
  state.getPanel.mockImplementation((id: string) => panels.find((panel) => panel.id === id));

  return { panels, groups };
}

/** ResizeObserver stand-in: jsdom has none, and compact mode is width-driven. */
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(): void {
    // The frame measures once itself; the tests drive the threshold by hand.
  }

  unobserve(): void {
    // Nothing is observed.
  }

  disconnect(): void {
    ResizeObserverStub.instances = ResizeObserverStub.instances.filter((entry) => entry !== this);
  }

  emit(width: number): void {
    this.callback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

/** @param width push a content width through every live observer */
function resize(width: number): void {
  for (const instance of [...ResizeObserverStub.instances]) instance.emit(width);
}

/** @returns a registry with the three sample pages */
function registry() {
  const result = createPageRegistry();
  result.register(navPage);
  result.register(conversationPage);
  result.register(treePage);

  return result;
}

/** @param children the frame's children @returns one serialized leaf node */
function leaf(id: string, views: string[]): Record<string, unknown> {
  return { type: "leaf", data: { id, views, activeView: views[0] }, size: 333 };
}

/** @returns a dockview-shaped serialization of {@link doc} */
function serialized(): Record<string, unknown> {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          leaf("nav-panel", ["nav"]),
          leaf("main-panel", ["conversation"]),
          leaf("tree-panel", ["tree"]),
        ],
      },
      width: 1200,
      height: 800,
      orientation: "HORIZONTAL",
    },
    panels: {
      nav: { id: "nav", contentComponent: "__page__", params: { pageId: "nav" } },
      conversation: {
        id: "conversation",
        contentComponent: "__page__",
        params: { pageId: "conversation" },
      },
      tree: { id: "tree", contentComponent: "__page__", params: { pageId: "tree" } },
    },
    activeGroup: "main-panel",
  };
}

describe("AppFrame", () => {
  beforeEach(() => {
    state.fromJSON.mockClear();
    state.maximize.mockClear();
    state.exitMaximized.mockClear();
    state.maximized = false;
    state.addPanel.mockClear();
    state.toJSON.mockReturnValue(serialized());
    defaultDock();
    ResizeObserverStub.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("shows both rails and their registered side pages", () => {
    render(
      <LocaleProvider locale="en">
        <AppFrame registry={registry()} doc={doc} revision={1} onLayoutChange={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByRole("navigation", { name: "Left rail" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Right rail" })).toBeTruthy();
    expect(screen.getByText("Navigation")).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
  });

  it("collapses a rail without touching the layout", () => {
    const onLayoutChange = vi.fn();

    render(
      <LocaleProvider locale="en">
        <AppFrame registry={registry()} doc={doc} revision={1} onLayoutChange={onLayoutChange} />
      </LocaleProvider>,
    );

    const [collapseLeft] = screen.getAllByRole("button", { name: "Collapse side rail" });

    if (collapseLeft === undefined) throw new Error("left rail toggle is missing");
    fireEvent.click(collapseLeft);

    expect(screen.getAllByRole("button", { name: "Expand side rail" })).toHaveLength(1);
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it("lets the shell own the rail state so a shortcut can move it", () => {
    const onToggleSide = vi.fn();

    const { rerender } = render(
      <LocaleProvider locale="en">
        <AppFrame
          registry={registry()}
          doc={doc}
          revision={1}
          onLayoutChange={vi.fn()}
          collapsedSides={{ left: false, right: false }}
          onToggleSide={onToggleSide}
        />
      </LocaleProvider>,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Collapse side rail" })[0] as HTMLElement,
    );

    // Controlled: the frame only reports, the shell decides.
    expect(onToggleSide).toHaveBeenCalledWith("left");
    expect(screen.queryAllByRole("button", { name: "Expand side rail" })).toHaveLength(0);

    rerender(
      <LocaleProvider locale="en">
        <AppFrame
          registry={registry()}
          doc={doc}
          revision={1}
          onLayoutChange={vi.fn()}
          collapsedSides={{ left: true, right: false }}
          onToggleSide={onToggleSide}
        />
      </LocaleProvider>,
    );

    expect(screen.getAllByRole("button", { name: "Expand side rail" })).toHaveLength(1);
  });

  it("switches to one main tab below 1200px and back above it", async () => {
    const onLayoutChange = vi.fn();

    render(
      <LocaleProvider locale="en">
        <AppFrame registry={registry()} doc={doc} revision={1} onLayoutChange={onLayoutChange} />
      </LocaleProvider>,
    );

    resize(1000);

    await waitFor(() => expect(state.maximize).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("navigation", { name: "Left rail" })).toBeNull();
    expect(screen.getByRole("button", { name: "Side rail" })).toBeTruthy();
    expect(onLayoutChange).not.toHaveBeenCalled();

    resize(1400);

    await waitFor(() => expect(state.exitMaximized).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("navigation", { name: "Left rail" })).toBeTruthy();
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it("opens the same page twice with distinct tab ids", async () => {
    render(
      <LocaleProvider locale="en">
        <AppFrame registry={registry()} doc={doc} revision={1} onLayoutChange={vi.fn()} />
      </LocaleProvider>,
    );

    resize(1000);
    await waitFor(() => expect(state.maximize).toHaveBeenCalledTimes(1));

    for (let index = 0; index < 2; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Side rail" }));
      fireEvent.click(screen.getByRole("button", { name: "Files" }));
    }

    expect(state.addPanel).toHaveBeenCalledTimes(2);

    const ids = state.addPanel.mock.calls.map((call) => (call[0] as { id: string }).id);
    const params = state.addPanel.mock.calls.map(
      (call) => (call[0] as { params: { pageId: string } }).params.pageId,
    );

    expect(new Set(ids).size).toBe(2);
    expect(params).toEqual(["tree", "tree"]);
  });

  it("keeps a closed unknown tab in the document as hidden", () => {
    const onLayoutChange = vi.fn();
    const unknownDoc = docWithMainTabs([
      { tabId: "conversation", pageId: "conversation" },
      { tabId: "mystery-1", pageId: "mystery" },
    ]);

    render(
      <LocaleProvider locale="en">
        <AppFrame
          registry={registry()}
          doc={unknownDoc}
          revision={1}
          onLayoutChange={onLayoutChange}
        />
      </LocaleProvider>,
    );

    const mystery = makePanel("mystery", "mystery-1");
    const close = (): void => {
      state.panels = (state.panels as FakePanel[]).filter((panel) => panel.id !== "mystery-1");
      state.layoutListener?.();
    };
    const panel = { ...mystery, api: { ...mystery.api, close } };

    state.getPanel.mockImplementation((id: string) =>
      id === "mystery-1" ? panel : (state.panels as FakePanel[]).find((item) => item.id === id),
    );

    const items = (
      state.props?.["getTabContextMenuItems"] as (params: unknown) => Array<{
        label: string;
        action: () => void;
      }>
    )({ panel, api: { panels: state.panels }, group: {}, event: {} });

    items.find((item) => item.label === "Close tab")?.action();

    expect(onLayoutChange).toHaveBeenCalledTimes(1);

    const saved = onLayoutChange.mock.calls[0]?.[0] as LayoutDoc;
    const main = (saved.root as Extract<LayoutNode, { type: "split" }>).children[1];

    expect(main?.type).toBe("panel");

    if (main?.type !== "panel") return;

    expect(main.tabs).toHaveLength(2);
    expect(main.tabs.filter((tab) => tab.hidden === true)).toEqual([
      { tabId: "mystery-1", pageId: "mystery", hidden: true },
    ]);
  });

  it("renders a shell banner and a hidden-tab banner, and dismisses the latter", () => {
    const hiddenDoc = docWithMainTabs([
      { tabId: "conversation", pageId: "conversation" },
      { tabId: "mystery-1", pageId: "mystery", hidden: true },
    ]);

    render(
      <LocaleProvider locale="en">
        <AppFrame
          registry={registry()}
          doc={hiddenDoc}
          revision={1}
          onLayoutChange={vi.fn()}
          banner={{ tone: "warning", message: "The layout is read-only" }}
        />
      </LocaleProvider>,
    );

    expect(screen.getByText("The layout is read-only")).toBeTruthy();
    expect(screen.getByText(/tabs are hidden/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss alert" }));

    expect(screen.getByText("The layout is read-only")).toBeTruthy();
    expect(screen.queryByText(/tabs are hidden/)).toBeNull();
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
