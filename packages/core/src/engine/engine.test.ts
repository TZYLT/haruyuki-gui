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
import { mkdir, mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { EngineConnectionError } from "./connection";
import { Engine } from "./engine";
import { isEngineError, toEngineError } from "./errors";
import { PortNotFoundError } from "./port-discovery";
import { TOKEN_FILE_NAME } from "./token";
import type { EngineError, EngineErrorCode, EngineSpawnSpec, EngineState } from "./types";

/** Pinned engine artifact; gitignored. */
const ENGINE_ENTRY = fileURLToPath(
  new URL("../../../../_research/engine-0.6.0/package/haruyuki.js", import.meta.url),
);

const ENGINE_AVAILABLE = existsSync(ENGINE_ENTRY);

/** Engine build string the pinned artifact reports (F-4). */
const ENGINE_VERSION = "0.6.0";

/** Loopback tooling for the WS server side; `ws` ships no declarations (see connection.ts). */
type WsServer = {
  on(event: "connection", listener: (socket: ServerSocket) => void): void;
  close(callback?: (error?: Error) => void): void;
};

type ServerSocket = {
  on(event: "message", listener: (data: Buffer) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

const requireFromHere = createRequire(import.meta.url);
const { WebSocketServer } = requireFromHere("ws") as {
  WebSocketServer: new (options: { server: http.Server }) => WsServer;
};

const tempRoots: string[] = [];
const engines: Engine[] = [];
const httpServers: http.Server[] = [];
const wsServers: WsServer[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    try {
      await engine.stopGraceful(1_000);
    } catch {
      // A stop never rejects by contract; guard so cleanup continues anyway.
    }
    engine.kill();
  }

  for (const wsServer of wsServers.splice(0)) {
    await new Promise<void>((resolve) => {
      wsServer.close(() => resolve());
    });
  }

  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  for (const root of tempRoots.splice(0)) {
    await removeTree(root);
  }
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

  it("classifies a version mismatch as PROTOCOL_MISMATCH and names both versions", async () => {
    const root = await makeRoot();
    const tokenDir = await makeDir(root, "tokens");
    const pidFile = path.join(root, "engine.pid");
    const stub = await startHandshakeStub();
    const engine = startTracking();

    const failure = await expectEngineFailure(
      engine.start({
        spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, pidFile), root),
        tokenDir,
        expectedEngineVersion: "9.9.9",
        portTimeoutMs: 5_000,
        handshakeTimeoutMs: 2_000,
      }),
      "PROTOCOL_MISMATCH",
    );

    expect(failure.detail).toContain("9.9.9");
    expect(failure.detail).toContain(ENGINE_VERSION);
    expect(engine.state).toBe("failed");

    const pid = await readPid(pidFile);
    await waitFor(
      () => !existsSync(path.join(tokenDir, TOKEN_FILE_NAME)),
      "the token file removal after PROTOCOL_MISMATCH",
    );
    await waitFor(() => !processAlive(pid), "the engine child to exit after PROTOCOL_MISMATCH");
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

  it("classifies a version mismatch as PROTOCOL_MISMATCH", async () => {
    const stub = await startHandshakeStub();
    const engine = startTracking();
    const errors: EngineError[] = [];
    engine.onError((error) => errors.push(error));

    const failure = await expectEngineFailure(
      engine.attach({ url: stub.url, token: "external-token", expectedEngineVersion: "1.2.3" }),
      "PROTOCOL_MISMATCH",
    );

    expect(failure.detail).toContain("1.2.3");
    expect(engine.state).toBe("failed");
    expect(engine.socketState).toBe("closed");
    expect(errors).toHaveLength(1);
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
    "classifies a version mismatch against the real engine and cleans up",
    async () => {
      const { spawnSpec, tokenDir, pidFile } = await prepareRealEngine();
      const engine = startTracking();

      const failure = await expectEngineFailure(
        engine.start({
          spawnSpec,
          tokenDir,
          expectedEngineVersion: "9.9.9",
          portTimeoutMs: 15_000,
          handshakeTimeoutMs: 5_000,
        }),
        "PROTOCOL_MISMATCH",
      );

      expect(failure.detail).toContain("9.9.9");
      expect(failure.detail).toContain(ENGINE_VERSION);
      expect(engine.state).toBe("failed");

      const pid = await readPid(pidFile);
      expect(existsSync(path.join(tokenDir, TOKEN_FILE_NAME))).toBe(false);
      await waitFor(() => !processAlive(pid), "the real engine process to exit after a failure");
    },
  );
});

// --- helpers ---------------------------------------------------------------

/**
 * Test-only launcher: rewrites `process.argv` to the measured F-6 command line
 * and loads the bundle in this same process, so the facade's child IS the engine
 * (one pid, no wrapper to orphan). `spawn.ts` appends `bundlePath` after
 * `argvPrefix`; see the file comment.
 */
const LAUNCHER_SOURCE = `import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const enginePath = process.argv[2];
const pidFile = process.argv[3];
const tokenPath = process.argv[4];
writeFileSync(pidFile, String(process.pid));
process.argv = [process.execPath, enginePath, "server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-file", tokenPath];
await import(pathToFileURL(enginePath).href);
`;

/** Spawn spec for the launcher: `node launcher.mjs <engine> <pidFile> <tokenPath> ...`. */
function realEngineSpec(options: {
  launcher: string;
  pidFile: string;
  home: string;
  work: string;
  root: string;
}): EngineSpawnSpec {
  return {
    exePath: process.execPath,
    env: environment({
      HARUYUKI_HOME: options.home,
      USERPROFILE: options.home,
      HOME: options.home,
    }),
    // `node <launcher> <engine entry> <pid file>`: bundlePath first, then the
    // engine arguments, matching the F-6 order.
    argvPrefix: [ENGINE_ENTRY, options.pidFile],
    bundlePath: options.launcher,
    cwd: options.work,
    stdio: "pipe",
    windowsHide: true,
    detached: false,
  };
}

/** Isolated home / work / launcher for one real-engine case. */
async function prepareRealEngine(): Promise<{
  spawnSpec: EngineSpawnSpec;
  tokenDir: string;
  pidFile: string;
}> {
  const root = await makeRoot();
  const tokenDir = await makeDir(root, "tokens");
  const home = await makeDir(root, "home");
  const work = await makeDir(root, "work");
  const launcher = path.join(root, "launcher.mjs");
  const pidFile = path.join(root, "engine.pid");
  await writeFile(launcher, LAUNCHER_SOURCE, "utf8");

  return { tokenDir, pidFile, spawnSpec: realEngineSpec({ launcher, pidFile, home, work, root }) };
}

/**
 * Spawn spec for a `node -e` fake engine: it prints one `WebSocket:` line and
 * stays alive, so discovery, connection and cleanup are real while the HTTP/WS
 * behaviour is supplied in-process.
 */
function fakeEngineSpec(source: string, root: string): EngineSpawnSpec {
  return {
    exePath: process.execPath,
    env: environment(),
    // `node -e <source>`: bundlePath is the interpreter flag, the source is the
    // first engine argument; `start` appends the token path after it.
    argvPrefix: [source],
    bundlePath: "-e",
    cwd: root,
    stdio: "pipe",
    windowsHide: true,
    detached: false,
  };
}

/** Inline fake engine: record the pid, print the endpoint, stay alive. */
function fakeEngineSource(url: string, pidFile: string): string {
  const lines = [
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `process.stdout.write(${JSON.stringify(`WebSocket: ${url}\n`)});`,
    "setInterval(() => {}, 1000);",
  ];
  return lines.join("\n");
}

type HandshakeStub = {
  url: string;
  pushFrame: (frame: unknown) => void;
};

/** In-process engine stub: answers `app_server_info` (F-15) and keeps the client socket. */
async function startHandshakeStub(): Promise<HandshakeStub> {
  const server = http.createServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("upgrade required");
  });
  const port = await listen(server);
  httpServers.push(server);

  const wsServer = new WebSocketServer({ server });
  wsServers.push(wsServer);
  const clients: ServerSocket[] = [];

  wsServer.on("connection", (socket) => {
    clients.push(socket);
    socket.on("message", (data: Buffer) => {
      const frame = parseFrame(data);

      if (frame === null || frame.type !== "app_server_info") {
        return;
      }

      socket.send(
        JSON.stringify({
          type: "app_server_info_response",
          request_id: frame.request_id,
          success: true,
          letta_code_version: ENGINE_VERSION,
          protocol_version: 1,
          backend: "local",
          capabilities: {},
        }),
      );
    });
  });

  const url = `ws://127.0.0.1:${port}/ws`;
  const pushFrame = (frame: unknown): void => {
    for (const socket of clients) socket.send(JSON.stringify(frame));
  };
  return { url, pushFrame };
}

function parseFrame(data: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data.toString("utf8"));

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A complete environment for a spawned child; never inherits a preload. */
function environment(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  delete env.NODE_OPTIONS;
  return { ...env, ...overrides };
}

/** Create a tracked temp root under the system temp directory. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "haruyuki-engine-"));
  tempRoots.push(root);
  return root;
}

/** Create one tracked subdirectory under a temp root. */
async function makeDir(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Register an engine so `afterEach` stops it even when a case fails early. */
function startTracking(): Engine {
  const engine = new Engine();
  engines.push(engine);
  return engine;
}

/** Record every transition of one engine. */
function recordStates(engine: Engine): EngineState[] {
  const states: EngineState[] = [];
  engine.onState((state) => states.push(state));
  return states;
}

/** Read the pid the fake engine recorded. */
async function readPid(pidFile: string): Promise<number> {
  const text = await readFile(pidFile, "utf8");
  const pid = Number.parseInt(text, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`the fake engine wrote no usable pid: ${JSON.stringify(text)}`);
  }
  return pid;
}

/** True when a process with that pid is still alive. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Listen on a system-assigned loopback port and return it. */
async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected the test server to bind a TCP port");
  }

  return address.port;
}

/** Close a server and wait for the handle to be released. */
async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Resolve to the rejection reason instead of throwing. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/** Assert that a facade call rejected with a classified `EngineError` of `code`. */
async function expectEngineFailure(
  promise: Promise<unknown>,
  code: EngineErrorCode,
): Promise<EngineError> {
  const error = await rejectionOf(promise);
  expect(isEngineError(error)).toBe(true);

  if (!isEngineError(error)) {
    throw new Error(`expected a classified EngineError, got ${String(error)}`);
  }

  expect(error.code).toBe(code);
  expect(error.detail.length).toBeGreaterThan(0);
  // The rejection value is still an Error, so a stack survives the throw.
  expect(error).toBeInstanceOf(Error);
  return error;
}

/** Poll a predicate until it holds or the deadline passes. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (predicate()) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }

    await delay(25);
  }
}

/** Promise-based sleep, used for polling and for timestamp gaps. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Delete a temp tree point by point: `unlink` every file, then `rmdir` every
 * directory bottom-up. Recursive delete helpers are forbidden, and a just-stopped
 * engine can hold a handle for a moment, so the walk is retried a few times.
 */
async function removeTree(root: string): Promise<void> {
  if (!existsSync(root)) {
    return;
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await removeTreeOnce(root);
      return;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }

  throw lastError;
}

/** One point-by-point delete pass. */
async function removeTreeOnce(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const child = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await removeTreeOnce(child);
      continue;
    }

    await unlink(child);
  }

  await rmdir(directory);
}
