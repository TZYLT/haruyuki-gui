/**
 * The two-column fallback used when dockview cannot initialise.
 *
 * This is a capability degradation, not an error page (`59` section 4.8): the
 * left column lists side pages, the main column is a tab stack, and there is no
 * drag, nesting or popout. It reads the same `LayoutDoc` and renders the same
 * page components, so a user can still reach every page while the dock is
 * unavailable.
 *
 * It deliberately does not write the layout: with no dock there is no
 * authoritative grid to save, and overwriting the user's document from a
 * degraded view would lose the arrangement the next launch should try again.
 */

import { useState, type ReactElement } from "react";
import type { LayoutDoc, LayoutPanel } from "@haruyuki/protocol";

import { ErrorState } from "../components/ErrorState.js";
import { useT } from "../i18n/index.js";

import { createActivityStore, type ActivityStore } from "./activity.js";
import { FrameHostProvider, type FrameHost } from "./host-context.js";
import type { PageRegistry } from "./types.js";

/** @param node a document node @returns its panels in reading order */
function panelsOf(node: LayoutDoc["root"]): LayoutPanel[] {
  if (node.type === "panel") return [node];

  return node.children.flatMap(panelsOf);
}

/** @param panel a panel @param registry the page registry @returns whether the panel is a side panel */
function isSide(panel: LayoutPanel, registry: PageRegistry): boolean {
  return panel.tabs.some((tab) => registry.get(tab.pageId)?.zone === "side");
}

/** Render one page with the instance props the dock would have supplied. */
function FallbackPage({
  panel,
  tabId,
  registry,
  activity,
  openPage,
}: {
  readonly panel: LayoutPanel;
  readonly tabId: string;
  readonly registry: PageRegistry;
  readonly activity: ActivityStore;
  readonly openPage: (pageId: string) => string;
}): ReactElement {
  const tab = panel.tabs.find((item) => item.tabId === tabId);
  const t = useT();
  const definition = tab === undefined ? undefined : registry.get(tab.pageId);

  if (tab === undefined || definition === undefined) {
    return <ErrorState title={t("page.frame.error.title")} />;
  }

  const Component = definition.component;
  const params: Record<string, unknown> = { ...(tab.props ?? {}) };

  return (
    <Component
      instanceId={tabId}
      pageId={tab.pageId}
      params={params}
      visible
      active
      canClose={definition.pinned !== true}
      layoutRevision={0}
      setTitle={() => undefined}
      setActivity={(update) => activity.set(tabId, update)}
      close={() => undefined}
      openPage={(next) => openPage(next)}
    />
  );
}

/** Render the fallback frame. */
export function FallbackFrame({
  registry,
  doc,
}: {
  readonly registry: PageRegistry;
  readonly doc: LayoutDoc;
}): ReactElement {
  const t = useT();
  const [activity] = useState(() => createActivityStore());
  const [active, setActive] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ tabId: string; pageId: string } | null>(null);
  const panels = panelsOf(doc.root);
  const side = panels.filter((panel) => isSide(panel, registry));
  const main = panels.filter((panel) => !isSide(panel, registry));
  const mainTabs = main.flatMap((panel) => panel.tabs);
  const open = (pageId: string): string => {
    const existing = mainTabs.find((tab) => tab.pageId === pageId);

    if (existing !== undefined) {
      setActive(existing.tabId);
      return existing.tabId;
    }

    const tabId = `${pageId}-fallback`;
    setOpened({ tabId, pageId });
    setActive(tabId);

    return tabId;
  };

  const host: FrameHost = {
    registry,
    activity,
    layoutRevision: 0,
    openPage: (pageId) => open(pageId),
    closeTab: () => undefined,
    hideTab: () => undefined,
  };

  return (
    <FrameHostProvider value={host}>
      <div className="hz-fallback">
        <nav className="hz-fallback__side" aria-label={t("page.frame.sideRail.title")}>
          {side.flatMap((panel) =>
            panel.tabs.map((tab) => (
              <button
                key={tab.tabId}
                type="button"
                className="hz-fallback__entry"
                onClick={() => setActive(tab.tabId)}
              >
                {registry.get(tab.pageId) === undefined
                  ? tab.pageId
                  : t(registry.get(tab.pageId)!.titleKey)}
              </button>
            )),
          )}
        </nav>
        <section className="hz-fallback__main">
          <div className="hz-fallback__tabs" role="tablist">
            {mainTabs.map((tab) => (
              <button
                key={tab.tabId}
                type="button"
                role="tab"
                aria-selected={active === tab.tabId}
                onClick={() => setActive(tab.tabId)}
              >
                {registry.get(tab.pageId) === undefined
                  ? tab.pageId
                  : t(registry.get(tab.pageId)!.titleKey)}
              </button>
            ))}
          </div>
          {(() => {
            const panel =
              opened === null
                ? (main.find((item) => item.tabs.some((tab) => tab.tabId === active)) ?? main[0])
                : {
                    type: "panel" as const,
                    id: "fallback-extra",
                    tabs: [{ tabId: opened.tabId, pageId: opened.pageId }],
                  };
            const tabId = active ?? panel?.tabs[0]?.tabId;

            if (panel === undefined || tabId === undefined) {
              return <ErrorState title={t("page.frame.empty.title")} />;
            }

            return (
              <FallbackPage
                panel={panel}
                tabId={tabId}
                registry={registry}
                activity={activity}
                openPage={open}
              />
            );
          })()}
        </section>
      </div>
    </FrameHostProvider>
  );
}
