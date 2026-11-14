/**
 * Shared fixtures for the engine facade tests.
 *
 * Split out of `engine.test.ts` so that file stays inside the repository's
 * file-size limit  while the facade's cases stay in one
 * readable block. Everything here is scaffolding: a fake engine child, an
 * in-process `app_server_info` stub, the test-only launcher for the real
 * artifact, and the point-by-point cleanup the discipline requires (no recursive
 * section 5.1 rule 3: no recursive delete).
 *
 * The file does not end in `.test.ts` on purpose: vitest collects files by that
 * suffix, so nothing here is ever treated as a suite.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { Engine } from "./engine";
import { isEngineError } from "./errors";
import { TOKEN_FILE_NAME } from "./token";
import type { EngineError, EngineErrorCode, EngineSpawnSpec, EngineState } from "./types";

/** Pinned engine artifact; gitignored. */
export const ENGINE_ENTRY = fileURLToPath(
  new URL("../../../../_research/engine-0.6.0/package/haruyuki.js", import.meta.url),
);

export const ENGINE_AVAILABLE = existsSync(ENGINE_ENTRY);

/** Engine build string the pinned artifact reports (F-4). */
export const ENGINE_VERSION = "0.6.0";

/**
 * The injected watchdog, addressed the way `NODE_OPTIONS` needs it.
 *
 * Forward slashes on every platform: Node strips backslashes inside
 * `NODE_OPTIONS` as escapes (measured), and the host port does the
 * same conversion for the same reason.
 */
export const WATCHDOG_ENTRY = fileURLToPath(new URL("../runtime/watchdog.cjs", import.meta.url))
  .split("\\")
  .join("/");

/** Loopback tooling for the WS server side; `ws` ships no declarations (see connection.ts). */
export type WsServer = {
  on(event: "connection", listener: (socket: ServerSocket) => void): void;
  close(callback?: (error?: Error) => void): void;
};

export type ServerSocket = {
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
export const httpServers: http.Server[] = [];
export const wsServers: WsServer[] = [];

/**
 * Tear down everything a case created: engines, servers, then temp roots.
 *
 * Exported rather than registered here so each test file keeps its own
 * `afterEach` and the support module stays free of test-runner state.
 */
export async function releaseFixtures(): Promise<void> {
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
}

// --- helpers ---------------------------------------------------------------

/**
 * Test-only launcher: rewrites `process.argv` to the measured F-6 command line
 * and loads the bundle in this same process, so the facade's child IS the engine
 * (one pid, no wrapper to orphan). `spawn.ts` appends `bundlePath` after
 * `argvPrefix`; see the file comment.
 */
export const LAUNCHER_SOURCE = `import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const enginePath = process.argv[2];
const pidFile = process.argv[3];
const tokenPath = process.argv[4];
writeFileSync(pidFile, String(process.pid));
process.argv = [process.execPath, enginePath, "server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-file", tokenPath];
await import(pathToFileURL(enginePath).href);
`;

/** Spawn spec for the launcher: `node launcher.mjs <engine> <pidFile> <tokenPath> ...`. */
export function realEngineSpec(options: {
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
export async function prepareRealEngine(): Promise<{
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
export function fakeEngineSpec(source: string, root: string): EngineSpawnSpec {
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
export function fakeEngineSource(url: string, pidFile: string): string {
  const lines = [
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `process.stdout.write(${JSON.stringify(`WebSocket: ${url}\n`)});`,
    "setInterval(() => {}, 1000);",
  ];
  return lines.join("\n");
}

export type HandshakeStub = {
  url: string;
  pushFrame: (frame: unknown) => void;
};

/** Overrides for the stub's answer; the defaults are the measured F-15 shape. */
export type HandshakeStubOptions = {
  protocolVersion?: number;
  engineVersion?: string;
  /** When false the stub accepts the request and never answers it. */
  answer?: boolean;
};

/** In-process engine stub: answers `app_server_info` (F-15) and keeps the client socket. */
export async function startHandshakeStub(
  options: HandshakeStubOptions = {},
): Promise<HandshakeStub> {
  const protocolVersion = options.protocolVersion ?? 1;
  const engineVersion = options.engineVersion ?? ENGINE_VERSION;
  const answer = options.answer ?? true;

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

      if (!answer) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: "app_server_info_response",
          request_id: frame.request_id,
          success: true,
          letta_code_version: engineVersion,
          protocol_version: protocolVersion,
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

export function parseFrame(data: Buffer): Record<string, unknown> | null {
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
export function environment(overrides: Record<string, string> = {}): Record<string, string> {
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
export async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "haruyuki-engine-"));
  tempRoots.push(root);
  return root;
}

/** Create one tracked subdirectory under a temp root. */
export async function makeDir(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Register an engine so `afterEach` stops it even when a case fails early. */
export function startTracking(): Engine {
  const engine = new Engine();
  engines.push(engine);
  return engine;
}

/** Record every transition of one engine. */
export function recordStates(engine: Engine): EngineState[] {
  const states: EngineState[] = [];
  engine.onState((state) => states.push(state));
  return states;
}

/** Read the pid the fake engine recorded. */
export async function readPid(pidFile: string): Promise<number> {
  const text = await readFile(pidFile, "utf8");
  const pid = Number.parseInt(text, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`the fake engine wrote no usable pid: ${JSON.stringify(text)}`);
  }
  return pid;
}

/** True when a process with that pid is still alive. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Listen on a system-assigned loopback port and return it. */
export async function listen(server: http.Server): Promise<number> {
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
export async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Resolve to the rejection reason instead of throwing. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/** Assert that a facade call rejected with a classified `EngineError` of `code`. */
export async function expectEngineFailure(
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
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
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
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Delete a temp tree point by point: `unlink` every file, then `rmdir` every
 * directory bottom-up. Recursive delete helpers are forbidden, and a just-stopped
 * engine can hold a handle for a moment, so the walk is retried a few times.
 */
export async function removeTree(root: string): Promise<void> {
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
export async function removeTreeOnce(directory: string): Promise<void> {
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
