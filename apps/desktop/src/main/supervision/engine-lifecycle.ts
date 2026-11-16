/**
 * The shell's engine start sequence, kept outside `main.ts` only to keep the
 * composition root under the file-size gate. The decisions are P4's: one
 * `startEngineHost` call, attach the host to quit, and stop a host that finished
 * starting after the quit already ran.
 */

import type { CrashRecord } from "../crash/records.js";
import { startEngineHost, stopEngineHost, type EngineHost } from "./engine-host.js";
import type { SupervisionLog } from "./errors.js";
import type { QuitSupervisor } from "./quit.js";

/** Everything the start sequence needs from the composition root. */
export interface ShellEngineDeps {
  readonly userData: string;
  readonly appVersion: string;
  readonly appPath: string;
  readonly onLog: SupervisionLog;
  readonly onCrash: (record: CrashRecord) => void;
  readonly quitSupervisor: QuitSupervisor | null;
  /** Publish the host, or clear it when the start was abandoned. */
  readonly onHost: (host: EngineHost | null) => void;
}

/**
 * Start the engine without blocking the window.
 *
 * A missing bundle is a normal skip, not a failure page: the window is already
 * open and usable. A start that loses the quit race is stopped before it is
 * published, which is the only way to avoid an orphan after `before-quit` ran
 * with `host: null`.
 *
 * @param deps the composition root's facts and callbacks
 */
export async function startShellEngine(deps: ShellEngineDeps): Promise<void> {
  const result = await startEngineHost({
    userData: deps.userData,
    appVersion: deps.appVersion,
    appPath: deps.appPath,
    onLog: deps.onLog,
    onCrash: deps.onCrash,
  });

  if (!result.ok) {
    deps.onLog("supervision.engine.start", {
      state: result.reason === "missing-bundle" ? "skipped" : "failed",
      reason: result.reason,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    });

    return;
  }

  const accepted = deps.quitSupervisor?.setHost(result.host) ?? true;

  if (!accepted) {
    const stopped = await stopEngineHost(result.host);

    deps.onLog("supervision.engine.start", {
      state: "stopped-after-quit",
      stopped: stopped.stopped,
      ...(stopped.reason === undefined ? {} : { reason: stopped.reason }),
    });

    return;
  }

  deps.onHost(result.host);
}
