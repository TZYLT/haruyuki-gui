/**
 * Behaviour tests for the injected parent-death watchdog.
 *
 * The watchdog is a plain CJS preload, so the tests exercise it the same way the
 * host does: spawn a real Node child and preload the script. Nothing here mocks
 * the process boundary, because the point is the real pipe and process
 * semantics of this Node build, including the Windows self-exit path.
 *
 * Every started child is tracked and force-killed in `afterEach`, so a failing
 * assertion never leaks a handle into the rest of the suite.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const WATCHDOG_PATH = fileURLToPath(new URL("./watchdog.cjs", import.meta.url));

/** Inline `-e` source that preloads the watchdog like `--require` does. */
const PRELOAD_SOURCE = `require(${JSON.stringify(WATCHDOG_PATH)})`;

/**
 * Stand-in for a live engine: something has to hold the event loop open, the
 * same way the app server does, or the child would exit before the signals run.
 */
const LIVE_SOURCE = `${PRELOAD_SOURCE}; setInterval(() => {}, 1000);`;

/**
 * `NODE_OPTIONS` needs forward slashes on Windows: backslashes inside the
 * documented double quotes are consumed as escapes, which mangles the path.
 */
const NODE_OPTIONS_PATH = WATCHDOG_PATH.replace(/\\/g, "/");

/** Self-check marker shape; the host uses it to confirm the injection worked. */
const MARKER_PATTERN = /WATCHDOG_OK=(\d+)/;

const BOOT_TIMEOUT_MS = 10000;
const EXIT_BUDGET_MS = 5000;
const STILL_ALIVE_MS = 3000;

type Output = { stdout: string; stderr: string };

type Started = { child: ChildProcess; output: Output };

/** Children started by a test, force-cleaned after it. */
const liveChildren = new Set<ChildProcess>();

afterEach(async () => {
  const children = [...liveChildren];
  liveChildren.clear();

  for (const child of children) {
    child.stdin?.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await waitForExit(child, 5000).catch(() => {
      // A child that still refuses to die shows up as the next test's failure.
    });
  }
});

describe("watchdog preload", () => {
  it("prints WATCHDOG_OK=<pid> to stderr on startup", async () => {
    const { child, output } = startChild(LIVE_SOURCE);

    const markerPid = await waitForMarker(child, output);

    expect(markerPid).toBe(child.pid);
    expect(output.stdout).toBe("");
  });

  it("exits within 5 s after the parent closes stdin", async () => {
    const { child, output } = startChild(LIVE_SOURCE);
    await waitForMarker(child, output);

    const startedAt = Date.now();
    child.stdin?.end();
    await waitForExit(child, EXIT_BUDGET_MS + 1000);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThanOrEqual(EXIT_BUDGET_MS);
    if (process.platform === "win32") {
      expect(child.exitCode).toBe(1);
    } else {
      expect(child.signalCode).toBe("SIGTERM");
    }
  });

  it("stays alive while stdin is open and the parent is alive", async () => {
    const { child, output } = startChild(LIVE_SOURCE);
    await waitForMarker(child, output);

    await delay(STILL_ALIVE_MS);

    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it("does not pollute stdout and keeps the marker on stderr", async () => {
    const { child, output } = startChild(`${LIVE_SOURCE}; console.log("engine-output")`);
    await waitForMarker(child, output);
    await waitForStdout(output, "engine-output");

    child.stdin?.end();
    await waitForExit(child, EXIT_BUDGET_MS + 1000);

    expect(output.stdout).toBe("engine-output\n");
    expect(output.stderr).toMatch(MARKER_PATTERN);
    expect(output.stderr).not.toContain("engine-output");
  });

  it("is preloaded through NODE_OPTIONS=--require on this Node build", async () => {
    const { child, output } = startChild(
      "console.log('engine-output'); setInterval(() => {}, 1000);",
      {
        ...process.env,
        NODE_OPTIONS: `--require "${NODE_OPTIONS_PATH}"`,
      },
    );

    const markerPid = await waitForMarker(child, output);
    expect(markerPid).toBe(child.pid);
    await waitForStdout(output, "engine-output");

    const startedAt = Date.now();
    child.stdin?.end();
    await waitForExit(child, EXIT_BUDGET_MS + 1000);

    expect(Date.now() - startedAt).toBeLessThanOrEqual(EXIT_BUDGET_MS);
    expect(output.stdout).toBe("engine-output\n");
  });

  it("does not keep the engine process alive on its own", async () => {
    const { child, output } = startChild(`${PRELOAD_SOURCE}; console.log("engine-output")`);
    await waitForMarker(child, output);
    await waitForStdout(output, "engine-output");

    // No keepalive here: with stdin unref'ed the child must exit naturally.
    await waitForExit(child, STILL_ALIVE_MS + 1000);

    expect(child.exitCode).toBe(0);
    expect(output.stdout).toBe("engine-output\n");
  });
});

/** Spawn an inline engine stand-in with piped stdio and collect its output. */
function startChild(source: string, env: NodeJS.ProcessEnv = process.env): Started {
  const output: Output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    output.stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output.stderr += chunk.toString();
  });

  liveChildren.add(child);
  return { child, output };
}

/** Wait for the self-check marker and return the pid it advertises. */
async function waitForMarker(
  child: ChildProcess,
  output: Output,
  timeoutMs = BOOT_TIMEOUT_MS,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = MARKER_PATTERN.exec(output.stderr);
    if (match) {
      return Number(match[1]);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `watchdog exited before printing its marker: ${JSON.stringify(output.stderr)}`,
      );
    }
    await delay(10);
  }

  throw new Error(`no WATCHDOG_OK marker within ${timeoutMs} ms: ${JSON.stringify(output.stderr)}`);
}

/** Wait until the child has written `needle` to stdout. */
async function waitForStdout(
  output: Output,
  needle: string,
  timeoutMs = BOOT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline && !output.stdout.includes(needle)) {
    await delay(10);
  }

  if (!output.stdout.includes(needle)) {
    throw new Error(
      `stdout never contained ${JSON.stringify(needle)}: ${JSON.stringify(output.stdout)}`,
    );
  }
}

/** Resolve when the child exits; reject if it is still running at the deadline. */
function waitForExit(child: ChildProcess, timeoutMs = EXIT_BUDGET_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
    };
    const done = (): void => {
      cleanup();
      resolve();
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`child did not exit within ${timeoutMs} ms`));
    }, timeoutMs);

    child.once("exit", done);
    child.once("close", done);
  });
}

/** Small sleep used by the polling helpers above. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
