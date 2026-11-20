/**
 * The host element for one page instance.
 *
 * Dockview mounts this component once per tab and keeps it mounted while the
 * tab is inactive, so page state survives a switch. The page itself is chosen
 * from the registry here; an unknown id becomes the placeholder instead of a
 * thrown render, because a layout written by a newer build must still open.
 *
 * The error boundary retries by remounting the page: a page that threw during
 * render usually threw from state that a plain re-render would reproduce, and
 * the retry has to keep the same props. Remounting is
 * therefore expressed as a changing React key over the same element, not as a
 * different element.
 */

import { Component, Fragment, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";

import { ErrorState } from "../components/ErrorState.js";
import { useT } from "../i18n/index.js";

import { useFrameHost } from "./host-context.js";
import { UnknownPage } from "./UnknownPage.js";

/** The panel params every page tab carries. */
export type PagePanelParams = { pageId: string };

/** Catches a page render failure so the rest of the frame keeps working. */
class PageBoundary extends Component<
  { readonly children: ReactNode; readonly title: string },
  { readonly failed: boolean; readonly attempt: number }
> {
  state = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The page's own error is the useful detail; the frame only needs to know
    // that this tab is broken and the others are not.
    console.error("page render failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <ErrorState
          title={this.props.title}
          onRetry={() => this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }))}
        />
      );
    }

    // The key only changes on retry, so an ordinary re-render keeps the page
    // mounted; a retry remounts it with exactly the props it had.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}

/** Render one registered page, or the unknown-page placeholder. */
export function PageHost(props: IDockviewPanelProps<PagePanelParams>): ReactElement {
  const host = useFrameHost();
  const t = useT();
  const params = (props.params ?? {}) as Record<string, unknown>;
  const pageId = typeof params["pageId"] === "string" ? params["pageId"] : "";
  const definition = host.registry.get(pageId);
  const tabId = props.api.id;

  if (definition === undefined) {
    return <UnknownPage pageId={pageId} onHide={() => host.hideTab(tabId)} />;
  }

  const pageParams: Record<string, unknown> = { ...params };
  delete pageParams["pageId"];

  const Component = definition.component;

  return (
    <PageBoundary title={t("page.frame.error.title")}>
      <Component
        instanceId={tabId}
        pageId={pageId}
        params={pageParams}
        visible={props.api.isVisible}
        active={props.api.isActive}
        canClose={definition.pinned !== true}
        layoutRevision={host.layoutRevision}
        setTitle={(title) => props.api.setTitle(title)}
        setActivity={(update) => host.activity.set(tabId, update)}
        close={() => host.closeTab(tabId)}
        openPage={(next, _params, target) => host.openPage(next, target)}
      />
    </PageBoundary>
  );
}
