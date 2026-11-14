/**
 * Tests for attaching to an external engine server.
 *
 * Shapes come from no recursive-B1 sections 3.3 (d) and (f), 4.2 , 6.1 
 * and section 8. The fixtures are inline by design (B1-D01): every case starts
 * its own loopback HTTP server on port 0, so no engine process is spawned, no
 * token file is written and nothing outside this file is imported (`fixtures/`
 * included).
 *
 * The four behaviours under test:
 * - a matching handshake resolves with the reported info and no mismatch;
 * - a different expected version resolves too, with the difference reported
 *   instead of thrown (a version mismatch is a notice, not a rejection);
 * - transport and handshake failures are propagated, never downgraded;
 * - attaching performs no filesystem work, so the engine-home snapshot stays
 *   byte-for-byte empty.
 *
 * `ws` has no bundled type declarations (see connection.ts), so the server side
 * is loaded through `createRequire` and described by the small structural type
 * below. Every server and socket is closed in `afterEach`.
 */

import { mkdtemp, readdir, rmdir } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { attachToExternalServer, describeAttachMismatch } from "./attach";
import { EngineConnectionError } from "./connection";
import type { EngineSocket } from "./connection";
import type { EngineErrorCode } from "./types";

const TOKEN = "test-capability-token";

/** Engine build the stub reports; the expected version is chosen per case. */
const ENGINE_VERSION = "0.6.0";

/** Server-side socket surface used by the stub; the client surface is EngineSocket. */
type WsServer = {
  on(event: "connection", listener: (socket: EngineSocket) => void): void;
  close(callback?: (error?: Error) => void): void;
};

type WsServerConstructor = new (options: { server: http.Server }) => WsServer;

const requireFromHere = createRequire(import.meta.url);
const { WebSocketServer } = requireFromHere("ws") as { WebSocketServer: WsServerConstructor };

/** Every server/socket a case opened, torn down between cases. */
const httpServers: http.Server[] = [];
const wsServers: WsServer[] = [];
const sockets: EngineSocket[] = [];

/** Every temp directory a case created, removed point by point afterwards. */
const tempDirs: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.terminate();
    } catch {
      // Already closed by the case itself.
    }
  }

  for (const wsServer of wsServers.splice(0)) {
    await new Promise<void>((resolve) => {
      wsServer.close(() => resolve());
    });
  }

  for (const httpServer of httpServers.splice(0)) {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  }

  // Not recursive on purpose: a leftover file must
  // never be deleted silently, and the case that created it has already failed.
  for (const dir of tempDirs.splice(0)) {
    await rmdir(dir).catch(() => undefined);
  }
});

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

function urlFor(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

/** Resolve to the rejection reason instead of throwing, so a wrong resolve fails loudly. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function expectConnectionError(error: unknown, code: EngineErrorCode): EngineConnectionError {
  expect(error).toBeInstanceOf(EngineConnectionError);

  const connectionError = error as EngineConnectionError;
  expect(connectionError.code).toBe(code);
  expect(connectionError.detail.length).toBeGreaterThan(0);
  return connectionError;
}

function parseJsonObject(data: Buffer): Record<string, unknown> | null {
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

/** The exact response shape measured from engine 0.6.0 (F-15). */
function appServerInfoResponse(requestId: unknown): Record<string, unknown> {
  return {
    type: "app_server_info_response",
    request_id: requestId,
    success: true,
    letta_code_version: ENGINE_VERSION,
    protocol_version: 1,
    backend: "local",
    capabilities: {},
  };
}

/**
 * Start a loopback engine stub and return its attach URL.
 *
 * With `answer: false` the stub accepts the socket but never replies, which is
 * the "connection up, handshake silent" timeout shape.
 */
async function startEngineStub(options: { answer?: boolean } = {}): Promise<string> {
  const answer = options.answer ?? true;

  const server = http.createServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("upgrade required");
  });
  const port = await listen(server);
  httpServers.push(server);

  const wsServer = new WebSocketServer({ server });
  wsServers.push(wsServer);
  wsServer.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data: Buffer) => {
      const frame = parseJsonObject(data);

      if (frame === null || answer === false) {
        return;
      }

      socket.send(JSON.stringify(appServerInfoResponse(frame.request_id)));
    });
  });

  return urlFor(port);
}

/** Start a server that rejects the upgrade with 401 and nothing else. */
async function startUnauthorizedServer(): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(401);
    response.end();
  });
  const port = await listen(server);
  httpServers.push(server);

  return urlFor(port);
}

/** Create a tracked `mkdtemp` directory that `afterEach` removes point by point. */
async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Sorted posix-relative paths of everything inside `root`, recursively. */
async function snapshotTree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });

  return entries.map((entry) => entry.split("\\").join("/")).sort();
}

/** Run `body` with one environment variable set, restoring it afterwards. */
async function withEnv(name: string, value: string, body: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;

  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

describe("attachToExternalServer", () => {
  it("completes the handshake and reports no mismatch for the expected version", async () => {
    const url = await startEngineStub();

    const result = await attachToExternalServer({
      url,
      token: TOKEN,
      expectedEngineVersion: ENGINE_VERSION,
    });

    expect(result.info).toMatchObject({
      protocolVersion: 1,
      engineVersion: ENGINE_VERSION,
      backend: "local",
    });
    expect(result.info.raw).toMatchObject({ type: "app_server_info_response", success: true });
    expect(result.versionMismatch).toBeNull();
    // A matching version produces no mismatch hint at all.
    expect(describeAttachMismatch(result)).toBe("");
  });

  it("reports a version mismatch without rejecting and still returns the info", async () => {
    const url = await startEngineStub();

    const result = await attachToExternalServer({
      url,
      token: TOKEN,
      expectedEngineVersion: "0.5.0",
    });

    // A version mismatch is a "combination not tested" notice: the attach succeeds anyway.
    expect(result.versionMismatch).toEqual({ expected: "0.5.0", actual: ENGINE_VERSION });
    expect(result.info.engineVersion).toBe(ENGINE_VERSION);
    expect(result.info.protocolVersion).toBe(1);

    const notice = describeAttachMismatch(result);
    expect(notice).toBe("expected engine 0.5.0, got 0.6.0; combination not tested");
  });

  it("treats an absent or blank expected version as no expectation", async () => {
    const url = await startEngineStub();

    const absent = await attachToExternalServer({ url, token: TOKEN });
    expect(absent.versionMismatch).toBeNull();

    // A blank config field must not raise a permanent mismatch banner.
    const blank = await attachToExternalServer({
      url,
      token: TOKEN,
      expectedEngineVersion: "   ",
    });
    expect(blank.versionMismatch).toBeNull();
  });

  it("propagates a 401 upgrade rejection as AUTH_FAILED", async () => {
    const url = await startUnauthorizedServer();

    const error = await rejectionOf(attachToExternalServer({ url, token: TOKEN }));
    const connectionError = expectConnectionError(error, "AUTH_FAILED");

    expect(connectionError.detail).toContain("401");
    expect(connectionError.wireHint).toBe("HTTP 401");
  });

  it("rejects a non-ws scheme with PROTOCOL_MISMATCH before opening a socket", async () => {
    // Port 9 has no listener: reaching the network would classify PORT_NOT_FOUND,
    // so the PROTOCOL_MISMATCH below proves the scheme check ran first.
    const error = await rejectionOf(
      attachToExternalServer({ url: "http://127.0.0.1:9/ws", token: TOKEN }),
    );
    const connectionError = expectConnectionError(error, "PROTOCOL_MISMATCH");

    expect(connectionError.detail).toContain('"http"');
    expect(connectionError.wireHint).toBe("http");
  });

  it("rejects a URL that has no usable scheme with PROTOCOL_MISMATCH", async () => {
    // A pasted endpoint without a scheme parses with the host as its "scheme".
    const error = await rejectionOf(
      attachToExternalServer({ url: "localhost:6387/ws", token: TOKEN }),
    );
    const connectionError = expectConnectionError(error, "PROTOCOL_MISMATCH");

    expect(connectionError.detail).toContain('"localhost"');
  });

  it("does not swallow a handshake timeout", async () => {
    const url = await startEngineStub({ answer: false });

    const error = await rejectionOf(attachToExternalServer({ url, token: TOKEN, timeoutMs: 150 }));
    const connectionError = expectConnectionError(error, "PROTOCOL_MISMATCH");

    expect(connectionError.detail).toContain("timed out");
  });

  it("writes nothing, so the engine home stays empty", async () => {
    // The start path derives its token directory from the engine home; an attach
    // must never create that file, so the whole tree is snapshotted before and
    // after. This directory is fresh, so the snapshot must also stay empty.
    const home = await createTempDir("haruyuki-attach-home-");
    const before = await snapshotTree(home);
    expect(before).toEqual([]);

    const url = await startEngineStub();

    await withEnv("HARUYUKI_HOME", home, async () => {
      const result = await attachToExternalServer({ url, token: TOKEN });
      expect(result.info.engineVersion).toBe(ENGINE_VERSION);
    });

    expect(await snapshotTree(home)).toEqual(before);
  });
});
