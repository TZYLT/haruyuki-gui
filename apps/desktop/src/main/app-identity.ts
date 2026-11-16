/**
 * The application's own name, and the one place that sets it.
 *
 * Why this is a module rather than one line inside `main()`: `app.setName` decides
 * where `userData` resolves, and three things live under `userData` that make the
 * difference a problem rather than an untidiness --
 *
 *   `media-access.json` holds the position-trust decision. In a shared directory,
 *   another unpackaged Electron application on the same machine could flip a switch
 *   that turns the file viewer into a whole-disk browser.
 *
 *   `shell-settings.json` is the shell's own; two applications would overwrite each
 *   other's window geometry and locale.
 *
 *   The engine's `HARUYUKI_HOME`, its token directory and its default file tree are all
 *   this same root.
 *
 * Those consequences are why the *check* on this behaviour has to measure the real
 * call and not a copy of it. `verify:host-port` launches a separate Electron process
 * and cannot load `main.ts` (importing it starts the whole shell), so before this module
 * existed the probe called `app.setName` itself and then asserted the result -- which
 * meant the assertion passed on any tree, including one where the shell's own call had
 * been deleted. A check that cannot fail is not a check.
 *
 * Now both the shell and the probe call {@link applyAppName}, and a static assertion in
 * `frozen-surfaces.test.ts` requires `main()` to call it before any `getPath`.
 */

import { app } from "electron";

import { APP_NAME } from "./i18n.js";

/**
 * The Windows Application User Model ID.
 *
 * Kept in this module so the `appId` in electron-builder and the runtime call
 * cannot drift: a toast belongs to the AUMID the process set, not to the name in
 * the installer. G1's builder config uses the same literal.
 */
export const APP_USER_MODEL_ID = "com.haruyuki.desktop" as const;

/**
 * Set the application name and (on Windows) the AUMID.
 *
 * Must run before any `app.getPath` call, because `setName` only affects paths resolved
 * after it. A `getPath` moved to module scope would silently undo this, and the symptom
 * would be a second `Electron` directory rather than an error.
 *
 * Idempotent, so a probe and the shell calling it in either order is harmless.
 */
export function applyAppName(): void {
  app.setName(APP_NAME);

  // Windows uses the AUMID to attribute notifications and taskbar identity.
  // Calling it on the other platforms is unnecessary; the guard keeps the
  // behaviour explicit rather than relying on a no-op.
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
}
