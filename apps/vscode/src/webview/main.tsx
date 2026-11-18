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

import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { AppFrame, LocaleProvider } from "@haruyuki/ui";

import { createRegistry } from "./registry.js";
import { applyShellTheme } from "./theme.js";
import { useBridgeNotice, useLayout, webviewTransport } from "./transport.js";

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
 * The frame, wired to the layout store.
 *
 * The document lives in an external store rather than in React state, because
 * two readers need the same answer at different times: the frame compares the
 * document it was handed by reference against the one it applied, and a change
 * that lands between a render and its effect must still repaint. Both are what
 * `useSyncExternalStore` guarantees and what a state pair updated from a
 * callback does not.
 *
 * The revision only ever moves locally: it exists because the frame treats a
 * `doc` prop as foreign until it is told something changed. No save path is
 * wired in this build, so a change is not persisted -- see `transport.ts` for
 * why that is stated rather than approximated.
 *
 * @returns the frame inside its locale provider
 */
export function WebviewApp(): ReactElement {
  const layout = useLayout();
  const banner = useBridgeNotice();
  const registry = createRegistry();

  return (
    <LocaleProvider locale={WEBVIEW_LOCALE}>
      <AppFrame
        registry={registry}
        doc={layout.doc}
        revision={layout.revision}
        {...(banner === undefined ? {} : { banner })}
        onLayoutChange={(doc) => {
          webviewTransport().layout.setDoc(doc);
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

  // The theme seam: before the first paint, so the panel never flashes the
  // palette while the editor's already says otherwise.
  applyShellTheme();

  mountWebview(container);
}

bootstrap();
