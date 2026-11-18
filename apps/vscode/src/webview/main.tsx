/**
 * The webview entry: the React application that runs inside the panel.
 *
 * This module mounts and nothing else. It has no `require`, no `process` and no
 * Node builtins, because it is served into a VS Code webview and runs in a
 * browser context: the only things it can reach are the DOM and whatever the
 * shared UI package hands it. Talking to the extension host is therefore not
 * here -- a bridge module owns that seam -- and this file only decides which
 * tree is drawn over a document it keeps in memory.
 *
 * The provider order follows the desktop shell (`LocaleProvider` outermost, the
 * frame inside it) so the two shells render the same shared components under
 * the same contexts. What is deliberately absent is the desktop's error
 * boundary and its runtime gate: neither is exported by the shared UI package,
 * and a private copy here would be a second implementation of behaviour the
 * frame already answers for (`AppFrame` falls back to a two-column frame when
 * its dock does not mount). A shell-level boundary is the right thing to add
 * once the UI package owns one.
 */

import { StrictMode, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { LayoutDoc } from "@haruyuki/protocol";

import { AppFrame, LocaleProvider } from "@haruyuki/ui";

import { applyLayoutChange, readLayout } from "./layout.js";
import { createRegistry } from "./registry.js";

/**
 * The locale this panel renders in.
 *
 * A constant on purpose: the extension host has not told this webview anything
 * yet, so guessing from the window or a query parameter would invent a second
 * source of truth for a value a later work package pushes down. When it does,
 * only this constant is replaced by a prop.
 */
const WEBVIEW_LOCALE = "en";

/** The id the HTML template has to provide, and the only thing it provides. */
export const WEBVIEW_ROOT_ID = "root";

/**
 * The frame, wired to the in-memory document.
 *
 * The document lives in React state so a change repaints, and in the layout
 * module so a reader without React can ask what is open. Both are updated from
 * the one callback, in that order: the store keeps the document the frame will
 * compare against, and the state update is what makes it render.
 *
 * The revision only ever moves locally. It exists because the frame treats a
 * `doc` prop as foreign until it is told something changed, and because the
 * save path this shell will grow needs a revision to be based on; no save path
 * is wired yet, so nothing is persisted.
 *
 * @returns the frame inside its locale provider
 */
export function WebviewApp(): ReactElement {
  const [layout, setLayout] = useState<{ readonly doc: LayoutDoc; readonly revision: number }>(
    () => ({ doc: readLayout(), revision: 0 }),
  );
  const registry = createRegistry();

  return (
    <LocaleProvider locale={WEBVIEW_LOCALE}>
      <AppFrame
        registry={registry}
        doc={layout.doc}
        revision={layout.revision}
        onLayoutChange={(doc) => {
          setLayout((current) => ({ doc: applyLayoutChange(doc), revision: current.revision + 1 }));
        }}
      />
    </LocaleProvider>
  );
}

/**
 * Mount the application into a container.
 *
 * @param container the element the tree is drawn into
 * @returns a function that unmounts the tree
 */
export function mountWebview(container: HTMLElement): () => void {
  const root = createRoot(container);

  root.render(
    <StrictMode>
      <WebviewApp />
    </StrictMode>,
  );

  return () => root.unmount();
}

/**
 * Mount into the template's `#root`.
 *
 * A missing container is a broken template rather than a recoverable state: the
 * page would render nothing, and a silent no-op would make that look like a
 * rendering bug instead of a build one.
 */
function bootstrap(): void {
  const container = document.getElementById(WEBVIEW_ROOT_ID);

  if (container === null) {
    throw new Error(`the webview document needs a #${WEBVIEW_ROOT_ID} element`);
  }

  mountWebview(container);
}

bootstrap();
