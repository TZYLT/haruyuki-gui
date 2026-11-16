/**
 * The preload script: build the bridge over `ipcRenderer` and expose it.
 *
 * This file runs before the page's own scripts, in a context that is not the
 * page's and not the main process's. Two properties of that context shape
 * everything below:
 *
 *   `sandbox: true`   the preload is plain JavaScript with no module system of
 *                     its own. It cannot `import`, and the one module it may
 *                     load is `electron`, through `require`. That is why the
 *                     host is loaded below with `require` and not with an ESM
 *                     `import`: the bundler keeps `require("electron")` as an
 *                     external call, which is exactly the call the sandboxed
 *                     preload runtime provides.
 *   `contextIsolation: true`
 *                     the object handed to `exposeInMainWorld` is copied across
 *                     an isolated-world boundary, not shared by reference.
 *                     Functions survive the copy, plain data survives, and
 *                     anything with a prototype or a getter does not. The
 *                     bridge is therefore built from functions and one frozen
 *                     array of strings, and nothing else.
 *
 * What is exposed is `window.haruyuki`, with exactly three members. Nothing from
 * freezes. Nothing from Electron is exposed alongside it: `ipcRenderer` alone
 * would turn the allowlist into decoration, because a renderer holding it can
 * call any channel at all.
 */

import {
  BRIDGE_GLOBAL_NAME,
  type BridgeIpc,
  createBridge,
  type HaruyukiBridge,
} from "../shared/bridge.js";
import { installDropListener } from "./drop.js";
import type { DroppedFileReport } from "../shared/bridge.js";

/**
 * Electron's preload surface.
 *
 * `require` rather than `import`: with `sandbox: true` there is no ESM loader in
 * the preload context, so an ESM import of `electron` would be a module the
 * runtime cannot resolve. The type comes from `electron`'s own declaration,
 * which overloads `NodeRequire` for exactly this name, so the values below are
 * fully typed even though the load is not an ESM one.
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron") as typeof import("electron");

/**
 * `ipcRenderer` as the bridge's IPC surface.
 *
 * The cast is unavoidable and it is also the only one in the preload. `BridgeIpc`
 * narrows three methods to the shapes the bridge actually relies on and leaves
 * `electron`'s own declarations to describe everything else; TS will not accept
 * `IpcRenderer` directly, because Electron declares `on` and `removeListener` as
 * returning `this` and the bridge deliberately declares them as returning `void`.
 * Assigning through `unknown` keeps the check honest: both sides must still be
 * described by `BridgeIpc`, so a drifted method name or arity is still an error.
 */
const ipc: BridgeIpc = ipcRenderer as unknown as BridgeIpc;

/** The one bridge instance for this renderer. */
const bridge: HaruyukiBridge = createBridge(ipc);

/**
 * Expose it under the frozen global name.
 *
 * `exposeInMainWorld` throws if the key already exists, which is the behaviour
 * wanted: a second preload running in the same renderer is a configuration bug,
 * and failing loudly at startup is better than one bridge silently replacing the
 * other's allowlist.
 */
contextBridge.exposeInMainWorld(BRIDGE_GLOBAL_NAME, bridge);

/**
 * Drag-drop, installed inside the preload rather than exposed to the page.
 *
 * This is the only place a dropped file's path can be read: `File` is a renderer-side
 * object and `webUtils.getPathForFile` takes one, so the main process has no way to
 * do it -- not a policy choice, a type fact. The listener therefore converts the drop
 * itself and sends an already-converted `{name, path}[]` over one channel.
 *
 * `window.haruyuki` is still exactly three members. The
 * requirement is explicit that other items add *channels*, never members, and a
 * fourth member here would be a change to the frozen surface.
 */
installDropListener({
  addEventListener: (type, listener) => {
    // `window` rather than `document`: a drop on any part of the page is a drop, and
    // listening on `document` misses the areas outside the document box.
    window.addEventListener(type, listener as EventListener);
  },
  removeEventListener: (type, listener) => {
    window.removeEventListener(type, listener as EventListener);
  },
  pathForFile: (file) => {
    // `""` for a `File` the browser constructed -- measured, and a normal return
    // value rather than an error. The main process treats "no path" as one case.
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  invoke: (channel, payload) => {
    // `invoke` rather than `send`: the main process decides which dropped paths are
    // usable, so the answer is the part worth having. A one-way send would report the
    // page's guess instead of the outcome.
    return ipcRenderer.invoke(channel, payload) as Promise<DroppedFileReport>;
  },
  onError: (detail) => {
    // A trace rather than silence. There is no logger in the preload, and a drop that
    // fails without a word is the failure mode users report as "drag and drop does
    // nothing".
    console.warn("[haruyuki] drop", detail);
  },
});
