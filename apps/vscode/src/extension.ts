/**
 * The extension host entry: what VS Code loads, and the only place this shell
 * binds the editor's API.
 *
 * Activation is registration and nothing else
 *   `activate` creates the two surfaces a user can see (an output channel and a
 *   status-bar item), registers the command and the tree view, and returns. It
 *   starts no core child, spawns no engine and reads no engine directory: those
 *   cost a process and a port, and an editor that pays them on every window
 *   start for a panel nobody opened is the exact cost the lazy activation
 *   design exists to avoid. The start happens inside {@link openPanel}, which
 *   only a command or a tree item can reach.
 *
 *   That rule is asserted, not just documented: the test installs a spy opener,
 *   activates, and expects zero calls, then invokes the registered command and
 *   expects the first one.
 *
 * The panel is not this file's to build
 *   Opening the panel is a `WebviewPanel`, a document and a CSP, and that is a
 *   separate body of work with its own files. This file declares the seam it
 *   will arrive through -- {@link setPanelOpener} -- and calls it. Until
 *   something installs an opener, clicking says so in the log and opens nothing,
 *   which is the honest state of a shell whose panel is not written yet rather
 *   than a placeholder panel that would have to be thrown away.
 *
 * The activity bar cannot carry a command
 *   `contributes.viewsContainers.activitybar` declares a container; the
 *   container itself has no click handler. The command therefore sits on the
 *   single {@link vscode.TreeItem} the view shows, which is what makes the
 *   icon an entry point at all.
 */

import * as vscode from "vscode";

import { createShellLog, type ShellLog } from "./host/log.js";
import { createStatusBar, type StatusBar } from "./host/status.js";
import { COMMAND_OPEN_PANEL, OUTPUT_CHANNEL_NAME, VIEW_LAUNCHER } from "./shared/channels.js";
import { APP_VERSION } from "./shared/version.js";

/**
 * What this file needs in order to open the panel.
 *
 * Deliberately one method: an opener that also knew how to close would be a
 * lifetime owner, and the panel's lifetime -- the `WebviewPanel`, its frame
 * path, its command path -- belongs to the module that creates it. `close` is
 * optional for the same reason: a shell that has nothing to tear down at
 * deactivation has nothing to implement.
 */
export interface PanelOpener {
  /** Create the panel, or focus it when it is already there. Must be idempotent. */
  open(): void;
  /** Release the panel and everything it owns. Called once, from `deactivate`. */
  close?(): Promise<void>;
}

/**
 * The seam the panel arrives through.
 *
 * The panel implementation (its document, its CSP, its frame path, its command
 * path) installs itself here. It is a module-level variable rather than a
 * parameter because `activate` is called by VS Code with an argument this shell
 * does not choose, and the panel module is loaded by the extension host, not by
 * this one.
 */
let panelOpener: PanelOpener | undefined;

/** The log the entry writes to; retained so `deactivate` can report itself. */
let shellLog: ShellLog | undefined;

/** The status bar, retained so `deactivate` can return it to idle. */
let statusBar: StatusBar | undefined;

/**
 * Install the panel opener.
 *
 * Passing `undefined` removes the current one, which is what a test does to
 * leave no seam behind between cases. Replacing an opener is allowed: a second
 * activation of the same window is not a case VS Code produces.
 *
 * @param opener the panel implementation, or `undefined` to remove it
 */
export function setPanelOpener(opener: PanelOpener | undefined): void {
  panelOpener = opener;
}

/**
 * Open the panel.
 *
 * This is the whole of what the command does. It is a named export so the
 * status-bar click, the tree item and the command palette all reach one
 * function rather than three copies of the same three lines.
 */
export function openPanel(): void {
  // Logged before the seam: when the opener is missing this line is the only
  // thing that tells the user the click was received.
  shellLog?.event("PANEL_OPEN_REQUESTED", { appVersion: APP_VERSION });

  if (panelOpener === undefined) {
    shellLog?.write(
      "the panel is not wired in this build: no panel opener is installed, so the command did nothing",
    );

    return;
  }

  try {
    panelOpener.open();
  } catch (error) {
    // The one call that turns a thrown panel failure into a log line: the
    // summary drops the stack and the redaction still runs before the append.
    shellLog?.failure("PANEL_OPEN_FAILED", error);

    statusBar?.set("failed");
  }
}

/**
 * The one item the launcher view shows.
 *
 * `command` is what makes the activity-bar icon do something: without it the
 * item is a label that selects and nothing else.
 */
function createLauncherItem(): vscode.TreeItem {
  const item = new vscode.TreeItem("Haruyuki", vscode.TreeItemCollapsibleState.None);

  item.id = VIEW_LAUNCHER;
  item.tooltip = "Open the Haruyuki panel";
  item.command = {
    command: COMMAND_OPEN_PANEL,
    title: "Open Haruyuki Panel",
  };

  return item;
}

/** The launcher view's content: one item, and it opens the panel. */
const launcherProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  },

  getChildren(element: vscode.TreeItem | undefined): vscode.TreeItem[] {
    // A container with children would be a menu to maintain; the launcher is
    // one entry point, so the root is the whole tree.
    return element === undefined ? [createLauncherItem()] : [];
  },
};

/**
 * Activate the extension.
 *
 * Everything it does is registration: no child process, no port, no engine
 * lookup. See the file comment for why that is a rule rather than a preference.
 *
 * @param context the extension context VS Code hands over
 */
export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const log = createShellLog({ channel });

  shellLog = log;
  log.event("EXTENSION_ACTIVATED", { appVersion: APP_VERSION });

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const status = createStatusBar({
    item,
    log: (code, fields) => log.event(code, fields),
  });

  statusBar = status;

  const command = vscode.commands.registerCommand(COMMAND_OPEN_PANEL, () => {
    openPanel();
  });

  const treeView = vscode.window.createTreeView(VIEW_LAUNCHER, {
    treeDataProvider: launcherProvider,
  });

  context.subscriptions.push(channel, item, command, treeView);
}

/**
 * Deactivate the extension.
 *
 * The opener is asked to release the panel first, because it owns everything
 * that would otherwise outlive the window. Nothing here starts anything, so a
 * deactivation of a window where no panel was ever opened is a no-op.
 *
 * @returns a promise that settles once the panel is gone
 */
export async function deactivate(): Promise<void> {
  const log = shellLog;

  statusBar?.set("inactive");

  const opener = panelOpener;

  panelOpener = undefined;

  if (opener?.close === undefined) {
    log?.event("EXTENSION_DEACTIVATED", { panel: false });

    return;
  }

  try {
    await opener.close();
    log?.event("EXTENSION_DEACTIVATED", { panel: true });
  } catch (error) {
    // A failure to close is reported and swallowed: VS Code waits on this
    // promise, and a rejection here would surface as a crash during shutdown.
    log?.failure("PANEL_CLOSE_FAILED", error);
  }
}
