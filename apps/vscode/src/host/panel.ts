/**
 * The panel host: the one place this shell creates a `WebviewPanel`.
 *
 * Opening the panel is four decisions that only make sense together, and this
 * module is the only place that can make them:
 *
 * 1. **One panel.** The command, the tree item and the status bar are all entry
 *    points to the same panel, so a second creation would either show two docks
 *    side by side or silently replace the first one's document while its frame
 *    path kept posting into it. `open` therefore reveals an existing panel and
 *    only creates one when there is none. A closed panel clears the handle, so
 *    the next `open` builds a genuinely fresh document rather than revealing a
 *    disposed one.
 * 2. **A retained context.** The panel holds a live document with its own state;
 *    the editor's default is to tear that context down when the panel goes to a
 *    background tab. Restoring it on every return would be a reload the user
 *    sees. The cost is memory, and it is paid only while a panel is open.
 * 3. **Its own document, assets and policy.** The HTML is assembled by
 *    `./html.ts` with the panel's own origin, because `asWebviewUri` and the CSP
 *    source belong to this instance and no other.
 * 4. **A replay point, created immediately.** The frame path must exist before
 *    the first frame can arrive, and its initial announcement is what tells the
 *    document which protocol versions it is speaking; it is also the only thing
 *    that puts the panel back in sync after a return to visibility.
 *
 * The resource roots are deliberately two directories and not the workspace:
 * this panel ships its own bundle (`dist/webview`) and its own icon (`media`),
 * and nothing it renders is read from the user's files. A root it does not need
 * is a file it could be tricked into loading.
 *
 * Everything except the panel itself is injected -- the extension root, the
 * editor's language, the diagnostic sink and the template reader -- so the
 * lifetime rules above are exercised against a recording double instead of a
 * running editor.
 */

import { readFileSync } from "node:fs";

import * as vscode from "vscode";

import { FRAME_PROTOCOL_VERSION } from "@haruyuki/protocol";

import { createFramePath, type FramePath } from "./frame-path.js";
import { createWebviewHtml } from "./html.js";
import { APP_VERSION, BRIDGE_VERSION } from "../shared/version.js";

/** The panel type the editor registers this document under. */
export const PANEL_VIEW_TYPE = "haruyuki.panel";

/** The tab title, and the only string a user reads about this panel. */
export const PANEL_TITLE = "Haruyuki";

/** Subdirectory of the extension root that holds the bundled document. */
const WEBVIEW_DIRECTORY = "dist/webview";

/** Subdirectory of the extension root that holds the assets VS Code contributes. */
const MEDIA_DIRECTORY = "media";

/** The template file, relative to the bundled document's own directory. */
const TEMPLATE_FILE = "index.html";

/** Diagnostic sink: codes and counters, never a document or a payload. */
export type PanelLog = (code: string, detail?: Record<string, unknown>) => void;

/** Everything the host needs from the shell that creates it. */
export interface PanelHostOptions {
  /** `context.extensionUri`: the package root the two resource roots hang off. */
  readonly extensionUri: vscode.Uri;
  /**
   * `vscode.env.language`, exactly as the editor spells it.
   *
   * Passed through to the document verbatim: resolving it to a supported locale
   * is the panel's job and is answered in one place, so a second normalization
   * here would be a second table that can disagree with the first.
   */
  readonly language: string;
  /** Diagnostic sink for the lifecycle this module owns. */
  readonly log?: PanelLog;
  /**
   * Read the document template.
   *
   * Injected so a test can supply a template without a build tree. Defaults to a
   * synchronous local read: the template ships inside the installed extension,
   * so it is a small local file rather than anything that could be slow.
   */
  readonly readTemplate?: (absolutePath: string) => string;
}

/** The handle the extension entry keeps, and the one `deactivate` calls. */
export interface PanelHost {
  /** Create the panel, or reveal it when one is already open. Idempotent. */
  open(): void;
  /** Dispose the panel and everything it owns. Idempotent. */
  close(): Promise<void>;
}

/** The one panel this host may have open. */
type Live = {
  readonly panel: vscode.WebviewPanel;
  readonly framePath: FramePath;
};

/**
 * Build the panel host.
 *
 * The handle owns at most one panel and no module-level state, so two hosts in
 * one process cannot reach each other's document. Nothing is created here and
 * nothing is read: a host that is never opened costs one closure and nothing
 * else.
 *
 * @param options the extension root, the language and the diagnostic sink
 * @returns the opener the extension entry installs
 */
export function createPanelHost(options: PanelHostOptions): PanelHost {
  const log = options.log ?? ((): void => undefined);
  const readTemplate = options.readTemplate ?? defaultReadTemplate;

  /** At most one panel, and exactly the one whose `onDidDispose` has not fired. */
  let live: Live | null = null;

  /** The two roots, resolved on first use so activation joins nothing. */
  let roots: { readonly webview: vscode.Uri; readonly media: vscode.Uri } | null = null;

  /** The template, read once per host: it cannot change while this one lives. */
  let template: string | null = null;

  /** Resolve the two directories this panel is allowed to read. */
  function resolveRoots(): { readonly webview: vscode.Uri; readonly media: vscode.Uri } {
    roots ??= {
      webview: vscode.Uri.joinPath(options.extensionUri, WEBVIEW_DIRECTORY),
      media: vscode.Uri.joinPath(options.extensionUri, MEDIA_DIRECTORY),
    };

    return roots;
  }

  /**
   * Read the document template on first use.
   *
   * @returns the bundled template
   */
  function loadTemplate(): string {
    if (template === null) {
      template = readTemplate(vscode.Uri.joinPath(resolveRoots().webview, TEMPLATE_FILE).fsPath);
    }

    return template;
  }

  /**
   * Fill one panel's document.
   *
   * @param panel the panel to fill
   */
  function showDocument(panel: vscode.WebviewPanel): void {
    const { webview } = resolveRoots();

    panel.webview.html = createWebviewHtml({
      template: loadTemplate(),
      cspSource: panel.webview.cspSource,
      // Bound to this panel: a URI resolved against another instance's origin
      // would be refused by this one's policy.
      resolveAsset: (relativePath: string) => {
        return panel.webview.asWebviewUri(vscode.Uri.joinPath(webview, relativePath)).toString();
      },
      appVersion: APP_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      frameProtocolVersion: FRAME_PROTOCOL_VERSION,
      language: options.language,
    });
  }

  return {
    open(): void {
      if (live !== null) {
        // Revealing is the whole of a second open: the document, its frame path
        // and its pending commands are the ones already running.
        live.panel.reveal();

        log("PANEL_REVEALED", {});

        return;
      }

      const panel = vscode.window.createWebviewPanel(
        PANEL_VIEW_TYPE,
        PANEL_TITLE,
        vscode.ViewColumn.Active,
        {
          // The document must be allowed to run its own bundle; without this the
          // panel renders an empty frame and no error.
          enableScripts: true,
          // The document carries live state (a dock layout, a scroll position,
          // a terminal buffer). Rebuilding it on every return to the tab would
          // be a reload the user sees, so the context is retained.
          retainContextWhenHidden: true,
          // Two directories, not the workspace: this panel reads only what it
          // ships, and a root it does not need is a file it could load.
          localResourceRoots: [resolveRoots().webview, resolveRoots().media],
        },
      );

      // The document first: a message posted to a panel with no document has
      // nothing listening for it, and the announcement below is a message.
      showDocument(panel);

      // Then the replay point, immediately: it must exist before the first frame
      // can arrive, and its initial announcement is what tells the document which
      // protocol versions it is speaking. Constructed before `live` is assigned
      // so a failure here leaves no half-built handle behind.
      const framePath = createFramePath(panel, {
        appVersion: APP_VERSION,
        bridgeVersion: BRIDGE_VERSION,
        frameProtocolVersion: FRAME_PROTOCOL_VERSION,
        log,
      });

      live = { panel, framePath };

      framePath.announce();

      // One subscription, and it clears the handle rather than only the frame
      // path: the next `open` must build a new document, not reveal this one.
      panel.onDidDispose(() => {
        if (live?.panel !== panel) return;

        live = null;
        framePath.dispose();

        log("PANEL_DISPOSED", {});
      });

      log("PANEL_OPENED", {});
    },

    async close(): Promise<void> {
      const current = live;

      if (current === null) return;

      live = null;

      // The frame path goes first so no replay can be posted into a panel that
      // is about to be disposed; the disposal itself is what tears the document
      // down, and its own listener then sees a handle that is already gone.
      current.framePath.dispose();

      current.panel.dispose();

      log("PANEL_CLOSED", {});
    },
  };
}

/**
 * Read the bundled template from the installed extension.
 *
 * @param absolutePath the template's path
 * @returns its contents
 */
function defaultReadTemplate(absolutePath: string): string {
  return readFileSync(absolutePath, "utf8");
}
