/**
 * The frame host: one dockview instance, one page registry, one activity store.
 *
 * The component is intentionally thin. It converts the document to dockview's
 * grid on ready, converts changes back through `toLayoutDoc`, and hands the
 * result to its caller. It does not write the layout itself: the caller owns the
 * revision and the save path, which is what keeps a save echo from rebuilding
 * every page.
 */

import { useEffect, useMemo, useRef, type ReactElement } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
} from "dockview-react";
import type { LayoutDoc } from "@haruyuki/protocol";

import "dockview-react/dist/styles/dockview.css";
import "./styles.css";

import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { useT } from "../i18n/index.js";

import { createActivityStore } from "./activity.js";
import { FrameHostProvider, type FrameHost } from "./host-context.js";
import { docEquals, toDockview, toLayoutDoc } from "./layout/map.js";
import { PageHost } from "./PageHost.js";
import { PageTab } from "./PageTab.js";
import { PagePicker } from "./PagePicker.js";
import type { OpenTarget, PageRegistry } from "./types.js";

/** What the shell supplies; the frame never invents these. */
export interface AppFrameProps {
  readonly registry: PageRegistry;
  /** The authoritative document, from C4 or the first-run default. */
  readonly doc: LayoutDoc;
  readonly revision: number;
  readonly onLayoutChange: (doc: LayoutDoc) => void;
}

/** A fresh tab id; layout tab ids are opaque and only need to be unique. */
let nextTab = 0;

/** Render the dock and its pages. */
export function AppFrame(props: AppFrameProps): ReactElement {
  const t = useT();
  const activity = useMemo(() => createActivityStore(), []);
  const apiRef = useRef<DockviewApi | null>(null);
  const latest = useRef<LayoutDoc>(props.doc);
  const applying = useRef(false);
  const frame = useRef<HTMLDivElement | null>(null);

  const size = (): { width: number; height: number } => ({
    width: frame.current?.clientWidth ?? 1200,
    height: frame.current?.clientHeight ?? 800,
  });

  const openPage = (pageId: string, target: OpenTarget = "focused"): string => {
    const definition = props.registry.get(pageId);
    const id = `${pageId}-${String(++nextTab)}`;
    const api = apiRef.current;

    if (api === null) return id;

    api.addPanel({
      id,
      component: "__page__",
      tabComponent: "__tab__",
      title: definition === undefined ? pageId : t(definition.titleKey),
      params: { pageId },
      ...(target === "main" ? { position: { direction: "right" } } : {}),
    });

    return id;
  };

  const closeTab = (tabId: string): void => {
    apiRef.current?.getPanel(tabId)?.api.close();
  };

  const host: FrameHost = {
    registry: props.registry,
    activity,
    layoutRevision: props.revision,
    openPage,
    closeTab,
  };

  const onReady = (event: DockviewReadyEvent): void => {
    apiRef.current = event.api;
    applying.current = true;

    const { serialized } = toDockview(latest.current, size());
    event.api.fromJSON(serialized as never);
    applying.current = false;

    event.api.onDidLayoutChange(() => {
      if (applying.current) return;

      const next = toLayoutDoc(event.api.toJSON() as never, latest.current);
      latest.current = next;
      props.onLayoutChange(next);
    });
  };

  useEffect(() => {
    const api = apiRef.current;

    if (api === null || docEquals(props.doc, latest.current)) return;

    applying.current = true;
    const { serialized } = toDockview(props.doc, size());
    api.fromJSON(serialized as never);
    applying.current = false;
    latest.current = props.doc;
  }, [props.doc, props.revision]);

  const contextMenu = (
    params: GetTabContextMenuItemsParams,
  ): Array<{ label: string; action: () => void }> => {
    const panelId = params.panel.api.id;
    const pageId = String((params.panel.params as { pageId?: string } | undefined)?.pageId ?? "");
    const definition = props.registry.get(pageId);

    if (definition?.pinned === true) return [];

    const pageOf = (panel: (typeof params.api.panels)[number]): string =>
      String((panel.params as { pageId?: string } | undefined)?.pageId ?? "");

    const close = (): void => {
      params.panel.api.close();
    };

    return [
      { label: t("page.frame.tab.close"), action: close },
      {
        label: t("page.frame.tab.closeOthers"),
        action: () => {
          for (const panel of params.api.panels) {
            if (panel.id === panelId) continue;
            if (props.registry.get(pageOf(panel))?.pinned !== true) panel.api.close();
          }
        },
      },
      {
        label: t("page.frame.tab.closeAll"),
        action: () => {
          for (const panel of params.api.panels) {
            if (props.registry.get(pageOf(panel))?.pinned !== true) panel.api.close();
          }
        },
      },
    ];
  };

  return (
    <div className="hz-frame" ref={frame}>
      <FrameHostProvider value={host}>
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
      </FrameHostProvider>
    </div>
  );
}
