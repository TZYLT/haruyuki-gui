/**
 * The `ipcMain` side of D3's channels.
 *
 * Kept out of `main.ts` for the same reason `main.ts` is kept out of every other
 * module: the composition root wires, it does not parse. This module also takes
 * its `ipc` as an argument rather than importing `ipcMain`, so the accept and
 * deny paths are unit-testable without an Electron process.
 *
 * Five handlers, six channels:
 *   submit   receives the renderer's control frames and hands the string to the
 *            host, which feeds it to the current session's sender; a frame an
 *            injected consumer takes first never reaches the host
 *   ack      terminal byte acknowledgement; transport-level, never a frame
 *   layout   C4's write-back; absent implementation is an explicit refusal, not
 *            a silent success
 *   state    C4's read-back; the same refusal when the wiring is not ready, so
 *            the renderer can tell "not mounted yet" from an empty document
 *   ping     D1's existing probe; D3 supplies the handler D1 never wrote
 */

import type { LayoutState } from "@haruyuki/protocol";

import { BRIDGE_CHANNEL_NAMES } from "../../shared/bridge.js";
import { APP_PING, FRAME_SUBMIT, LAYOUT_SAVE, TERMINAL_ACK } from "./channels.js";
import type { BridgeSessionHost } from "./types.js";

/**
 * The layout read-back channel.
 *
 * Read from the shared table instead of being spelled a second time: the
 * preload's allowlist and this handler must agree exactly, and two literals are
 * two chances to drift. (`channels.ts` stays the home of D3's frame pipes; this
 * channel belongs to C4's read path.)
 */
export const LAYOUT_STATE = BRIDGE_CHANNEL_NAMES.layoutState;

/** The explicit refusal when C4's `LayoutChannel` has not been injected. */
export const LAYOUT_UNAVAILABLE = "LAYOUT_UNAVAILABLE" as const;

/** The refusal for a malformed IPC payload. */
export const BAD_PAYLOAD = "BAD_PAYLOAD" as const;

/** The slice of `ipcMain` this module uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** What the composition root injects. */
export interface BridgeIpcDeps {
  readonly ipc: IpcMainLike;
  readonly host: BridgeSessionHost;
  /** C4's `LayoutChannel.handleSave`; absent until C4 lands. */
  readonly layoutSave?: (request: unknown) => Promise<unknown> | unknown;
  /** C4's `LayoutChannel.handleState`; absent until the layout wiring is ready. */
  readonly layoutState?: () => LayoutState;
  /**
   * The consumer for a control frame the submit path does not own.
   *
   * The submit path is a renderer-bound sender: handing it a request frame
   * numbers the frame and sends it back to the renderer it came from. A
   * producer that answers such a request has to take it here instead.
   *
   * It receives the payload string exactly as it arrived and reports whether it
   * consumed the frame; `true` stops the frame from reaching the host, `false`
   * leaves the submit path as it is. Absent means every frame takes that path.
   */
  readonly onControlFrame?: (payload: string) => boolean;
}

/** The reply every handler returns; `ok:false` is a refusal, never a throw. */
export interface IpcReply {
  readonly ok: boolean;
  readonly code?: string;
}

/**
 * Register the four handlers once.
 *
 * @returns an idempotent disposer; calling it twice removes nothing the second
 *   time, which is what a reload/teardown path needs
 */
export function registerBridgeIpc(deps: BridgeIpcDeps): () => void {
  const { host, ipc, layoutSave, layoutState, onControlFrame } = deps;

  ipc.handle(FRAME_SUBMIT, (_event, payload) => {
    if (typeof payload !== "string") return { ok: false, code: BAD_PAYLOAD };

    // Asked first, and only when injected: a frame a producer answers here must
    // not reach the submit path, which would number it and send it back to the
    // renderer that asked. A hook that cannot answer leaves the frame alone -
    // the existing path is the one every frame took before this hook existed.
    if (onControlFrame !== undefined && consumed(onControlFrame, payload)) return { ok: true };

    host.submit(payload);

    return { ok: true };
  });

  ipc.handle(TERMINAL_ACK, (_event, payload) => {
    const ack = readAck(payload);

    if (ack === null) return { ok: false, code: BAD_PAYLOAD };

    host.ack(ack.terminalId, ack.bytes);

    return { ok: true };
  });

  ipc.handle(LAYOUT_SAVE, async (_event, request) => {
    if (layoutSave === undefined) return { ok: false, code: LAYOUT_UNAVAILABLE };

    try {
      return await layoutSave(request);
    } catch {
      // The failure is the renderer's answer; the composition root logs the
      // detail. Throwing here would turn a refused save into an unhandled
      // rejection in the renderer's invoke().
      return { ok: false, code: "LAYOUT_SAVE_FAILED" };
    }
  });

  ipc.handle(LAYOUT_STATE, () => {
    if (layoutState === undefined) return { ok: false, code: LAYOUT_UNAVAILABLE };

    try {
      return layoutState();
    } catch {
      // A thrown provider would reject the renderer's invoke() and surface as
      // an unhandled rejection; a refusal code keeps the call answerable.
      return { ok: false, code: "LAYOUT_STATE_FAILED" };
    }
  });

  ipc.handle(APP_PING, () => ({ ok: true }));

  let disposed = false;

  return () => {
    if (disposed) return;

    disposed = true;

    for (const channel of [FRAME_SUBMIT, TERMINAL_ACK, LAYOUT_SAVE, LAYOUT_STATE, APP_PING]) {
      ipc.removeHandler(channel);
    }
  };
}

/**
 * Ask the injected consumer whether it took this frame.
 *
 * A hook that throws has not consumed anything: the frame still has an owner
 * that predates the hook, and turning a wiring bug into a rejected `invoke()`
 * in the renderer would trade a working path for a broken one.
 */
function consumed(hook: (payload: string) => boolean, payload: string): boolean {
  try {
    return hook(payload) === true;
  } catch {
    return false;
  }
}

/** Read and validate the ack payload without trusting its shape. */
function readAck(payload: unknown): { terminalId: string; bytes: number } | null {
  if (typeof payload !== "object" || payload === null) return null;

  const record = payload as Record<string, unknown>;
  const terminalId = record["terminal_id"];
  const bytes = record["bytes"];

  if (typeof terminalId !== "string" || terminalId === "") return null;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;

  return { terminalId, bytes };
}
