/**
 * The supervision probe: what actually happens when a real Electron main process
 * supervises a real engine child and a real renderer.
 *
 * `supervision-smoke.mjs` builds this file into `dist/probe/supervision-probe.cjs`
 * and launches it with the Electron binary. Everything below runs in a real main
 * process because the questions are about real processes: a stale PID, an OS exit
 * code, a crashpad directory and a `render-process-gone` event cannot be answered
 * by a Node script.
 *
 * It prints one line per judgment, in the shape the smoke script parses:
 *
 *   PASS <id> <measured facts>
 *   FAIL <id> <why>
 *   SKIP <id> <why it cannot be judged honestly here>
 *
 * Required ids: leaked-child-reclaimed, engine-stop-exit-record, ambiguous-pid-not-killed, engine-crash-record, renderer-recovery-sequence, main-crash-record, diagnostic-bundle-tree. A SKIP is not a pass.
 *
 * What the ids mean in this probe:
 *
 *   leaked-child-reclaimed  a leaked real child survives the death of the process that recorded it,
 *         and the next boot reclaims it on two-condition evidence, removes the
 *         token file and rewrites the runtime marker
 *   engine-stop-exit-record  a real engine child killed while ready leaves `lastExit` and a readable
 *         `stderrTail`; a normal stop reports whatever the OS exposed, or null
 *   ambiguous-pid-not-killed  the reclaim decision is two-condition: a live PID with a matching time
 *         or image alone is `ambiguous` and is never killed
 *   engine-crash-record  log retention (7 days / 50 MB, current day never deleted) and redaction
 *         (home -> ~, known secret -> [redacted]) on temp directories only
 *   renderer-recovery-sequence  renderer recovery, two stages plus the fallback: first death reloads the
 *         normal interface (interactive, no error page), second death shows the D4
 *         crash page (title 界面已停止, three enabled actions), third death calls the
 *         fallback exactly once and does not navigate again
 *   main-crash-record  an engine that dies while ready produces a CrashRecord and a
 *         `?crash=engine` crash-page query
 *   diagnostic-bundle-tree  `collectDiagnostics` + `writeZip` produce the documented tree, manifest
 *         hashes match the shipped bytes, and no default session content ships
 *
 * Two environment facts this file has to survive (both measured in docs/33):
 *
 *   `ELECTRON_RUN_AS_NODE=1` is set globally on this machine. Inherited by the
 *   Electron binary it turns the process into plain Node, `app.whenReady()` never
 *   resolves, and the failure looks like a hang. The smoke script removes it; this
 *   file never sets it on itself, only on the children it spawns.
 *
 *   `forcefullyCrashRenderer()` produced no minidump within 3 s in the route's
 *   probe on this host. It is still what the renderer-recovery check uses, because
 *   the ruling is about the recovery sequence, not about crashpad; the dump size is
 *   printed as an observation and is never part of the judgment.
 *
 * Everything written goes under one temp root: `HARUYUKI_PROBE_TEMP` when the
 * caller supplies one (the smoke script does, so it can remove the whole tree after
 * this process exits), otherwise a fresh `mkdtemp` directory. No user data is read
 * or written.
 */

import { readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app, BrowserWindow } from "electron";

import { installMainCrashHandlers } from "../src/main/crash/capture.js";
import { crashVersions } from "../src/main/crash/wiring.js";

// First import on purpose: its module scope isolates Electron (userData,
// crashDumps), starts the crash reporter and registers the privileged scheme
// before the app is ready.
import { TEMP_ROOT, registerAppProtocol } from "./supervision-probe/environment.js";
import { killAllSpawned } from "./supervision-probe/processes.js";
import { describe, info, outcomes, record, recordOnce } from "./supervision-probe/report.js";
import { checkEngine, checkV03 } from "./supervision-probe/scenarios/engine.js";
import { checkV09MainCrash } from "./supervision-probe/scenarios/main-crash.js";
import { checkV01, checkV04, checkV05V06 } from "./supervision-probe/scenarios/reclaim.js";
import { checkV08 } from "./supervision-probe/scenarios/renderer.js";
import { checkV07, checkV10V11, checkV12 } from "./supervision-probe/scenarios/diagnostics.js";

/** Every id the smoke script requires; the summary is built from this list. */
const REQUIRED_IDS = [
  "leaked-child-reclaimed",
  "engine-stop-exit-record",
  "watchdog-start-timeout",
  "ambiguous-pid-not-killed",
  "manual-cleanup-dialog",
  "foreign-shell-pid-kept",
  "engine-crash-record",
  "renderer-recovery-sequence",
  "main-crash-record",
  "crash-record-retention",
  "log-retention-configured",
  "diagnostic-bundle-tree",
];

/**
 * Run every check in an order that keeps dependencies explicit.
 *
 * The engine observation from engine-stop-exit-record/main-crash-record feeds the bundle's `engine/stderr-tail.txt`
 * and `env.json`, which is why diagnostic-bundle-tree runs last.
 */
async function runChecks(): Promise<void> {
  await runSafely("leaked-child-reclaimed", checkV01);
  await runSafely("ambiguous-pid-not-killed", checkV04);
  await runSafely("manual-cleanup-dialog", checkV05V06);

  const engine = await checkEngine();

  await runSafely("watchdog-start-timeout", checkV03);
  await runSafely("main-crash-record", checkV09MainCrash);
  await runSafely("renderer-recovery-sequence", checkV08);
  await runSafely("engine-crash-record", checkV07);
  await runSafely("crash-record-retention", checkV10V11);
  await runSafely("diagnostic-bundle-tree", () => checkV12(engine));
}

/**
 * Run one check, turning an unexpected throw into its FAIL line.
 *
 * @param id the check's id
 * @param check the check body
 */
async function runSafely(id: string, check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    recordOnce(id, "FAIL", describe(error));
  }

  if (!outcomes.some((outcome) => outcome.id === id)) {
    recordOnce(id, "FAIL", "the check produced no judgment");
  }
}

/**
 * Stop every child this probe owns, destroy its windows, and remove its temp tree.
 *
 * A caller-supplied temp root belongs to the caller: the smoke script removes it
 * after this process exits, which is the reliable moment on Windows (Chromium
 * keeps session files open until then).
 */
async function cleanup(): Promise<void> {
  killAllSpawned();

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }

  if (process.env["HARUYUKI_PROBE_TEMP"] !== undefined) return;

  try {
    rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch (error) {
    info(`temp=${path.resolve(TEMP_ROOT)} cleanup=partial (${describe(error)})`);
  }
}

/**
 * The entry point.
 *
 * The summary is printed before exit so a truncated run still says what it
 * judged. `app.exit` bypasses teardown, so stdout is flushed first.
 */
async function main(): Promise<void> {
  await app.whenReady();
  registerAppProtocol();

  // Every table id now has an executable check; the smoke summary requires all
  // twelve, so a check that stops producing a judgment fails the run.

  info(`temp=${TEMP_ROOT}`);
  info(
    `electron=${process.versions.electron ?? "unknown"} node=${process.versions.node} ` +
      `platform=${process.platform}`,
  );

  await runChecks();
  await cleanup();

  const passed = REQUIRED_IDS.filter((id) =>
    outcomes.some((outcome) => outcome.id === id && outcome.status === "PASS"),
  );
  const summary = JSON.stringify({
    required: REQUIRED_IDS.length,
    passed: passed.length,
    outcomes: outcomes.map((outcome) => ({ id: outcome.id, status: outcome.status })),
  });

  process.stdout.write(`SUMMARY ${summary}\n`, () => {
    app.exit(passed.length === REQUIRED_IDS.length ? 0 : 1);
  });
}

/**
 * The child half of A real Electron main process that crashes on purpose.
 *
 * It installs the production handler before `whenReady` (the handler's own
 * requirement), waits for ready so `app.exit` is a normal exit path, and throws
 * with no window open. `onFatal` runs after `handleMainCrash` has synchronously
 * written the record; the beacon it writes is the parent's proof of that order.
 */
function runMainCrashChild(): void {
  const index = process.argv.indexOf("--main-crash-child");
  const crashDir = process.argv[index + 1];

  if (crashDir === undefined) {
    process.stderr.write("probe: --main-crash-child needs a crash directory\n");
    app.exit(2);
    return;
  }

  const beaconPath = process.env["HARUYUKI_MAIN_CRASH_BEACON"];

  installMainCrashHandlers({
    dir: crashDir,
    versions: crashVersions(),
    onFatal: (code) => {
      if (beaconPath !== undefined) {
        try {
          const records = readdirSync(crashDir)
            .filter((name) => name.startsWith("crash-") && name.endsWith(".json"))
            .sort();

          writeFileSync(
            beaconPath,
            JSON.stringify({
              exitCode: code,
              windowCount: BrowserWindow.getAllWindows().length,
              records,
              at: new Date().toISOString(),
            }),
          );
        } catch (error) {
          process.stderr.write(`probe: beacon write failed: ${describe(error)}\n`);
        }
      }

      app.exit(code);
    },
  });

  void app.whenReady().then(() => {
    // No window is created: the crash page path is not part of a main crash, and
    // the beacon's window count is how the parent checks "headless".
    setImmediate(() => {
      throw new Error("probe main crash");
    });
  });
}

if (process.argv.includes("--main-crash-child")) {
  runMainCrashChild();
} else {
  void app
    .whenReady()
    .then(main)
    .catch((error: unknown) => {
      process.stdout.write(`FAIL probe ${describe(error)}\n`, () => app.exit(1));
    });
}
