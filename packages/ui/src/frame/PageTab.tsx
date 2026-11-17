/**
 * The tab header.
 *
 * A custom header rather than dockview's default because pinned tabs have no
 * close affordance and the badge is driven by the external activity store. The
 * tab subscribes to one id, so a streaming terminal does not re-render its
 * neighbours.
 */

import { useEffect, useSyncExternalStore, type ReactElement } from "react";
import type { IDockviewPanelHeaderProps } from "dockview-react";

import { useT } from "../i18n/index.js";

import { badgeText } from "./activity.js";
import { useFrameHost } from "./host-context.js";
import type { PagePanelParams } from "./PageHost.js";

/** Render one tab: icon, title, badge, optional close. */
export function PageTab(props: IDockviewPanelHeaderProps<PagePanelParams>): ReactElement {
  const host = useFrameHost();
  const t = useT();
  const tabId = props.api.id;
  const params = (props.params ?? {}) as Record<string, unknown>;
  const pageId = typeof params["pageId"] === "string" ? params["pageId"] : "";
  const definition = host.registry.get(pageId);
  const activity = useSyncExternalStore(
    (listener) => host.activity.subscribe(tabId, listener),
    () => host.activity.get(tabId),
  );
  const badge = badgeText(activity);
  const pinned = definition?.pinned === true;

  useEffect(() => {
    if (props.api.isActive) host.activity.clearUnread(tabId);
  }, [host.activity, props.api, tabId]);

  return (
    <div className="hz-tab" data-active={props.api.isActive ? "true" : "false"}>
      {definition !== undefined && <span className="hz-tab__icon" aria-hidden="true" />}
      <span className="hz-tab__title">{props.api.title ?? pageId}</span>
      {badge !== null && (
        <span className="hz-tab__badge" aria-label={String(badge)}>
          {badge}
        </span>
      )}
      {!pinned && (
        <button
          type="button"
          className="hz-tab__close"
          aria-label={t("page.frame.tab.close")}
          onClick={(event) => {
            event.stopPropagation();
            // A page this build does not know is hidden rather than dropped:
            // the document keeps the tab so a later build can show it.
            if (definition === undefined) host.hideTab(tabId);
            else props.api.close();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
