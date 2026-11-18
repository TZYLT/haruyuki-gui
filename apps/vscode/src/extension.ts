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
 * The panel is installed here, built elsewhere
 *   Opening the panel is a `WebviewPanel`, a document and a CSP, and those live
 *   in `./host/panel.ts`. This file declares the seam it arrives through --
 *   {@link setPanelOpener} -- installs the host during activation and calls it.
 *   Constructing the host starts nothing: it joins two URIs and reads no
 *   document, so the panel itself is still created only when a command or a tree
 *   item asks for it. A build that installs no opener would say so in the log
 *   and open nothing, which is why the seam stays optional.
 *
 * The activity bar cannot carry a command
 *   `contributes.viewsContainers.activitybar` declares a container; the
 *   container itself has no click handler. The command therefore sits on the
 *   single {@link vscode.TreeItem} the view shows, which is what makes the
 *   icon an entry point at all.
 */

import { homedir } from "node:os";

import * as vscode from "vscode";

import { createController, type Controller } from "./host/controller.js";
import { createVSCodeEngineSettings } from "./host/engine-source.js";
import { createLifecycle, type Lifecycle, type LifecycleCoreHost } from "./host/lifecycle.js";
import { createShellLog, type ShellLog } from "./host/log.js";
import { createPanelHost, type PanelLinkFactory } from "./host/panel.js";
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
 * The core child this activation started, and where its token went.
 *
 * Both are `undefined` until something opens the panel: activation itself starts
 * nothing (see the file comment). The opener that does start the child hands it
 * over through {@link setCoreHost}, so teardown never has to guess a path or
 * reach into another module's state.
 */
let coreHost: LifecycleCoreHost | undefined;
let tokenDir: string | undefined;

/**
 * Record the core child this activation owns.
 *
 * Called by whatever starts the child -- the controller -- so `deactivate` knows
 * what to stop and which single directory holds the token file. Passing
 * `undefined` forgets it, which is what a test does to leave no state behind.
 *
 * @param host the running child, or `undefined` when none was started
 * @param dir the directory the engine wrote its capability token into
 */
export function setCoreHost(host: LifecycleCoreHost | undefined, dir?: string): void {
  coreHost = host;
  tokenDir = dir;
}

/**
 * The panel actions that need an editor surface.
 *
 * The ones that only move the controller's own state never reach here; what does
 * is a request for something only the editor can show -- its settings page, a
 * folder picker, the log channel. A request this build does not answer is logged
 * rather than swallowed, so a button that does nothing says so somewhere.
 *
 * @param action the action the panel sent
 */
function handlePanelAction(action: string): void {
  switch (action) {
    case "openSettings":
      void vscode.commands.executeCommand("workbench.action.openSettings", "haruyuki.enginePath");

      return;

    case "openLogs":
      shellLog?.show();

      return;

    default:
      shellLog?.event("PANEL_ACTION_UNHANDLED", { action });
  }
}

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

  // The assembly itself. Built here but started later: constructing it builds a
  // host port, a secret store and two subscriptions, and starts no process, so
  // activation still costs nothing and the seam is filled by the time any entry
  // point can be reached. `open` is what forks the child, and it does so once.
  const controller: Controller = createController({
    extensionPath: context.extensionUri.fsPath,
    secrets: context.secrets,
    storageRoot: context.globalStorageUri.fsPath,
    toFileUri: (absPath) => vscode.Uri.file(absPath),
    locale: vscode.env.language,
    // Read at start rather than at activation: the user may have opened a folder
    // in between, and a window that starts without one is the case the
    // degradation exists for.
    folders: vscode.workspace.workspaceFolders,
    homeDir: homedir(),
    settings: createVSCodeEngineSettings((section) => vscode.workspace.getConfiguration(section)),
    ...(process.env["PATH"] === undefined ? {} : { pathEnv: process.env["PATH"] }),
    log,
    status,
    createPanel: (link: PanelLinkFactory) =>
      createPanelHost({
        extensionUri: context.extensionUri,
        language: vscode.env.language,
        log: (code, fields) => log.event(code, fields),
        createLink: link,
      }),
    // The child and its token directory reach `deactivate` through the one seam
    // the teardown reads, so nothing here has to be duplicated there.
    onStarted: (host, dir) => {
      setCoreHost(host, dir);
    },
    onAction: (action) => {
      handlePanelAction(action);
    },
  });

  setPanelOpener({
    open: () => {
      controller.open();
    },
    close: async () => {
      await controller.close();
    },
  });

  context.subscriptions.push(channel, item, command, treeView);
}

/**
 * Deactivate the extension.
 *
 * The whole teardown is one call into {@link createLifecycle}, which owns the
 * order -- panel, then the core child (which stops the engine first), then the
 * capability-token file, then the status bar -- and the budget it runs inside.
 * Nothing about that order is repeated here: a second copy of a sequence is a
 * second sequence, and the one that runs would be whichever was edited last.
 *
 * Every module-level handle is cleared before the teardown starts, so a
 * deactivation that is still in flight cannot be observed by a call that
 * happens during it, and a reactivated window starts from no shared state.
 *
 * @returns a promise that settles once the teardown is over, within its budget
 */
export async function deactivate(): Promise<void> {
  const log = shellLog;
  const opener = panelOpener;
  const host = coreHost;
  const dir = tokenDir;

  panelOpener = undefined;
  coreHost = undefined;
  tokenDir = undefined;

  const lifecycle: Lifecycle = createLifecycle({
    panel: opener,
    coreHost: host,
    tokenDir: dir,
    log,
    status: statusBar,
  });

  await lifecycle.dispose();

  log?.event("EXTENSION_DEACTIVATED", {
    panel: opener?.close !== undefined,
    core: host !== undefined,
  });
}
