/**
 * Process-wide environment for the probe: temp isolation, crash reporter, the
 * `app://` scheme, and the renderer location.
 *
 * The side effects at module scope are deliberate and must happen before Electron
 * becomes ready: `userData` and `crashDumps` decide where a crash lands, and a
 * privileged scheme cannot be registered after ready. The entry imports this
 * module first, so none of it depends on a check running.
 *
 * No user data is read: the temp root is either the caller's (the smoke script
 * removes it) or a fresh `mkdtemp` directory.
 */

import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { app, crashReporter, protocol } from "electron";

import { headersFor } from "../../src/main/csp.js";
import {
  APP_HOST,
  APP_PRIVILEGES,
  APP_SCHEME,
  createProtocolHandler,
} from "../../src/main/protocol.js";
import { describe, shellLog } from "./report.js";

/** The app version the probe reports; it is not a shipped build. */
const PROBE_APP_VERSION = "0.1.0-supervision-probe";

/** The engine bundle the smoke script resolved; absent means the engine checks skip. */
const ENGINE_BUNDLE = absoluteEnvironmentPath("HARUYUKI_ENGINE_BUNDLE");

/**
 * The built renderer root; absent means the renderer-recovery check skips instead
 * of judging a stand-in.
 */
const RENDERER_ROOT = absoluteEnvironmentPath("HARUYUKI_RENDERER_ROOT");

/** The engine version the probe asks `Engine.start` to confirm. */
const EXPECTED_ENGINE_VERSION = "0.6.0";

/** One temp root for everything this run writes. */
const TEMP_ROOT = resolveTempRoot();

/** This run's userData, so `app.getPath` never touches the real one. */
const USER_DATA = path.join(TEMP_ROOT, "user-data");

/** Crashpad's own directory; the recovery check observes it but never requires a dump. */
const CRASH_DUMPS = path.join(TEMP_ROOT, "crash-dumps");

// Isolate Electron before anything can read a path: the crash path and the
// marker path both key off userData, and a probe must not touch the user's real
// profile.
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(CRASH_DUMPS, { recursive: true });
app.setPath("userData", USER_DATA);
app.setPath("crashDumps", CRASH_DUMPS);

// The probe creates and destroys windows as part of its checks. Electron's
// default `window-all-closed` behaviour quits the app, which would end the run
// halfway through; the probe owns its own lifetime.
app.on("window-all-closed", () => {
  // Deliberately empty: the run ends in `main`, not when a test window closes.
});

// Before ready, and before the first window: an early crash is still a crash.
crashReporter.start({ uploadToServer: false, compress: false, rateLimit: false });

// The scheme must be registered before ready. The probe registers the shell's own
// scheme with the shell's own privileges so the recovery check drives the real
// renderer bundle through the real handler, not a fixture that mimics one.
try {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { ...APP_PRIVILEGES } }]);
} catch (error) {
  process.stderr.write(`probe: registerSchemesAsPrivileged failed: ${describe(error)}\n`);
}

/**
 * Read an environment variable as an absolute path.
 *
 * @param name variable name
 * @returns the resolved path, or null when unset or blank
 */
function absoluteEnvironmentPath(name: string): string | null {
  const value = process.env[name];

  return value === undefined || value.trim() === "" ? null : path.resolve(value);
}

/**
 * Create the temp root, preferring the caller's directory.
 *
 * The caller-owned path lets the smoke script remove the tree after this process
 * exits, which is the reliable moment on Windows: Chromium keeps session files
 * open until the process is gone.
 *
 * @returns an absolute directory that exists
 */
function resolveTempRoot(): string {
  const supplied = process.env["HARUYUKI_PROBE_TEMP"];
  const directory =
    supplied === undefined || supplied.trim() === ""
      ? mkdtempSync(path.join(tmpdir(), "haruyuki-supervision-probe-"))
      : path.resolve(supplied);

  mkdirSync(directory, { recursive: true });

  return directory;
}

/** Whether the built renderer the crash page belongs to is present. */
function rendererAvailable(): boolean {
  return RENDERER_ROOT !== null && existsSync(path.join(RENDERER_ROOT, "index.html"));
}

/** The normal page URL, with the locale the crash-page assertion reads. */
function normalPageUrl(): string {
  return `${APP_SCHEME}://${APP_HOST}/index.html?locale=zh-CN&theme=light`;
}

/**
 * When set, the next requests for a page without a `crash` query are failed.
 *
 * The reload-failure case needs a *real* navigation failure: the handler
 * throwing is how Electron turns a request into `did-fail-load`, which is the
 * event `reloadNormalPage` watches. Nothing else is faked -- the retry is not an
 * injected event, and the crash page itself is served normally.
 */
let failNormalPageRequests = false;

/**
 * Turn the normal-page protocol fault on or off.
 *
 * @param enabled whether requests without a `crash` query must fail
 */
function setNormalPageFault(enabled: boolean): void {
  failNormalPageRequests = enabled;
}

/**
 * Register the real `app://` handler against the built renderer.
 *
 * The handler is production code (`createProtocolHandler` + `headersFor`), so a
 * bug in path resolution or content type shows up here as a page that does not
 * load, not as a probe that silently serves a fixture. The wrapper adds only the
 * fault switch above.
 */
function registerAppProtocol(): void {
  if (!rendererAvailable() || RENDERER_ROOT === null) return;

  const handler = createProtocolHandler({
    allowRoot: RENDERER_ROOT,
    headersFor,
    onFailure: (error) => {
      shellLog.push({ event: "probe.protocol.refused", detail: { code: error.code } });
    },
  });

  try {
    protocol.handle(APP_SCHEME, async (request) => {
      if (failNormalPageRequests) {
        let crashRoute = true;

        try {
          crashRoute = new URL(request.url).searchParams.has("crash");
        } catch {
          crashRoute = false;
        }

        if (!crashRoute) throw new Error("probe: injected app:// failure for the normal page");
      }

      return handler(request);
    });
  } catch (error) {
    process.stderr.write(`probe: protocol.handle failed: ${describe(error)}\n`);
  }
}

export {
  APP_HOST,
  APP_SCHEME,
  CRASH_DUMPS,
  ENGINE_BUNDLE,
  EXPECTED_ENGINE_VERSION,
  PROBE_APP_VERSION,
  RENDERER_ROOT,
  TEMP_ROOT,
  normalPageUrl,
  registerAppProtocol,
  rendererAvailable,
  setNormalPageFault,
};
