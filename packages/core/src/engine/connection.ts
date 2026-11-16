/**
 * Engine WebSocket connection: attach the capability token and classify a failed
 * upgrade.
 *
 * Scope source: no recursive-B1 sections 2.2 (F-10..F-12), 3.1 (module split), 3.3 (c)
 * and (f) (error taxonomy), 4.2  and section 8 invariant 1 (the token never
 * enters argv; it travels only in the Authorization header here).
 *
 * The engine listens on a system-assigned port and authenticates the upgrade
 * request by comparing the SHA-256 of `Bearer <token>` with the token file using
 * `timingSafeEqual` (F-10). Two measured failure shapes matter (F-11, F-12):
 *
 * - a bad or missing token ends in an `unexpected-response` event with HTTP 401
 *   (403 is treated the same way), not in `close`;
 * - a port with no listener ends in `error` with `code === "ECONNREFUSED"`.
 *
 * Both are translated here into `EngineConnectionError`, which carries the frozen
 * `EngineErrorCode` so the facade (`engine.ts`) can map it without re-classifying.
 * Origin header is sent: the engine's auth check looks at Authorization only, and
 * an Origin would make the request look like a browser cross-origin upgrade.
 *
 * `ws` ships no type declarations and `@types/ws` is not installed; adding it
 * would mean editing `packages/core/package.json`, which is outside this
 * package's file ownership. This module therefore declares the exact client
 * surface it uses and loads the implementation through `createRequire`, keeping
 * the runtime dependency `ws@8` as pinned while making the compile-time boundary
 * explicit. `EngineSocket` is the socket type the facade consumes.
 */

import { createRequire } from "node:module";

import type { EngineError, EngineErrorCode } from "./types";

/** Default budget for the WebSocket upgrade. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Numeric `OPEN` readyState of a ws socket (CONNECTING=0, OPEN=1, ...). */
const SOCKET_OPEN = 1;

/** Upgrade request object handed to the `unexpected-response` listener. */
export type EngineUpgradeRequest = {
  destroy(): void;
};

/**
 * Rejected upgrade response handed to the `unexpected-response` listener.
 *
 * `statusCode` is absent when the server closed the connection before a status
 * line was parsed, so it is typed as possibly undefined.
 */
export type EngineUpgradeResponse = {
  readonly statusCode?: number | undefined;
  destroy(): void;
};

/**
 * Events this module (and the facade) need from a ws client socket.
 *
 * The payload shapes mirror ws 8: text frames arrive as a `Buffer` plus an
 * `isBinary` flag, and a rejected upgrade arrives as (request, response).
 */
export type EngineSocketEventMap = {
  open: [];
  message: [data: Buffer, isBinary: boolean];
  close: [code: number, reason: Buffer];
  error: [error: Error];
  "unexpected-response": [request: EngineUpgradeRequest, response: EngineUpgradeResponse];
};

/**
 * The ws client surface used by the engine transport.
 *
 * Structural on purpose: tests and the facade can hold one without importing ws
 * types, and the implementation is injected at half-open time above.
 */
export interface EngineSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on<E extends keyof EngineSocketEventMap>(
    event: E,
    listener: (...args: EngineSocketEventMap[E]) => void,
  ): EngineSocket;
  once<E extends keyof EngineSocketEventMap>(
    event: E,
    listener: (...args: EngineSocketEventMap[E]) => void,
  ): EngineSocket;
  removeListener<E extends keyof EngineSocketEventMap>(
    event: E,
    listener: (...args: EngineSocketEventMap[E]) => void,
  ): EngineSocket;
}

/** Options accepted by the ws client constructor for this transport. */
type EngineSocketOptions = {
  headers: Record<string, string>;
  handshakeTimeout: number;
};

type EngineSocketConstructor = new (url: string, options: EngineSocketOptions) => EngineSocket;

/** Load the ws client, which has no bundled declarations (see the file comment). */
function loadWsConstructor(): EngineSocketConstructor {
  const requireFromHere = createRequire(import.meta.url);
  const wsModule = requireFromHere("ws") as { WebSocket?: EngineSocketConstructor };
  const WebSocket = wsModule.WebSocket;

  if (typeof WebSocket !== "function") {
    throw new Error('the "ws" package did not expose a WebSocket constructor');
  }

  return WebSocket;
}

/** Resolved once: ws is a hard runtime dependency and must be present at load. */
const WsWebSocket = loadWsConstructor();

/**
 * Options for {@link connectEngine}.
 *
 * `timeoutMs` bounds the whole upgrade (TCP connect plus HTTP handshake) and is
 * forwarded to ws as `handshakeTimeout`; it defaults to 10 s, matching the
 * facade's start budget.
 */
export type ConnectEngineOptions = {
  timeoutMs?: number;
  /**
   * Runs on the open socket inside the `open` handler, before the promise settles.
   *
   * The window this closes: a server that writes its first frames in
   * the same tick it accepts writes them before the caller's `await` can resume,
   * so a listener attached after the promise resolves misses them (measured: 0 of
   * 4 frames). A caller that needs those frames arms a capture here.
   *
   * Optional and unused by default, so every existing path behaves identically.
   * Only one hook is expected; a second caller would silently replace it, which is
   * why this is not exported from the package's public surface.
   */
  readonly onOpen?: (socket: EngineSocket) => void;
};

/**
 * One classified connection failure.
 *
 * `code` is the frozen taxonomy value, `detail` is for humans and logs only, and
 * `wireHint` carries the raw, engine-supplied fragment that drove the
 * classification (`ECONNREFUSED`, `HTTP 401`, ...) when there is one.
 *
 * The facade (`engine.ts`) catches this class and forwards `toEngineError()`
 * so no second classification pass and no translation table are needed.
 */
export class EngineConnectionError extends Error {
  /** Frozen classification; also the value the facade exposes as `EngineError.code`. */
  readonly code: EngineErrorCode;

  /** Human-readable diagnosis. Never used for branching. */
  readonly detail: string;

  /** Raw wire hint behind the classification, when available. */
  readonly wireHint?: string;

  constructor(code: EngineErrorCode, detail: string, wireHint?: string) {
    super(detail);
    this.name = "EngineConnectionError";
    this.code = code;
    this.detail = detail;
    if (wireHint !== undefined) {
      this.wireHint = wireHint;
    }
  }

  /**
   * Render the frozen `EngineError` shape.
   *
   * `wireHint` is only present when there is a hint, so the result satisfies the
   * exact-optional-property contract in `types.ts`.
   */
  toEngineError(): EngineError {
    if (this.wireHint === undefined) {
      return { code: this.code, detail: this.detail };
    }

    return { code: this.code, detail: this.detail, wireHint: this.wireHint };
  }
}

/**
 * Open an authenticated WebSocket to the engine.
 *
 * Resolves only when the socket is OPEN. On every failure the attempt-scoped
 * listeners are removed and the upgrade request is torn down, so a rejected
 * attempt cannot keep a handle open. Classification follows no recursive-B1 section
 * 3.3 (f):
 *
 * - HTTP 401/403 on the upgrade -> `AUTH_FAILED` (detail carries the status);
 * - `error` with `ECONNREFUSED` -> `PORT_NOT_FOUND`;
 * - anything else (other error, handshake timeout, early close, rejected
 *   non-auth status) -> `TIMEOUT`, with the raw code in `wireHint`.
 *
 * @param url engine WebSocket endpoint, e.g. `ws://127.0.0.1:6387/ws` (F-6)
 * @param token capability token; sent as `Authorization: Bearer <token>`
 * @param options upgrade budget, 10 s by default
 */
export function connectEngine(
  url: string,
  token: string,
  options: ConnectEngineOptions = {},
): Promise<EngineSocket> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  return new Promise<EngineSocket>((resolve, reject) => {
    let socket: EngineSocket;

    try {
      socket = new WsWebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: timeoutMs,
      });
    } catch (error) {
      // A malformed URL throws synchronously from the ws constructor.
      reject(
        new EngineConnectionError(
          "TIMEOUT",
          `could not create a WebSocket for ${url}: ${messageOf(error)}`,
          wireCodeOf(error),
        ),
      );
      return;
    }

    // Baseline error sink. ws emits `error` for faults that can arrive after this
    // attempt settled (for example the next-tick error of an aborted handshake),
    // and an EventEmitter `error` with no listener would crash the host. Every
    // listener still runs, so the facade observes the same events; only one sink
    // is installed per socket, so attempts do not accumulate listeners.
    socket.on("error", ignoreSocketError);

    let settled = false;

    const detach = (): void => {
      socket.removeListener("open", onOpen);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("unexpected-response", onUnexpectedResponse);
    };

    const fail = (error: EngineConnectionError): void => {
      if (settled) {
        return;
      }

      settled = true;
      detach();
      reject(error);
    };

    function onOpen(): void {
      if (settled) {
        return;
      }

      if (socket.readyState !== SOCKET_OPEN) {
        fail(
          new EngineConnectionError(
            "TIMEOUT",
            `WebSocket to ${url} reported open while in state ${socket.readyState}.`,
            `readyState ${socket.readyState}`,
          ),
        );
        socket.terminate();
        return;
      }

      settled = true;

      // Arm the caller's capture BEFORE detaching and resolving: this is the only
      // point where a listener can exist while the server is still in the tick
      // that may have written the first frames.
      options.onOpen?.(socket);

      detach();
      resolve(socket);
    }

    function onUnexpectedResponse(
      request: EngineUpgradeRequest,
      response: EngineUpgradeResponse,
    ): void {
      const status = response.statusCode;

      if (status === 401 || status === 403) {
        fail(
          new EngineConnectionError(
            "AUTH_FAILED",
            `engine rejected the WebSocket upgrade with HTTP ${status}.`,
            `HTTP ${status}`,
          ),
        );
      } else {
        const label = typeof status === "number" ? String(status) : "unknown";
        fail(
          new EngineConnectionError(
            "TIMEOUT",
            `engine rejected the WebSocket upgrade with HTTP ${label}.`,
            `HTTP ${label}`,
          ),
        );
      }

      // ws only suppresses its own abort when an `unexpected-response` listener
      // exists, so this listener owns the teardown. Destroying the request also
      // destroys its socket; the response is destroyed for servers that kept a
      // body open.
      destroyQuietly(request);
      destroyQuietly(response);
    }

    function onError(error: Error): void {
      const wireCode = wireCodeOf(error);

      if (wireCode === "ECONNREFUSED") {
        fail(
          new EngineConnectionError(
            "PORT_NOT_FOUND",
            `no engine is listening at ${url} (ECONNREFUSED).`,
            wireCode,
          ),
        );
        return;
      }

      fail(
        new EngineConnectionError(
          "TIMEOUT",
          `WebSocket upgrade to ${url} failed: ${messageOf(error)}`,
          wireCode ?? `readyState ${socket.readyState}`,
        ),
      );
    }

    function onClose(code: number): void {
      fail(
        new EngineConnectionError(
          "TIMEOUT",
          `socket closed before the WebSocket upgrade to ${url} completed (code ${code}).`,
          `close ${code}`,
        ),
      );
    }

    socket.on("open", onOpen);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("unexpected-response", onUnexpectedResponse);
  });
}

/** Baseline `error` sink; see the comment in {@link connectEngine}. */
function ignoreSocketError(): void {
  // Deliberately empty: the classification path has its own error listener.
}

/** Teardown helper that tolerates an already-destroyed stream. */
function destroyQuietly(stream: { destroy(): void }): void {
  try {
    stream.destroy();
  } catch {
    // Already destroyed or never opened; nothing left to release.
  }
}

/** Extract a Node error code (`ECONNREFUSED`, `ETIMEDOUT`, ...) without trusting the value. */
function wireCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/** Readable message for a thrown value of unknown shape. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

/**
 * Normalize the upgrade budget: absent or non-finite falls back to the default,
 * and a fractional/zero value becomes at least 1 ms because ws treats 0 as "no
 * handshake timeout".
 */
function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_CONNECT_TIMEOUT_MS;
  }

  return Number.isFinite(timeoutMs)
    ? Math.max(1, Math.trunc(timeoutMs))
    : DEFAULT_CONNECT_TIMEOUT_MS;
}
