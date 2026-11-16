/**
 * What the shell does when the renderer process dies.
 *
 * The user's ruling is two-stage: the first death reloads the normal interface
 * once, and only a second death shows the D4 error page. A third death falls back
 * to the static D1 page; the error page itself is not allowed to loop. Reload is
 * used rather than a new `BrowserWindow` because the process-gone listener is
 * attached to this window's `webContents`; a new window would need that wiring
 * duplicated, and a reload preserves the theme/locale query and the listener.
 */

import type { BrowserWindow } from "electron";

import { rendererCrashQuery } from "./page.js";
import { showCrashPage, type CrashLog } from "./wiring.js";

/** How long a normal reload may take before it is treated as failed. */
const RELOAD_TIMEOUT_MS = 10_000;

/**
 * Reload the window's current normal page and report whether it committed.
 *
 * `reload()` returns `void`, so the only honest completion signal is the pair of
 * load events. Listeners are removed on every path, including the timeout, so a
 * later navigation cannot resolve a stale promise.
 *
 * @param window the window whose renderer died
 * @param log the shell log sink
 * @returns true when `did-finish-load` fired before failure or timeout
 */
export async function reloadNormalPage(window: BrowserWindow, log: CrashLog): Promise<boolean> {
  if (window.isDestroyed()) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (ok: boolean): void => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      window.webContents.removeListener("did-finish-load", onFinish);
      window.webContents.removeListener("did-fail-load", onFail);
      resolve(ok);
    };
    const onFinish = (): void => finish(true);
    const onFail = (): void => {
      log("supervision.renderer.reload", { state: "failed" });
      finish(false);
    };
    timer = setTimeout(() => {
      log("supervision.renderer.reload", { state: "timeout" });
      finish(false);
    }, RELOAD_TIMEOUT_MS);

    window.webContents.once("did-finish-load", onFinish);
    window.webContents.once("did-fail-load", onFail);

    try {
      window.reload();
      log("supervision.renderer.reload", { state: "started" });
    } catch (error) {
      log("supervision.renderer.reload", {
        state: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      finish(false);
    }
  });
}

/** What the recovery factory needs from the window it belongs to. */
export interface RendererRecoveryDeps {
  readonly window: BrowserWindow;
  readonly appScheme: string;
  readonly log: CrashLog;
  /** The static D1 page, used only after the D4 error page has also died. */
  readonly showFallback: (reason: string, exitCode: number | null, detail: string) => void;
}

/**
 * Build the renderer-gone handler for one window.
 *
 * The counter belongs to the window: replacing the window replaces its renderer,
 * and a new window starts at zero. The error-page flag is separate from the
 * counter because a failed first reload also shows the error page, and that page
 * dying must not show it a second time.
 *
 * @param deps the window and the two page paths
 * @returns the handler called once per `render-process-gone`
 */
export function createRendererRecovery(
  deps: RendererRecoveryDeps,
): (reason: string, exitCode: number | null) => void {
  let crashes = 0;
  let errorPageShown = false;

  const showErrorPage = (reason: string, exitCode: number | null): void => {
    if (errorPageShown) {
      deps.showFallback(
        reason,
        exitCode,
        "the D4 error page died after it was shown; using the static page",
      );

      return;
    }

    void showCrashPage(
      deps.window,
      rendererCrashQuery({ reason, exitCode }),
      "renderer",
      deps.appScheme,
      deps.log,
    ).then((shown) => {
      if (shown) {
        errorPageShown = true;

        return;
      }

      deps.showFallback(reason, exitCode, "the D4 error page could not be shown");
    });
  };

  return (reason, exitCode) => {
    crashes += 1;

    deps.log("supervision.renderer.crash", {
      reason,
      exitCode,
      attempt: crashes,
    });

    if (crashes === 1) {
      void reloadNormalPage(deps.window, deps.log).then((ok) => {
        // A second crash while the reload was in flight owns the next stage.
        if (ok || crashes !== 1) return;

        showErrorPage(reason, exitCode);
      });

      return;
    }

    if (crashes === 2) {
      showErrorPage(reason, exitCode);

      return;
    }

    deps.showFallback(
      reason,
      exitCode,
      "the renderer died again after the D4 error page; not rebuilding",
    );
  };
}
