/**
 * Tests for the engine facade : the seven-state machine, the five error
 * codes, the event stream and frame tracking (no recursive-B1 sections 3.3 (c), (e),
 * (f); decisions in docs/15 D-01, D-10, D-11).
 *
 * - The real engine is preferred: `_research/engine-0.6.0/package/haruyuki.js`
 *   runs `start -> ready -> stopGraceful`; the case is skipped (`it.skipIf`) when
 *   the gitignored artifact is absent, so a clean clone works.
 * - Error classification uses INLINE fixtures only: a loopback HTTP server for
 *   401 and for a just-closed port, plus a `node -e` child printing one
 *   `WebSocket:` line. Nothing here imports `fixtures/`.
 * - The child is real, so pid liveness is real evidence of the cleanup.
 *
 * `spawn.ts` composes child argv as `[bundlePath, ...argvPrefix]`, and
 * `headless-host-port.ts` puts the engine entry in `bundlePath` and the
 * engine options in `argvPrefix` (the F-6 shape `node haruyuki.js server ...`).
 * The real-engine case still drives the engine through a test-only launcher
 * that rewrites `process.argv` and loads the bundle in the same process: the
 * spawned child is still the engine (one pid, no wrapper to orphan).
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EngineConnectionError } from "./connection";
import { Engine } from "./engine";
import { isEngineError, toEngineError } from "./errors";
import { PortNotFoundError } from "./port-discovery";
import { TOKEN_FILE_NAME } from "./token";
import type { EngineError, EngineErrorCode, EngineSpawnSpec, EngineState } from "./types";
import {
  ENGINE_AVAILABLE,
  ENGINE_VERSION,
  WATCHDOG_ENTRY,
  fakeEngineSource,
  fakeEngineSpec,
  makeDir,
  makeRoot,
  readPid,
  processAlive,
  startTracking,
  recordStates,
  startHandshakeStub,
  prepareRealEngine,
  expectEngineFailure,
  rejectionOf,
  waitFor,
  releaseFixtures,
  listen,
  closeServer,
  delay,
  environment,
  httpServers,
} from "./engine-test-support";

afterEach(async () => {
  await releaseFixtures();
});
describe("toEngineError", () => {
  it("forwards an EngineConnectionError without re-classifying it", () => {
    const mapped = toEngineError(new EngineConnectionError("AUTH_FAILED", "denied", "HTTP 401"));

    expect(mapped).toEqual({ code: "AUTH_FAILED", detail: "denied", wireHint: "HTTP 401" });
  });

  it("maps PortNotFoundError to PORT_NOT_FOUND and keeps the parser detail", () => {
    const mapped = toEngineError(new PortNotFoundError(3, "OpenAI: http://x/v1", "timed out"));

    expect(mapped.code).toBe("PORT_NOT_FOUND");
    expect(mapped.detail).toContain("timed out");
    expect(mapped.detail).toContain("3 line(s)");
  });

  it("maps a spawn-side ENOENT fault to SPAWN_FAILED", () => {
    const error = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
    const mapped = toEngineError(error);

    expect(mapped.code).toBe("SPAWN_FAILED");
    expect(mapped.detail).toContain("ENOENT");
    expect(mapped.wireHint).toBe("ENOENT");
  });

  it("maps a permission fault to SPAWN_FAILED", () => {
    const error = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });

    expect(toEngineError(error).code).toBe("SPAWN_FAILED");
  });

  it("falls back to TIMEOUT and keeps the original message", () => {
    const mapped = toEngineError(new Error("something odd happened"));

    expect(mapped.code).toBe("TIMEOUT");
    expect(mapped.detail).toContain("something odd happened");
  });

  it("is total: non-error values still produce a classified error", () => {
    for (const value of ["boom", 42, null, undefined, { nope: true }]) {
      const mapped = toEngineError(value);

      expect(mapped.code).toBe("TIMEOUT");
      expect(mapped.detail.length).toBeGreaterThan(0);
    }
  });

  it("is idempotent on an already classified error", () => {
    const classified: EngineError = { code: "PROTOCOL_MISMATCH", detail: "bad version" };

    expect(toEngineError(classified)).toEqual(classified);
  });
});

describe("isEngineError", () => {
  it("accepts the frozen shape with and without a hint", () => {
    expect(isEngineError({ code: "TIMEOUT", detail: "slow" })).toBe(true);
    expect(isEngineError({ code: "AUTH_FAILED", detail: "401", wireHint: "HTTP 401" })).toBe(true);
  });

  it("rejects a code outside the frozen five", () => {
    expect(isEngineError({ code: "RECONNECT", detail: "nope" })).toBe(false);
  });

  it("rejects a non-string detail or hint", () => {
    expect(isEngineError({ code: "TIMEOUT", detail: 42 })).toBe(false);
    expect(isEngineError({ code: "TIMEOUT", detail: "slow", wireHint: 7 })).toBe(false);
    expect(isEngineError({ code: "TIMEOUT" })).toBe(false);
  });

  it("rejects primitives", () => {
    for (const value of [null, undefined, "TIMEOUT", 1, true]) {
      expect(isEngineError(value)).toBe(false);
    }
  });
});

describe("Engine.start", () => {
  it("drives spawning -> handshaking -> ready and reports what it learned", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();
    const states = recordStates(engine);

    const info = await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
      tokenDir,
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    expect(info.engineVersion).toBe(ENGINE_VERSION);
    expect(info.protocolVersion).toBe(1);
    expect(info.backend).toBe("local");
    expect(engine.state).toBe("ready");
    expect(engine.socketState).toBe("open");
    expect(engine.appServerInfo).toBe(info);
    // The handshake answer is itself a frame, so the timestamp is already set.
    expect(engine.lastFrameAt).not.toBeNull();
    expect(states).toEqual(["spawning", "handshaking", "ready"]);

    // The token file lives for the whole session and the child is alive.
    expect(existsSync(path.join(tokenDir, TOKEN_FILE_NAME))).toBe(true);
    const pid = await readPid(pidFile);
    expect(processAlive(pid)).toBe(true);
  });

  it("reports inbound frames and keeps lastFrameAt in step", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const stub = await startHandshakeStub();
    const engine = startTracking();

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, path.join(root, "engine.pid")), root),
      tokenDir,
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    const handshakeAt = engine.lastFrameAt;
    expect(handshakeAt).not.toBeNull();

    const frames: number[] = [];
    const unsubscribe = engine.onFrame((at) => frames.push(at));

    await delay(10);
    stub.pushFrame({ type: "app_server_info", request_id: "after-ready" });
    await waitFor(() => frames.length === 1, "the first pushed frame");

    expect(frames[0]).toBeGreaterThan(handshakeAt ?? 0);
    expect(engine.lastFrameAt).toBe(frames[0]);

    unsubscribe();
    stub.pushFrame({ type: "app_server_info", request_id: "after-unsubscribe" });
    await delay(200);
    expect(frames).toHaveLength(1);
  });

  it("stopGraceful closes the socket, deletes the token and stops the child", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();
    const states = recordStates(engine);

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
      tokenDir,
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    const pid = await readPid(pidFile);
    const tokenPath = path.join(tokenDir, TOKEN_FILE_NAME);

    await engine.stopGraceful(1_000);

    expect(engine.state).toBe("closed");
    expect(engine.socketState).toBe("closed");
    expect(states).toEqual(["spawning", "handshaking", "ready", "closing", "closed"]);
    expect(existsSync(tokenPath)).toBe(false);
    await waitFor(() => !processAlive(pid), "the engine child to exit");
  });

  it("moves to failed when the engine dies while ready", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();
    const codes: EngineErrorCode[] = [];
    engine.onError((error) => codes.push(error.code));

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
      tokenDir,
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    process.kill(await readPid(pidFile));

    await waitFor(() => engine.state === "failed", "the crash to reach the facade");
    expect(codes).toEqual(["TIMEOUT"]);
    expect(engine.socketState).toBe("closed");
  });

  it("kill() terminates the child and deletes the token file", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
      tokenDir,
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    const pid = await readPid(pidFile);
    const tokenPath = path.join(tokenDir, TOKEN_FILE_NAME);

    engine.kill();

    expect(engine.state).toBe("closed");
    expect(engine.socketState).toBe("closed");
    await waitFor(() => !existsSync(tokenPath), "the token file removal after kill");
    await waitFor(() => !processAlive(pid), "the engine child to die after kill");
  });

  it("kill() then stopGraceful is proof that the token file is gone", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
      tokenDir,
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    const tokenPath = path.join(tokenDir, TOKEN_FILE_NAME);
    expect(existsSync(tokenPath)).toBe(true);

    // kill() is synchronous and only *starts* the unlink, so the documented way
    // to get proof of removal is a following stopGraceful. That promise is
    // worthless if it resolves before the unlink it shares, hence no waitFor here.
    engine.kill();
    await engine.stopGraceful();

    expect(existsSync(tokenPath)).toBe(false);
    expect(engine.state).toBe("closed");
  });

  it("keeps a caller-initiated stop from being rewritten to failed", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    // The stub accepts the upgrade and never answers the handshake, so `start`
    // parks in `handshaking` long enough for the stop to win the race.
    const stub = await startHandshakeStub({ answer: false });
    const engine = startTracking();

    const starting = engine
      .start({
        spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
        tokenDir,
        portTimeoutMs: 5_000,
        handshakeTimeoutMs: 10_000,
      })
      .catch((error: unknown) => error);

    await waitFor(() => engine.state === "handshaking", "the facade to reach handshaking");
    await engine.stopGraceful(500);

    const failure = await starting;

    // The start did fail (the caller asked for it), but `closed` is what the
    // caller asked the facade to be: `failed` is terminal and would block the
    // next start for no reason.
    expect(isEngineError(failure)).toBe(true);
    expect(engine.state).toBe("closed");
    expect(existsSync(path.join(tokenDir, TOKEN_FILE_NAME))).toBe(false);
  });
});

describe("Engine.degradations", () => {
  it("reports an untested protocol version but still reaches ready", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub({ protocolVersion: 2 });
    const engine = startTracking();

    // The rule is "warn, then connect anyway": the five frozen error codes
    // have no slot for this, so it must not become a failure.
    const info = await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
      tokenDir,
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    expect(info.protocolVersion).toBe(2);
    expect(engine.state).toBe("ready");

    const protocol = engine.degradations.filter((entry) => entry.kind === "protocol-version");
    expect(protocol).toHaveLength(1);
    expect(protocol[0]?.detail).toContain("2");

    await engine.stopGraceful(3_000);
  });

  it("stays silent about the watchdog when the injected script prints its marker", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();

    const info = await engine.start({
      spawnSpec: {
        ...fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
        env: environment({ NODE_OPTIONS: `--require "${WATCHDOG_ENTRY}"` }),
      },
      tokenDir,
      portTimeoutMs: 10_000,
      handshakeTimeoutMs: 2_000,
    });

    expect(info.engineVersion).toBe(ENGINE_VERSION);
    expect(engine.degradations.filter((entry) => entry.kind === "watchdog")).toEqual([]);

    await engine.stopGraceful(3_000);
  });

  it("reports a watchdog degradation when the preloaded script prints no marker", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const silent = path.join(root, "watchdog.cjs");
    await writeFile(silent, "// preloaded, prints nothing: simulates a disabled marker\n");

    const stub = await startHandshakeStub();
    const engine = startTracking();

    // R-3: the fuse disables `--require`, or the path is wrong. Orphan
    // protection then rests on the parent, and the host has to know.
    await engine.start({
      spawnSpec: {
        ...fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
        env: environment({ NODE_OPTIONS: `--require "${silent.split("\\").join("/")}"` }),
      },
      tokenDir,
      portTimeoutMs: 10_000,
      handshakeTimeoutMs: 2_000,
    });

    expect(engine.state).toBe("ready");
    expect(engine.degradations.filter((entry) => entry.kind === "watchdog")).toHaveLength(1);

    await engine.stopGraceful(3_000);
  });

  it("reports no degradation at all for a plain start", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
      tokenDir,
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    expect(engine.degradations).toEqual([]);

    await engine.stopGraceful(3_000);
  });
});

describe("Engine.start failure classification", () => {
  it("classifies a 401 upgrade as AUTH_FAILED and cleans up after itself", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");

    const server = http.createServer((_request, response) => {
      response.writeHead(401);
      response.end();
    });
    const port = await listen(server);
    httpServers.push(server);

    const engine = startTracking();
    const errors: EngineError[] = [];
    engine.onError((error) => errors.push(error));

    const failure = await expectEngineFailure(
      engine.start({
        spawnSpec: fakeEngineSpec(fakeEngineSource(`ws://127.0.0.1:${port}/ws`, pidFile), root),
        tokenDir,
        portTimeoutMs: 5_000,
      }),
      "AUTH_FAILED",
    );

    expect(failure.detail).toContain("401");
    expect(engine.state).toBe("failed");
    expect(engine.socketState).toBe("closed");

    // The failure event fires once, before the cleanup (work package order).
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("AUTH_FAILED");

    const pid = await readPid(pidFile);
    await waitFor(
      () => !existsSync(path.join(tokenDir, TOKEN_FILE_NAME)),
      "the token file removal after AUTH_FAILED",
    );
    await waitFor(() => !processAlive(pid), "the engine child to exit after AUTH_FAILED");
  });

  it("classifies a just-closed port as PORT_NOT_FOUND", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");

    const server = http.createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const port = await listen(server);
    await closeServer(server);

    const engine = startTracking();

    const failure = await expectEngineFailure(
      engine.start({
        spawnSpec: fakeEngineSpec(fakeEngineSource(`ws://127.0.0.1:${port}/ws`, pidFile), root),
        tokenDir,
        portTimeoutMs: 5_000,
      }),
      "PORT_NOT_FOUND",
    );

    expect(failure.detail).toContain("ECONNREFUSED");
    expect(engine.state).toBe("failed");
    await waitFor(
      () => !existsSync(path.join(tokenDir, TOKEN_FILE_NAME)),
      "the token file removal after PORT_NOT_FOUND",
    );
  });

  it("classifies a missing interpreter as SPAWN_FAILED", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");

    const engine = startTracking();

    const failure = await expectEngineFailure(
      engine.start({
        spawnSpec: {
          ...fakeEngineSpec("", root),
          exePath: path.join(root, "no-such-interpreter.exe"),
        },
        tokenDir,
        portTimeoutMs: 2_000,
      }),
      "SPAWN_FAILED",
    );

    expect(failure.detail.length).toBeGreaterThan(0);
    expect(engine.state).toBe("failed");
    expect(engine.socketState).toBe("closed");
    await waitFor(
      () => !existsSync(path.join(tokenDir, TOKEN_FILE_NAME)),
      "the token file removal after SPAWN_FAILED",
    );
  });

  it("rejects an incomplete spawn spec before spawning anything", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const engine = startTracking();

    const spec = fakeEngineSpec("", root) as unknown as Record<string, unknown>;
    delete spec.cwd;

    const failure = await expectEngineFailure(
      engine.start({
        spawnSpec: spec as unknown as EngineSpawnSpec,
        tokenDir,
      }),
      "SPAWN_FAILED",
    );

    expect(failure.detail).toContain("cwd");
    expect(engine.state).toBe("failed");
    // Validation runs before the token file exists, so nothing was created.
    expect(existsSync(path.join(tokenDir, TOKEN_FILE_NAME))).toBe(false);
  });

  it("reaches ready on a version mismatch and reports it as a degradation", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();
    const errors: EngineError[] = [];
    engine.onError((error) => errors.push(error));

    // An untested build is a warning, not a veto, so the
    // start must succeed and the mismatch must survive as an observable fact.
    const info = await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
      tokenDir,
      expectedEngineVersion: "9.9.9",
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    expect(info.engineVersion).toBe(ENGINE_VERSION);
    expect(engine.state).toBe("ready");
    expect(errors).toEqual([]);

    const mismatch = engine.degradations.filter((entry) => entry.kind === "engine-version");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.detail).toContain("9.9.9");
    expect(mismatch[0]?.detail).toContain(ENGINE_VERSION);

    // The engine is still fully usable: the token file and the child survive.
    const pid = await readPid(pidFile);
    expect(existsSync(path.join(tokenDir, TOKEN_FILE_NAME))).toBe(true);
    expect(processAlive(pid)).toBe(true);

    await engine.stopGraceful(3_000);

    expect(engine.state).toBe("closed");
    expect(existsSync(path.join(tokenDir, TOKEN_FILE_NAME))).toBe(false);
    await waitFor(() => !processAlive(pid), "the engine child to exit after the stop");
  });

  it("keeps failed terminal: a second start rejects with the previous code", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const engine = startTracking();
    const spec = fakeEngineSpec("", root);

    await expectEngineFailure(
      engine.start({ spawnSpec: spec, tokenDir, portTimeoutMs: 2_000 }),
      "PORT_NOT_FOUND",
    );

    const second = await expectEngineFailure(
      engine.start({ spawnSpec: spec, tokenDir }),
      "PORT_NOT_FOUND",
    );

    expect(second.detail).toContain("terminal");
    expect(engine.state).toBe("failed");
  });

  it("stops notifying after the state and error unsubscribers run", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const engine = startTracking();
    const states: EngineState[] = [];
    const errors: EngineError[] = [];

    const offState = engine.onState((state) => states.push(state));
    const offError = engine.onError((error) => errors.push(error));
    offState();
    offError();

    await rejectionOf(
      engine.start({
        spawnSpec: { ...fakeEngineSpec("", root), exePath: path.join(root, "missing.exe") },
        tokenDir,
        portTimeoutMs: 1_000,
      }),
    );

    expect(states).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("keeps the state machine running when a subscriber throws", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const engine = startTracking();
    const observed: EngineState[] = [];

    engine.onState(() => {
      throw new Error("bad subscriber");
    });
    engine.onState((state) => observed.push(state));

    await expectEngineFailure(
      engine.start({
        spawnSpec: { ...fakeEngineSpec("", root), exePath: path.join(root, "missing.exe") },
        tokenDir,
        portTimeoutMs: 1_000,
      }),
      "SPAWN_FAILED",
    );

    expect(observed).toEqual(["spawning", "failed"]);
  });
});

describe("Engine.attach", () => {
  it("reaches ready through the inline connect + handshake path", async () => {
    const stub = await startHandshakeStub();
    const engine = startTracking();
    const states = recordStates(engine);

    const info = await engine.attach({ url: stub.url, token: "external-token" });

    expect(info.engineVersion).toBe(ENGINE_VERSION);
    expect(engine.state).toBe("ready");
    expect(engine.socketState).toBe("open");
    expect(engine.appServerInfo).toBe(info);
    expect(engine.lastFrameAt).not.toBeNull();
    // No process is spawned, so attach hands the handshaking state directly.
    expect(states).toEqual(["handshaking", "ready"]);

    await engine.stopGraceful(500);

    expect(engine.state).toBe("closed");
    expect(engine.socketState).toBe("closed");
    expect(states).toEqual(["handshaking", "ready", "closing", "closed"]);
  });

  it("keeps an untested version as a degradation instead of failing the facade", async () => {
    const stub = await startHandshakeStub();
    const engine = startTracking();
    const errors: EngineError[] = [];
    engine.onError((error) => errors.push(error));

    // A version mismatch is a warning, not a veto: the manual URL + token flow must stay
    // usable with a build the GUI was never tested against, and `failed` is
    // terminal, so turning this into a rejection would close that door for good.
    const info = await engine.attach({
      url: stub.url,
      token: "external-token",
      expectedEngineVersion: "1.2.3",
    });

    expect(info.engineVersion).toBe(ENGINE_VERSION);
    expect(engine.state).toBe("ready");
    expect(engine.socketState).toBe("open");
    expect(errors).toEqual([]);

    const mismatch = engine.degradations.filter((entry) => entry.kind === "engine-version");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.detail).toContain("1.2.3");
    expect(mismatch[0]?.detail).toContain(ENGINE_VERSION);

    await engine.stopGraceful(500);
  });

  it("refuses a second attach after a failure, quoting the previous code", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const port = await listen(server);
    await closeServer(server);

    const engine = startTracking();

    await expectEngineFailure(
      engine.attach({ url: `ws://127.0.0.1:${port}/ws`, token: "external-token" }),
      "PORT_NOT_FOUND",
    );

    const second = await expectEngineFailure(
      engine.attach({ url: `ws://127.0.0.1:${port}/ws`, token: "external-token" }),
      "PORT_NOT_FOUND",
    );

    expect(second.detail).toContain("terminal");
    expect(engine.state).toBe("failed");
  });
});

describe("Engine.start against the real engine", () => {
  it.skipIf(!ENGINE_AVAILABLE)(
    "starts the pinned engine, reaches ready and stops gracefully",
    async () => {
      const { spawnSpec, tokenDir, pidFile } = await prepareRealEngine();
      const engine = startTracking();
      const states = recordStates(engine);

      const info = await engine.start({
        spawnSpec,
        tokenDir,
        expectedEngineVersion: ENGINE_VERSION,
        portTimeoutMs: 15_000,
        handshakeTimeoutMs: 5_000,
      });

      expect(info.engineVersion).toBe(ENGINE_VERSION);
      expect(info.protocolVersion).toBe(1);
      expect(info.backend).toBe("local");
      expect(engine.state).toBe("ready");
      expect(engine.socketState).toBe("open");
      expect(engine.lastFrameAt).not.toBeNull();
      expect(states).toEqual(["spawning", "handshaking", "ready"]);

      const pid = await readPid(pidFile);
      expect(processAlive(pid)).toBe(true);
      expect(existsSync(path.join(tokenDir, TOKEN_FILE_NAME))).toBe(true);

      await engine.stopGraceful(3_000);

      expect(engine.state).toBe("closed");
      expect(engine.socketState).toBe("closed");
      expect(states).toEqual(["spawning", "handshaking", "ready", "closing", "closed"]);
      expect(existsSync(path.join(tokenDir, TOKEN_FILE_NAME))).toBe(false);
      await waitFor(() => !processAlive(pid), "the real engine process to exit");
    },
  );

  it.skipIf(!ENGINE_AVAILABLE)(
    "reaches ready on a real-engine version mismatch and reports the degradation",
    async () => {
      const { spawnSpec, tokenDir, pidFile } = await prepareRealEngine();
      const engine = startTracking();

      const info = await engine.start({
        spawnSpec,
        tokenDir,
        expectedEngineVersion: "9.9.9",
        portTimeoutMs: 15_000,
        handshakeTimeoutMs: 5_000,
      });

      expect(info.engineVersion).toBe(ENGINE_VERSION);
      expect(engine.state).toBe("ready");

      const mismatch = engine.degradations.filter((entry) => entry.kind === "engine-version");
      expect(mismatch).toHaveLength(1);
      expect(mismatch[0]?.detail).toContain("9.9.9");
      expect(mismatch[0]?.detail).toContain(ENGINE_VERSION);

      const pid = await readPid(pidFile);
      expect(processAlive(pid)).toBe(true);

      await engine.stopGraceful(3_000);

      expect(engine.state).toBe("closed");
      expect(existsSync(path.join(tokenDir, TOKEN_FILE_NAME))).toBe(false);
      await waitFor(() => !processAlive(pid), "the real engine process to exit after the stop");
    },
  );
});
