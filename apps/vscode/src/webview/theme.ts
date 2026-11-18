/**
 * Follow the editor's theme inside the panel.
 *
 * The shared UI package already owns a token layer and an adapter that maps a
 * host's `--vscode-*` variables onto our `--ui-*` slots. This module is the
 * small amount of wiring between the two: it installs the tokens once, asks the
 * adapter which combination the editor's `body` class implies, activates that
 * combination, and copies the host variables across.
 *
 * Nothing here invents a token, a colour or a component variant. A component
 * keeps reading `--ui-*` and never learns that it is inside an editor, which is
 * the property that makes this an adapter rather than a second theme.
 *
 * Why an observer instead of an event: the editor does not tell a webview that
 * the user switched themes. It swaps a class on `document.body`, and that class
 * is the only signal a panel ever gets. A `MutationObserver` on that one
 * attribute is therefore the whole refresh mechanism; a listener on `window`
 * would never fire.
 *
 * Lifecycle: a panel document survives reloads and may be torn down, so the
 * observer is exposed through a handle rather than parked in a module global
 * nobody can reach. A caller that finishes with a panel stops the observation;
 * a caller that does not is relying on the document going away with the
 * observer.
 */

import {
  VSCODE_TOKEN_MAP,
  applyHostTokens,
  applyTheme,
  hostThemeCombination,
  installTokens,
  type ThemeAttrs,
} from "@haruyuki/ui";

/** A live theme binding for one document. */
export interface ShellTheme {
  /**
   * Re-read the host and re-apply the theme.
   *
   * Safe at any time and idempotent: token installation is keyed by its own
   * style element, so a repeat cannot stack a second sheet, and the two theme
   * attributes are overwritten rather than accumulated.
   *
   * @returns the combination that was activated
   */
  refresh(): ThemeAttrs;

  /** Stop observing the host. Later `refresh` calls still work; safe to repeat. */
  dispose(): void;
}

/** The binding this module currently owns, so a repeat call reuses it. */
let current: { readonly document: Document; readonly shell: ShellTheme } | null = null;

/**
 * Activate the host theme on a document and keep it in sync.
 *
 * The first call does the work: install the tokens, decide the combination,
 * apply it, map the host variables, then watch `body` for a class change. Every
 * later call on the same document only refreshes -- it neither installs a second
 * stylesheet nor attaches a second observer, which is what makes the call safe
 * from a render path.
 *
 * A call for a different document tears the previous binding down first: two
 * documents in one process is not a case the panel exercises, but a live
 * observer pointed at an abandoned document is a leak that would only show up
 * as a panel that slowly stops repainting.
 *
 * @param doc the document to theme, defaults to the ambient one
 * @returns the binding, so a caller can dispose it
 */
export function applyShellTheme(doc?: Document): ShellTheme {
  const target = doc ?? globalThis.document;

  if (target === undefined) {
    throw new Error("applyShellTheme needs a Document; none was passed and none is ambient");
  }

  if (current !== null && current.document === target) {
    current.shell.refresh();

    return current.shell;
  }

  current?.shell.dispose();

  const body = target.body;

  if (body === null) {
    throw new Error("applyShellTheme needs a <body>: it is the element the host class rides on");
  }

  const root = target.documentElement;

  /**
   * Read the host, then write our two attributes and the mapped slots.
   *
   * A slot is cleared before it is re-mapped. Without that, a slot whose host
   * variable disappeared between two themes would keep the previous theme's
   * inline value and could never fall back to the palette -- the editor does
   * change which variables it publishes, not only their values. The slots
   * cleared are exactly the ones the adapter can write, taken from its own map,
   * so this cannot touch a slot the adapter does not own.
   *
   * The mapped slots are inline custom properties on the root, which beat any
   * rule in the sheet regardless of insertion order, so a host value wins over
   * the palette for the whole subtree.
   *
   * @returns the combination that was activated
   */
  function refresh(): ThemeAttrs {
    installTokens(target);

    const attrs = hostThemeCombination(body);

    applyTheme(attrs, target);

    for (const slot of Object.keys(VSCODE_TOKEN_MAP)) {
      root.style.removeProperty(slot);
    }

    applyHostTokens(body, root);

    return attrs;
  }

  refresh();

  const observer = new MutationObserver(() => {
    refresh();
  });

  observer.observe(body, { attributes: true, attributeFilter: ["class"] });

  let disposed = false;

  const shell: ShellTheme = {
    refresh,
    dispose() {
      if (disposed) return;

      disposed = true;
      observer.disconnect();

      if (current?.shell === shell) current = null;
    },
  };

  current = { document: target, shell };

  return shell;
}
