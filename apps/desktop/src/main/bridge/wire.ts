/**
 * D3's wiring between the shell and the bridge host.
 *
 * Kept out of `main.ts` for the reason the file-size gate exists: `main.ts` owns the
 * window, the protocol and the settings document, and those are already a file's
 * worth. The split is by responsibility, though -- this module is the one place that
 * knows a *renderer generation* is not a window: a reload replaces the session while
 * the host, and every producer holding it, outlives the window that reloaded.
 *
 * Everything the shell supplies is a value (the version the accept frame reports, a
 * log sink) or a window; nothing here reads the shell's settings.
 */

import { app, ipcMain, type BrowserWindow } from "electron";

import { FRAME_PROTOCOL_VERSION } from "@haruyuki/protocol";
import type { Frame, LayoutState } from "@haruyuki/protocol";

import { BRIDGE_VERSION } from "./channels.js";
import { createBridgeHost } from "./host.js";
import { registerBridgeIpc } from "./register.js";
import type { BridgeSessionHost } from "./types.js";

/** How the shell logs one bridge event. */
export type BridgeLog = (event: string, detail?: Record<string, unknown>) => void;

/** What the shell holds for its lifetime: one host, one `ipcMain` registration. */
export interface BridgeWiring {
  /** Follow one window's renderer generations, starting with the boot one. */
  attachWindow(window: BrowserWindow): void;
  /**
   * The version facts the renderer cannot import at runtime (rule R7).
   *
   * They travel in the boot URL so a mismatch is the renderer's `bridge.ready`
   * rather than a silent default.
   */
  bootParams(): Record<string, string>;
  /**
   * The producer-side sink, exactly `BridgeSessionHost.send`.
   *
   * Layout and engine-event producers hold this rather than a sender: a reload
   * replaces the session behind the host, while the host itself outlives the
   * window that reloaded.
   */
  readonly send: (frame: Frame) => void;
  /**
   * Point the submit path's consume hook at whoever answers control frames.
   *
   * The hook is read through a stable closure installed at registration, so a
   * consumer assembled after this wiring (which is the order the composition
   * root builds them in: the bridge carries layout snapshots, the command path
   * and the session frames, and those need the store) can still take its
   * frames without re-registering a single `ipcMain` handler -- a window
   * between `removeHandler` and the next `handle` would reject any `invoke()`
   * that raced it.
   *
   * `null` restores the absent state: every frame takes the existing path.
   */
  setControlFrameHook(hook: ((payload: string) => boolean) | null): void;
  /** Removes the `ipcMain` handlers and closes the host; idempotent. */
  dispose(): void;
}

/**
 * Create the app-wide host and wire it to IPC.
 *
 * One host per app, not per window: a reload replaces the session behind it, and the
 * producers hold the host rather than any sender.
 *
 * @param options the version the accept frame reports, where events are logged,
 *   and the optional C4 providers the shell may not have built yet
 */
export function wireBridge(options: {
  coreVersion: string;
  log: BridgeLog;
  /** C4's write path; absent until the layout wiring is ready. */
  layoutSave?: (request: unknown) => Promise<unknown> | unknown;
  /** C4's read path; absent until the layout wiring is ready. */
  layoutState?: () => LayoutState;
  /**
   * Control-frame consumer, for a caller that already has one.
   *
   * The eager form of {@link BridgeWiring.setControlFrameHook}; the shell uses
   * the setter instead, because the consumer it wants to install is assembled
   * from this wiring's own sink.
   */
  onControlFrame?: (payload: string) => boolean;
}): BridgeWiring {
  const host: BridgeSessionHost = createBridgeHost({
    expectedBridgeVersion: BRIDGE_VERSION,
    coreVersion: options.coreVersion,
    // `bulkPages: 0` says "no multi-page snapshot yet"; C4 fills it in when it lands.
    bulkPages: 0,
    log: options.log,
  });

  /**
   * The live control-frame consumer, read on every submit.
   *
   * A mutable cell rather than a `deps` value because of the build order: this
   * wiring is created before the session store exists (the store is built beside
   * the command path, which itself needs this host's sink). The closure below is
   * what `registerBridgeIpc` receives, so no handler is ever re-registered.
   */
  let controlFrameHook: ((payload: string) => boolean) | null = options.onControlFrame ?? null;

  // Conditional spreads keep an absent provider absent instead of passing an
  // explicit `undefined`, which `exactOptionalPropertyTypes` distinguishes.
  const disposeIpc = registerBridgeIpc({
    ipc: ipcMain,
    host,
    ...(options.layoutSave === undefined ? {} : { layoutSave: options.layoutSave }),
    ...(options.layoutState === undefined ? {} : { layoutState: options.layoutState }),
    onControlFrame: (payload) => controlFrameHook?.(payload) === true,
  });

  return {
    send: host.send,
    setControlFrameHook(hook) {
      controlFrameHook = hook;
    },
    attachWindow(window) {
      // `did-start-navigation` is the last moment before the new document's scripts
      // can run, so it is the only safe place to swap the generation.
      // `did-finish-load` would be too late: the renderer's `bridge.ready` can already
      // be in flight, and `submit` would find no session.
      window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (!isMainFrame || isInPlace) return;

        host.detach("reload");
        host.attach(window.webContents, "load");
      });
      window.webContents.on("render-process-gone", () => host.detach("crash"));
      window.on("closed", () => host.detach("close"));

      // The first main-frame navigation is the initial load itself, so the handler above
      // already attaches the generation the first `bridge.ready` will arrive in. An extra
      // boot attach before `loadURL` would only be detached when that navigation starts,
      // making the first accepted generation "2" for no reason -- and a reload counter
      // that begins at 2 is a counter nobody can read.
    },
    bootParams() {
      return {
        appVersion: app.getVersion(),
        bridgeVersion: BRIDGE_VERSION,
        frameProtocolVersion: String(FRAME_PROTOCOL_VERSION),
      };
    },
    dispose() {
      disposeIpc();
      host.dispose();
    },
  };
}
