/**
 * The `ipcMain` half of the command path.
 *
 * What this module is
 *   One handler on one channel: `bridge:control.command.invoke`. The renderer
 *   sends a {@link CommandCall}-shaped payload, the injected `invoke` (the
 *   command dispatcher, wired in the composition root) answers with a
 *   {@link CommandReply}, and the reply goes back untouched. This module parses
 *   nothing: the payload is untrusted data, and the single authority on whether
 *   it is a valid envelope is the dispatcher behind `invoke`. Validating here as
 *   well would create a second, drifting copy of the envelope rules.
 *
 * Why the handler never rejects
 *   A rejecting `ipcMain.handle` listener arrives in the renderer as a rejected
 *   `invoke()` promise - an exception where the contract promises three reply
 *   arms. Every foreseeable failure is already an `ok: false` reply, so a
 *   rejection here means a dispatcher bug or a wiring one. The envelope has a
 *   code for "there is no working channel to answer on", which is the honest
 *   summary of that situation, so it is used instead of an unhandled rejection.
 *   The composition root is where the cause gets logged; a user does not need
 *   the stack trace, and the renderer cannot use one.
 *
 * Why `ipc` is injected
 *   Importing `ipcMain` would make this only testable inside a real Electron
 *   process. Taking the two methods as an interface keeps the handler, the
 *   passthrough and the disposal unit-testable with a map, which is what the
 *   fake-pool tests rely on.
 */

import type { CommandReply } from "@haruyuki/core";

import { BRIDGE_CHANNEL_NAMES } from "../../shared/bridge.js";

/**
 * The slice of `ipcMain` this module uses.
 *
 * Narrow on purpose: a handler registration and its removal are the whole
 * contract, so a test double is two methods and the real `ipcMain` satisfies it
 * without an adapter.
 */
export interface CommandIpcLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void;
  removeHandler(channel: string): void;
}

/**
 * What the composition root injects.
 *
 * `invoke` takes `unknown` rather than {@link CommandCall}: the value comes off
 * the IPC boundary and has not been validated yet. The dispatcher is the
 * component that narrows it, which is why the widest type is the right one
 * here - a narrower parameter would invite a cast at this call site instead.
 */
export interface CommandIpcOptions {
  readonly ipc: CommandIpcLike;
  readonly invoke: (call: unknown) => Promise<CommandReply>;
}

/**
 * The reply used when the dispatcher itself failed.
 *
 * A fresh object each time rather than a shared frozen constant: the value is
 * serialized by Electron and handed to other code, and a shared instance would
 * make an accidental mutation visible in every later reply.
 */
function unavailableReply(): CommandReply {
  return { ok: false, code: "COMMAND_CHANNEL_UNAVAILABLE" };
}

/**
 * Registers the command handler once.
 *
 * @param options the IPC surface and the dispatcher to delegate to
 * @returns an idempotent disposer; calling it twice removes nothing the second
 *   time, which is what a reload or a shutdown path needs
 */
export function registerCommandIpc(options: CommandIpcOptions): () => void {
  const { ipc, invoke } = options;

  ipc.handle(BRIDGE_CHANNEL_NAMES.commandInvoke, async (_event, payload): Promise<CommandReply> => {
    try {
      return await invoke(payload);
    } catch {
      return unavailableReply();
    }
  });

  let disposed = false;

  return () => {
    if (disposed) {
      return;
    }

    disposed = true;

    ipc.removeHandler(BRIDGE_CHANNEL_NAMES.commandInvoke);
  };
}
