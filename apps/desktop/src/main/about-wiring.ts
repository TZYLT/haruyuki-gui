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

import { app, shell, type IpcMain } from "electron";
import path from "node:path";

import { registerAboutIpc } from "./about-ipc.js";
import { openAboutWindow } from "./about-window.js";
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
}

/** What the composition root keeps: the menu's callback and the teardown. */
export interface AboutInstall {
  /** Open the window, or focus the one already open. */
  open(): void;
  /** Remove the two channels and close the window. */
  dispose(): void;
}

/**
 * Install the about surface and hand back its one entry point.
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

  return {
    open: () => {
      void openAboutWindow({
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
      dispose();
    },
  };
}
