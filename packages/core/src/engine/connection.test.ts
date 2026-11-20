/**
 * Tests for the engine connection and app_server_info handshake.
 *
 * The fixtures are inline by design: each case starts its own loopback
 * HTTP server on port 0, so no engine process is spawned, no port is guessed and
 * nothing outside this file is imported. Every server and socket is closed in
 * `afterEach`, so vitest can exit without dangling handles.
 *
 * `ws` has no bundled type declarations (see connection.ts), so the server side is
 * loaded through `createRequire` and described by the small structural type
 * below; the client socket type is the one `connection.ts` exports.
 */

import http from "node:http";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { connectEngine, EngineConnectionError } from "./connection";
import type { EngineSocket } from "./connection";
import { requestAppServerInfo } from "./handshake";
import type { EngineErrorCode } from "./types";

const TOKEN = "test-capability-token";

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

/** Close a server and wait for the handle to be released; already-closed is fine. */
async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
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

/** The exact response shape measured from engine 0.6.0. */
function appServerInfoResponse(requestId: unknown): Record<string, unknown> {
  return {
    type: "app_server_info_response",
    request_id: requestId,
    success: true,
    letta_code_version: "0.6.0",
    protocol_version: 1,
    backend: "local",
    capabilities: {},
  };
}

type Stub = {
  client: EngineSocket;
  upgradeHeaders: () => http.IncomingHttpHeaders | undefined;
};

/**
 * Start a loopback engine stub, accept one authenticated client and let the case
 * answer the app_server_info frame. The upgrade headers are captured before ws
 * completes the handshake so the Authorization/Origin assertions are real.
 */
async function startEngineStub(
  onFrame: (socket: EngineSocket, frame: Record<string, unknown>) => void,
): Promise<Stub> {
  const server = http.createServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("upgrade required");
  });
  const port = await listen(server);
  httpServers.push(server);

  let upgradeHeaders: http.IncomingHttpHeaders | undefined;
  server.on("upgrade", (request) => {
    upgradeHeaders = request.headers;
  });

  const wsServer = new WebSocketServer({ server });
  wsServers.push(wsServer);
  wsServer.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data: Buffer) => {
      const frame = parseJsonObject(data);

      if (frame !== null) {
        onFrame(socket, frame);
      }
    });
  });

  const client = await connectEngine(urlFor(port), TOKEN);
  sockets.push(client);

  return { client, upgradeHeaders: () => upgradeHeaders };
}

describe("connectEngine", () => {
  it("classifies a 401 upgrade rejection as AUTH_FAILED", async () => {
    let observed: http.IncomingHttpHeaders | undefined;

    const server = http.createServer((request, response) => {
      observed = request.headers;
      response.writeHead(401);
      response.end();
    });
    const port = await listen(server);
    httpServers.push(server);

    const error = await rejectionOf(connectEngine(urlFor(port), TOKEN));
    const connectionError = expectConnectionError(error, "AUTH_FAILED");

    expect(connectionError.detail).toContain("401");
    // The token travels in the header, and no Origin is sent.
    expect(observed?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(observed?.origin).toBeUndefined();
  });

  it("classifies a refused port as PORT_NOT_FOUND", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const port = await listen(server);
    await closeServer(server);

    const error = await rejectionOf(connectEngine(urlFor(port), TOKEN));
    const connectionError = expectConnectionError(error, "PORT_NOT_FOUND");

    expect(connectionError.detail).toContain("ECONNREFUSED");
    expect(connectionError.wireHint).toBe("ECONNREFUSED");
  });

  it("maps itself onto the frozen EngineError shape", () => {
    expect(new EngineConnectionError("AUTH_FAILED", "denied").toEngineError()).toEqual({
      code: "AUTH_FAILED",
      detail: "denied",
    });

    expect(new EngineConnectionError("TIMEOUT", "slow", "ETIMEDOUT").toEngineError()).toEqual({
      code: "TIMEOUT",
      detail: "slow",
      wireHint: "ETIMEDOUT",
    });
  });
});

describe("requestAppServerInfo", () => {
  it("completes the handshake with the matching response", async () => {
    const stub = await startEngineStub((socket, frame) => {
      socket.send(JSON.stringify(appServerInfoResponse(frame.request_id)));
    });

    const info = await requestAppServerInfo(stub.client, 1_000);

    expect(info).toMatchObject({
      protocolVersion: 1,
      engineVersion: "0.6.0",
      backend: "local",
    });
    expect(info.raw).toMatchObject({ type: "app_server_info_response", success: true });

    // The successful upgrade carries the Bearer token and no Origin header.
    expect(stub.upgradeHeaders()?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(stub.upgradeHeaders()?.origin).toBeUndefined();
  });

  it("rejects with PROTOCOL_MISMATCH when no response arrives", async () => {
    const stub = await startEngineStub(() => {
      // Deliberately silent: the engine accepted the socket but never answered.
    });

    const error = await rejectionOf(requestAppServerInfo(stub.client, 100));
    const handshakeError = expectConnectionError(error, "PROTOCOL_MISMATCH");

    expect(handshakeError.detail).toContain("request_id");
  });

  it("ignores a foreign request_id and times out with PROTOCOL_MISMATCH", async () => {
    const stub = await startEngineStub((socket, frame) => {
      socket.send(JSON.stringify(appServerInfoResponse(`foreign-${String(frame.request_id)}`)));
    });

    // A foreign id is ignored on purpose (see handshake.ts); the pending request
    // therefore reaches its timeout instead of failing on the first stray frame.
    const error = await rejectionOf(requestAppServerInfo(stub.client, 100));
    const handshakeError = expectConnectionError(error, "PROTOCOL_MISMATCH");

    expect(handshakeError.detail).toContain("timed out");
  });

  it("rejects with PROTOCOL_MISMATCH when the engine answers success:false", async () => {
    const stub = await startEngineStub((socket, frame) => {
      socket.send(
        JSON.stringify({
          type: "app_server_info_response",
          request_id: frame.request_id,
          success: false,
          error: "protocol version 2 is not supported",
        }),
      );
    });

    const error = await rejectionOf(requestAppServerInfo(stub.client, 1_000));
    const handshakeError = expectConnectionError(error, "PROTOCOL_MISMATCH");

    expect(handshakeError.detail).toContain("protocol version 2 is not supported");
  });

  it("rejects with PROTOCOL_MISMATCH when the socket closes first", async () => {
    const stub = await startEngineStub((socket) => {
      socket.close();
    });

    const error = await rejectionOf(requestAppServerInfo(stub.client, 1_000));
    expectConnectionError(error, "PROTOCOL_MISMATCH");
  });
});
