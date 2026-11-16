/**
 * Settings I/O: read the document, decide whether this build may write it.
 *
 * Kept out of `main.ts` because both operations are a procedure with one result
 * each, not startup ordering. The caller owns the in-memory settings and the
 * `writable` flag; nothing here caches them.
 */

import { app, safeStorage, type BrowserWindow } from "electron";

import {
  DEFAULT_SETTINGS,
  readSettings,
  serializeSettings,
  SETTINGS_VERSION,
  settingsPath,
  type ShellSettings,
} from "./settings.js";
import { shellError } from "../shared/shell-error.js";
import type { Logger } from "./log.js";

export interface LoadedSettings {
  readonly settings: ShellSettings;
  /** False when the file on disk is a newer format than this build understands. */
  readonly writable: boolean;
}

/**
 * Read the settings, reporting every decision that is not a plain success.
 *
 * @param logger the shell log at call time
 */
export async function loadSettings(logger: Logger | null): Promise<LoadedSettings> {
  const { readFile } = await import("node:fs/promises");
  const file = settingsPath(app.getPath("userData"));

  let raw: string;

  try {
    raw = await readFile(file, "utf8");
  } catch {
    // Not an error: this is a first launch, or the file was removed.
    logger?.info("settings.first-launch", { file });

    return { settings: { ...DEFAULT_SETTINGS }, writable: true };
  }

  const read = readSettings(raw, {
    onLogsInvalid: (problems) => {
      logger?.warn("settings.logs.invalid", { fields: problems });
    },
  });

  // A file that exists but could not be understood is a different event from a
  // first launch. Reporting both as "first launch" is how a settings file being
  // written over by a half-crashed process goes unnoticed until someone wonders
  // why their preferences never stick.
  if (read.corrupt) {
    logger?.warn("settings.corrupt", {
      code: shellError("SHELL_SETTINGS_CORRUPT", `unparsable document: ${file}`).code,
      detail: file,
    });
  }

  if (!read.writable) {
    logger?.warn("settings.read-only", {
      file,
      foundVersion: read.foundVersion,
      supportedVersion: SETTINGS_VERSION,
    });
  }

  logger?.info("settings.loaded", {
    file,
    theme: read.settings.theme,
    locale: read.settings.locale,
    writable: read.writable,
  });

  return { settings: read.settings, writable: read.writable };
}

/**
 * Persist the settings. Failures are logged, never surfaced: a settings file
 * that cannot be written must not close the window the user is working in.
 *
 * @param next the complete document to write
 * @param writable whether this build may write the file at all
 * @param logger the shell log at call time
 */
export async function saveSettings(
  next: ShellSettings,
  writable: boolean,
  logger: Logger | null,
): Promise<void> {
  if (!writable) {
    logger?.info("settings.write-skipped", { detail: "the file was written by a newer version" });

    return;
  }

  const { writeFile } = await import("node:fs/promises");
  const file = settingsPath(app.getPath("userData"));

  try {
    await writeFile(file, serializeSettings(next), "utf8");
  } catch (error) {
    logger?.warn("settings.write-failed", { detail: String(error) });
  }
}

/** Capture the window geometry into a settings document. */
export function rememberGeometry(current: ShellSettings, window: BrowserWindow): ShellSettings {
  if (window.isMinimized()) return current;

  const maximized = window.isMaximized();
  const bounds = maximized ? window.getNormalBounds() : window.getBounds();

  return { ...current, window: { ...bounds, maximized } };
}

/** Which storage backend Electron selected; `unknown` on a build without the API. */
export function chosenStorageBackend(): string {
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string })
    .getSelectedStorageBackend;

  return typeof backend === "function" ? backend.call(safeStorage) : "unknown";
}
