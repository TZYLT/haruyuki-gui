/**
 * Tests for process evidence collection.
 *
 * The live-child cases use the real platform commands on the host running the
 * suite: `wmic`/PowerShell on Windows and `/proc`/`ps` on POSIX. No test requires
 * `wmic` specifically: the Windows fallback cases inject a command runner, which
 * also lets POSIX CI exercise the Windows parser without a Windows machine.
 *
 * Every spawned child is recorded and killed in `afterEach`; the tests never
 * signal a PID they did not spawn.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EvidenceCommandRunner } from "./evidence";
import { collectEvidence } from "./evidence";
import type { EngineMarker } from "./types";

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      continue;
    }

    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }

  for (const dir of tempDirs.splice(0).reverse()) {
    await unlink(join(dir, "engine-token")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await rmdir(dir);
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "haruyuki-supervision-evidence-"));
  tempDirs.push(dir);
  return dir;
}

async function createTokenFile(): Promise<string> {
  const dir = await createTempDir();
  const filePath = join(dir, "engine-token");
  await writeFile(filePath, "token\n", "utf8");
  return filePath;
}

function engineMarker(overrides: Partial<EngineMarker> = {}): EngineMarker {
  return {
    pid: 4242,
    startedAt: new Date().toISOString(),
    exePath: process.execPath,
    bundlePath: "/app/haruyuki.js",
    runToken: "run-token-1",
    watchdog: "active",
    tokenFile: null,
    port: null,
    ...overrides,
  };
}

async function startFakeChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
    windowsHide: true,
  });
  children.push(child);
  await once(child, "spawn");
  return child;
}

function childPid(child: ChildProcess): number {
  if (child.pid === undefined) {
    throw new Error("the fake engine child was not spawned");
  }

  return child.pid;
}

/** Answer every command with the same failure: identity is unavailable. */
function failingRunner(calls: string[] = []): EvidenceCommandRunner {
  return async (command) => {
    calls.push(command);
    throw new Error(`${command} is unavailable`);
  };
}

describe("collectEvidence on the current platform", () => {
  it("finds the identity of a live fake engine child", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);
    const tokenFile = await createTokenFile();
    const marker = engineMarker({ pid, tokenFile });

    const evidence = await collectEvidence(marker);

    expect(evidence.pid).toBe(pid);
    expect(evidence.alive).toBe(true);
    expect(evidence.runToken).toBe(marker.runToken);
    expect(evidence.tokenFileExists).toBe(true);
    expect(evidence.portListening).toBe(false);
    expect(evidence.reason.length).toBeGreaterThan(0);

    if (process.platform === "win32" || process.platform === "linux") {
      expect(evidence.imagePath).not.toBeNull();
      expect(evidence.createdAt).not.toBeNull();
      expect(evidence.matched).toBe(true);
      expect(evidence.reason).toBe("createdAt and imagePath both match");
    }
  });

  it("reports a missing token file without failing the collection", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);
    const marker = engineMarker({ pid, tokenFile: join(tmpdir(), "haruyuki-no-such-token") });

    const evidence = await collectEvidence(marker);

    expect(evidence.alive).toBe(true);
    expect(evidence.tokenFileExists).toBe(false);
  });

  it("returns alive:false for an exited child without throwing", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;

    const evidence = await collectEvidence(engineMarker({ pid }));

    expect(evidence.alive).toBe(false);
    expect(evidence.imagePath).toBeNull();
    expect(evidence.createdAt).toBeNull();
    expect(evidence.tokenFileExists).toBe(false);
    expect(evidence.matched).toBe(false);
    expect(evidence.reason).toBe("process is not running");
  });

  it.runIf(process.platform === "linux")("reads identity from /proc", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);
    const tokenFile = await createTokenFile();

    const evidence = await collectEvidence(engineMarker({ pid, tokenFile }));

    expect(evidence.imagePath).toBe(process.execPath);
    expect(evidence.createdAt).not.toBeNull();
    expect(evidence.matched).toBe(true);
  });
});

describe("collectEvidence Windows fallbacks", () => {
  it("parses wmic CSV without requiring wmic on this host", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);
    const tokenFile = await createTokenFile();
    const marker = engineMarker({
      pid,
      startedAt: "2026-11-16T12:00:00.000Z",
      exePath: "C:\\fake\\node.exe",
      tokenFile,
    });
    const csv = [
      "",
      "Node,CreationDate,ExecutablePath,ProcessId",
      `HOST,20261116115958.000000+000,C:\\fake\\node.exe,${pid}`,
      "",
    ].join("\r\n");
    const run: EvidenceCommandRunner = async (command) => {
      if (command !== "wmic") {
        throw new Error(`unexpected fallback to ${command}`);
      }

      return csv;
    };

    const evidence = await collectEvidence(marker, { platform: "win32", runCommand: run });

    expect(evidence.imagePath).toBe("C:\\fake\\node.exe");
    expect(evidence.createdAt).toBe("2026-11-16T11:59:58.000Z");
    expect(evidence.matched).toBe(true);
  });

  it("falls back to PowerShell when wmic is missing", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);
    const tokenFile = await createTokenFile();
    const createdAt = new Date();
    const marker = engineMarker({
      pid,
      startedAt: createdAt.toISOString(),
      exePath: "C:\\fake\\node.exe",
      tokenFile,
    });
    const calls: string[] = [];
    const run: EvidenceCommandRunner = async (command) => {
      calls.push(command);
      if (command === "wmic") {
        throw new Error("wmic is not recognized");
      }

      return JSON.stringify({
        Id: pid,
        Path: "C:\\fake\\node.exe",
        StartTime: `/Date(${createdAt.getTime()})/`,
      });
    };

    const evidence = await collectEvidence(marker, { platform: "win32", runCommand: run });

    expect(calls).toEqual(["wmic", "powershell.exe"]);
    expect(evidence.imagePath).toBe("C:\\fake\\node.exe");
    expect(evidence.createdAt).not.toBeNull();
    expect(evidence.matched).toBe(true);
  });

  it("keeps the evidence ambiguous when both identity commands fail", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);
    const tokenFile = await createTokenFile();
    const calls: string[] = [];

    const evidence = await collectEvidence(engineMarker({ pid, tokenFile }), {
      platform: "win32",
      runCommand: failingRunner(calls),
    });

    expect(calls).toEqual(["wmic", "powershell.exe"]);
    expect(evidence.alive).toBe(true);
    expect(evidence.imagePath).toBeNull();
    expect(evidence.createdAt).toBeNull();
    expect(evidence.tokenFileExists).toBe(true);
    expect(evidence.matched).toBe(false);
    expect(evidence.reason).toBe("only the pid is available");
  });

  it("stays ambiguous when only the creation time matches and the token is gone", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);
    const createdAt = new Date();
    const marker = engineMarker({
      pid,
      startedAt: createdAt.toISOString(),
      exePath: "C:\\fake\\node.exe",
      tokenFile: join(tmpdir(), "haruyuki-no-such-token"),
    });
    const run: EvidenceCommandRunner = async (command) => {
      if (command === "wmic") {
        throw new Error("wmic is not recognized");
      }

      return JSON.stringify({ Id: pid, Path: null, StartTime: `/Date(${createdAt.getTime()})/` });
    };

    const evidence = await collectEvidence(marker, { platform: "win32", runCommand: run });

    expect(evidence.createdAt).not.toBeNull();
    expect(evidence.imagePath).toBeNull();
    expect(evidence.tokenFileExists).toBe(false);
    expect(evidence.matched).toBe(false);
    expect(evidence.reason).toBe("createdAt matches but the token file is missing");
  });

  it("uses the default runner without a shell when asked for a real command", async () => {
    // A guard against the test seam hiding the production path: the default
    // runner is `execFile`, so collecting for this process must not throw.
    const marker = engineMarker({ pid: process.pid, startedAt: new Date().toISOString() });

    const evidence = await collectEvidence(marker);

    expect(evidence.alive).toBe(true);
    expect(evidence.pid).toBe(process.pid);
  });
});

describe("collectEvidence command timeouts", () => {
  it("does not run a command for an absent process", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const calls: string[] = [];

    const evidence = await collectEvidence(engineMarker({ pid, tokenFile: null }), {
      platform: "win32",
      runCommand: failingRunner(calls),
    });

    expect(calls).toEqual([]);
    expect(evidence.alive).toBe(false);
    expect(evidence.reason).toBe("process is not running");
  });

  it("accepts a custom timeout without changing the result", async () => {
    const now = Date.now();
    const calls: Array<{ command: string; timeoutMs: number }> = [];
    const run: EvidenceCommandRunner = async (command, _args, timeoutMs) => {
      calls.push({ command, timeoutMs });
      throw new Error("offline");
    };

    const evidence = await collectEvidence(
      engineMarker({ pid: process.pid, startedAt: new Date(now).toISOString() }),
      { platform: "win32", runCommand: run, timeoutMs: 250 },
    );

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.timeoutMs === 250)).toBe(true);
    expect(evidence.matched).toBe(false);
  });
});
