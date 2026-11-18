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
 *
 * The session assembly lives here for a third reason that is also structural:
 * its store needs the bridge sink, its control-frame consumer has to be reachable
 * from the submit path, and neither may be built by the composition root itself.
 * The two hooks are therefore installed from this module -- the bridge's consume
 * hook through a setter, the change consumer into the command lifecycle -- so
 * `main.ts` keeps owning the window and nothing else.
 */

import type { IpcMain } from "electron";

import { createSessionStore } from "@haruyuki/core";

import { createLayoutWiring, type LayoutWiring } from "./layout/wiring.js";
import { DEFAULT_LAYOUT, PAGE_IDS } from "./layout/catalog.js";
import { createCommandLifecycle, type CommandLifecycle } from "./command/lifecycle.js";
import { createSessionWiring, type SessionWiring } from "./session/wiring.js";
import type { BridgeWiring } from "./bridge/wire.js";

/** What the composition root keeps for the app's lifetime. */
export interface ShellServices {
  /** Null when the layout document could not be assembled. */
  readonly layout: LayoutWiring | null;
  readonly command: CommandLifecycle;
  /** The selector frames' shell half: control-frame consumer and change sink. */
  readonly session: SessionWiring;
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

  // One store for the app, not one per engine: it outlives the engine that fed
  // it, and the change consumer below is what keeps it fed across a rebuild.
  const session = createSessionWiring({
    store: createSessionStore(),
    send: options.host.send,
  });

  // The bridge's consume hook is installed after registration on purpose: the
  // hook reads a mutable cell there, so a consumer built once the store exists
  // still takes its frames, and no handler is ever re-registered.
  options.host.setControlFrameHook(session.onControlFrame);

  const command = createCommandLifecycle({
    ipc: options.ipc,
    send: options.host.send,
    log: options.log,
    onMergerChange: session.onMergerChange,
    // The command lifecycle is the shell's only guaranteed teardown call, so the
    // session's subscriptions are released from there. The alternative is another
    // call in the composition root, which is the file this assembly keeps small.
    onDispose: session.dispose,
  });

  return { layout, command, session };
}
