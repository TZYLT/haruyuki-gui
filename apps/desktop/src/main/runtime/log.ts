/**
 * Open the log directory for the runtime error page.
 *
 * `shell.openPath` returns an empty string on success and a non-empty error
 * string on failure; a boolean wrapper would throw that detail away. The
 * directory can legitimately not exist yet (first launch, no log line written),
 * so that case is reported as a value instead of letting `openPath` fail with a
 * message the page cannot show.
 *
 * The `openPath` function is injected so this can be tested without launching
 * Explorer or a file manager.
 */

import { stat } from "node:fs/promises";

import type { RuntimeLogResult } from "../../shared/runtime.js";

/** The slice of `shell.openPath` this module needs. */
export type OpenPath = (directory: string) => Promise<string>;

/**
 * Open a directory and report what happened.
 *
 * @param logsDir absolute log directory from the runtime layout
 * @param openPath Electron's `shell.openPath`, or a fake in tests
 * @returns success, or a failure with an actionable detail
 */
export async function openLogsDirectory(
  logsDir: string,
  openPath: OpenPath,
): Promise<RuntimeLogResult> {
  try {
    const info = await stat(logsDir);

    if (!info.isDirectory()) {
      return { ok: false, detail: `log path is not a directory: ${logsDir}` };
    }
  } catch {
    return { ok: false, detail: `log directory does not exist: ${logsDir}` };
  }

  try {
    const error = await openPath(logsDir);

    return error === ""
      ? { ok: true }
      : { ok: false, detail: `could not open ${logsDir}: ${error}` };
  } catch (error) {
    return {
      ok: false,
      detail: `could not open ${logsDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
