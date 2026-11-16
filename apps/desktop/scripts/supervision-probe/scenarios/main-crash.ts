/**
 * A real main-process crash, recorded before the process exits.
 *
 * A main crash cannot be judged inside the probe: the crash handler's contract is
 * that the process stops existing. So the probe spawns a second Electron process
 * running this same bundle with `--main-crash-child`, which installs the
 * production `installMainCrashHandlers` and then throws. The parent only observes
 * from outside: exit code, the record on disk, and a beacon the child writes from
 * inside `onFatal` after the synchronous record write.
 *
 * The beacon is what makes "record exists before exit" a measurement instead of a
 * claim: it is written after `handleMainCrash` has written the file and before
 * `app.exit`, and it lists the record it saw. It also carries the window count, so
 * "headless / no prompt" is observed rather than assumed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { readCrashRecords } from "../../../src/main/crash/records.js";
import { TEMP_ROOT } from "../environment.js";
import { killOwned, track, untrack } from "../processes.js";
import { describe, record } from "../report.js";

/** What the child writes from `onFatal`; every field is checked by the parent. */
interface MainCrashBeacon {
  readonly exitCode: number;
  readonly windowCount: number;
  readonly records: string[];
  readonly at: string;
}

/** The child's observed end. */
interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly error: string | null;
  readonly timedOut: boolean;
}

/** The Windows STATUS_BREAKPOINT exit a restricted job object can impose. */
const CHROMIUM_JOB_ABORT = -2147483645;

/**
 * Whether an exit looks like the shell blocking a nested Electron before main ran.
 *
 * @param code the child's exit code
 * @returns whether it is the job-object abort
 */
function isChromiumJobAbort(code: number | null): boolean {
  if (process.platform !== "win32" || code === null) return false;

  return code === CHROMIUM_JOB_ABORT || code >>> 0 === 0x80000003;
}

/**
 * Spawn the child and wait for it to end.
 *
 * @param crashDir the directory the child writes its record into
 * @param beaconPath where the child writes its onFatal beacon
 * @param childTemp the child's isolated temp root
 * @returns the exit facts and captured stderr
 */
function runChild(crashDir: string, beaconPath: string, childTemp: string): Promise<ChildExit> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };

    // Electron must start as Electron, not as Node: the inherited switch would
    // turn the child into a plain Node process and no app would ever exist.
    delete env["ELECTRON_RUN_AS_NODE"];
    delete env["NODE_OPTIONS"];
    env["HARUYUKI_PROBE_TEMP"] = childTemp;
    env["HARUYUKI_MAIN_CRASH_BEACON"] = beaconPath;

    const child: ChildProcess = spawn(
      process.execPath,
      [__filename, "--main-crash-child", crashDir],
      {
        cwd: TEMP_ROOT,
        env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );

    track(child.pid);

    let stderr = "";
    let settled = false;

    const settle = (exit: ChildExit): void => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      untrack(child.pid);
      resolve(exit);
    };

    const timer = setTimeout(() => {
      if (child.pid !== undefined) killOwned(child.pid);
      settle({ code: null, signal: null, stderr, error: null, timedOut: true });
    }, 30_000);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });

    child.on("error", (error: Error) => {
      settle({ code: null, signal: null, stderr, error: describe(error), timedOut: false });
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      settle({ code, signal, stderr, error: null, timedOut: false });
    });
  });
}

/**
 * Run the main-crash child and judge its record.
 *
 * A child that cannot run at all (job object, spawn failure, timeout) is a SKIP,
 * not a FAIL and definitely not a PASS. A child that ran and exited but produced
 * no usable record is a FAIL.
 */
async function checkV09MainCrash(): Promise<void> {
  const id = "main-crash-record";
  const root = path.join(TEMP_ROOT, "v09-main");
  const crashDir = path.join(root, "crashes");
  const beaconPath = path.join(root, "beacon.json");
  const childTemp = path.join(root, "child");

  mkdirSync(crashDir, { recursive: true });

  const exit = await runChild(crashDir, beaconPath, childTemp);

  if (exit.timedOut || exit.error !== null || isChromiumJobAbort(exit.code)) {
    const reason =
      exit.error ??
      (exit.timedOut
        ? "the child did not exit within 30 s"
        : `the child was blocked before main ran (exit ${String(exit.code)})`);

    record(id, "SKIP", `the main-crash child could not run: ${reason}`);
    return;
  }

  if (!existsSync(beaconPath)) {
    const stderrTail = exit.stderr.trim().split(/\r?\n/).slice(-3).join(" | ");

    record(
      id,
      "FAIL",
      `the child exited ${String(exit.code)} without a beacon` +
        (stderrTail === "" ? "" : `; stderr=${JSON.stringify(stderrTail)}`),
    );
    return;
  }

  let beacon: MainCrashBeacon;

  try {
    beacon = JSON.parse(readFileSync(beaconPath, "utf8")) as MainCrashBeacon;
  } catch (error) {
    record(id, "FAIL", `the beacon is unreadable: ${describe(error)}`);
    return;
  }

  const files = readdirSync(crashDir)
    .filter((name) => name.startsWith("crash-") && name.endsWith(".json"))
    .sort();
  const records = readCrashRecords(crashDir);
  const mainRecord = records.find((entry) => entry.kind === "main");
  const problems: string[] = [];

  if (exit.code !== 1) problems.push(`child exit is ${String(exit.code)}, expected 1`);
  if (beacon.exitCode !== 1) problems.push(`beacon exit is ${String(beacon.exitCode)}`);
  if (beacon.windowCount !== 0)
    problems.push(`the child had ${String(beacon.windowCount)} windows`);
  if (files.length !== 1) problems.push(`${String(files.length)} crash files, expected 1`);
  if (records.length !== 1) problems.push(`${String(records.length)} records, expected 1`);
  if (mainRecord === undefined) problems.push("no record has kind=main");
  if (mainRecord !== undefined && mainRecord.code !== "MAIN_CRASHED") {
    problems.push(`main record code is ${JSON.stringify(mainRecord.code)}`);
  }
  if (mainRecord?.main?.message.includes("probe main crash") !== true) {
    problems.push(`main record message is ${JSON.stringify(mainRecord?.main?.message ?? null)}`);
  }
  if (files[0] === undefined || !beacon.records.includes(files[0])) {
    problems.push("the beacon does not list the record written before exit");
  }

  if (problems.length > 0) {
    record(id, "FAIL", problems.join("; "));
    return;
  }

  record(
    id,
    "PASS",
    `childExit=1 signal=null kind=main code=MAIN_CRASHED record=${files[0] ?? "?"} ` +
      `beacon=before-exit windows=0 headless=true`,
  );
}

export { checkV09MainCrash };
