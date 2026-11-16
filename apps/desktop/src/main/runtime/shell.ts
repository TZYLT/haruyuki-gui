/**
 * The composition root's runtime wiring: verify, start, and the three recovery
 * channels. Kept out of `main.ts` because that file is at its 999-line limit and
 * because none of this belongs in the window/bootstrap order.
 *
 * D4 still owns start/stop. This module only hands it a bundle and a real
 * watchdog, then publishes status. The picker restart uses the D4
 * `restartWithSpec` seam; it never constructs a second `EngineHost`.
 */

import { app, dialog, shell, type BrowserWindow, type IpcMain } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

import type { CrashRecord } from "../crash/records.js";
import { desktopPaths, buildSpawnSpec, ensurePaths } from "../host-port.js";
import { startEngineHost, type EngineHost } from "../supervision/engine-host.js";
import { startShellEngine, type ShellEngineDeps } from "../supervision/engine-lifecycle.js";
import type { SupervisionLog } from "../supervision/errors.js";
import type { QuitSupervisor } from "../supervision/quit.js";
import {
  RUNTIME_FAILED_CHANNEL,
  registerRuntimeChannels,
  type RuntimeChannelHost,
  type RuntimePickResult,
  type RuntimeResetResult,
} from "../../shared/runtime-channels.js";
import type { RuntimeFailure, RuntimeLogResult, RuntimeStatus } from "../../shared/runtime.js";
import { openLogsDirectory } from "./log.js";
import { computeRuntimeLayout, type RuntimeLayout } from "./layout.js";
import { selectBundle } from "./selection.js";
import { readRuntimeState, writeRuntimeState } from "./state.js";
import { prepareRuntime, type RuntimePlan } from "./startup.js";

/** Everything `main.ts` has to provide; no Electron reads inside the caller. */
export interface RuntimeShellDeps {
  readonly window: BrowserWindow;
  readonly ipcMain: IpcMain;
  readonly userData: string;
  readonly appVersion: string;
  readonly appPath: string;
  /** `__dirname` of the built main bundle; used for the dev layout only. */
  readonly here: string;
  readonly logsDir: string;
  readonly onLog: SupervisionLog;
  readonly onCrash: (record: CrashRecord) => void;
  readonly quitSupervisor: QuitSupervisor | null;
  readonly onHost: (host: EngineHost | null) => void;
}

/** The controller behind the runtime channels. */
class RuntimeController implements RuntimeChannelHost {
  private statusValue: RuntimeStatus;
  private host: EngineHost | null = null;
  private source: "bundled" | "external" | "path";
  private engineVersion?: string;
  private readonly layout: RuntimeLayout;
  private readonly deps: RuntimeShellDeps;

  constructor(plan: RuntimePlan, layout: RuntimeLayout, deps: RuntimeShellDeps) {
    this.source = plan.ok ? plan.source : "bundled";
    if (plan.ok && plan.engineVersion !== undefined) {
      this.engineVersion = plan.engineVersion;
    }
    this.layout = layout;
    this.deps = deps;
    this.statusValue = { phase: "starting", appVersion: deps.appVersion };
  }

  /** @returns the current status */
  status(): Promise<RuntimeStatus> {
    return Promise.resolve(this.statusValue);
  }

  /** @returns whether the log directory opened */
  log(): Promise<RuntimeLogResult> {
    return openLogsDirectory(this.layout.logsDir, (directory) => shell.openPath(directory));
  }

  /**
   * Ask for a directory, validate it, confirm an untested version, persist the
   * pick and restart through D4's explicit seam.
   *
   * @returns the pick result, including the failure the page should show
   */
  async pick(): Promise<RuntimePickResult> {
    const picked = await dialog.showOpenDialog(this.deps.window, {
      title: "Choose an engine directory",
      properties: ["openDirectory"],
    });

    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, failureKind: "missing-bundle", detail: "No directory selected." };
    }

    const chosen = picked.filePaths[0]!;
    const selected = await selectBundle({ bundledDir: chosen, externalDir: chosen });

    if (selected.kind === "missing") {
      return { ok: false, failureKind: "missing-bundle", detail: selected.reason };
    }

    const location = selected.location;

    // The picker must never fall through to the bundled branch. Passing the
    // chosen directory as both roots would accept an invalid external pick as
    // "bundled" (the bundled inspection does not require package.json/name),
    // persist it as external and then start it. Only a real external location
    // is allowed here.
    if (location.source !== "external") {
      return {
        ok: false,
        failureKind: "external-invalid",
        detail:
          selected.externalInvalid?.reason ??
          "The selected directory is not a usable external engine.",
      };
    }

    const lock = await this.currentLockVersion();
    const mismatch =
      lock !== undefined && location.version !== undefined && location.version !== lock;

    if (mismatch) {
      const confirm = await dialog.showMessageBox(this.deps.window, {
        type: "warning",
        buttons: ["Cancel", "Use anyway"],
        defaultId: 0,
        cancelId: 0,
        title: "Untested engine version",
        message: `This engine is ${location.version}; the bundled engine is ${lock}.`,
        detail: "It may write state this app cannot read. Use it only if you trust the directory.",
      });

      if (confirm.response !== 1) {
        return {
          ok: false,
          failureKind: "start-failed",
          detail: "Cancelled at the version warning.",
        };
      }
    }

    const read = await readRuntimeState(this.layout.statePath);
    const state = {
      ...read.state,
      externalEngineDir: location.engineDir,
      ...(location.version === undefined ? {} : { externalEngineVersion: location.version }),
    };

    await writeRuntimeState(this.layout.statePath, state).catch(() => undefined);

    const result = await this.startWith(
      location.bundlePath,
      location.engineDir,
      "external",
      location.version,
    );

    if (!result.ok) {
      return { ok: false, failureKind: result.failure.kind, detail: result.failure.detail };
    }

    return {
      ok: true,
      engineDir: location.engineDir,
      ...(location.version === undefined ? {} : { engineVersion: location.version }),
    };
  }

  /**
   * Clear the external pick and return to the bundled engine.
   *
   * @returns reset result
   */
  async reset(): Promise<RuntimeResetResult> {
    const read = await readRuntimeState(this.layout.statePath);
    const { externalEngineDir: _dir, externalEngineVersion: _version, ...rest } = read.state;

    await writeRuntimeState(this.layout.statePath, rest).catch(() => undefined);

    const result = await this.startWith(
      this.layout.bundlePath,
      this.layout.engineDir,
      "bundled",
      undefined,
    );

    return result.ok ? { ok: true } : { ok: false, detail: result.failure.detail };
  }

  /** Publish a failure and notify the renderer. */
  fail(failure: RuntimeFailure): void {
    this.statusValue = {
      phase: "failed",
      failure,
      appVersion: this.deps.appVersion,
    };
    sendFailed(this.deps.window, failure);
  }

  /** Publish a host as ready. */
  ready(host: EngineHost, externalNotice?: string): void {
    this.host = host;
    this.statusValue = {
      phase: "ready",
      appVersion: this.deps.appVersion,
      source: this.source,
      ...(this.engineVersion === undefined ? {} : { engineVersion: this.engineVersion }),
      ...(externalNotice === undefined ? {} : { externalNotice }),
    };
  }

  /** Attach the initial D4 host without a restart. */
  attach(host: EngineHost | null, externalNotice?: string): void {
    this.host = host;

    if (host !== null) this.ready(host, externalNotice);
  }

  /** Start or restart through D4 and publish the outcome. */
  private async startWith(
    bundlePath: string,
    engineDir: string,
    source: "external" | "bundled",
    version: string | undefined,
  ): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> {
    this.source = source;
    if (version === undefined) {
      delete this.engineVersion;
    } else {
      this.engineVersion = version;
    }

    if (this.host !== null) {
      const spec = await this.buildSpec(bundlePath);

      if (!spec.ok) return { ok: false, failure: spec.failure };

      const result = await this.host.restartWithSpec(spec.spec);

      if (!result.ok) {
        const failure: RuntimeFailure = {
          kind: "start-failed",
          detail: result.detail ?? result.reason,
          engineDir: engineDir,
          logPath: this.layout.logsDir,
        };
        this.fail(failure);
        return { ok: false, failure };
      }

      this.ready(result.host);
      this.deps.onHost(result.host);
      return { ok: true };
    }

    const result = await startEngineHost({
      userData: this.deps.userData,
      appVersion: this.deps.appVersion,
      appPath: this.deps.appPath,
      bundlePath,
      resolveWatchdog: () => this.layout.watchdogPath,
      onLog: this.deps.onLog,
      onCrash: this.deps.onCrash,
    });

    if (!result.ok) {
      const failure: RuntimeFailure = {
        kind: "start-failed",
        detail: result.detail ?? result.reason,
        engineDir: engineDir,
        logPath: this.layout.logsDir,
      };
      this.fail(failure);
      return { ok: false, failure };
    }

    const accepted = this.deps.quitSupervisor?.setHost(result.host) ?? true;

    if (!accepted) {
      const failure: RuntimeFailure = {
        kind: "start-failed",
        detail: "The engine was stopped because the app is quitting.",
        engineDir: engineDir,
        logPath: this.layout.logsDir,
      };
      this.fail(failure);
      return { ok: false, failure };
    }

    this.ready(result.host);
    this.deps.onHost(result.host);
    return { ok: true };
  }

  /** Build a spec against the real layout; `buildSpawnSpec` owns the shape. */
  private async buildSpec(
    bundlePath: string,
  ): Promise<
    | { ok: true; spec: import("@haruyuki/core").EngineSpawnSpec }
    | { ok: false; failure: RuntimeFailure }
  > {
    const paths = desktopPaths((name) => app.getPath(name as Parameters<typeof app.getPath>[0]));

    await ensurePaths(paths);

    const built = await buildSpawnSpec(
      { bundlePath, watchdogPath: this.layout.watchdogPath },
      paths,
      existsSync,
      this.deps.appPath,
    );

    if (!built.ok) {
      return {
        ok: false,
        failure: {
          kind: "start-failed",
          detail: built.reason,
          engineDir: path.dirname(bundlePath),
          logPath: this.layout.logsDir,
        },
      };
    }

    return { ok: true, spec: built.spec };
  }

  /** Read the bundled lock version for the "untested combination" warning. */
  private async currentLockVersion(): Promise<string | undefined> {
    try {
      const text = await readFileText(this.layout.lockPath);
      const parsed: unknown = JSON.parse(text);

      if (typeof parsed === "object" && parsed !== null) {
        const version = (parsed as Record<string, unknown>)["engineVersion"];

        return typeof version === "string" ? version : undefined;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }
}

/** Read a small file without importing the async fs module twice. */
async function readFileText(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");

  return readFile(file, "utf8");
}

/**
 * Wire the runtime for this window: verify, register channels, start D4.
 *
 * @param deps the shell's facts and callbacks
 */
export async function startRuntimeShell(deps: RuntimeShellDeps): Promise<void> {
  const layout = computeRuntimeLayout({
    isPackaged: app.isPackaged,
    appPath: deps.appPath,
    resourcesPath: process.resourcesPath,
    here: deps.here,
    userData: deps.userData,
    logsDir: deps.logsDir,
  });
  const plan = await prepareRuntime({ layout, appVersion: deps.appVersion });
  const controller = new RuntimeController(plan, layout, deps);

  registerRuntimeChannels(deps.ipcMain, controller);

  if (!plan.ok) {
    controller.fail(plan.failure);
    return;
  }

  const host = await startShellEngine({
    userData: deps.userData,
    appVersion: deps.appVersion,
    appPath: deps.appPath,
    bundlePath: plan.bundlePath,
    watchdogPath: plan.watchdogPath,
    onLog: deps.onLog,
    onCrash: deps.onCrash,
    quitSupervisor: deps.quitSupervisor,
    onHost: (started) =>
      controller.attach(
        started,
        plan.externalInvalid === undefined
          ? undefined
          : `External engine unavailable; using the bundled engine (${plan.externalInvalid.reason}).`,
      ),
  });

  if (host === null) {
    controller.fail({
      kind: "start-failed",
      detail: "The engine did not start; see the log for the spawn failure.",
      logPath: layout.logsDir,
    });
  }
}

/** Send the failure after the page can receive it. */
function sendFailed(window: BrowserWindow, failure: RuntimeFailure): void {
  if (window.isDestroyed()) return;

  const send = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(RUNTIME_FAILED_CHANNEL, failure);
    }
  };

  if (window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

/** Re-export for `main.ts` typing without importing D4 twice. */
export type { ShellEngineDeps };
