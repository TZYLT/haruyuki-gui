/**
 * The frame host: one dockview instance, one page registry, one activity store.
 *
 * The component is intentionally thin. It converts the document to dockview's
 * grid on ready, converts changes back through `toLayoutDoc`, and hands the
 * result to its caller. It does not write the layout itself: the caller owns the
 * revision and the save path, which is what keeps a save echo from rebuilding
 * every page.
 *
 * Two rendering modes share the same document:
 *
 * - **Docked** (default). Left and right rails list the side-zone pages; the
 *   dock shows the saved layout. Collapsing a rail only narrows the rail strip.
 * - **Compact** (`< 1200px`, `59` section 4.8). The dock is unchanged and every
 *   page stays mounted; the active main group is *maximised* so one main tab
 *   fills the width, and the side pages move behind a "side rail" entry that
 *   opens them into the main group. Leaving compact mode exits the maximised
 *   view. Neither action writes a document: maximising is a view state that
 *   `toLayoutDoc` ignores, so a compact window cannot overwrite the saved
 *   layout.
 *
 * The mode is measured with a `ResizeObserver` rather than `matchMedia` because
 * the threshold is about the *content* width, not the window's: a window that is
 * wide but has a panel open beside it should still get the compact treatment.
 */

import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  DockviewReact,
  type AddPanelOptions,
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
  type IDockviewPanel,
} from "dockview-react";
import type { LayoutDoc } from "@haruyuki/protocol";

import "dockview-react/dist/styles/dockview.css";
import "./styles.css";

import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { useT } from "../i18n/index.js";

import { createActivityStore } from "./activity.js";
import { Banner, type BannerProps } from "./Banner.js";
import { FallbackFrame } from "./FallbackFrame.js";
import { FrameHostProvider, type FrameHost } from "./host-context.js";
import { hiddenTabCount, hideTab as hideTabInDoc } from "./layout/hidden.js";
import { swapSidePanels } from "./layout/sides.js";
import { docEquals, toDockview, toLayoutDoc } from "./layout/map.js";
import { PageHost } from "./PageHost.js";
import { PageTab } from "./PageTab.js";
import { PagePicker } from "./PagePicker.js";
import { CompactSideRail, SideRail, type SideRailSide } from "./SideRail.js";
import type { OpenTarget, PageDefinition, PageRegistry } from "./types.js";

/** Content width below which only one main tab is shown, in px (`59` section 4.8). */
export const COMPACT_WIDTH = 1200;

/** What the shell supplies; the frame never invents these. */
export interface AppFrameProps {
  readonly registry: PageRegistry;
  /** The authoritative document, from C4 or the first-run default. */
  readonly doc: LayoutDoc;
  readonly revision: number;
  readonly onLayoutChange: (doc: LayoutDoc) => void;
  /**
   * A notice pushed by the shell, for a layout that could not be read or came
   * from a newer version, and for a disconnected engine. The frame does not read
   * the layout channel or the bridge itself: it renders what it is handed.
   */
  readonly banner?: BannerProps;
  /**
   * Rail collapsed state, when the shell owns it.
   *
   * The frame keeps this in memory when the props are absent. A shell that owns
   * a keyboard shortcut for the rails (`Ctrl+B`) supplies both this and
   * `onToggleSide`, so the shortcut and the rail button move the same state
   * instead of two copies that drift.
   */
  readonly collapsedSides?: Readonly<Record<SideRailSide, boolean>>;
  /** Rail toggle request; required alongside {@link collapsedSides}. */
  readonly onToggleSide?: (side: SideRailSide) => void;
}

/** A fresh tab id; layout tab ids are opaque and only need to be unique. */
let nextTab = 0;

/** @param panel a dockview panel @returns its page id, or the empty string */
function pageIdOfPanel(panel: IDockviewPanel | undefined): string {
  const params = panel?.params as { pageId?: unknown } | undefined;

  return typeof params?.pageId === "string" ? params.pageId : "";
}

/** Render the dock and its pages. */
export function AppFrame(props: AppFrameProps): ReactElement {
  const t = useT();
  const activity = useMemo(() => createActivityStore(), []);
  const apiRef = useRef<DockviewApi | null>(null);
  const latest = useRef<LayoutDoc>(props.doc);
  const applying = useRef(false);
  const frame = useRef<HTMLDivElement | null>(null);
  const compactRef = useRef(false);
  const saveRef = useRef(props.onLayoutChange);
  const maximizedGroup = useRef<string | null>(null);
  const lastMainGroup = useRef<string | null>(null);
  const temporary = useRef(new Set<string>());
  saveRef.current = props.onLayoutChange;
  const [compact, setCompact] = useState(false);
  const [fallback, setFallback] = useState(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [collapsedLocal, setCollapsedLocal] = useState<Record<SideRailSide, boolean>>({
    left: false,
    right: false,
  });
  // The shell may own the collapsed state so a shortcut and the rail buttons
  // move one value; without those props the frame keeps it itself.
  const collapsed = props.collapsedSides ?? collapsedLocal;
  const toggleSide = (side: SideRailSide): void => {
    props.onToggleSide?.(side);

    if (props.collapsedSides === undefined) {
      setCollapsedLocal((current) => ({ ...current, [side]: !current[side] }));
    }
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [activePageId, setActivePageId] = useState("");

  /** @param panel a dockview panel @returns whether its page belongs to a side rail */
  const isSidePanel = (panel: IDockviewPanel): boolean =>
    props.registry.get(pageIdOfPanel(panel))?.zone === "side";

  /**
   * The group a side rail's pages live in.
   *
   * A group is the rail's panel only when every tab in it is a side page on that
   * side; a mixed group is somebody else's arrangement and is left alone.
   *
   * @param api the dock API
   * @param side the edge to find
   * @returns the group, when there is one
   */
  const sideGroup = (api: DockviewApi, side: SideRailSide): DockviewGroupPanel | undefined =>
    api.groups.find(
      (group) =>
        group.panels.length > 0 &&
        group.panels.every((panel) => {
          const definition = props.registry.get(pageIdOfPanel(panel));

          return definition?.zone === "side" && (definition.defaultSide ?? "left") === side;
        }),
    );

  /**
   * The group compact mode should maximise.
   *
   * The active panel wins when it is a main page, so switching tabs in the main
   * area in compact mode re-targets the window; otherwise the first group that
   * holds a main page.
   *
   * @param api the dock API
   * @returns the group, when there is one
   */
  const mainGroup = (api: DockviewApi): DockviewGroupPanel | undefined => {
    const active = api.activePanel;

    if (active !== undefined && !isSidePanel(active)) return active.group;

    return api.groups.find((group) => group.panels.some((panel) => !isSidePanel(panel)));
  };

  /**
   * Leave the single-group view.
   *
   * @param api the dock API
   */
  const exitCompact = (api: DockviewApi): void => {
    const id = maximizedGroup.current;

    if (id === null) return;

    maximizedGroup.current = null;
    const group = api.getGroup(id);

    if (group === undefined) return;

    applying.current = true;

    try {
      if (group.api.isMaximized()) group.api.exitMaximized();
    } finally {
      applying.current = false;
    }
  };

  /**
   * Show only the main group, without touching the document.
   *
   * `maximize` is a view operation: the other groups stay mounted, `toJSON`
   * keeps the real grid, and `toLayoutDoc` ignores the maximised marker. That is
   * why compact mode can be entered and left without an `onLayoutChange`.
   *
   * @param api the dock API
   */
  const applyCompact = (api: DockviewApi): void => {
    const group = mainGroup(api);

    if (group === undefined) return;
    if (maximizedGroup.current === group.id && group.api.isMaximized()) return;

    if (maximizedGroup.current !== null && maximizedGroup.current !== group.id) exitCompact(api);

    maximizedGroup.current = group.id;
    applying.current = true;

    try {
      group.api.maximize();
    } finally {
      applying.current = false;
    }
  };

  const openPage = (
    pageId: string,
    target: OpenTarget = "focused",
    params?: Record<string, unknown>,
  ): string => {
    const definition = props.registry.get(pageId);
    const id = `${pageId}-${String(++nextTab)}`;
    const api = apiRef.current;

    if (api === null) return id;

    const side: SideRailSide | null =
      target === "side-left" ? "left" : target === "side-right" ? "right" : null;
    const base: Omit<AddPanelOptions, "position" | "floating"> = {
      id,
      component: "__page__",
      tabComponent: "__tab__",
      title: definition === undefined ? pageId : t(definition.titleKey),
      params: { pageId, ...(params ?? {}) },
    };
    const remembered =
      lastMainGroup.current === null ? undefined : api.getGroup(lastMainGroup.current);
    const host =
      side !== null
        ? sideGroup(api, side)
        : target === "focused" && remembered !== undefined
          ? remembered
          : compactRef.current
            ? mainGroup(api)
            : undefined;

    if (host !== undefined) {
      api.addPanel({
        ...base,
        floating: false,
        position: { referenceGroup: host.id, direction: "within" },
      });
    } else if (side !== null) {
      api.addPanel({ ...base, floating: false, position: { direction: side } });
    } else if (target === "main") {
      api.addPanel({ ...base, floating: false, position: { direction: "right" } });
    } else {
      api.addPanel({ ...base, floating: false });
    }

    return id;
  };

  /**
   * Focus the open instance of a page, or open it on its own rail.
   *
   * A rail click is "take me to the file tree", not "open a second file tree",
   * so an existing instance wins.
   *
   * @param pageId the page to show
   * @param side the rail it was clicked on
   */
  const focusOrOpen = (pageId: string, side: SideRailSide): void => {
    const api = apiRef.current;
    const existing = api?.panels.find((panel) => pageIdOfPanel(panel) === pageId);

    if (existing !== undefined) {
      existing.api.setActive();
      return;
    }

    openPage(pageId, side === "left" ? "side-left" : "side-right");
  };

  /**
   * Close a tab while keeping it in the layout document.
   *
   * The document is patched *before* the panel closes: `onDidLayoutChange` runs
   * `toLayoutDoc` against `latest`, and `toLayoutDoc` only carries a hidden tab
   * forward when the document it merges against already has `hidden: true`.
   *
   * @param tabId the tab to hide
   */
  const hideTab = (tabId: string): void => {
    const patched = hideTabInDoc(latest.current, tabId);

    if (patched !== null) latest.current = patched;

    apiRef.current?.getPanel(tabId)?.api.close();
  };

  const closeTab = (tabId: string): void => {
    apiRef.current?.getPanel(tabId)?.api.close();
  };

  /** Swap the side panels as a document change, so the swap survives a restart. */
  const swapSides = (): void => {
    const api = apiRef.current;

    if (api === null) return;

    const next = swapSidePanels(latest.current, props.registry);

    if (next === null) return;

    applying.current = true;

    try {
      api.fromJSON(toDockview(next, size()).serialized as never);
      applyPanelTitles(api);
    } finally {
      applying.current = false;
    }

    latest.current = next;
    saveRef.current(next);
  };

  const host: FrameHost = {
    registry: props.registry,
    activity,
    layoutRevision: props.revision,
    openPage,
    closeTab,
    hideTab,
  };

  const size = (): { width: number; height: number } => ({
    width: frame.current?.clientWidth ?? 1200,
    height: frame.current?.clientHeight ?? 800,
  });

  /**
   * Replace dockview's default tab title with the page's localized title.
   *
   * `toDockview` is a pure document mapping and has no translator, so the title
   * it can produce is the tab id. Without this pass a restored layout shows
   * `conversation` where the page picker shows "Conversation"; a document that
   * came from a save would read as a different product than the one just opened.
   */
  const applyPanelTitles = (api: DockviewApi): void => {
    for (const panel of api.panels ?? []) {
      const definition = props.registry.get(pageIdOfPanel(panel));

      if (definition !== undefined && typeof panel.api.setTitle === "function") {
        panel.api.setTitle(t(definition.titleKey));
      }
    }
  };

  const onReady = (event: DockviewReadyEvent): void => {
    apiRef.current = event.api;

    if (fallbackTimer.current !== null) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }

    applying.current = true;

    const { serialized } = toDockview(latest.current, size());
    event.api.fromJSON(serialized as never);
    applyPanelTitles(event.api);
    applying.current = false;
    setActivePageId(pageIdOfPanel(event.api.activePanel));

    event.api.onDidLayoutChange(() => {
      if (applying.current) return;

      // A compact tab the user closed is no longer "temporary"; keeping the id
      // would make the back button close an unrelated tab that reused it.
      const open = new Set(event.api.panels.map((panel) => panel.id));

      for (const id of temporary.current) {
        if (!open.has(id)) temporary.current.delete(id);
      }

      const next = toLayoutDoc(event.api.toJSON() as never, latest.current);
      latest.current = next;
      saveRef.current(next);
    });

    // In compact mode the maximised group has to follow the active tab, or the
    // user would switch to a tab that is not on screen.
    if (typeof event.api.onDidActivePanelChange === "function") {
      event.api.onDidActivePanelChange((change) => {
        if (compactRef.current) applyCompact(event.api);
        const panel = change.panel;
        const active = pageIdOfPanel(panel);

        if (panel !== undefined && props.registry.get(active)?.zone === "main") {
          lastMainGroup.current = panel.group?.id ?? null;
        }

        setActivePageId(pageIdOfPanel(event.api.activePanel));
      });
    }
  };

  // Measure the content width, not the window: the threshold is about how much
  // room the frame actually has.
  useEffect(() => {
    const element = frame.current;

    if (element === null) return;

    const measure = (width: number): void => {
      if (width <= 0) return;
      compactRef.current = width < COMPACT_WIDTH;
      setCompact(compactRef.current);
    };

    if (typeof ResizeObserver === "undefined") {
      measure(element.clientWidth);
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      measure(entry?.contentRect.width ?? element.clientWidth);
    });

    observer.observe(element);
    measure(element.clientWidth);

    return () => observer.disconnect();
  }, []);

  // Entering and leaving compact mode is a view change only.
  useEffect(() => {
    const api = apiRef.current;

    if (api === null) return;

    if (compact) applyCompact(api);
    else exitCompact(api);
  }, [compact]);

  // The one global shortcut (`59` section 4.11): cycle the active group's tabs.
  // It listens in the bubble phase, so a page that consumed Tab first wins.
  // A dock that never calls `onReady` is a capability failure, not a hang:
  // after five seconds the two-column fallback takes over (`59` section 4.8).
  useEffect(() => {
    fallbackTimer.current = setTimeout(() => {
      if (apiRef.current === null) {
        console.warn("frame.fallback", "dockview did not become ready within 5000 ms");
        setFallback(true);
      }
    }, 5000);

    return () => {
      if (fallbackTimer.current !== null) clearTimeout(fallbackTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.key !== "Tab" || event.defaultPrevented) return;

      const api = apiRef.current;

      if (api === null) return;

      const panels = api.panels.filter((panel) => panel.api.isVisible);

      if (panels.length < 2) return;

      const active = api.activePanel;
      const current = panels.findIndex((panel) => panel.id === active?.id);
      const step = event.shiftKey ? -1 : 1;
      const next = panels[(current + step + panels.length) % panels.length];

      if (next === undefined) return;

      event.preventDefault();
      next.api.setActive();
    };

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const api = apiRef.current;

    if (api === null || docEquals(props.doc, latest.current)) return;

    applying.current = true;
    const { serialized } = toDockview(props.doc, size());
    api.fromJSON(serialized as never);
    applyPanelTitles(api);
    applying.current = false;
    latest.current = props.doc;

    // `fromJSON` rebuilds the grid, which drops the maximised view.
    if (compactRef.current) applyCompact(api);
  }, [props.doc, props.revision]);

  const contextMenu = (
    params: GetTabContextMenuItemsParams,
  ): Array<{ label: string; action: () => void }> => {
    const panelId = params.panel.api.id;
    const pageId = pageIdOfPanel(params.panel);
    const definition = props.registry.get(pageId);

    if (definition?.pinned === true) return [];

    const close = (panel: IDockviewPanel): void => {
      // An unregistered page is hidden, not deleted: the document keeps it so a
      // later build can show it (`59` section 4.4).
      if (props.registry.get(pageIdOfPanel(panel)) === undefined) hideTab(panel.id);
      else panel.api.close();
    };

    return [
      { label: t("page.frame.tab.close"), action: () => close(params.panel) },
      {
        label: t("page.frame.tab.closeOthers"),
        action: () => {
          for (const panel of params.api.panels) {
            if (panel.id === panelId) continue;
            if (props.registry.get(pageIdOfPanel(panel))?.pinned !== true) close(panel);
          }
        },
      },
      {
        label: t("page.frame.tab.closeAll"),
        action: () => {
          for (const panel of params.api.panels) {
            if (props.registry.get(pageIdOfPanel(panel))?.pinned !== true) close(panel);
          }
        },
      },
    ];
  };

  const sidePages = (side: SideRailSide): readonly PageDefinition[] =>
    props.registry
      .list()
      .filter((page) => page.zone === "side" && (page.defaultSide ?? "left") === side);

  const dismiss = (key: string): void => {
    setDismissed((current) => (current.includes(key) ? current : [...current, key]));
  };

  /** Open a side page from the compact entry; it lands in the main area. */
  const openFromCompact = (pageId: string): void => {
    const id = openPage(pageId, "main");

    temporary.current.add(id);
    setMenuOpen(false);
    const api = apiRef.current;

    if (api !== null) applyCompact(api);
  };

  /** Close the temporary compact tab, or re-focus the main group. */
  const returnToLayout = (): void => {
    const api = apiRef.current;

    if (api === null) return;

    const active = api.activePanel;

    if (active !== undefined && temporary.current.delete(active.id)) {
      active.api.close();
    }

    applyCompact(api);
  };

  const banners: ReactElement[] = [];

  if (props.banner !== undefined) {
    banners.push(<Banner key="shell" {...props.banner} />);
  }

  const hidden = hiddenTabCount(props.doc);
  const hiddenKey = `hidden:${String(hidden)}`;

  if (hidden > 0 && !dismissed.includes(hiddenKey)) {
    banners.push(
      <Banner
        key="hidden"
        tone="info"
        message={t("page.frame.banner.hidden", { count: hidden })}
        onDismiss={() => dismiss(hiddenKey)}
      />,
    );
  }

  if (fallback) {
    return (
      <div className="hz-frame hz-frame--fallback">
        {props.banner === undefined ? null : <Banner {...props.banner} />}
        <FallbackFrame registry={props.registry} doc={props.doc} />
      </div>
    );
  }

  return (
    <div className="hz-frame__stack" ref={frame}>
      {banners.length === 0 ? null : (
        <div className="hz-frame__banners" role="region" aria-live="polite">
          {banners}
        </div>
      )}
      {compact ? null : (
        <div className="hz-frame__bar">
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            {t("page.frame.empty.open")}
          </Button>
        </div>
      )}
      {compact ? (
        <div className="hz-compact-bar">
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={menuOpen}
            aria-controls="hz-compact-pages"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {t("page.frame.sideRail.title")}
          </Button>
          <Button variant="ghost" size="sm" onClick={returnToLayout}>
            {t("page.frame.compact.back")}
          </Button>
          {menuOpen ? (
            <div className="hz-compact-bar__menu" id="hz-compact-pages">
              <CompactSideRail
                left={sidePages("left")}
                right={sidePages("right")}
                onOpen={openFromCompact}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <FrameHostProvider value={host}>
        <div className={compact ? "hz-frame hz-frame--compact" : "hz-frame"}>
          {pickerOpen ? (
            <div className="hz-frame__picker">
              <PagePicker onOpen={() => setPickerOpen(false)} />
              <Button variant="secondary" size="sm" onClick={() => setPickerOpen(false)}>
                {t("page.topbar.cancel")}
              </Button>
            </div>
          ) : null}
          {compact ? null : (
            <SideRail
              side="left"
              pages={sidePages("left")}
              collapsed={collapsed.left}
              activePageId={activePageId}
              onToggle={toggleSide}
              onOpen={(pageId) => focusOrOpen(pageId, "left")}
              onSwap={swapSides}
            />
          )}
          <FrameBoundary
            onError={() => {
              console.warn("frame.fallback", "dockview threw while mounting");
              setFallback(true);
            }}
          >
            <DockviewReact
              className="hz-frame__dock"
              components={{ __page__: PageHost }}
              tabComponents={{ __tab__: PageTab }}
              onReady={onReady}
              getTabContextMenuItems={contextMenu}
              watermarkComponent={() => (
                <div className="hz-frame__empty">
                  <EmptyState
                    title={t("page.frame.empty.title")}
                    action={
                      <Button
                        onClick={() => {
                          const first = props.registry.list().find((page) => page.zone === "main");

                          if (first !== undefined) openPage(first.id, "main");
                        }}
                      >
                        {t("page.frame.empty.open")}
                      </Button>
                    }
                  />
                  <PagePicker onOpen={() => undefined} />
                </div>
              )}
            />
          </FrameBoundary>
          {compact ? null : (
            <SideRail
              side="right"
              pages={sidePages("right")}
              collapsed={collapsed.right}
              activePageId={activePageId}
              onToggle={toggleSide}
              onOpen={(pageId) => focusOrOpen(pageId, "right")}
              onSwap={swapSides}
            />
          )}
        </div>
      </FrameHostProvider>
    </div>
  );
}

/** Catches a dockview mount failure and hands it to the fallback. */
class FrameBoundary extends Component<
  { readonly children: ReactNode; readonly onError: () => void },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("dockview mount failed", error, info.componentStack);
    this.props.onError();
  }

  render(): ReactNode {
    if (this.state.failed) return null;

    return this.props.children;
  }
}
