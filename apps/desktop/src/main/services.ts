/**
 * The services that need the bridge host and the window's `userData`.
 *
 * `main.ts` is already a composition root for the window, protocol, settings and
 * menus; keeping the layout and command assembly here keeps it under the file
 * limit without hiding either lifetime rule:
 *
 *   - layout is loaded before a renderer can ask for it, and a failed load is a
 *     degraded session (the window still opens with LAYOUT_UNAVAILABLE);
 *   - the command IPC exists before an engine does, so a click during startup
 *     gets a refusal rather than a missing-handler rejection.
 */

import type { IpcMain } from "electron";

import { createLayoutWiring, type LayoutWiring } from "./layout/wiring.js";
import { DEFAULT_LAYOUT, PAGE_IDS } from "./layout/catalog.js";
import { createCommandLifecycle, type CommandLifecycle } from "./command/lifecycle.js";
import type { BridgeWiring } from "./bridge/wire.js";

/** What the composition root keeps for the app's lifetime. */
export interface ShellServices {
  /** Null when the layout document could not be assembled. */
  readonly layout: LayoutWiring | null;
  readonly command: CommandLifecycle;
}

/** Build the layout subsystem and the command channel around one bridge host. */
export async function createShellServices(options: {
  readonly userData: string;
  readonly ipc: IpcMain;
  readonly host: BridgeWiring;
  readonly log: (code: string, detail?: Record<string, unknown>) => void;
}): Promise<ShellServices> {
  let layout: LayoutWiring | null = null;

  try {
    layout = await createLayoutWiring({
      userData: options.userData,
      host: options.host,
      knownPageIds: PAGE_IDS,
      defaultDoc: DEFAULT_LAYOUT,
      log: options.log,
    });
  } catch (error: unknown) {
    // A layout that cannot be assembled is a degraded session, not a failed
    // boot: the window still opens, and the renderer sees LAYOUT_UNAVAILABLE.
    options.log("layout.wiring.failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const command = createCommandLifecycle({
    ipc: options.ipc,
    send: options.host.send,
    log: options.log,
  });

  return { layout, command };
}
