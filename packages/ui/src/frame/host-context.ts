/**
 * The host capabilities a page may use.
 *
 * Passed through React context rather than through dockview panel params: the
 * params are persisted layout data and must stay serializable, while these are
 * live callbacks. Keeping them out of params also means a page cannot accidentally
 * write a function into the layout document.
 */

import { createContext, createElement, useContext } from "react";
import type { ReactNode, ReactElement } from "react";

import type { ActivityStore } from "./activity.js";
import type { OpenTarget, PageRegistry } from "./types.js";

/** What `PageHost` and `PageTab` need from the frame. */
export interface FrameHost {
  readonly registry: PageRegistry;
  readonly activity: ActivityStore;
  readonly layoutRevision: number;
  openPage(pageId: string, target?: OpenTarget): string;
  closeTab(tabId: string): void;
  /**
   * Close the tab *without deleting it from the layout document*.
   *
   * This is the path for a page this build cannot render (`59` section 4.4): the
   * tab leaves the dock, the document keeps it with `hidden: true`, and a later
   * build that registers the page shows it again. `closeTab` is the ordinary
   * close, which really does drop the tab.
   */
  hideTab(tabId: string): void;
}

const CONTEXT = createContext<FrameHost | null>(null);

/** Provide the host to one frame tree. */
export function FrameHostProvider({
  value,
  children,
}: {
  value: FrameHost;
  children: ReactNode;
}): ReactElement {
  return createElement(CONTEXT.Provider, { value }, children);
}

/** Read the host; throws outside a frame so the mistake is immediate. */
export function useFrameHost(): FrameHost {
  const host = useContext(CONTEXT);

  if (host === null) {
    throw new Error("frame host is not available outside AppFrame");
  }

  return host;
}
