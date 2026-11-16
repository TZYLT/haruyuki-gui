/**
 * Child processes, OS liveness checks and bounded waits.
 *
 * Every PID this module spawns is tracked, so the final sweep can only ever kill
 * something the probe created. Nothing here kills by name or by a PID it read from
 * a file, which is the property that keeps a test run from touching a real process.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import { TEMP_ROOT } from "./environment.js";

const spawnedPids = new Set<number>();

/** Sleep for a bounded time. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an observation until it produces a truthy value.
 *
 * @param probeFn the observation to repeat
 * @param timeoutMs how long to keep trying
 * @param intervalMs pause between attempts
 * @returns the first truthy value, or null on timeout
 */
async function waitFor<T>(
  probeFn: () => T | null | undefined | false,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const value = probeFn();

      if (value !== null && value !== undefined && value !== false) return value;
    } catch {
      // A probe that throws is a "not yet": the window or process may still be
      // mid-restart. The deadline is the only authority.
    }

    if (Date.now() >= deadline) return null;

    await sleep(intervalMs);
  }
}

/**
 * Ask the OS, independently of Node, whether a PID exists.
 *
 * Two observers are used for a reclaim: this one and `isProcessAlive`. Neither
 * alone proves "the tree is gone", and disagreement between them is a finding.
 *
 * @param pid the process id
 * @returns true/false, or null when the command could not answer
 */
function tasklistHasPid(pid: number): Promise<boolean | null> {
  if (process.platform !== "win32") return Promise.resolve(null);

  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/NH"],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }

        resolve(stdout.includes(String(pid)));
      },
    );
  });
}

/**
 * Wait until the OS no longer lists the PID.
 *
 * @param pid the process id
 * @param timeoutMs how long the caller is willing to wait
 * @returns the last tasklist answer, or null when the command never answered
 */
async function waitUntilTasklistGone(pid: number, timeoutMs: number): Promise<boolean | null> {
  const deadline = Date.now() + timeoutMs;
  let last: boolean | null = null;

  for (;;) {
    last = await tasklistHasPid(pid);

    if (last === false) return false;

    if (Date.now() >= deadline) return last;

    await sleep(100);
  }
}

/** Track a spawned child so the final sweep can never leave it behind. */
function track(pid: number | undefined): void {
  if (pid !== undefined && Number.isInteger(pid) && pid > 0) spawnedPids.add(pid);
}

/** Stop tracking a child that has exited. */
function untrack(pid: number | undefined): void {
  if (pid !== undefined) spawnedPids.delete(pid);
}

/**
 * Kill one PID this probe owns, never a PID it did not spawn.
 *
 * @param pid the process id
 */
function killOwned(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone is the success case.
  }
}

/**
 * Wait for a file to exist.
 *
 * @param file absolute path
 * @param timeoutMs how long to wait
 * @returns whether it appeared
 */
async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const found = await waitFor(() => existsSync(file), timeoutMs, 50);

  return found !== null;
}

/**
 * Wait for a spawned child to report its PID.
 *
 * @param child the spawned child
 * @returns its PID, or null when it never spawned
 */
async function childPid(child: ChildProcess): Promise<number | null> {
  if (child.pid !== undefined) return child.pid;

  const pid = await waitFor(() => child.pid, 5_000, 25);

  return pid ?? null;
}

/**
 * Spawn the Electron binary as plain Node and run a script.
 *
 * The engine child and the leak helper are Node processes; the Electron binary
 * doubles as Node when `ELECTRON_RUN_AS_NODE=1` is set on the child only.
 *
 * @param script absolute script path
 * @param env extra environment variables
 * @returns the child
 */
function spawnNode(script: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [script], {
    cwd: TEMP_ROOT,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
    windowsHide: true,
  });

  track(child.pid);

  return child;
}

/**
 * A long-lived Node child that stands in for an engine process.
 *
 * @returns the child
 */
function spawnIdleNode(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: TEMP_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
    windowsHide: true,
  });

  track(child.pid);

  return child;
}

/** Kill every child this probe still owns; called once from the final sweep. */
function killAllSpawned(): void {
  for (const pid of spawnedPids) killOwned(pid);
}

export {
  childPid,
  killAllSpawned,
  killOwned,
  sleep,
  spawnIdleNode,
  spawnNode,
  tasklistHasPid,
  track,
  untrack,
  waitFor,
  waitForFile,
  waitUntilTasklistGone,
};
