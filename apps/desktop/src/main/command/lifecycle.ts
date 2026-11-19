/**
 * The lifetime of the command path in the shell.
 *
 * The engine arrives after the window is created, so the IPC channel must exist
 * before there is a service to answer it, and the service must be rebuilt if the
 * runtime hands over a new engine. Keeping that ordering here leaves `main.ts`
 * as a composition root and keeps the "one pool per engine" rule in one place.
 *
 * The IPC registration deliberately outlives a service: a click during startup
 * gets `COMMAND_CHANNEL_UNAVAILABLE`, not a missing-handler rejection.
 */

import type { IpcMain } from "electron";

import type { Frame } from "@haruyuki/protocol";
import type { CommandCall, MergerChange } from "@haruyuki/core";

import { createCommandService, type CommandService } from "./service.js";
import { registerCommandIpc } from "./register.js";
import type { EngineHost } from "../supervision/engine-host.js";

/** What the composition root supplies once per app. */
export interface CommandLifecycleOptions {
  readonly ipc: IpcMain;
  readonly send: (frame: Frame) => void;
  readonly log?: (code: string, detail?: Record<string, unknown>) => void;
  /**
   * The consumer for every merged change, forwarded to each service this
   * lifecycle builds.
   *
   * The service is rebuilt whenever the runtime hands over a new engine, so a
   * consumer installed once here is the only way the second engine's changes
   * reach it. Passing it per call instead would leave the rebuild to whoever
   * remembers.
   */
  readonly onMergerChange?: (change: MergerChange) => void;
  /**
   * Release the rest of the shell when this lifecycle is disposed.
   *
   * This is not a command concern, and its presence here is not a design claim.
   * It exists because the shell's single teardown point (`will-quit`) already
   * calls `dispose()` on this lifecycle and on nothing else that is guaranteed
   * to exist: the layout and the bridge have their own handles, and the session
   * assembly is reachable only through the services that this lifecycle is built
   * beside. Adding a second teardown chain would mean another call in the
   * composition root, which is the file this assembly exists to keep small.
   *
   * Called once, after the service's own disposal, and only if `dispose()` was
   * not already called.
   */
  readonly onDispose?: () => void;
}

/** The handle `main.ts` keeps for the app's lifetime. */
export interface CommandLifecycle {
  /** Build the service for one engine; a previous service is disposed first. */
  onHost(host: EngineHost): void;
  /** Remove the IPC handler, then dispose the service; idempotent. */
  dispose(): void;
}

/** Wire the command channel and its per-engine service. */
export function createCommandLifecycle(options: CommandLifecycleOptions): CommandLifecycle {
  let service: CommandService | null = null;

  const disposeIpc = registerCommandIpc({
    ipc: options.ipc,
    invoke: (call: unknown) =>
      service === null
        ? Promise.resolve({ ok: false, code: "COMMAND_CHANNEL_UNAVAILABLE" })
        : service.invoke(call as CommandCall),
  });

  let disposed = false;

  return {
    onHost(host) {
      if (disposed) return;

      service?.dispose();
      service = createCommandService({
        engine: host.engine,
        send: options.send,
        ...(options.log === undefined ? {} : { log: options.log }),
        ...(options.onMergerChange === undefined ? {} : { onMergerChange: options.onMergerChange }),
      });
    },
    dispose() {
      if (disposed) return;

      disposed = true;
      disposeIpc();
      service?.dispose();
      service = null;

      // Last, and once: the service is already gone, so the rest of the shell
      // cannot see a half-disposed command path. `disposed` above is what makes
      // this happen exactly once, the same flag the idempotency rests on.
      options.onDispose?.();
    },
  };
}
