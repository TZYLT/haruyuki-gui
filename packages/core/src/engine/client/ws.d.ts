/**
 * Minimal typings for `ws`, limited to what this package's tests use.
 *
 * ## Why this file exists
 *
 * `packages/core` depends on `ws` (its runtime transport needs it), but the
 * project does not install `@types/ws` - the dependency graph is deliberate about
 * what it pulls in, and adding `@types/ws` for two test files would put a dev
 * dependency in front of a runtime one.
 *
 * ## Why it is narrow on purpose
 *
 * Declaring `declare module "ws"` with `any` would let every misuse compile. This
 * file names exactly the three members the early-frame tests need:
 *
 * - `WebSocketServer` receiving an existing HTTP server and calling back on
 *   `connection`, so a test can write frames in the accept callback - which is the
 *   whole point of the early-frame reproduction.
 * - `client.send(text)` to write those frames.
 * - `wss.clients` / `client.terminate()` for teardown that cannot hang.
 *
 * Anything else would be a surface this package has not reviewed, so it is
 * omitted rather than typed loosely.
 */
declare module "ws" {
  import type { IncomingMessage, Server } from "node:http";

  /** A server-side connection, as much of it as the tests touch. */
  export interface WebSocket {
    /** Text frames are sent as strings; binary is out of scope. */
    send(data: string): void;
    /** Drop the connection without a closing handshake (teardown). */
    terminate(): void;
    /** The HTTP request that opened this connection. */
    readonly req?: IncomingMessage;
  }

  /** Options this package passes to the server. */
  export interface ServerOptions {
    /** Adopt an existing HTTP server instead of listening on its own port. */
    server?: Server;
    /** Accept only this sub-protocol, when set. */
    path?: string;
  }

  /**
   * A WebSocket server.
   *
   * `on("connection", ...)` is the only event used: it fires in the tick the
   * upgrade completes, which is what lets a test write frames before the client's
   * promise resumes.
   */
  export class WebSocketServer {
    constructor(options: ServerOptions, callback?: () => void);
    on(event: "connection", listener: (client: WebSocket, request: IncomingMessage) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    /** Live connections; `terminate()` on each for teardown. */
    readonly clients: Set<WebSocket>;
    /** Stop accepting; the callback runs once every client is gone. */
    close(callback?: () => void): void;
  }
}
