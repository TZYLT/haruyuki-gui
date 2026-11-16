/**
 * The IPC channel names D3 owns.
 *
 * These are transport pipes, not frame types: a frame's `ch` says control /
 * stream / bulk, while these names say which `ipcRenderer` channel carries the
 * serialized frame. Keeping the two lists apart is what lets the frame envelope
 * stay frozen (no new frame types) while the channel allowlist grows.
 *
 * Every name must pass `validateChannelName` (prefix plus exactly three
 * segments). A name that is well-formed but missing from `CHANNEL_ALLOWLIST`
 * is denied before it reaches `ipcRenderer`, so a mismatch between this file and
 * the allowlist is a test failure, not a silent dead channel.
 */

/** One delivery channel per frame `ch`. */
export const FRAME_DELIVER = {
  control: "bridge:control.frame.deliver",
  stream: "bridge:stream.frame.deliver",
  bulk: "bridge:bulk.frame.deliver",
} as const;

/** The frame channel a `ch` value delivers on. */
export type FrameChannelKey = keyof typeof FRAME_DELIVER;

/** renderer -> main: the first frame (`bridge.ready`) and later UI control frames. */
export const FRAME_SUBMIT = "bridge:control.frame.submit" as const;

/** renderer -> main: terminal byte acknowledgement. Transport-level, not a frame. */
export const TERMINAL_ACK = "bridge:stream.terminal.ack" as const;

/** main -> renderer: "the terminal entry dropped N bytes". Transport-level, not a frame. */
export const TERMINAL_NOTICE = "bridge:stream.terminal.notice" as const;

/** renderer -> main: C4's layout document write-back. */
export const LAYOUT_SAVE = "bridge:control.layout.save" as const;

/** renderer -> main: D1's existing availability probe. */
export const APP_PING = "bridge:control.app.ping" as const;

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
