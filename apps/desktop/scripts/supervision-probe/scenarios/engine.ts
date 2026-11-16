/**
 * A real engine child, started through the shell's own host, killed while ready,
 * while ready, then started once more and stopped normally.
 *
 * The crash half proves `lastExit`/`stderrTail` and the engine `CrashRecord` (with
 * the `?crash=engine` route); the normal half proves that an orderly stop is not a
 * crash and reports whatever the OS exposed, or `null`.
 */

import path from "node:path";

import { BrowserWindow } from "electron";

import {
  crashDirFor,
  crashRecordFileName,
  readCrashRecords,
  type CrashRecord,
} from "../../../src/main/crash/records.js";
import { engineCrashQuery } from "../../../src/main/crash/page.js";
import { crashPageUrl } from "../../../src/main/crash/wiring.js";
import { APP_SCHEME } from "../../../src/main/protocol.js";
import {
  ENGINE_BUNDLE,
  EXPECTED_ENGINE_VERSION,
  PROBE_APP_VERSION,
  TEMP_ROOT,
  normalPageUrl,
  rendererAvailable,
} from "../environment.js";
import { describe, info, logSink, record, recordOnce } from "../report.js";
import { waitFor } from "../processes.js";
import {
  startEngineHost,
  stopEngineHost,
  type EngineHost,
} from "../../../src/main/supervision/engine-host.js";

// ---------------------------------------------------------------------------
// A real engine child, killed while ready
// ---------------------------------------------------------------------------

/** Engine facts captured while it was ready, for the bundle check. */
interface EngineObservation {
  readonly version: string | null;
  readonly protocolVersion: number | null;
  readonly watchdog: "active" | "inactive" | "unknown";
  readonly stderrTail: readonly string[];
}

/**
 * Start the real engine through the shell's host, kill it while ready, and
 * ready, and observe the exit, the stderr tail, the CrashRecord and the crash
 * query. Then start it once more and stop it normally, reporting `lastExit`
 * exactly as the OS exposed it (or null).
 *
 * @returns what was observed while the engine was ready, or null when it never
 * started (both ids still get a FAIL line)
 */
async function checkEngine(): Promise<EngineObservation | null> {
  if (ENGINE_BUNDLE === null) {
    recordOnce("engine-stop-exit-record", "SKIP", "HARUYUKI_ENGINE_BUNDLE is not set");
    recordOnce("engine-crash-record", "SKIP", "HARUYUKI_ENGINE_BUNDLE is not set");

    return null;
  }

  const userData = path.join(TEMP_ROOT, "v09");
  const crashDir = crashDirFor(userData);
  const normalUserData = path.join(TEMP_ROOT, "v02-normal");
  let crashRecord: CrashRecord | null = null;
  let host: EngineHost | null = null;
  let normalHost: EngineHost | null = null;
  let observation: EngineObservation | null = null;
  let crashProblems: string[] = [];

  try {
    const started = await startEngineHost({
      userData,
      appVersion: PROBE_APP_VERSION,
      bundlePath: ENGINE_BUNDLE,
      expectedEngineVersion: EXPECTED_ENGINE_VERSION,
      onLog: logSink,
      onCrash: (record) => {
        crashRecord = record;
      },
    });

    if (!started.ok) {
      const detail = `${started.reason}${started.detail === undefined ? "" : ` (${started.detail})`}`;

      recordOnce("engine-stop-exit-record", "FAIL", `the engine did not start: ${detail}`);
      recordOnce("engine-crash-record", "FAIL", `the engine did not start: ${detail}`);

      return null;
    }

    host = started.host;

    const serverInfo = host.engine.appServerInfo;

    observation = {
      version: serverInfo?.engineVersion ?? null,
      protocolVersion: serverInfo?.protocolVersion ?? null,
      watchdog: host.watchdog,
      stderrTail: host.engine.stderrTail(),
    };

    info(
      `engine version=${observation.version ?? "unknown"} ` +
        `protocol=${String(observation.protocolVersion ?? "unknown")} ` +
        `watchdog=${observation.watchdog} pid=${String(host.pid)}`,
    );

    // Kill the child. The watcher needs a transition into `failed` with a
    // handshake already recorded, which is exactly this state.
    const recordWait = waitFor(() => crashRecord, 10_000, 100);
    const exitWait = waitFor(() => host?.engine.lastExit ?? null, 10_000, 50);
    process.kill(host.pid, "SIGKILL");

    const exit = await exitWait;
    const recordResult = await recordWait;
    const tail = host.engine.stderrTail();
    const exitCode = exit?.code ?? null;
    const signal = exit?.signal ?? null;
    const query =
      exit === null
        ? ""
        : engineCrashQuery({
            ...exit,
            watchdog: host.watchdog,
          });
    const pageUrl = query === "" ? null : await engineCrashPageUrl(query);

    if (exit === null) crashProblems.push("lastExit stayed null after a real child kill");
    if (!Array.isArray(tail)) crashProblems.push("stderrTail is not readable after the crash");

    if (recordResult === null) {
      crashProblems.push("no CrashRecord within 10 s");
    } else if (recordResult.kind !== "engine" || recordResult.code !== "ENGINE_CRASHED") {
      crashProblems.push(`record kind=${recordResult.kind} code=${recordResult.code}`);
    } else if (recordResult.engine === undefined) {
      crashProblems.push("record has no engine facts");
    } else if (recordResult.engine.exitCode !== exitCode || recordResult.engine.signal !== signal) {
      crashProblems.push(
        `record exit ${String(recordResult.engine.exitCode)}/${String(recordResult.engine.signal)} ` +
          `differs from lastExit ${String(exitCode)}/${String(signal)}`,
      );
    } else if (recordResult.engine.engineVersion !== observation.version) {
      crashProblems.push("record engineVersion differs from the handshake");
    }

    if (!query.includes("crash=engine")) crashProblems.push(`query is ${JSON.stringify(query)}`);

    // The URL half only exists when the built renderer does; the record and the
    // query are still judged without it.
    if (pageUrl !== null && !pageUrl.includes("crash=engine")) {
      crashProblems.push(`page URL is ${pageUrl}`);
    }

    if (crashProblems.length === 0 && recordResult !== null) {
      record(
        "engine-crash-record",
        "PASS",
        `record=${crashRecordFileName(new Date(recordResult.at))} kind=engine ` +
          `code=ENGINE_CRASHED exit=${String(exitCode)} signal=${String(signal)} ` +
          `query=${query}${pageUrl === null ? " pageUrl=renderer-unavailable" : ` url=${new URL(pageUrl).search}`}`,
      );
    } else {
      record("engine-crash-record", "FAIL", crashProblems.join("; ") || "unknown engine crash failure");
    }

    // A normal stop is a different path: the caller asked for it, so the crash
    // watcher must not fire, and `lastExit` is whatever the OS exposed. The dead
    // host must be released first: the shell's single-host guard refuses a second
    // start while `activeHost` still names this one.
    if (host !== null) {
      await stopEngineHost(host).catch(() => undefined);
      host = null;
    }

    const normalStarted = await startEngineHost({
      userData: normalUserData,
      appVersion: PROBE_APP_VERSION,
      bundlePath: ENGINE_BUNDLE,
      expectedEngineVersion: EXPECTED_ENGINE_VERSION,
      onLog: logSink,
    });

    if (!normalStarted.ok) {
      recordOnce("engine-stop-exit-record", "FAIL", `the second engine start failed: ${normalStarted.reason}`);
      return observation;
    }

    normalHost = normalStarted.host;

    const stop = await stopEngineHost(normalHost);
    const normalExit = normalHost.engine.lastExit;
    const normalTail = normalHost.engine.stderrTail();

    info(
      `normal-stop stopped=${String(stop.stopped)} state=${normalHost.engine.state} ` +
        `lastExit=${normalExit === null ? "null" : `${String(normalExit.code)}/${String(normalExit.signal)}`}`,
    );

    if (crashProblems.length > 0) {
      recordOnce("engine-stop-exit-record", "FAIL", crashProblems.join("; "));
    } else if (!stop.stopped) {
      recordOnce("engine-stop-exit-record", "FAIL", `the engine did not stop: ${stop.reason ?? "unknown"}`);
    } else if (!Array.isArray(normalTail)) {
      recordOnce("engine-stop-exit-record", "FAIL", "stderrTail is not readable after a normal stop");
    } else {
      recordOnce(
        "engine-stop-exit-record",
        "PASS",
        `crashExit=${String(exitCode)} signal=${String(signal)} stderrLines=${String(tail.length)} ` +
          `normalStopLastExit=${
            normalExit === null ? "null" : `${String(normalExit.code)}/${String(normalExit.signal)}`
          }`,
      );
    }
  } catch (error) {
    const detail = describe(error);

    recordOnce("engine-stop-exit-record", "FAIL", detail);
    recordOnce("engine-crash-record", "FAIL", detail);
  } finally {
    if (host !== null) await stopEngineHost(host).catch(() => undefined);
    if (normalHost !== null) await stopEngineHost(normalHost).catch(() => undefined);

    info(`engine-crash-records=${String(readCrashRecords(crashDir).length)}`);
  }

  return observation;
}

/**
 * Derive an engine crash-page URL from a real window showing the normal page.
 *
 * @param query the crash query
 * @returns the derived URL, or null when the renderer is not available
 */
async function engineCrashPageUrl(query: string): Promise<string | null> {
  if (query === "" || !rendererAvailable()) return null;

  const window = await loadNormalWindow();

  if (window === null) return null;

  try {
    return crashPageUrl(window, query, APP_SCHEME);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

/**
 * Open a window on the real renderer's normal page.
 *
 * @returns the loaded window, or null when the renderer is not available
 */
async function loadNormalWindow(): Promise<BrowserWindow | null> {
  if (!rendererAvailable()) return null;

  const window = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  try {
    await window.loadURL(normalPageUrl());

    return window;
  } catch (error) {
    process.stderr.write(`probe: the normal page did not load: ${describe(error)}\n`);
    window.destroy();

    return null;
  }
}

export { checkEngine };
export type { EngineObservation };
