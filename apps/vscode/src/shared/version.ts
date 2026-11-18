/**
 * The version numbers this shell speaks, in one place.
 *
 * Three different questions are answered here, and they must not be confused:
 *
 * - `APP_VERSION` is the version of this extension package. It identifies the
 *   bundle a crash report came from, so it has to match the manifest VS Code
 *   packages. `package.json` is the packaged source of that number; the literal
 *   below is a copy because the extension entry is bundled as CommonJS and a
 *   JSON import would drag the whole manifest into the artifact. A test reads
 *   both and fails on drift, so the copy cannot rot.
 * - `TESTED_ENGINE_VERSION` is the engine build this shell was developed and
 *   tested against. It is what the host announces as the expected version and
 *   what the status line shows before an engine has answered. The contract
 *   snapshot pins the same number, and a test compares the two.
 * - `BRIDGE_VERSION` is the version of the message family between the panel and
 *   the extension host. Both sides compare it for exact equality, so it may
 *   only ever be written in one place per bundle. The webview bundle's copy is
 *   `WEBVIEW_BRIDGE_VERSION` in `../webview/bridge.ts`, which belongs to the
 *   panel bundle and is kept separate on purpose: importing it here would pull
 *   the panel's module graph (React included) into the extension host entry.
 *   The pairing is enforced by a test instead of by an import.
 */

import type { CoreStatusSnapshot } from "../core/ipc.js";

/** Version of the extension package; must equal `package.json`. */
export const APP_VERSION = "0.1.0";

/** The engine build this shell targets. Must equal the contract snapshot pin. */
export const TESTED_ENGINE_VERSION = "0.6.0";

/** The host/panel message family version. Must equal the webview's copy. */
export const BRIDGE_VERSION = "1";

/**
 * The version facts a status surface or a log line reports.
 *
 * One reader of `CoreStatusSnapshot`, so the status line and the activation
 * line cannot describe the same run differently.
 *
 * @param snapshot the core's last reported status
 * @returns the version and origin fields it carried
 */
export function versionFactsFrom(snapshot: CoreStatusSnapshot | undefined): {
  readonly engineVersion?: string;
  readonly cwd?: string;
  readonly source?: string;
} {
  if (snapshot === undefined) return {};

  return {
    ...(snapshot.engineVersion === undefined ? {} : { engineVersion: snapshot.engineVersion }),
    ...(snapshot.cwd === undefined ? {} : { cwd: snapshot.cwd }),
    ...(snapshot.source === undefined ? {} : { source: snapshot.source }),
  };
}
