/**
 * The diagnostics export channel, wired as one procedure.
 *
 * `registerDiagnosticsIpc` owns the protocol; this module owns the product
 * context it needs (paths, settings, engine facts, dialogs). Keeping both out of
 * `main.ts` means the entry point only says "install this" and the export
 * details have one home.
 */

import { dialog, shell, type App, type IpcMain } from "electron";
import { release as osRelease } from "node:os";

import type { EngineHost } from "../supervision/engine-host.js";
import { crashDirFor, readCrashRecords } from "../crash/records.js";
import { collectDiagnostics } from "./collect.js";
import { runDiagnosticsExport, type DiagnosticsExportContext } from "./export.js";
import { registerDiagnosticsIpc } from "./ipc.js";
import { diagnosticsEngineFacts, diagnosticsLabels, diagnosticsSecrets } from "./wiring.js";
import { writeZip } from "./zip.js";
import type { ShellSettings } from "../settings.js";
import type { Logger } from "../log.js";
import type { SessionDiagnosticsSource } from "./session.js";

export interface MainDiagnosticsIpcOptions {
  readonly ipcMain: IpcMain;
  readonly getWindow: () => Electron.BrowserWindow | null;
  readonly sessionSource: () => SessionDiagnosticsSource | null;
  readonly logger: Logger;
  readonly app: App;
  readonly userData: string;
  readonly settings: ShellSettings;
  readonly locale: string;
  readonly getEngineHost: () => EngineHost | null;
  readonly cleanup: () => Promise<void>;
}

/** Register the three diagnostics commands against the live shell. */
export function registerMainDiagnosticsIpc(options: MainDiagnosticsIpcOptions): void {
  const { app, userData, settings, locale, logger } = options;

  registerDiagnosticsIpc({
    ipcMain: options.ipcMain,
    getWindow: options.getWindow,
    sessionAvailable: options.sessionSource() !== null,
    logger,
    app,
    export: async (run) => {
      // Second sweep: before the save dialog, so a cleanup failure cannot hide behind it.
      await options.cleanup();

      const context: DiagnosticsExportContext = {
        userData,
        logsDir: app.getPath("logs"),
        crashDumpsDir: app.getPath("crashDumps"),
        downloadsDir: app.getPath("downloads"),
        appVersion: app.getVersion(),
        commit: null,
        electron: process.versions.electron ?? "unknown",
        chrome: process.versions.chrome ?? "unknown",
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        release: osRelease(),
        locale,
        theme: settings.theme,
        settings,
        engine: diagnosticsEngineFacts(options.getEngineHost()),
        crashes: readCrashRecords(crashDirFor(userData)),
        sessionSource: options.sessionSource(),
        secrets: diagnosticsSecrets(options.getEngineHost()),
      };

      return runDiagnosticsExport({ options: run.options }, context, {
        now: () => new Date(),
        onEvent: run.onEvent,
        abortSignal: run.signal,
        collect: collectDiagnostics,
        writeZip,
        labels: diagnosticsLabels(locale),
        showSaveDialog: async (dialogOptions) => {
          const window = options.getWindow();
          const result =
            window === null
              ? await dialog.showSaveDialog(dialogOptions)
              : await dialog.showSaveDialog(window, dialogOptions);

          return { canceled: result.canceled, filePath: result.filePath };
        },
        showMessageBox: async (messageOptions) => {
          const window = options.getWindow();
          const result =
            window === null
              ? await dialog.showMessageBox(messageOptions)
              : await dialog.showMessageBox(window, messageOptions);

          return { response: result.response };
        },
        openPath: async (target) => {
          const failure = await shell.openPath(target);

          if (failure !== "") throw new Error(failure);
        },
      });
    },
  });
}
