/**
 * The composition root's about glue: the two channels, and the window they feed.
 *
 * Kept out of `main.ts` because that file is at its size gate and none of this
 * belongs in the boot order: the about window opens long after launch, on a menu
 * click, and the channels it uses answer from facts that are already on disk.
 *
 * This module is the only place that reads Electron for the about surface, so
 * the three paths a packaged build can put the legal documents in are computed
 * once, from the same facts the runtime layer uses. It also owns the conversion
 * from Electron's `openPath` answer (`""` on success) to the boolean-free
 * `{ok}` shape the channel answers with -- a window that reported "opened" for a
 * document with no handler would be wrong about the only thing its button does.
 */

import { app, shell, type App, type IpcMain } from "electron";
import path from "node:path";

import { registerAboutIpc } from "./about-ipc.js";
import { registerUpdateIpc } from "./update-check.js";
import { closeAboutWindow, openAboutWindow, type AboutWindowDeps } from "./about-window.js";
import type { Logger } from "./log.js";
import { computeRuntimeLayout } from "./runtime/layout.js";

/** Everything the composition root has to tell this module. */
export interface AboutInstallDeps {
  /** `__dirname` of the built main bundle: the preload and allow root sit beside it. */
  readonly here: string;
  readonly ipcMain: IpcMain;
  /** The locale resolved for this launch, read at click time. */
  readonly locale: () => string;
  /** The live theme mode and contrast, read at click time. */
  readonly theme: () => { readonly mode: string; readonly contrast: string };
  /** The inspector gate, shared with the shell window. */
  readonly devtoolsAllowed: () => boolean;
  /** The bundle the engine is running now, for the "where did it come from" answer. */
  readonly liveBundlePath: () => string | null;
  readonly logger?: Logger;
  /**
   * Test seam for the window opener.
   *
   * Production never passes it: the window is this module's own collaborator, and
   * an injected one would be a second way to create a second window. A test uses
   * it to observe that the menu entry reached the opener at all -- the failure
   * that motivated adding it was a click that silently did nothing.
   */
  readonly openWindow?: (deps: AboutWindowDeps) => Promise<unknown>;
}

/** What the composition root keeps: the menu's callback and the teardown. */
export interface AboutInstall {
  /** Open the window, or focus the one already open. */
  open(): void;
  /** Remove the two channels and close the window. */
  dispose(): void;
} /**
 * Install the about surface and hand back its one entry point.
 *
 * The teardown is registered here rather than returned to `main.ts`, because
 * `main.ts` is at its size gate and this surface's lifetime is its own concern:
 * its handlers belong to this process and its window to this session, and both
 * have to go when the process does.
 *
 * @param deps the composition root's facts
 * @returns the menu callback and the teardown
 */
export function installAbout(deps: AboutInstallDeps): AboutInstall {
  const layout = computeRuntimeLayout({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    here: deps.here,
    userData: app.getPath("userData"),
    logsDir: app.getPath("logs"),
  });

  const dispose = registerAboutIpc({
    ipc: {
      handle: (channel, listener) => {
        deps.ipcMain.handle(channel, listener);
      },
      removeHandler: (channel) => {
        deps.ipcMain.removeHandler(channel);
      },
    },
    appVersion: () => app.getVersion(),
    userData: app.getPath("userData"),
    engineDir: layout.engineDir,
    lockPath: layout.lockPath,
    paths: {
      isPackaged: app.isPackaged,
      // The directory the user unzipped into: the three documents belong there
      // because they must be readable without opening the archive.
      exeDir: path.dirname(app.getPath("exe")),
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      // `dist/main` sits four levels below the checkout root
      // (`main` -> `dist` -> `desktop` -> `apps` -> root); a packaged build
      // never reads this because the documents are beside the executable there.
      devRoot: path.resolve(deps.here, "..", "..", "..", ".."),
    },
    versions: {
      electron: process.versions.electron ?? "",
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    openPath: (target) => shell.openPath(target),
    liveBundlePath: deps.liveBundlePath,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });

  // The update button lives in this window, so its handler belongs to this
  // surface rather than to the composition root: the root registers a menu entry
  // and a window, and this call is what makes the window's one button answer.
  // Nothing here reaches the network - the handler only runs when the renderer
  // invokes it, which keeps a launch from spending a query quota nobody asked
  // for.
  const disposeUpdate = registerUpdateIpc({
    ipc: {
      handle: (channel, listener) => {
        deps.ipcMain.handle(channel, listener);
      },
      removeHandler: (channel) => {
        deps.ipcMain.removeHandler(channel);
      },
    },
    current: () => app.getVersion(),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });

  return {
    open: () => {
      const open = deps.openWindow ?? openAboutWindow;

      void open({
        here: deps.here,
        locale: deps.locale(),
        theme: deps.theme().mode,
        contrast: deps.theme().contrast,
        devtoolsAllowed: deps.devtoolsAllowed(),
        openExternal: (url) => {
          void shell.openExternal(url);
        },
        onFailure: (detail) => {
          deps.logger?.warn("about.window.failed", { detail });
        },
      });
    },
    dispose: () => {
      // Both halves: the handlers belong to this process, the window to this
      // user's session. Leaving the window open after its channels are gone
      // would show a page whose buttons all fail -- the worst of the two.
      closeAboutWindow();
      dispose();
      disposeUpdate();
    },
  };
}

/**
 * How this module asks to be torn down.
 *
 * A callback rather than an `app.on` call inside this file: the about surface is
 * one of several things the quit path has to release, and the composition root
 * owns the order. Taking the hook keeps this module free of a second quit path.
 */
export interface QuitHook {
  /** Register a callback to run before the process exits. */
  readonly onQuit: (callback: () => void) => void;
}

/**
 * Install the surface and tear it down when the process quits.
 *
 * One call from the composition root, which is why this exists: the root is at
 * its size gate, and "when does this go away" is a fact this module owns.
 *
 * @param deps the composition root's facts plus the quit hook
 * @returns the surface, for the menu
 */
export function installAboutOnQuit(deps: AboutInstallDeps & QuitHook): AboutInstall {
  const about = installAbout(deps);

  deps.onQuit(() => {
    about.dispose();
  });

  return about;
}

/**
 * Install the about surface from the composition root's own vocabulary.
 *
 * Exists so `main.ts` can call one function: the root is at its size gate, and
 * every line it keeps is a line something else has to give up. This assembles
 * the two facts the root knows and hands the rest to `installAboutOnQuit`, which
 * owns the lifetime.
 *
 * @param deps what the root has, named the way the root names it
 * @returns the surface, for the menu
 */
export function installAboutForRoot(deps: {
  readonly here: string;
  readonly ipcMain: IpcMain;
  readonly app: App;
  readonly settings: () => { readonly mode: string; readonly contrast: string };
  readonly locale: () => string;
  readonly devtoolsAllowed: () => boolean;
  readonly liveBundlePath: () => string | null;
  readonly logger?: Logger;
}): AboutInstall {
  return installAboutOnQuit({
    here: deps.here,
    ipcMain: deps.ipcMain,
    onQuit: (callback) => {
      deps.app.on("will-quit", callback);
    },
    locale: deps.locale,
    theme: deps.settings,
    devtoolsAllowed: deps.devtoolsAllowed,
    liveBundlePath: deps.liveBundlePath,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
}
