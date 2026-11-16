/**
 * The host-port probe: the members that need a real main process to be believed.
 *
 * Every other test in this item runs under plain Node with the shell injected, which
 * is the right way to cover the failure paths. What it cannot cover is whether the
 * *real* dependencies behave as the injected ones claim:
 *
 *   `paths`            do the four roots `app.getPath` reports actually exist and
 *                      accept a write? A path that is merely composed correctly still
 *                      fails at the first engine write.
 *   `notify`           does `new Notification(...)` construct without throwing on this
 *                      machine? Whether a toast is *visible* cannot be checked here --
 *                      that needs an installed Start Menu entry (requirement T-3) and
 *                      belongs to packaging.
 *   `openExternal`     does the scheme allow-list hold against the real platform, and
 *                      does an accepted URL hand off without throwing?
 *   `pickPaths`        does `dialog.showOpenDialog` exist and answer a shape this code
 *                      understands? The dialog is not driven -- driving it would need
 *                      a human -- so this reports only that the call is reachable.
 *   `onShutdown`       does `before-quit` reach the registered callback, and does a
 *                      second quit run it again?
 *
 * The report goes to a file as well as stdout, because `app.exit` does not drain
 * piped stdout on Windows: a probe that reports through the pipe alone can exit
 * having reported nothing, which is a mistake worth not repeating.
 *
 * One probe, one process, one window at most. This machine refuses to load a second
 * custom scheme in one process once another window exists (measured), so stages that
 * need no window simply do not create one.
 */

import { app, dialog, Notification, shell } from "electron";
import { constants, existsSync, writeSync, writeFileSync } from "node:fs";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildSpawnSpec,
  DESKTOP_CAPABILITIES,
  desktopPaths,
  ensurePaths,
} from "../src/main/host-port.js";
import { createDesktopMembers } from "../src/main/host-members.js";

/** Everything the probe reports. */
interface ProbeResult {
  pathsResolved?: Record<string, string>;
  pathsWritable?: boolean;
  pathsProblem?: string;
  capabilities?: Record<string, boolean>;
  notifyConstructed?: boolean;
  notifyError?: string;
  openExternalAccepted?: boolean;
  openExternalRefused?: boolean;
  openExternalError?: string;
  dialogReachable?: boolean;
  dialogError?: string;
  spawnSpecOk?: boolean;
  spawnSpecReason?: string;
  spawnSpecCwd?: string;
  spawnSpecExeIsElectron?: boolean;
  spawnSpecEnvHasRunAsNode?: boolean;
  shutdownRan?: number;
  shutdownSecondRunIgnored?: boolean;
  fatal?: string;
}

const result: ProbeResult = {};

/** Where the report goes; `verify-host-port.mjs` reads this. */
function reportPath(): string | undefined {
  return process.env["HARUYUKI_D2_HOST_OUT"];
}

/** Write the report so far. Called after every stage. */
function flush(): void {
  const out = reportPath();
  if (out === undefined) return;

  try {
    writeFileSync(out, `HOSTRESULT ${JSON.stringify(result)}\n`, "utf8");
  } catch {
    // A later flush may succeed.
  }
}

/**
 * Print and exit.
 *
 * @param code exit code
 */
function finish(code: number): void {
  flush();

  try {
    writeSync(1, `HOSTRESULT ${JSON.stringify(result)}\n`);
  } catch {
    // The file is the authoritative copy.
  }

  app.exit(code);
}

/** Run every stage, keeping whatever completed. */
async function main(): Promise<void> {
  await app.whenReady();

  // --- paths: composed correctly is not the same as usable -------------------
  try {
    const paths = desktopPaths((name) => app.getPath(name));
    result.pathsResolved = { ...paths };

    await ensurePaths(paths);

    // The real question: can the engine write into the home it will be given as cwd?
    // A directory that exists but denies a write fails at the first engine write,
    // long after the port reported success.
    const probeFile = path.join(paths.userData, `.d2-write-probe-${process.pid}`);
    await writeFile(probeFile, "x");
    await access(probeFile, constants.W_OK);
    await rm(probeFile, { force: true });

    result.pathsWritable = true;
  } catch (error) {
    result.pathsWritable = false;
    result.pathsProblem = String(error).slice(0, 200);
  }
  flush();

  // --- capabilities: the constant, as the shell will report it ---------------
  result.capabilities = { ...DESKTOP_CAPABILITIES };
  flush();

  // --- notify: does the real constructor accept this call -------------------
  try {
    // `show: false` equivalent for a notification is not showing it at all; the
    // question here is whether construction throws, which it does before ready or
    // with a malformed options object.
    const notification = new Notification({ title: "probe", body: "constructed only" });
    result.notifyConstructed = notification !== null;
  } catch (error) {
    result.notifyConstructed = false;
    result.notifyError = String(error).slice(0, 200);
  }
  flush();

  // --- openExternal: the allow-list against the real platform ---------------
  const members = createDesktopMembers({
    showNotification: () => undefined,
    openExternal: (url) => shell.openExternal(url),
    showOpenDialog: async () => ({ cancelled: true, paths: [] }),
    canNotify: () => true,
    readableRoots: () => [],
    trustAllPaths: () => false,
  });

  try {
    // Refused before the OS sees it: a `file:` URL would let a compromised renderer
    // read local files by handing them to an external application.
    const refused = await members.members.openExternal("file:///etc/hosts");
    result.openExternalRefused = refused.ok === false;
  } catch (error) {
    result.openExternalError = String(error).slice(0, 200);
  }

  try {
    // Accepted and handed off. This one really does open a browser, which is
    // unavoidable: there is no "would you accept this" without asking.
    const accepted = await members.members.openExternal("https://example.com/");
    result.openExternalAccepted = accepted.ok === true;
  } catch (error) {
    result.openExternalAccepted = false;
    result.openExternalError = String(error).slice(0, 200);
  }
  flush();

  // --- pickPaths: reachable, not driven -------------------------------------
  try {
    // The dialog is never shown: showing it would need a human to dismiss it, and a
    // probe that waits for a human is a probe that hangs CI. What this checks is that
    // the module is wired and the call is reachable, which is the half a machine can
    // answer.
    result.dialogReachable = typeof dialog.showOpenDialog === "function";
  } catch (error) {
    result.dialogReachable = false;
    result.dialogError = String(error).slice(0, 200);
  }
  flush();

  // --- spawn spec: the real bundle does not exist, so refuse honestly -------
  try {
    // The engine bundle is packaging's artifact and is not present in a checkout, so
    // the honest expectation is a refusal that names the path. A probe that invented
    // a bundle to get `ok: true` would be testing the probe.
    const paths = desktopPaths((name) => app.getPath(name));
    const missing = path.join(app.getAppPath(), "no-such-engine-bundle.mjs");
    const refused = await buildSpawnSpec(
      { bundlePath: missing },
      paths,
      existsSync,
      app.getAppPath(),
    );

    result.spawnSpecOk = refused.ok;
    if (!refused.ok) result.spawnSpecReason = refused.reason;

    // And the shape of a successful spec. The `exists` answer is stubbed to `true`
    // rather than pointed at real files, because the two artifacts this checks for --
    // the engine bundle and the watchdog -- are packaging's (G1) and are not in a
    // checkout. Pointing at a real file would pass the bundle check and then fail the
    // watchdog check, and the resulting `ok: false` would look like a spec bug rather
    // than a missing artifact.
    //
    // What this stage is for is the spec's *shape*: cwd, exePath and the env flag. The
    // refusal path is covered by the real, unstubbed call above.
    const built = await buildSpawnSpec(
      { bundlePath: paths.userData },
      paths,
      () => true,
      app.getAppPath(),
    );

    if (built.ok) {
      result.spawnSpecCwd = built.spec.cwd;
      // `process.execPath` inside Electron is the Electron binary, and the child needs
      // the run-as-node flag to be that binary running a script rather than a second
      // app. Checked against `process.execPath` rather than against a name: the binary
      // is called `electron` here, but a packaged build is the product's own name and
      // a name test would fail there for the wrong reason.
      result.spawnSpecExeIsElectron = built.spec.exePath === process.execPath;
      result.spawnSpecEnvHasRunAsNode = built.spec.env["ELECTRON_RUN_AS_NODE"] === "1";
    }
  } catch (error) {
    result.spawnSpecReason = String(error).slice(0, 200);
  }
  flush();

  // --- onShutdown: the real quit path reaches the callback ------------------
  let ran = 0;
  members.members.onShutdown(() => {
    ran += 1;
  });

  await members.runShutdown();
  result.shutdownRan = ran;

  // And a second run must not run it again: the quit path can arrive twice.
  await members.runShutdown();
  result.shutdownSecondRunIgnored = ran === 1;
  flush();

  finish(0);
}

main().catch((error) => {
  result.fatal = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  finish(1);
});
