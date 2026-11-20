/**
 * The renderer recovery sequence, driven on the real renderer bundle.
 *
 * The user's ruling is two-stage plus a fallback: the first death reloads the
 * normal interface, the second shows the D4 crash page, and a third death uses the
 * static D1 page without looping. The handler under test is the production
 * `createRendererRecovery`, wired exactly as `main.ts` wires it.
 *
 * Three scenarios are judged, in two windows:
 *
 *   A  the normal path: first death -> reloaded normal page (alive, not loading,
 *      `#root` present, interactive, not the crash page); second death -> the D4
 *      crash page (`?crash=renderer`, title 界面已停止, three enabled actions, no
 *      further reload); third death -> fallback once, no navigation loop
 *   B  the reload-failure path: the first death's reload is made to fail at the
 *      `app://` boundary, so the D4 error page has to appear from the failure
 *      branch; the error page's own death must fall back to the static page and
 *      must not re-show itself. The reload failure must not increment the crash
 *      counter -- only `render-process-gone` does.
 *
 * `forcefullyCrashRenderer()` is the trigger, per the measured fact that it emits
 * `render-process-gone` with `{reason:"crashed", exitCode:2}`. The route's earlier
 * probe saw no dump within 3 s; this probe waits longer and prints whatever actually
 * appears. The dump is an observation, never part of the judgment.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { BrowserWindow } from "electron";

import { handleRendererGone, type RendererGoneDetails } from "../../../src/main/crash/capture.js";
import {
  crashDirFor,
  readCrashRecords,
  type CrashRecord,
} from "../../../src/main/crash/records.js";
import { createRendererRecovery } from "../../../src/main/crash/renderer-recovery.js";
import { crashVersions } from "../../../src/main/crash/wiring.js";
import {
  APP_SCHEME,
  CRASH_DUMPS,
  TEMP_ROOT,
  normalPageUrl,
  rendererAvailable,
  setNormalPageFault,
} from "../environment.js";
import { sleep, waitFor } from "../processes.js";
import { describe, info, logSink, record, shellLog } from "../report.js";

/** One decision the production fallback asked for. */
interface RendererFallback {
  readonly reason: string;
  readonly exitCode: number | null;
  readonly detail: string;
}

/** A window wired like `main.ts` wires its renderer, plus what the checks observe. */
interface RendererHarness {
  readonly window: BrowserWindow;
  readonly crashDir: string;
  readonly crashes: CrashRecord[];
  readonly fallbackCalls: RendererFallback[];
  /** `did-finish-load` count; a rebuild is a second increment. */
  loads(): number;
  destroy(): void;
}

/**
 * Open one window on the normal page and wire the production recovery to it.
 *
 * This mirrors the `render-process-gone` block in `main.ts`: record first, then
 * let the recovery policy decide. The only difference is the fallback sink, which
 * records instead of painting the D1 page (that page is D1's, and the judgment
 * here is whether it was reached exactly once).
 *
 * @param userData the per-scenario userData directory
 * @returns the harness; the caller destroys it
 */
async function openRendererHarness(userData: string): Promise<RendererHarness> {
  const crashDir = crashDirFor(userData);
  const window = new BrowserWindow({
    show: false,
    width: 640,
    height: 420,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  const crashes: CrashRecord[] = [];
  const fallbackCalls: RendererFallback[] = [];
  let loads = 0;

  window.webContents.on("did-finish-load", () => {
    loads += 1;
  });

  const recovery = createRendererRecovery({
    window,
    appScheme: APP_SCHEME,
    log: logSink,
    showFallback: (reason, exitCode, detail) => {
      fallbackCalls.push({ reason, exitCode, detail });
    },
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    if (window.isDestroyed()) return;

    void handleRendererGone(
      { reason: details.reason, exitCode: details.exitCode ?? null },
      {
        dir: crashDir,
        versions: crashVersions(),
        onCrash: (crashRecord) => {
          crashes.push(crashRecord);
          recovery(crashRecord.renderer?.reason ?? "", crashRecord.renderer?.exitCode ?? null);
        },
      },
    ).catch((error: unknown) => {
      shellLog.push({ event: "probe.renderer.record.failed", detail: { detail: describe(error) } });
    });
  });

  await window.loadURL(normalPageUrl());

  return {
    window,
    crashDir,
    crashes,
    fallbackCalls,
    loads: () => loads,
    destroy: () => {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

/** Count logged crash-policy events (`supervision.renderer.crash`). */
function crashEventCount(): number {
  return shellLog.filter((entry) => entry.event === "supervision.renderer.crash").length;
}

/** Count crash pages that were actually shown (not merely attempted). */
function crashPageShownCount(): number {
  return shellLog.filter(
    (entry) => entry.event === "shell.crash.page" && entry.detail?.["state"] === "shown",
  ).length;
}

/** Whether a renderer-reload failure was logged. */
function reloadFailureLogged(): boolean {
  return shellLog.some(
    (entry) =>
      entry.event === "supervision.renderer.reload" && entry.detail?.["state"] === "failed",
  );
}

/**
 * Judge the two-stage recovery, the error page, the fallback and the
 * reload-failure branch on a real renderer.
 */
async function checkV08(): Promise<void> {
  const id = "renderer-recovery-sequence";

  if (!rendererAvailable()) {
    record(id, "SKIP", `HARUYUKI_RENDERER_ROOT does not name a built renderer`);
    return;
  }

  const problems: string[] = [];
  const measured: string[] = [];
  let reloadFailureInduced = false;
  let reloadFailureDetail = "";

  // --- Scenario A: the normal two-stage sequence --------------------------
  try {
    const normal = await judgeTwoStage();
    problems.push(...normal.problems);
    measured.push(normal.measured);
  } catch (error) {
    problems.push(`two-stage: ${describe(error)}`);
  }

  // --- Scenario B: the reload-failure branch ------------------------------
  try {
    const failure = await judgeReloadFailure();

    if (failure.induced) {
      reloadFailureInduced = true;
      reloadFailureDetail = failure.measured;
      problems.push(...failure.problems);
    } else {
      reloadFailureDetail = failure.reason;
      record(
        "renderer-recovery-reload-failure",
        "SKIP",
        `the injected app:// fault did not produce a real did-fail-load: ${failure.reason}`,
      );
    }
  } catch (error) {
    reloadFailureDetail = describe(error);
    record(
      "renderer-recovery-reload-failure",
      "SKIP",
      `the reload-failure scenario threw: ${describe(error)}`,
    );
  }

  const dumps = listDumpSizes();
  const dumpText =
    dumps.length === 0 ? "none" : dumps.map((dump) => `${String(dump.bytes)}B`).join("+");

  info(`v08 trigger=forcefullyCrashRenderer dump=${dumpText}`);

  if (problems.length > 0) {
    record(id, "FAIL", problems.join("; "));
    return;
  }

  const failureText = reloadFailureInduced
    ? `reloadFailure=${reloadFailureDetail}`
    : "reloadFailure=SKIP";

  record(id, "PASS", `${measured.join(" ")} ${failureText} dump=${dumpText}`);
}

/** What the two-stage scenario judged. */
interface TwoStageResult {
  readonly problems: string[];
  readonly measured: string;
}

/** Judge scenario A. */
async function judgeTwoStage(): Promise<TwoStageResult> {
  const harness = await openRendererHarness(path.join(TEMP_ROOT, "v08-normal"));
  const problems: string[] = [];
  let measured = "";

  try {
    // --- Stage 1: first death reloads the normal interface ---------------
    const stage1 = await crashOnce(harness.window, "stage 1");
    const normalState = await waitForNormalPage(harness.window, 15_000);

    if (normalState === null) {
      problems.push(
        `the normal page did not come back after the first crash ` +
          `(${stage1.reason}/${String(stage1.exitCode)})`,
      );

      return { problems, measured: measuredFor(problems) };
    }

    // Every element of the ruling is checked as a fact, not an adjective.
    if (harness.window.isDestroyed())
      problems.push("the window was destroyed after the first crash");
    if (normalState.destroyed) problems.push("the window reports itself destroyed");
    if (normalState.loading) problems.push("webContents.isLoading() is still true");
    if (!normalState.url.startsWith(`${APP_SCHEME}://`))
      problems.push(`stage 1 URL is ${normalState.url}`);
    if (normalState.url.includes("crash=")) problems.push("stage 1 showed the crash route");
    if (!normalState.rootPresent) problems.push("the normal page has no #root element");
    if (normalState.rootChildren === 0)
      problems.push("the reloaded page mounted nothing into #root");
    if (normalState.showsCrashHeading) problems.push("stage 1 shows the crash page heading");
    if (!normalState.interactive) problems.push("the reloaded page did not answer a DOM click");

    // --- Stage 2: second death shows the D4 crash page -------------------
    // Let the stage-1 reload's own `did-finish-load` land before the baseline,
    // so the stage-2 count is exactly "the crash page loaded once".
    await sleep(200);

    const loadsBeforeCrash = harness.loads();

    await crashOnce(harness.window, "stage 2");

    const crashPage = await waitForCrashPage(harness.window, 15_000);

    if (crashPage === null) {
      problems.push("the crash page did not appear after the second crash");

      return { problems, measured: measuredFor(problems) };
    }

    // The crash page must settle: exactly one load (the crash page itself) and
    // no further rebuild in the next second.
    const urlAtCrashPage = crashPage.url;
    const loadsAtCrashPage = harness.loads();

    await sleep(1_000);

    if (!crashPage.url.includes("crash=renderer")) problems.push(`crash URL is ${crashPage.url}`);
    if (crashPage.reason !== "crashed")
      problems.push(`crash reason is ${JSON.stringify(crashPage.reason)}`);
    if (crashPage.exitCode !== 2) problems.push(`crash exitCode is ${String(crashPage.exitCode)}`);
    if (!crashPage.heading.includes("界面已停止")) {
      problems.push(`the crash page heading is ${JSON.stringify(crashPage.heading.slice(0, 80))}`);
    }
    if (crashPage.buttons.length !== 3) {
      problems.push(`crash actions are ${JSON.stringify(crashPage.buttons)}`);
    }
    if (crashPage.buttons.some((button) => button.disabled))
      problems.push("a crash action is disabled");

    const labels = crashPage.buttons.map((button) => button.label).join(",");

    if (labels !== "导出诊断,重启应用,退出应用") {
      problems.push(`crash action labels are ${JSON.stringify(labels)}`);
    }

    if (loadsAtCrashPage !== loadsBeforeCrash + 1) {
      problems.push(
        `the crash page took ${String(loadsAtCrashPage - loadsBeforeCrash)} loads, expected 1`,
      );
    }
    if (harness.loads() !== loadsAtCrashPage)
      problems.push("the crash page reloaded after it appeared");
    if (harness.window.webContents.getURL() !== urlAtCrashPage) {
      problems.push("the window navigated away from the crash page");
    }

    // An action that is present but whose handler is not wired is not clickable.
    // Clicking it must reach the page's own handler; with no preload that handler
    // shows the "bridge unavailable" notice instead of doing nothing.
    const clicked = await clickCrashAction(harness.window, "导出诊断");

    if (!clicked) {
      problems.push("the 导出诊断 action could not be clicked");
    } else if (!(await waitForPageText(harness.window, "诊断桥不可用", 3_000))) {
      problems.push("clicking 导出诊断 did not reach the page's handler");
    }

    // --- Stage 3: third death falls back once, no loop -------------------
    const fallbackBefore = harness.fallbackCalls.length;

    await crashOnce(harness.window, "stage 3");

    const fellBack = await waitFor(
      () => (harness.fallbackCalls.length > fallbackBefore ? true : null),
      10_000,
      100,
    );
    const urlAfterFallback = harness.window.webContents.getURL();

    await sleep(1_500);

    if (fellBack === null) problems.push("the third death did not reach the fallback");
    if (harness.fallbackCalls.length !== fallbackBefore + 1) {
      problems.push(
        `the fallback ran ${String(harness.fallbackCalls.length - fallbackBefore)} times`,
      );
    }
    if (harness.window.webContents.getURL() !== urlAfterFallback) {
      problems.push("the window navigated after the fallback");
    }

    const records = readCrashRecords(harness.crashDir).filter((entry) => entry.kind === "renderer");

    if (records.length !== 3) problems.push(`renderer CrashRecords=${String(records.length)} of 3`);
    if (harness.crashes.length !== 3) {
      problems.push(`the recovery saw ${String(harness.crashes.length)} crashes of 3`);
    }

    if (problems.length === 0) {
      measured =
        `first=reloaded-normal(windowAlive=true loading=false root=#root children=${String(
          normalState.rootChildren,
        )} interactive=true not-crash-page) ` +
        `second=crashPage(crash=renderer reason=crashed code=2 title=界面已停止 actions=3 ` +
        `clicked=bridge-missing loads+1) ` +
        `third=fallback(1) noLoop=true records=3`;
    }

    return { problems, measured: measuredFor(problems, measured) };
  } finally {
    harness.destroy();
  }
}

/** What the reload-failure scenario judged. */
interface ReloadFailureResult {
  readonly induced: boolean;
  readonly reason: string;
  readonly problems: string[];
  readonly measured: string;
}

/**
 * Judge scenario B: a first death whose reload really fails.
 *
 * The fault is at the `app://` boundary (the handler throws for a page without a
 * `crash` query), so the failure Electron reports is a genuine `did-fail-load`,
 * not a synthesised event. The listener that clears the fault is registered before
 * the crash, so it runs before the recovery's own one and the crash page request
 * that follows is served normally.
 */
async function judgeReloadFailure(): Promise<ReloadFailureResult> {
  const harness = await openRendererHarness(path.join(TEMP_ROOT, "v08-reload-failure"));
  const problems: string[] = [];
  let reloadFailure: { code: number; description: string; url: string } | null = null;
  // A function, not a re-read of the variable: the assignment happens inside the
  // `did-fail-load` closure, which control-flow analysis cannot see, so reading
  // the variable directly would narrow it to `never`.
  const observedFailure = (): { code: number; description: string; url: string } | null =>
    reloadFailure;

  try {
    harness.window.webContents.on("did-fail-load", (_event, code, description, failedUrl) => {
      if (failedUrl.includes("crash=")) return;

      reloadFailure = { code, description, url: failedUrl };
      setNormalPageFault(false);
    });

    const crashEventsBefore = crashEventCount();
    const shownBefore = crashPageShownCount();

    setNormalPageFault(true);
    await crashOnce(harness.window, "reload failure");

    const errorPage = await waitForCrashPage(harness.window, 15_000);

    const observed = observedFailure();

    if (observed === null) {
      return {
        induced: false,
        reason:
          errorPage === null
            ? "no did-fail-load and no error page"
            : "the error page appeared without a did-fail-load",
        problems,
        measured: "",
      };
    }

    if (errorPage === null) {
      problems.push("the D4 error page did not appear after a failed reload");
      return { induced: true, reason: "", problems, measured: "" };
    }

    if (!errorPage.url.includes("crash=renderer"))
      problems.push(`error-page URL is ${errorPage.url}`);
    if (!errorPage.heading.includes("界面已停止")) {
      problems.push(`error-page heading is ${JSON.stringify(errorPage.heading.slice(0, 80))}`);
    }
    if (errorPage.buttons.length !== 3) {
      problems.push(`error-page actions are ${JSON.stringify(errorPage.buttons)}`);
    }

    // The counter only moves on a process death. The failed reload must not add
    // an attempt, or the next death would land on the "third" branch early.
    if (crashEventCount() !== crashEventsBefore + 1) {
      problems.push(
        `the failed reload changed the crash counter (${String(
          crashEventCount() - crashEventsBefore,
        )} events, expected 1)`,
      );
    }
    if (!reloadFailureLogged()) problems.push("no supervision.renderer.reload failed log");
    if (crashPageShownCount() !== shownBefore + 1) {
      problems.push("the D4 error page was not shown exactly once");
    }

    // The error page's own death: the flag must route it to the static fallback,
    // never to a second error page.
    const urlAtErrorPage = errorPage.url;
    const fallbacksBefore = harness.fallbackCalls.length;

    await crashOnce(harness.window, "error-page crash");

    const fellBack = await waitFor(
      () => (harness.fallbackCalls.length > fallbacksBefore ? true : null),
      10_000,
      100,
    );

    await sleep(1_000);

    if (fellBack === null)
      problems.push("the error page's own death did not reach the static fallback");
    if (crashPageShownCount() !== shownBefore + 1)
      problems.push("the D4 error page was shown a second time");
    if (harness.fallbackCalls.length !== fallbacksBefore + 1) {
      problems.push(
        `the fallback ran ${String(harness.fallbackCalls.length - fallbacksBefore)} times`,
      );
    }
    if (harness.window.webContents.getURL() !== urlAtErrorPage) {
      problems.push("the window navigated after the fallback");
    }

    const fallbackDetail = harness.fallbackCalls.at(-1)?.detail ?? "";

    if (!fallbackDetail.includes("after it was shown")) {
      problems.push(`fallback reason is ${JSON.stringify(fallbackDetail)}`);
    }

    const records = readCrashRecords(harness.crashDir).filter((entry) => entry.kind === "renderer");

    if (records.length !== 2)
      problems.push(`reload-failure CrashRecords=${String(records.length)} of 2`);

    const measured =
      `did-fail-load(${String(observed.code)} ${observed.description}) errorPage=shown ` +
      `crashCounterUnchangedByReload=true errorPageCrash=fallback(1) reshown=false ` +
      `noLoop=true records=2`;

    return { induced: true, reason: "", problems, measured };
  } finally {
    setNormalPageFault(false);
    harness.destroy();
  }
}

/** A measured string for a scenario that failed early. */
function measuredFor(problems: string[], measured = ""): string {
  return problems.length === 0 ? measured : "scenario did not complete";
}

/** One observed renderer death. */
interface RendererDeath {
  readonly reason: string;
  readonly exitCode: number | null;
}

/**
 * Crash the window's renderer and wait for Electron's own event.
 *
 * @param window the window to crash
 * @param label for the failure message
 * @returns the event details
 */
function crashOnce(window: BrowserWindow, label: string): Promise<RendererDeath> {
  return new Promise<RendererDeath>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.webContents.removeListener("render-process-gone", onGone);
      reject(new Error(`${label}: render-process-gone did not fire within 10 s`));
    }, 10_000);

    const onGone = (_event: unknown, details: RendererGoneDetails): void => {
      clearTimeout(timer);
      window.webContents.removeListener("render-process-gone", onGone);
      resolve({ reason: details.reason, exitCode: details.exitCode });
    };

    window.webContents.once("render-process-gone", onGone);
    window.webContents.forcefullyCrashRenderer();
  });
}

/** What the normal page says about itself. */
interface NormalPageState {
  readonly url: string;
  readonly destroyed: boolean;
  readonly loading: boolean;
  readonly rootPresent: boolean;
  readonly rootChildren: number;
  readonly showsCrashHeading: boolean;
  readonly interactive: boolean;
}

/**
 * Wait until the reloaded normal page is complete and interactive.
 *
 * "Interactive" is not a screenshot comparison: a button is created, clicked and
 * removed in the page's own world, so a dead or frozen renderer cannot pass.
 *
 * @param window the window
 * @param timeoutMs how long the reload may take
 * @returns the observed state, or null when the page never came back
 */
async function waitForNormalPage(
  window: BrowserWindow,
  timeoutMs: number,
): Promise<NormalPageState | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (window.isDestroyed()) return null;

    if (window.webContents.getURL().includes("crash=")) return null;

    try {
      const result = (await window.webContents.executeJavaScript(`
        (() => {
          const container = document.getElementById("root");
          const button = document.createElement("button");
          button.id = "supervision-probe-hit";
          let clicked = false;
          button.addEventListener("click", () => { clicked = true; });
          document.body.appendChild(button);
          button.click();
          button.remove();
          return {
            readyState: document.readyState,
            rootPresent: container !== null,
            rootChildren: container === null ? 0 : container.childElementCount,
            clicked,
            heading: document.body.innerText,
          };
        })()
      `)) as {
        readyState: string;
        rootPresent: boolean;
        rootChildren: number;
        clicked: boolean;
        heading: string;
      };

      if (result.readyState === "complete" && result.rootPresent) {
        return {
          url: window.webContents.getURL(),
          destroyed: window.isDestroyed(),
          loading: window.webContents.isLoading(),
          rootPresent: result.rootPresent,
          rootChildren: result.rootChildren,
          showsCrashHeading: result.heading.includes("界面已停止"),
          interactive: result.clicked,
        };
      }
    } catch {
      // The reload is still in flight; the renderer rejects script evaluation.
    }

    await sleep(100);
  }

  return null;
}

/** What the crash page says about itself. */
interface CrashPageState {
  readonly url: string;
  readonly heading: string;
  readonly buttons: { label: string; disabled: boolean }[];
  readonly reason: string;
  readonly exitCode: number | null;
}

/**
 * Wait for the crash page to mount and read the facts the requirement names.
 *
 * @param window the window
 * @param timeoutMs how long the page may take
 * @returns the observed page, or null when it never mounted
 */
async function waitForCrashPage(
  window: BrowserWindow,
  timeoutMs: number,
): Promise<CrashPageState | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (window.isDestroyed()) return null;

    try {
      const page = (await window.webContents.executeJavaScript(`
        (() => {
          const root = document.querySelector('[data-testid="crash-page"]');
          if (root === null) return null;
          return {
            heading: document.body.innerText,
            buttons: Array.from(root.querySelectorAll("button")).map((button) => ({
              label: (button.textContent || "").trim(),
              disabled: button.disabled === true,
            })),
          };
        })()
      `)) as { heading: string; buttons: { label: string; disabled: boolean }[] } | null;

      if (page !== null) {
        // Read the URL after the DOM, and only accept it once the navigation has
        // committed. The two observations travel different channels: sampling the
        // URL first can pair a mounted crash page with the pre-navigation URL and
        // turn a correct recovery into a false failure.
        await sleep(50);

        const url = window.webContents.getURL();

        if (!url.includes("crash=")) continue;

        const params = new URL(url).searchParams;
        const code = params.get("code");

        return {
          url,
          heading: page.heading,
          buttons: page.buttons,
          reason: params.get("reason") ?? "",
          exitCode: code === null || code === "" ? null : Number(code),
        };
      }
    } catch {
      // The renderer is mid-load or mid-crash; retry until the deadline.
    }

    await sleep(100);
  }

  return null;
}

/**
 * Click one action on the crash page in the page's own world.
 *
 * @param window the window
 * @param label the button's visible label
 * @returns whether a matching button was found and clicked
 */
async function clickCrashAction(window: BrowserWindow, label: string): Promise<boolean> {
  try {
    const clicked = (await window.webContents.executeJavaScript(`
      (() => {
        const root = document.querySelector('[data-testid="crash-page"]');
        if (root === null) return false;
        const button = Array.from(root.querySelectorAll("button")).find(
          (candidate) => (candidate.textContent || "").trim() === ${JSON.stringify(label)},
        );
        if (button === undefined) return false;
        button.click();
        return true;
      })()
    `)) as boolean;

    return clicked === true;
  } catch {
    return false;
  }
}

/**
 * Wait until the page's visible text contains a phrase.
 *
 * @param window the window
 * @param text the phrase
 * @param timeoutMs how long to wait
 * @returns whether it appeared
 */
async function waitForPageText(
  window: BrowserWindow,
  text: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (window.isDestroyed()) return false;

    try {
      const found = (await window.webContents.executeJavaScript(
        `document.body.innerText.includes(${JSON.stringify(text)})`,
      )) as boolean;

      if (found) return true;
    } catch {
      // Mid-render; retry.
    }

    await sleep(100);
  }

  return false;
}

/** One `.dmp` in crashpad's reports directory. */
function listDumpSizes(): { path: string; bytes: number }[] {
  const reports = path.join(CRASH_DUMPS, "reports");

  if (!existsSync(reports)) return [];

  return readdirSync(reports)
    .filter((name) => name.toLowerCase().endsWith(".dmp"))
    .map((name) => {
      const full = path.join(reports, name);

      try {
        return { path: full, bytes: statSync(full).size };
      } catch {
        return { path: full, bytes: 0 };
      }
    });
}

export { checkV08 };
