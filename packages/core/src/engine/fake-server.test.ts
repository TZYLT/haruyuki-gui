/**
 * Tests for the programmable fake engine server.
 *
 * The fixture stands in for the real engine process, so it is exercised over a
 * real loopback WebSocket instead of through the connection/handshake modules
 * (that would be the integration under test in  and would risk a cycle).
 * Shapes come from the frame shapes below are pinned to that wire 6.1
 * (V-5, V-6, diagnostic-bundle-tree).
 *
 * `ws` ships no type declarations, so both the fixture's module surface and the
 * client socket are described structurally below and loaded through
 * `createRequire` / a dynamic `import()` of the fixture path. Every socket,
 * server and child process opened here is released in `afterEach` (or the
 * case's own `finally`), so vitest exits without dangling handles.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/* ------------------------------------------------------------------ */
/* ws client surface (no bundled declarations)                         */
/* ------------------------------------------------------------------ */

type ClientSocket = {
  on(event: string, listener: (...args: any[]) => void): ClientSocket;
  once(event: string, listener: (...args: any[]) => void): ClientSocket;
  removeListener(event: string, listener: (...args: any[]) => void): ClientSocket;
  send(data: string): void;
  close(): void;
  terminate(): void;
};

type ClientOptions = { headers?: Record<string, string> };
type WebSocketConstructor = new (url: string, options?: ClientOptions) => ClientSocket;

const requireFromHere = createRequire(import.meta.url);
const { WebSocket } = requireFromHere("ws") as { WebSocket: WebSocketConstructor };

/* ------------------------------------------------------------------ */
/* fixtured module surface                                             */
/* ------------------------------------------------------------------ */

type FakeMode =
  | "ok"
  | "no-response"
  | "bad-request-id"
  | "bad-protocol"
  | "success-false"
  | "close-on-connect"
  | "non-json";

type FakeServerOptions = {
  port?: number;
  mode?: FakeMode;
  token?: string;
  host?: string;
};

type FakeServer = {
  url: string;
  port: number;
  received: string[];
  close(): Promise<void>;
};

type FakeServerModule = {
  startFakeServer(options?: FakeServerOptions): Promise<FakeServer>;
};

/** packages/core/src/engine -> repo root -> fixtures/engine/fake-server.mjs */
const FIXTURE_PATH = fileURLToPath(
  new URL("../../../../fixtures/engine/fake-server.mjs", import.meta.url),
);

const sockets: ClientSocket[] = [];
const servers: FakeServer[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.terminate();
    } catch {
      // Already closed by the case itself.
    }
  }

  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function startServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const module = (await import(pathToFileURL(FIXTURE_PATH).href)) as FakeServerModule;
  const server = await module.startFakeServer(options);
  servers.push(server);
  return server;
}

/* ------------------------------------------------------------------ */
/* client helpers                                                      */
/* ------------------------------------------------------------------ */

type CloseInfo = { code: number; reason: string };
type Message = { text: string; isBinary: boolean };

type Client = {
  socket: ClientSocket;
  opened: Promise<void>;
  closed: Promise<CloseInfo>;
};

function openClient(url: string, headers?: Record<string, string>): Client {
  const socket = headers === undefined ? new WebSocket(url) : new WebSocket(url, { headers });
  sockets.push(socket);

  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error: Error) => reject(error));
  });

  const closed = new Promise<CloseInfo>((resolve) => {
    socket.once("close", (code: number, reason: Buffer) => {
      resolve({
        code,
        reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason),
      });
    });
  });

  socket.on("error", () => {
    // An injected close or a terminate mid-test emits this before close.
  });

  return { socket, opened, closed };
}

function decodeMessage(data: unknown, isBinary: boolean): Message {
  return {
    text: Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
    isBinary: Boolean(isBinary),
  };
}

function nextMessage(socket: ClientSocket): Promise<Message> {
  return new Promise((resolve) => {
    socket.once("message", (data: unknown, isBinary: boolean) =>
      resolve(decodeMessage(data, isBinary)),
    );
  });
}

function collectMessages(socket: ClientSocket): Message[] {
  const messages: Message[] = [];
  socket.on("message", (data: unknown, isBinary: boolean) => {
    messages.push(decodeMessage(data, isBinary));
  });
  return messages;
}

function sendHandshake(socket: ClientSocket, requestId: string): string {
  const frame = JSON.stringify({ type: "app_server_info", request_id: requestId });
  socket.send(frame);
  return frame;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve with the HTTP status of a rejected upgrade (F-11 shape). */
function expectUpgradeRejected(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for the rejected upgrade"));
    }, 5000);

    socket.on("error", () => {
      // terminate() below emits an error once the status has been read.
    });

    socket.once("unexpected-response", (_request: unknown, response: { statusCode?: number }) => {
      clearTimeout(timer);
      const status = response.statusCode ?? 0;
      socket.terminate();
      resolve(status);
    });

    socket.once("open", () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error("the server accepted an upgrade with a bad token"));
    });

    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/* ------------------------------------------------------------------ */
/* child process helpers (executable mode)                             */
/* ------------------------------------------------------------------ */

function collectStdoutLines(
  child: ChildProcess,
  stdout: Readable,
  patterns: readonly RegExp[],
  timeoutMs = 10000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const matched: string[] = [];
    let buffer = "";

    const cleanup = () => {
      clearTimeout(timer);
      stdout.removeListener("data", onData);
      child.removeListener("exit", onExit);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for stdout lines; saw: ${matched.join(" | ")}`));
    }, timeoutMs);

    const onData = (chunk: unknown) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const pattern = patterns[matched.length];

        if (pattern !== undefined && pattern.test(line)) {
          matched.push(line);

          if (matched.length === patterns.length) {
            cleanup();
            resolve(matched);
            return;
          }
        }
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(`fake server exited before printing both lines (code=${code}, signal=${signal})`),
      );
    };

    stdout.setEncoding("utf8");
    stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ */
/* handshake modes                                                     */
/* ------------------------------------------------------------------ */

describe("fake server handshake modes", () => {
  it("ok: answers app_server_info and records the raw request frame", async () => {
    const server = await startServer();
    const client = openClient(server.url);
    await client.opened;

    const frame = sendHandshake(client.socket, "req-ok-1");
    const message = await nextMessage(client.socket);
    const response = JSON.parse(message.text) as Record<string, unknown>;

    expect(message.isBinary).toBe(false);
    expect(response.type).toBe("app_server_info_response");
    expect(response.request_id).toBe("req-ok-1");
    expect(response.success).toBe(true);
    expect(response.protocol_version).toBe(1);
    expect(response.letta_code_version).toBe("0.6.0");
    expect(response.backend).toBe("local");
    expect(response.capabilities).toEqual({});
    expect(server.received).toContain(frame);
  });

  it("no-response: receives the request but stays silent (timeout shape)", async () => {
    const server = await startServer({ mode: "no-response" });
    const client = openClient(server.url);
    await client.opened;

    const messages = collectMessages(client.socket);
    sendHandshake(client.socket, "req-timeout-1");
    await sleep(100);

    expect(messages).toHaveLength(0);
    expect(server.received).toHaveLength(1);
  });

  it("bad-request-id: the response carries a different request_id", async () => {
    const server = await startServer({ mode: "bad-request-id" });
    const client = openClient(server.url);
    await client.opened;

    sendHandshake(client.socket, "req-bad-1");
    const message = await nextMessage(client.socket);
    const response = JSON.parse(message.text) as Record<string, unknown>;

    expect(response.type).toBe("app_server_info_response");
    expect(response.request_id).not.toBe("req-bad-1");
    expect(response.request_id).toBe("req-bad-1-mismatched");
  });

  it("bad-protocol: the response carries protocol_version 99", async () => {
    const server = await startServer({ mode: "bad-protocol" });
    const client = openClient(server.url);
    await client.opened;

    sendHandshake(client.socket, "req-protocol-1");
    const message = await nextMessage(client.socket);
    const response = JSON.parse(message.text) as Record<string, unknown>;

    expect(response.request_id).toBe("req-protocol-1");
    expect(response.protocol_version).toBe(99);
  });

  it("success-false: the response carries success false and an error message", async () => {
    const server = await startServer({ mode: "success-false" });
    const client = openClient(server.url);
    await client.opened;

    sendHandshake(client.socket, "req-failure-1");
    const message = await nextMessage(client.socket);
    const response = JSON.parse(message.text) as Record<string, unknown>;

    expect(response.request_id).toBe("req-failure-1");
    expect(response.success).toBe(false);
    expect(typeof response.error).toBe("string");
    expect((response.error as string).length).toBeGreaterThan(0);
  });

  it("token: a mismatched bearer token is rejected with HTTP 401", async () => {
    const server = await startServer({ token: "expected-token" });

    const status = await expectUpgradeRejected(server.url, {
      authorization: "Bearer wrong-token",
    });

    expect(status).toBe(401);
    expect(server.received).toHaveLength(0);
  });

  it("close-on-connect: the socket is closed right after it opens", async () => {
    const server = await startServer({ mode: "close-on-connect" });
    const client = openClient(server.url);
    await client.opened;

    const close = await client.closed;

    // The server closes without a status code, so the client sees 1005.
    expect(close.code).toBe(1005);
    expect(server.received).toHaveLength(0);
  });

  it("non-json: answers with a text frame that JSON.parse rejects", async () => {
    const server = await startServer({ mode: "non-json" });
    const client = openClient(server.url);
    await client.opened;

    sendHandshake(client.socket, "req-nonjson-1");
    const message = await nextMessage(client.socket);

    expect(message.isBinary).toBe(false);
    expect(() => JSON.parse(message.text)).toThrow();
    expect(message.text.startsWith("{")).toBe(false);
    expect(server.received).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* executable mode                                                     */
/* ------------------------------------------------------------------ */

describe("fake server executable mode", () => {
  it("prints the two engine-shaped stdout lines and dies on kill", async () => {
    const child = spawn(process.execPath, [FIXTURE_PATH, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout = child.stdout;
    const stderr = child.stderr;

    if (stdout === null || stderr === null) {
      throw new Error("expected piped stdout and stderr");
    }

    stderr.resume();

    try {
      const lines = await collectStdoutLines(child, stdout, [
        /^Listening on ws:\/\/127\.0\.0\.1:(\d+)$/,
        /^WebSocket:\s+(ws:\/\/\S+)$/,
      ]);

      const listenMatch = /^Listening on ws:\/\/127\.0\.0\.1:(\d+)$/.exec(lines[0] ?? "");
      const socketMatch = /^WebSocket:\s+(ws:\/\/\S+)$/.exec(lines[1] ?? "");

      expect(listenMatch).not.toBeNull();
      expect(socketMatch).not.toBeNull();

      const port = Number(listenMatch?.[1] ?? "0");

      expect(port).toBeGreaterThan(0);
      expect(socketMatch?.[1]).toBe(`ws://127.0.0.1:${port}/ws`);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child, 5000);
    }

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
