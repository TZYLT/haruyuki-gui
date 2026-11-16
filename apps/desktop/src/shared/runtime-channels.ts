/**
 * The four runtime channels and their payloads.
 *
 * They are declared once and consumed by three sides: the bridge allowlist
 * (preload), the main process's `ipcMain.handle` registrations, and the
 * renderer's error page. A second spelling would be a channel that looks
 * allowed but never receives anything.
 *
 * These are channels, not bridge members. `window.haruyuki` is frozen at
 * `invoke`, `on` and `channelAllowlist`; adding a channel is the permitted way
 * to grow the surface.
 */

import type { RuntimeFailure, RuntimeStatus } from "./runtime.js";

/** Ask for the current runtime status. */
export const RUNTIME_STATUS_CHANNEL = "bridge:control.runtime.status" as const;
/** Open the directory picker and attempt to use the chosen engine. */
export const RUNTIME_PICK_CHANNEL = "bridge:control.runtime.pick" as const;
/** Clear the external pick and return to the bundled engine. */
export const RUNTIME_RESET_CHANNEL = "bridge:control.runtime.reset" as const;
/** Main -> renderer: startup failed, show the runtime error page. */
export const RUNTIME_FAILED_CHANNEL = "bridge:control.runtime.failed" as const;

/** Every runtime channel, frozen so a renderer cannot push into the allowlist. */
export const RUNTIME_CHANNELS = Object.freeze([
  RUNTIME_STATUS_CHANNEL,
  RUNTIME_PICK_CHANNEL,
  RUNTIME_RESET_CHANNEL,
  RUNTIME_FAILED_CHANNEL,
]) as readonly string[];

/** What the picker reports back. */
export type RuntimePickResult =
  | {
      readonly ok: true;
      readonly engineDir: string;
      readonly engineVersion?: string;
    }
  | {
      readonly ok: false;
      readonly failureKind: RuntimeFailure["kind"];
      readonly detail?: string;
    };

/** What resetting to the bundled engine reports back. */
export type RuntimeResetResult =
  { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** The payload accepted by the status channel; `full` asks for a tree check. */
export interface RuntimeStatusRequest {
  readonly full?: boolean;
}

/** The four methods the shell's runtime controller must offer. */
export interface RuntimeChannelHost {
  status(): Promise<RuntimeStatus>;
  pick(): Promise<RuntimePickResult>;
  reset(): Promise<RuntimeResetResult>;
}

/** The slice of `ipcMain` this registrar needs; fakeable in tests. */
export interface RuntimeIpcMain {
  handle(channel: string, listener: () => Promise<unknown> | unknown): void;
}

/**
 * Register the three request/response channels.
 *
 * `failed` is deliberately not registered: it is a push from main to renderer,
 * sent by the startup coordinator through `webContents.send`, not a request.
 *
 * @param ipcMain the main process's IPC registry
 * @param host the controller that owns the answers
 */
export function registerRuntimeChannels(ipcMain: RuntimeIpcMain, host: RuntimeChannelHost): void {
  ipcMain.handle(RUNTIME_STATUS_CHANNEL, () => host.status());
  ipcMain.handle(RUNTIME_PICK_CHANNEL, () => host.pick());
  ipcMain.handle(RUNTIME_RESET_CHANNEL, () => host.reset());
}
