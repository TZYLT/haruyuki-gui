/**
 * fake-server.mjs - programmable fake engine WebSocket server.
 *
 * The real engine (haruyuki 0.6.0) prints two lines on stdout and then speaks a
 * small WebSocket handshake; the frame shapes below are pinned to that wire
 * protocol. This fixture reproduces only what the connection, handshake and
 * connection, handshake and state-machine packages need, and lets a test inject
 * one broken shape at a time:
 *
 *   ok                handshake succeeds: success true, protocol_version 1,
 *                     letta_code_version "0.6.0", backend "local"
 *   no-response       requests are received but never answered (the client times out)
 *   bad-request-id    the response carries a different request_id
 *   bad-protocol      the response carries protocol_version 99
 *   success-false     the response carries success false and an error message
 *   close-on-connect  the socket is closed right after the connection opens
 *   non-json          requests are answered with a non-JSON text frame
 *
 * Two ways in:
 *   node fixtures/engine/fake-server.mjs [--port 0] [--mode <mode>] [--token <t>]
 *   import { startFakeServer } from "./fixtures/engine/fake-server.mjs";
 *
 * The fixture deliberately imports nothing from packages/core: only `ws` via a
 * require anchored at packages/core/package.json, because `ws` is a dependency
 * of that package and pnpm does not hoist it to the repo root.
 */

import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const DEFAULT_MODE = "ok";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const RESPONSE_TYPE = "app_server_info_response";
const REQUEST_TYPE = "app_server_info";
const ENGINE_VERSION = "0.6.0";

/** Every mode `--mode` / `opts.mode` accepts, in documentation order. */
export const FAKE_SERVER_MODES = Object.freeze([
  "ok",
  "no-response",
  "bad-request-id",
  "bad-protocol",
  "success-false",
  "close-on-connect",
  "non-json",
]);

/**
 * Resolve `ws` without adding a dependency edge: packages/core owns the `ws`
 * dependency, so its package directory is the resolution anchor. The root
 * package is tried second for layouts that do hoist it.
 */
function loadWebSocket() {
  const anchors = [
    path.join(REPO_ROOT, "packages", "core", "package.json"),
    path.join(REPO_ROOT, "package.json"),
  ];
  const failures = [];

  for (const anchor of anchors) {
    try {
      return createRequire(anchor)("ws");
    } catch (error) {
      failures.push(`  ${anchor}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `fake-server: cannot resolve "ws" (install packages/core dependencies).\n${failures.join("\n")}`,
  );
}

const { WebSocketServer } = loadWebSocket();

/** Validate and normalize a mode name. */
function normalizeMode(mode) {
  const value = mode === undefined || mode === null ? DEFAULT_MODE : String(mode);

  if (!FAKE_SERVER_MODES.includes(value)) {
    throw new Error(
      `fake-server: unknown mode "${value}"; expected one of ${FAKE_SERVER_MODES.join(", ")}`,
    );
  }

  return value;
}

/**
 * F-11 shape: the engine compares the SHA-256 of `Bearer <token>`. The fixture
 * only needs the accept/reject verdict, so a plain comparison is enough.
 */
function isAuthorized(header, token) {
  if (token === null || token === undefined) return true;
  return header === `Bearer ${token}`;
}

/** Base success payload (F-15), shared by the variants below. */
function buildSuccess(requestId) {
  return {
    type: RESPONSE_TYPE,
    request_id: requestId,
    success: true,
    protocol_version: 1,
    letta_code_version: ENGINE_VERSION,
    backend: "local",
    capabilities: {},
  };
}

/** Build the injected answer for one mode (never called for no-response). */
function buildResponse(mode, request) {
  const requestId = typeof request.request_id === "string" ? request.request_id : "";

  switch (mode) {
    case "bad-request-id":
      return { ...buildSuccess(requestId), request_id: `${requestId}-mismatched` };

    case "bad-protocol":
      return { ...buildSuccess(requestId), protocol_version: 99 };

    case "success-false":
      return {
        type: RESPONSE_TYPE,
        request_id: requestId,
        success: false,
        error: "fake-server: injected success=false response",
      };

    default:
      return buildSuccess(requestId);
  }
}

/** Text frame that a JSON parser must reject. */
const NON_JSON_FRAME = "fake-server: this frame is intentionally not JSON";

/**
 * Start a fake engine server.
 *
 * @param {{
 *   port?: number,
 *   mode?: string,
 *   token?: string | null,
 *   host?: string,
 *   logReceived?: boolean,
 * }} [options]
 * @returns {Promise<{
 *   url: string,
 *   port: number,
 *   close: () => Promise<void>,
 *   received: string[],
 * }>}
 */
export function startFakeServer(options = {}) {
  const mode = normalizeMode(options.mode);
  const token = options.token ?? null;
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const logReceived = options.logReceived === true;

  /** Every frame the server received, in arrival order (for assertions). */
  const received = [];
  const sockets = new Set();

  let closePromise = null;

  const handleFrame = (socket, raw) => {
    received.push(raw);

    if (logReceived) {
      process.stderr.write(`[fake-server] received: ${raw}\n`);
    }

    if (mode === "no-response") return;

    if (mode === "non-json") {
      socket.send(NON_JSON_FRAME);
      return;
    }

    let request;

    try {
      request = JSON.parse(raw);
    } catch {
      // Malformed frames are recorded but never answered, like the engine's
      // own frame decoder: only a well-formed handshake gets a response.
      return;
    }

    if (request === null || typeof request !== "object" || request.type !== REQUEST_TYPE) {
      return;
    }

    socket.send(JSON.stringify(buildResponse(mode, request)));
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
      response.end("fake-server: WebSocket upgrade required\n");
    });

    const socketServer = new WebSocketServer({ noServer: true });

    // The token gate lives on the HTTP layer so a rejected client sees the same
    // `unexpected-response` 401 shape as the real engine (F-11). `res.writeHead`
    // is unavailable on an `upgrade` listener, so the status line is written on
    // the raw socket and the connection is closed.
    server.on("upgrade", (request, socket, head) => {
      if (!isAuthorized(request.headers.authorization, token)) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\n" +
            "Connection: close\r\n" +
            "Content-Length: 0\r\n" +
            "\r\n",
        );
        socket.end();
        return;
      }

      socketServer.handleUpgrade(request, socket, head, (webSocket) => {
        socketServer.emit("connection", webSocket, request);
      });
    });

    socketServer.on("connection", (webSocket) => {
      sockets.add(webSocket);

      webSocket.on("close", () => {
        sockets.delete(webSocket);
      });
      webSocket.on("error", () => {
        // A test may terminate mid-frame; the close handler still runs.
      });
      webSocket.on("message", (data) => {
        const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        handleFrame(webSocket, raw);
      });

      if (mode === "close-on-connect") {
        webSocket.close();
      }
    });

    server.once("error", reject);

    server.listen(requestedPort, host, () => {
      server.off("error", reject);

      const address = server.address();

      if (address === null || typeof address === "string") {
        reject(new Error("fake-server: expected the HTTP server to bind a TCP port"));
        return;
      }

      const port = address.port;

      const close = () => {
        if (closePromise !== null) return closePromise;

        closePromise = (async () => {
          for (const socket of sockets) {
            try {
              socket.terminate();
            } catch {
              // Already gone.
            }
          }
          sockets.clear();

          await new Promise((resolveClose) => {
            socketServer.close(() => resolveClose());
          });

          await new Promise((resolveClose) => {
            if (typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close(() => resolveClose());
          });
        })();

        return closePromise;
      };

      resolve({
        url: `ws://${host}:${port}/ws`,
        port,
        received,
        close,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Executable mode                                                     */
/* ------------------------------------------------------------------ */

function parsePort(value) {
  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(port) !== value.trim()) {
    throw new Error(`fake-server: invalid --port "${value}"`);
  }

  return port;
}

function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    mode: DEFAULT_MODE,
    token: null,
    host: DEFAULT_HOST,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inline = separator === -1 ? null : argument.slice(separator + 1);

    const takeValue = () => {
      if (inline !== null) return inline;
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`fake-server: missing value for ${flag}`);
      return value;
    };

    switch (flag) {
      case "--port":
        options.port = parsePort(takeValue());
        break;
      case "--mode":
        options.mode = normalizeMode(takeValue());
        break;
      case "--token": {
        const value = takeValue();
        if (value.length === 0) throw new Error("fake-server: --token must not be empty");
        options.token = value;
        break;
      }
      case "--host":
        options.host = takeValue();
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`fake-server: unknown argument "${argument}"`);
    }
  }

  return options;
}

const USAGE = [
  "usage: node fixtures/engine/fake-server.mjs [--port 0] [--mode <mode>] [--token <t>]",
  `modes: ${FAKE_SERVER_MODES.join(", ")}`,
  "",
].join("\n");

async function main() {
  let options;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[fake-server] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
    return;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const server = await startFakeServer({
    port: options.port,
    mode: options.mode,
    token: options.token,
    host: options.host,
    logReceived: true,
  });

  // Same two lines the real engine prints (F-6), in the same order.
  process.stdout.write(`Listening on ws://${options.host}:${server.port}\n`);
  process.stdout.write(`WebSocket: ws://${options.host}:${server.port}/ws\n`);

  let stopping = false;

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`[fake-server] ${signal} received, closing\n`);

    server.close().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(
          `[fake-server] close failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      },
    );
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    try {
      process.on(signal, () => shutdown(signal));
    } catch {
      // Windows does not deliver every signal; the CI harness kills the process.
    }
  }
}

/** True when this file is the process entry point (not imported). */
function isEntryPoint() {
  const entry = process.argv[1];

  if (typeof entry !== "string" || entry.length === 0) return false;

  const entryUrl = pathToFileURL(path.resolve(entry)).href;

  return entryUrl === import.meta.url || entryUrl.toLowerCase() === import.meta.url.toLowerCase();
}

if (isEntryPoint()) {
  main().catch((error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[fake-server] fatal: ${detail}\n`);
    process.exit(1);
  });
}
