/**
 * The IPC channel names D3 owns.
 *
 * These are transport pipes, not frame types: a frame's `ch` says control /
 * stream / bulk, while these names say which `ipcRenderer` channel carries the
 * serialized frame. Keeping the two lists apart is what lets the frame envelope
 * stay frozen (no new frame types) while the channel allowlist grows.
 *
 * The literals live in `shared/bridge.ts` because the renderer subscribes to the
 * same names and the desktop package must not grow two spellings of a channel.
 * This module only re-shapes them for the main-process code.
 */

import { BRIDGE_CHANNEL_NAMES } from "../../shared/bridge.js";

/** One delivery channel per frame `ch`. */
export const FRAME_DELIVER = BRIDGE_CHANNEL_NAMES.frameDeliver;

/** The frame channel a `ch` value delivers on. */
export type FrameChannelKey = keyof typeof FRAME_DELIVER;

/** renderer -> main: the first frame (`bridge.ready`) and later UI control frames. */
export const FRAME_SUBMIT = BRIDGE_CHANNEL_NAMES.frameSubmit;

/** renderer -> main: terminal byte acknowledgement. Transport-level, not a frame. */
export const TERMINAL_ACK = BRIDGE_CHANNEL_NAMES.terminalAck;

/** main -> renderer: "the terminal entry dropped N bytes". Transport-level, not a frame. */
export const TERMINAL_NOTICE = BRIDGE_CHANNEL_NAMES.terminalNotice;

/** renderer -> main: C4's layout document write-back. */
export const LAYOUT_SAVE = BRIDGE_CHANNEL_NAMES.layoutSave;

/** renderer -> main: D1's existing availability probe. */
export const APP_PING = BRIDGE_CHANNEL_NAMES.appPing;

/** The frame channels, in `ch` order. */
export const FRAME_CHANNEL_KEYS: readonly FrameChannelKey[] = ["control", "stream", "bulk"];

/**
 * Whether a raw `ch` value is one of the three.
 *
 * `Object.hasOwn` rather than a lookup, so `toString` or `__proto__` cannot be
 * mistaken for a channel and get a frame filed where no limit exists.
 */
export function isFrameChannelKey(value: unknown): value is FrameChannelKey {
  return typeof value === "string" && Object.hasOwn(FRAME_DELIVER, value);
}

/** The IPC channel for one frame `ch`. */
export function channelFor(channel: FrameChannelKey): string {
  return FRAME_DELIVER[channel];
}
