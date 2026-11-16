/**
 * The preload bridge: the three members the renderer can see, and the channel
 * names it may use them with.
 *
 * This module is the shape half of the bridge contract. The
 * Electron half is `index.ts`, and nothing here imports `electron`, for two
 * reasons: a sandboxed preload can only `require` a handful of modules, so a
 * dependency-free module is the only kind that survives bundling; and a bridge
 * that can be built over a fake `ipcRenderer` is a bridge whose deny path can be
 * tested without launching a browser process at all.
 *
 * Why the surface is three members and no more: `window.haruyuki` is the entire
 * host capability a compromised renderer would gain. Every extra member is a new
 * hole, and the obvious "helpful" additions are the worst ones -- `ipcRenderer`
 * is an open RPC, `process` leaks versions and environment, `Buffer` is a
 * stepping stone to native memory. D3 adds channel names to the allowlist; it
 * does not add members.
 */

/**
 * The prefix every channel name starts with (route doc section 3.4).
 *
 * A channel is `<prefix><channel>.<domain>.<action>`, e.g.
 * `bridge:control.app.ping`. The prefix is what keeps a host channel from being
 * confused with an engine frame type or a plain string in a handler table.
 */
const CHANNEL_PREFIX = "bridge:";

/**
 * The shape of one name segment after the prefix.
 *
 * Lowercase kebab only. The grammar is deliberately narrower than "any run
 * without a dot": names are compared against the allowlist as exact strings, so
 * a segment that differs only by case or by an underscore would be a second
 * spelling of a channel that nobody remembers to add to the list.
 */
const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The three channels of the render bridge, prefixed.
 *
 * Frozen, and frozen in the frame corpus too: `packages/core`'s
 * fixture parser accepts exactly `control`, `stream` and `bulk` as a frame's
 * `ch`. Two spellings of the same three channels would be a naming split the
 * allowlist could not see.
 */
export const BRIDGE_CHANNELS = {
  control: "bridge:control",
  stream: "bridge:stream",
  bulk: "bridge:bulk",
} as const;

/** A prefixed channel name, e.g. `bridge:control`. */
export type BridgeChannel = (typeof BRIDGE_CHANNELS)[keyof typeof BRIDGE_CHANNELS];

/** A short channel id: the keys of {@link BRIDGE_CHANNELS}, without the prefix. */
export type BridgeChannelName = keyof typeof BRIDGE_CHANNELS;

/**
 * The global the bridge is exposed under, so the renderer calls
 * `window.haruyuki.invoke(...)` (requirement doc 23 section 4.2).
 *
 * Frozen with the three members. A renamed global is a breaking change for every
 * renderer module at once, and the break is a `undefined is not an object` deep
 * inside a component rather than anything that names the bridge.
 */
export const BRIDGE_GLOBAL_NAME = "haruyuki" as const;

/**
 * The three diagnostics commands D4 adds to the control channel.
 *
 * They are named here so the allowlist and `main/diagnostics/ipc.ts` cannot
 * drift into two spellings of one channel. They are still ordinary entries in
 * the allowlist below: naming a constant is not a permission of its own.
 */
export const DIAGNOSTICS_CHANNELS = {
  export: "bridge:control.diagnostics.export",
  relaunch: "bridge:control.diagnostics.relaunch",
  quit: "bridge:control.diagnostics.quit",
} as const;

/**
 * The channels the main process answers.
 *
 * D1 registers one, because the shell had no real IPC yet. `ping` stays: it is
 * the channel that makes the allow *and* deny paths exercisable -- with an empty
 * list every call would be refused and the accept path would be untested code.
 * D4 appends the three diagnostics commands (`33` section 4.3); each is
 * `<channel>.<domain>.<action>` and is registered by
 * `main/diagnostics/ipc.ts`. No preload member is added for them.
 *
 * Frozen at runtime as well as in the type, because the same array is handed to
 * the renderer through the bridge and read as a diagnostic: a renderer that
 * could push into it would be able to change what the preload then accepts.
 */
export const CHANNEL_ALLOWLIST: readonly string[] = Object.freeze([
  "bridge:control.app.ping",
  DIAGNOSTICS_CHANNELS.export,
  DIAGNOSTICS_CHANNELS.relaunch,
  DIAGNOSTICS_CHANNELS.quit,
]);

/**
 * Why a channel name was refused.
 *
 * Distinct values rather than one `invalid`, for the same reason `protocol.ts`
 * separates `outside-root` from `bad-path`: the reason ends up in a log line or
 * a rejected promise, and "which rule fired" is the useful half of it.
 *
 * - `empty`            nothing was passed -- an unset variable, not a typo
 * - `wrong-prefix`     not the `bridge:` scheme at all
 * - `unknown-channel`  prefixed, but the first segment is not one of the three
 * - `missing-action`   fewer than `<domain>.<action>` segments after the channel
 * - `bad-shape`        a segment breaks the token grammar (space, uppercase, gap)
 * - `not-allowed`      well-formed, but the main process does not answer it
 */
export type ChannelRefusal =
  "empty" | "wrong-prefix" | "unknown-channel" | "missing-action" | "bad-shape" | "not-allowed";

/** The result of validating one channel name's shape. */
export type ChannelValidation =
  | { readonly ok: true; readonly channel: BridgeChannelName }
  | { readonly ok: false; readonly reason: ChannelRefusal };

/**
 * Whether `value` is one of the three short channel ids.
 *
 * `Object.hasOwn` rather than a property lookup, so `bridge:toString.app.ping`
 * is an unknown channel instead of a call to `Object.prototype.toString`.
 */
function isBridgeChannelName(value: string): value is BridgeChannelName {
  return Object.hasOwn(BRIDGE_CHANNELS, value);
}

/**
 * Check a channel name against the naming convention, without consulting the
 * allowlist.
 *
 * Returns a result instead of throwing, matching `resolveInside`: the caller
 * decides whether a refusal is a rejected promise, a thrown error or a log line,
 * and a validator that throws forces every one of those callers to wrap it in
 * `try`. Shape and permission are separate questions here on purpose -- an
 * allowlist typo should be reported as "not allowed", not as "malformed".
 *
 * @param name the channel name as the renderer passed it, untrusted
 */
export function validateChannelName(name: string): ChannelValidation {
  if (name.trim() === "") {
    return { ok: false, reason: "empty" };
  }

  if (!name.startsWith(CHANNEL_PREFIX)) {
    return { ok: false, reason: "wrong-prefix" };
  }

  const segments = name.slice(CHANNEL_PREFIX.length).split(".");
  const [shortName] = segments;

  if (shortName === undefined || !isBridgeChannelName(shortName)) {
    return { ok: false, reason: "unknown-channel" };
  }

  // The convention is exactly `<channel>.<domain>.<action>`. Fewer segments means
  // the action is missing; more means the name carries something the convention
  // has no place for, and a real split of channel names starts right there.
  if (segments.length < 3) {
    return { ok: false, reason: "missing-action" };
  }

  if (segments.length > 3) {
    return { ok: false, reason: "bad-shape" };
  }

  if (!segments.every((segment) => SEGMENT_PATTERN.test(segment))) {
    return { ok: false, reason: "bad-shape" };
  }

  return { ok: true, channel: shortName };
}

/**
 * The error code a denied call reports (requirement doc 23 section 4.2).
 *
 * A string constant rather than a class name, because the caller distinguishes a
 * policy refusal from a transport failure by reading it, and a code survives
 * being logged, shown, or sent back through the bridge as text.
 */
export const BRIDGE_CHANNEL_DENIED = "BRIDGE_CHANNEL_DENIED" as const;

/** The rejection a denied channel produces. */
export interface ChannelDeniedError extends Error {
  /** Always {@link BRIDGE_CHANNEL_DENIED}, so a caller can branch on one field. */
  readonly code: typeof BRIDGE_CHANNEL_DENIED;
  /** Which rule refused the name; the same values as {@link ChannelRefusal}. */
  readonly reason: ChannelRefusal;
}

/**
 * Build the refusal for one channel.
 *
 * The name is included in the message because the common failure is a typo in a
 * channel string, and a message that omits it makes the caller compare two
 * files to find the difference.
 *
 * @param name the channel that was refused
 * @param reason which rule refused it
 */
export function createChannelDeniedError(name: string, reason: ChannelRefusal): ChannelDeniedError {
  return Object.assign(new Error(`${BRIDGE_CHANNEL_DENIED}: ${reason}: ${name}`), {
    name: "ChannelDeniedError",
    code: BRIDGE_CHANNEL_DENIED,
    reason,
  });
}

/** The result of the guard: shape, allowlist, and the frozen refusal code. */
export type ChannelGuard =
  | { readonly ok: true; readonly channel: BridgeChannelName }
  | {
      readonly ok: false;
      readonly reason: ChannelRefusal;
      readonly code: typeof BRIDGE_CHANNEL_DENIED;
    };

/**
 * Decide whether a call may touch IPC at all.
 *
 * Membership is an exact-string test, never a prefix test. A `startsWith` check
 * on `bridge:control.` would admit every channel D3 has not audited yet, which
 * is precisely the failure the allowlist exists to prevent.
 *
 * @param name the channel name as the renderer passed it, untrusted
 */
export function guardChannel(name: string): ChannelGuard {
  const shape = validateChannelName(name);

  if (!shape.ok) {
    return { ok: false, reason: shape.reason, code: BRIDGE_CHANNEL_DENIED };
  }

  if (!CHANNEL_ALLOWLIST.includes(name)) {
    return { ok: false, reason: "not-allowed", code: BRIDGE_CHANNEL_DENIED };
  }

  return shape;
}

/**
 * The frozen renderer-visible surface (route doc section 3.4, requirement doc
 * section 4.2). Three members, no more; D3 adds channels, never members.
 */
export interface HaruyukiBridge {
  /**
   * Request/response. A channel outside `channelAllowlist` rejects immediately,
   * without reaching IPC.
   */
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  /**
   * Subscribe to one channel. Returns the unsubscribe function; calling it twice
   * is a no-op, because a window teardown may run cleanup more than once.
   */
  on(channel: string, listener: (payload: unknown) => void): () => void;
  /** The names `invoke` and `on` accept, read-only at runtime. */
  readonly channelAllowlist: readonly string[];
}

/**
 * The slice of `ipcRenderer` the bridge uses.
 *
 * Declared here rather than imported from `electron` so this module stays
 * Electron-free: `index.ts` passes the real object (and the assignment is
 * type-checked against `IpcRenderer` there), while the test passes a fake and
 * exercises the deny path without a browser process.
 *
 * The real `on` and `removeListener` return `this`; the return is `void` here
 * because the bridge must not depend on chaining, and a host that returns
 * something else should still fit.
 */
export interface BridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

/**
 * Build the bridge over one IPC implementation.
 *
 * Both entry points validate before touching `ipc`, so an unknown channel never
 * becomes a pending `ipcRenderer.invoke` and never registers a listener that
 * would receive frames from a channel nobody meant to subscribe to.
 *
 * @param ipc the host's IPC object, or a fake with the same shape
 */
export function createBridge(ipc: BridgeIpc): HaruyukiBridge {
  const invoke = (channel: string, payload?: unknown): Promise<unknown> => {
    const verdict = guardChannel(channel);

    if (!verdict.ok) {
      return Promise.reject(createChannelDeniedError(channel, verdict.reason));
    }

    // The payload is forwarded only when it was supplied: a handler sees
    // `(event)` versus `(event, undefined)`, and the second form tells it that
    // the caller passed an explicit undefined rather than nothing at all.
    return payload === undefined ? ipc.invoke(channel) : ipc.invoke(channel, payload);
  };

  const on = (channel: string, listener: (payload: unknown) => void): (() => void) => {
    const verdict = guardChannel(channel);

    // There is no promise here to reject, so the refusal is thrown. Returning a
    // no-op unsubscribe instead would be the silent ignore the contract forbids: a
    // misspelled channel would look like a quiet channel, and the mistake would
    // surface later as missing frames.
    if (!verdict.ok) {
      throw createChannelDeniedError(channel, verdict.reason);
    }

    // The wrapper exists for two reasons. `ipcRenderer.on` passes the listener an
    // `IpcRendererEvent` first, and the event is not part of the frozen
    // contract. And `ipcRenderer` has no unsubscribe: removal needs this exact
    // function reference, so the bridge has to be the one that keeps it.
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);

    ipc.on(channel, wrapped);

    let subscribed = true;

    return () => {
      // Idempotent on purpose. Cleanup that runs twice is normal when a window
      // reloads, and the second `removeListener` is either a no-op or an
      // exception depending on the host; the flag removes the question.
      if (!subscribed) return;

      subscribed = false;
      ipc.removeListener(channel, wrapped);
    };
  };

  return {
    invoke,
    on,
    channelAllowlist: CHANNEL_ALLOWLIST,
  };
}
