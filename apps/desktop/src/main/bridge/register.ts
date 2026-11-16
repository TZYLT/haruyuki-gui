/**
 * The `ipcMain` side of D3's channels.
 *
 * Kept out of `main.ts` for the same reason `main.ts` is kept out of every other
 * module: the composition root wires, it does not parse. This module also takes
 * its `ipc` as an argument rather than importing `ipcMain`, so the accept and
 * deny paths are unit-testable without an Electron process.
 *
 * Four handlers, five channels:
 *   submit   receives the renderer's control frames and hands the string to the
 *            host, which feeds it to the current session's sender
 *   ack      terminal byte acknowledgement; transport-level, never a frame
 *   layout   C4's write-back; absent implementation is an explicit refusal, not
 *            a silent success
 *   ping     D1's existing probe; D3 supplies the handler D1 never wrote
 */

import { APP_PING, FRAME_SUBMIT, LAYOUT_SAVE, TERMINAL_ACK } from "./channels.js";
import type { BridgeSessionHost } from "./types.js";

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
  const { host, ipc, layoutSave } = deps;

  ipc.handle(FRAME_SUBMIT, (_event, payload) => {
    if (typeof payload !== "string") return { ok: false, code: BAD_PAYLOAD };

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

  ipc.handle(APP_PING, () => ({ ok: true }));

  let disposed = false;

  return () => {
    if (disposed) return;

    disposed = true;

    for (const channel of [FRAME_SUBMIT, TERMINAL_ACK, LAYOUT_SAVE, APP_PING]) {
      ipc.removeHandler(channel);
    }
  };
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
