/**
 * Behaviour tests for engine process spawning and lifecycle.
 *
 * Every test starts a fake engine as `process.execPath -e <source>` instead of
 * the real engine bundle, so the suite is hermetic and fast, and nothing here
 * depends on the engine artifact. No `child_process` module is mocked: the
 * point is the real ChildProcess contract of this Node build, including the
 * Windows taskkill downgrade path and the ENOENT spawn-failure shape.
 *
 * These tests create no temporary directories: the fake engine is inline source
 * and the missing-binary case uses a path that is never created, so there is
 * nothing to clean up beyond the children themselves.
 */

import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  killProcess,
  onProcessError,
  onProcessExit,
  startEngineProcess,
  stopGraceful,
} from "./spawn";
import type { EngineSpawnSpec } from "./types";

type ExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

const LONG_LIVED_SOURCE = "setInterval(() => {}, 1000);";
const EXITS_NOW_SOURCE = "process.exit(0);";
const PRINTS_SOURCE =
  'process.stdout.write("spawn-stdout:" + process.env.SPAWN_TEST_MARKER + "\\n");' +
  'process.stderr.write("spawn-stderr\\n");';
const POSIX_SIGTERM_SOURCE =
  'process.on("SIGTERM", () => { process.exit(7); }); process.stdout.write("armed\\n"); setInterval(() => {}, 1000);';
const POSIX_IGNORES_TERM_SOURCE =
  'process.on("SIGTERM", () => {}); process.stdout.write("armed\\n"); setInterval(() => {}, 1000);';
const GRANDCHILD_SOURCE =
  'const { spawn } = require("node:child_process");' +
  'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });' +
  'process.stdout.write("GRANDCHILD=" + g.pid + "\\n");' +
  "setInterval(() => {}, 1000);";

/** Children started by a test, force-cleaned after it. */
const liveChildren = new Set<ChildProcess>();

afterEach(async () => {
  const children = [...liveChildren];
  liveChildren.clear();

  for (const child of children) {
    killProcess(child);
    await waitForTermination(child, 2000);
  }
});

describe("startEngineProcess", () => {
  it("returns a live child without waiting for output", () => {
    const startedAt = Date.now();
    const child = start(engineSpec(LONG_LIVED_SOURCE));
    const elapsedMs = Date.now() - startedAt;

    expect(typeof child.pid).toBe("number");
    expect(child.pid).toBeGreaterThan(0);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("keeps stdout and stderr readable and passes the environment through", async () => {
    const spec: EngineSpawnSpec = {
      ...engineSpec(PRINTS_SOURCE),
      env: { ...environment(), SPAWN_TEST_MARKER: "marker-42" },
    };
    const child = start(spec);

    const [stdout, stderr] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
    ]);

    expect(stdout).toContain("spawn-stdout:marker-42");
    expect(stderr).toContain("spawn-stderr");

    await waitForTermination(child, 5000);
  });
});

describe("onProcessExit", () => {
  it("notifies once the child is gone", async () => {
    const child = start(engineSpec(LONG_LIVED_SOURCE));
    const exit = nextExit(child);
    const unsubscribe = onProcessExit(child, () => {});
    unsubscribe();

    killProcess(child);
    const info = await exit;

    expect(hasExited(child)).toBe(true);
    expect(info.code === null || typeof info.code === "number").toBe(true);
    expect(info.signal === null || typeof info.signal === "string").toBe(true);
  });

  it("stops notifying after the returned unsubscribe function runs", async () => {
    const child = start(engineSpec(LONG_LIVED_SOURCE));
    let calls = 0;
    const unsubscribe = onProcessExit(child, () => {
      calls += 1;
    });

    unsubscribe();
    killProcess(child);
    await waitForTermination(child, 5000);

    expect(calls).toBe(0);
  });
});

describe("onProcessError", () => {
  it("receives ENOENT when exePath does not exist", async () => {
    const spec: EngineSpawnSpec = {
      ...engineSpec(""),
      exePath: missingExePath(),
    };
    const child = start(spec);

    const error = await withTimeout(
      new Promise<Error>((resolve) => {
        onProcessError(child, resolve);
      }),
      5000,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("code", "ENOENT");
  });

  it("does not take the host down when nobody subscribes", async () => {
    // startEngineProcess installs a baseline error sink; without it Node would
    // rethrow the spawn error as an uncaught exception and fail this test run.
    start({ ...engineSpec(""), exePath: missingExePath() });

    await new Promise((resolve) => setTimeout(resolve, 300));
  });
});

describe("killProcess", () => {
  it("terminates a running child immediately", async () => {
    const child = start(engineSpec(LONG_LIVED_SOURCE));
    const exit = nextExit(child);

    killProcess(child);
    await exit;

    expect(hasExited(child)).toBe(true);
  });
});

describe("stopGraceful", () => {
  it("stops a running child, notifies exit and returns in bounded time", async () => {
    const child = start(engineSpec(LONG_LIVED_SOURCE));
    const exit = nextExit(child, 10000);

    const startedAt = Date.now();
    await stopGraceful(child);
    const elapsedMs = Date.now() - startedAt;
    const info = await exit;

    expect(hasExited(child)).toBe(true);
    expect(Number.isFinite(elapsedMs)).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    // POSIX worst case is ~3 s, Windows ~2.5 s; 8 s leaves room on a busy box.
    expect(elapsedMs).toBeLessThan(8000);
    expect(info.code === null || typeof info.code === "number").toBe(true);
    expect(info.signal === null || typeof info.signal === "string").toBe(true);
  });

  it("is idempotent for concurrent and repeated calls", async () => {
    const child = start(engineSpec(LONG_LIVED_SOURCE));

    await withTimeout(Promise.all([stopGraceful(child), stopGraceful(child)]), 10000);
    expect(hasExited(child)).toBe(true);

    await expect(stopGraceful(child)).resolves.toBeUndefined();
    expect(hasExited(child)).toBe(true);
  });

  it("resolves immediately when the child already exited", async () => {
    const child = start(engineSpec(EXITS_NOW_SOURCE));
    await waitForTermination(child, 5000);
    expect(hasExited(child)).toBe(true);

    const startedAt = Date.now();
    await stopGraceful(child);

    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("resolves for a child that never spawned", async () => {
    const child = start({ ...engineSpec(""), exePath: missingExePath() });
    await new Promise<void>((resolve) => {
      onProcessError(child, () => {
        resolve();
      });
    });

    // A spawn failure emits error then close and never exit; the stop must
    // still settle instead of waiting out the fixed stage budgets.
    await expect(stopGraceful(child, 1000)).resolves.toBeUndefined();
  });

  it("caps the whole sequence at the caller's budget", async () => {
    const child = start(engineSpec(LONG_LIVED_SOURCE));

    const startedAt = Date.now();
    await stopGraceful(child, 50);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);

    // The hard kill happens even when the budget is already spent.
    await waitForTermination(child, 5000);
    expect(hasExited(child)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "lets a POSIX child exit through its own SIGTERM handler",
    async () => {
      const child = start(engineSpec(POSIX_SIGTERM_SOURCE));
      // The handler is installed only after Node boots; signalling before the
      // "armed" line lands would exercise the default SIGTERM disposition
      // instead of the handler (a flake on slow hosts, seen on Linux first).
      await new Promise<void>((resolve) => {
        child.stdout!.once("data", () => {
          resolve();
        });
      });
      const exit = nextExit(child, 10000);

      await stopGraceful(child);
      const info = await exit;

      expect(info.code).toBe(7);
      expect(info.signal).toBeNull();
    },
  );
  it.skipIf(process.platform === "win32")(
    "escalates to SIGKILL for a POSIX child that ignores SIGTERM",
    async () => {
      // The whole point of the escalation stage: a wedged engine must still die
      // inside the caller's budget. Without this case the SIGTERM grace could be
      // skipped entirely and every other test would stay green.
      const child = start(engineSpec(POSIX_IGNORES_TERM_SOURCE));
      await new Promise<void>((resolve) => {
        child.stdout!.once("data", () => {
          resolve();
        });
      });
      const exit = nextExit(child, 10000);

      const startedAt = Date.now();
      await stopGraceful(child, 600);
      const info = await exit;

      expect(info.signal).toBe("SIGKILL");
      expect(Date.now() - startedAt).toBeLessThan(5000);
    },
  );

  it.skipIf(process.platform === "win32")(
    "takes the whole process group with it when the child is detached",
    async () => {
      // `detached` exists so POSIX can signal the group.
      // The engine runs external commands, so a grandchild must not survive the
      // stop; without the group signal this case leaves it running.
      const child = start({ ...engineSpec(GRANDCHILD_SOURCE), detached: true });

      const grandchildPid = await new Promise<number>((resolve, reject) => {
        let buffered = "";

        child.stdout!.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");

          const match = /^GRANDCHILD=(\d+)$/m.exec(buffered);

          if (match !== null) {
            resolve(Number(match[1]));
          }
        });

        child.once("error", reject);
      });

      expect(isAlive(grandchildPid)).toBe(true);

      await stopGraceful(child, 5000);
      await waitForTermination(child, 5000);

      await waitUntil(() => !isAlive(grandchildPid), "the grandchild to be killed with the group");
    },
  );
});

/** True while `process.kill(pid, 0)` succeeds; EPERM still means alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** Poll `predicate` until it holds or the budget runs out. */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  throw new Error(`timed out waiting for ${label}`);
}

/** Full environment as the string-only shape EngineSpawnSpec requires. */
function environment(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Fake-engine spec: `node -e <source>`. The child argv is
 * `<bundlePath> <argvPrefix...>`, so `bundlePath = "-e"` plus
 * `argvPrefix = [source]` yields exactly the tail startEngineProcess builds;
 * the seam under test is real even though `-e` is an interpreter flag rather
 * than a file.
 */
function engineSpec(source: string): EngineSpawnSpec {
  return {
    exePath: process.execPath,
    env: environment(),
    argvPrefix: [source],
    bundlePath: "-e",
    cwd: process.cwd(),
    stdio: "pipe",
    windowsHide: true,
    detached: false,
  };
}

function start(spec: EngineSpawnSpec): ChildProcess {
  const child = startEngineProcess(spec);
  liveChildren.add(child);
  return child;
}

/** A path whose parent directory is never created, so spawn must fail. */
function missingExePath(): string {
  return path.join(
    os.tmpdir(),
    `haruyuki-spawn-missing-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "no-such-engine.exe",
  );
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolve with the first exit report, failing the test if none arrives. */
function nextExit(child: ChildProcess, timeoutMs = 5000): Promise<ExitInfo> {
  return withTimeout(
    new Promise<ExitInfo>((resolve) => {
      onProcessExit(child, resolve);
    }),
    timeoutMs,
  );
}

/** Resolve once the child is gone; used for cleanup and expected-fast exits. */
function waitForTermination(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (hasExited(child)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const done = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
      resolve();
    };

    timer = setTimeout(done, timeoutMs);
    child.once("exit", done);
    child.once("close", done);
  });
}

/** Collect a piped stream to its end, with a bound for a stalled pipe. */
function readStream(stream: Readable | null, timeoutMs = 5000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (stream === null) {
      reject(new Error("expected the child to expose a piped stream"));
      return;
    }

    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);

      if (error === undefined) {
        resolve(text);
      } else {
        reject(error);
      }
    };

    const onData = (chunk: unknown): void => {
      text += String(chunk);
    };
    const onEnd = (): void => {
      finish();
    };
    const onError = (error: Error): void => {
      finish(error);
    };

    timer = setTimeout(() => {
      finish(new Error(`stream did not end within ${timeoutMs} ms`));
    }, timeoutMs);

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`operation did not settle within ${timeoutMs} ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
