/**
 * Tests for the read-only observability surface added for D4
 * contract v1.1).
 *
 * Three facts are asserted, each with a real child process rather than a mock:
 *
 * - `pid` is the child's actual PID and becomes `null` after cleanup;
 * - `lastExit` records the OS exit fact, including a crash;
 * - `stderrTail` is fed by the single reader in `spawn.ts` and survives the
 *   child's death.
 *
 * The fake engine is the same `node -e` shape the facade tests already use, so
 * no engine artifact is required.
 */

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Engine } from "./engine";
import {
  ENGINE_VERSION,
  fakeEngineSpec,
  makeDir,
  makeRoot,
  processAlive,
  readPid,
  releaseFixtures,
  startHandshakeStub,
  startTracking,
  waitFor,
  delay,
} from "./engine-test-support";

afterEach(async () => {
  await releaseFixtures();
});

/**
 * A fake engine that records its PID, prints the endpoint, writes two stderr
 * lines after a short delay, and stays alive.
 *
 * The delay is deliberate: the tail subscriber is attached immediately after
 * spawn, but the child can start before the parent reaches that line. Writing
 * after 100 ms makes the test deterministic without hiding a real race.
 *
 * @param url the WebSocket endpoint the handshake stub is listening on
 * @param pidFile where the child records its PID
 */
function fakeEngineWithStderr(url: string, pidFile: string): string {
  return [
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `process.stdout.write(${JSON.stringify(`WebSocket: ${url}\n`)});`,
    `setTimeout(() => { process.stderr.write("engine: line one\\nengine: line two\\n"); }, 100);`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

describe("Engine.pid", () => {
  it("is the real child PID and becomes null after the child is gone", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineWithStderr(stub.url, pidFile), root),
      tokenDir,
      expectedEngineVersion: ENGINE_VERSION,
    });

    const pid = await readPid(pidFile);

    expect(engine.pid).toBe(pid);
    expect(processAlive(pid)).toBe(true);

    await engine.stopGraceful(1_000);

    expect(engine.pid).toBeNull();
  });
});

describe("Engine.lastExit", () => {
  it("records the exit fact when the engine crashes after ready", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineWithStderr(stub.url, pidFile), root),
      tokenDir,
      expectedEngineVersion: ENGINE_VERSION,
    });

    const pid = await readPid(pidFile);

    expect(engine.lastExit).toBeNull();

    process.kill(pid, "SIGKILL");

    await waitFor(() => engine.state === "failed", "the crash to reach failed");

    expect(engine.lastExit).not.toBeNull();
    expect(engine.lastExit?.code !== null || engine.lastExit?.signal !== null).toBe(true);

    await waitFor(() => engine.pid === null, "the cleanup to release the child");
  });
});

describe("Engine.stderrTail", () => {
  it("captures stderr through the single reader and survives the child", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineWithStderr(stub.url, pidFile), root),
      tokenDir,
      expectedEngineVersion: ENGINE_VERSION,
    });

    await delay(300);

    expect(engine.stderrTail()).toContain("engine: line one");
    expect(engine.stderrTail()).toContain("engine: line two");

    await engine.stopGraceful(1_000);

    // The tail is a diagnostic of the dead child, not a live stream.
    expect(engine.stderrTail()).toContain("engine: line one");
  });

  it("honours the line limit", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineWithStderr(stub.url, pidFile), root),
      tokenDir,
      expectedEngineVersion: ENGINE_VERSION,
    });

    await delay(300);

    expect(engine.stderrTail(1)).toEqual(["engine: line two"]);
  });
});
