/**
 * replay-client.ts - drive a wire fixture through the fake engine server.
 *
 * Scope: the replay data flow - `loadFixture` ->
 * `startFakeServer({ mode: "replay" })` -> client), section 3.4.3 (the frozen
 * fake-server handle shapes declared below.
 *
 * When is a replay finished? The fake server has no completion event: it stays
 * open after the last step, `turn_finished` is ordinary payload that a fixture
 * may carry zero or several times, and a `Clock` only shapes waits - it has no
 * "exhausted" state. The one honest signal is the plan itself:
 * `buildReplaySteps(fixture, plan)` deterministically lists every s2c emission,
 * so this client is done when that many frames have arrived. A planned
 * `disconnect` with `resume: true` is followed by a reconnect; any other socket
 * close ends the run where it stands, because no further frame can reach this
 * client (a caller who breaks the socket is doing exactly that on purpose). A
 * wall-clock budget (1000 ms by default) turns a budget overrun into a named
 * failure instead of a hang.
 *
 * Why this module opens the socket itself instead of calling `connectEngine`:
 * the replay server pushes its first frame in the same tick it accepts the
 * WebSocket, while `connectEngine` resolves on `open` and ws emits that first
 * batch in the same nextTick queue - before any promise continuation can attach
 * a `message` listener. Measured against this server, every frame of an
 * instant-clock replay is gone by the time `connectEngine` resolves (0 of 4),
 * deterministically. A pre-open listener is therefore required; the constructor
 * and the `Authorization` header below are the same ones `connection.ts` uses,
 * so this stays one socket shape, not a second protocol client. This is reported
 * as a finding, not hidden: the alternative is a change in `fixtures/engine`.
 *
 * Whatever happens, the socket and the server are closed on every exit path, so
 * a failed case cannot leak a listener into the next one.
 */

import { createRequire } from "node:module";

import type { EngineSocket } from "../engine/connection";

import type { Clock, ReplayPlan, ReplayStep, WireFixture } from "./fixture";
import { loadReplayModule } from "./fixture";

/** Token used when the caller does not inject one. */
const DEFAULT_TOKEN = "replay-through-token";

/** Upgrade budget for the first and every reconnect (milliseconds). */
const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;

/** Budget for the whole replay (milliseconds); see the file comment. */
const DEFAULT_FINISH_TIMEOUT_MS = 1_000;

/** `ws` ships no declarations, so the constructor surface is declared here. */
type EngineSocketConstructor = new (
  url: string,
  options: { headers: Record<string, string>; handshakeTimeout: number },
) => EngineSocket;

const requireFromHere = createRequire(import.meta.url);

/** Load the ws client constructor, matching how `connection.ts` resolves it. */
function loadSocketConstructor(): EngineSocketConstructor {
  const module = requireFromHere("ws") as { WebSocket?: EngineSocketConstructor };
  const WebSocket = module.WebSocket;

  if (typeof WebSocket !== "function") {
    throw new Error('the "ws" package did not expose a WebSocket constructor');
  }

  return WebSocket;
}

const WsWebSocket = loadSocketConstructor();

/** Options of the fake server's replay mode. */
type FakeServerOptions = {
  port?: number;
  host?: string;
  token?: string | null;
  logReceived?: boolean;
  mode: "replay";
  replay: { fixture: WireFixture; plan?: ReplayPlan; clock?: Clock };
};

/** The handle `startFakeServer` resolves with. */
export type FakeServerHandle = {
  /** Endpoint the client connects to, e.g. `ws://127.0.0.1:6387/ws`. */
  url: string;
  /** Bound TCP port. */
  port: number;
  /** Raw c2s frames the server received, in arrival order. */
  received: string[];
  /** Raw s2c frames replay emitted, in emission order. */
  emitted: string[];
  /** Close the server; idempotent, later calls return the same promise. */
  close(): Promise<void>;
};

/** The surface of `fixtures/engine/fake-server.mjs` this module uses. */
type FakeServerModule = {
  startFakeServer(options: FakeServerOptions): Promise<FakeServerHandle>;
};

/** `packages/core/src/testing` -> repo root -> `fixtures/engine/fake-server.mjs`. */
const FAKE_SERVER_URL = new URL("../../../../fixtures/engine/fake-server.mjs", import.meta.url);

let fakeServerModule: Promise<FakeServerModule> | undefined;

/** Load the fake server module once; a failed import is not cached. */
function loadFakeServerModule(): Promise<FakeServerModule> {
  fakeServerModule ??= import(FAKE_SERVER_URL.href)
    .then((module) => module as FakeServerModule)
    .catch((error: unknown) => {
      fakeServerModule = undefined;
      throw error;
    });

  return fakeServerModule;
}

/** One s2c frame as the client received it: raw text plus the parsed JSON. */
export type ReplayFrame = {
  /** Text exactly as it arrived on the socket. */
  text: string;
  /** `JSON.parse(text)`; every fixture message is a JSON object. */
  json: unknown;
};

/** Options of {@link replayThrough}. */
export type ReplayThroughOptions = {
  /** Parsed wire fixture, usually from `loadFixture` / `loadFixtureText`. */
  fixture: WireFixture;
  /** Plan to run; the default plan emits every s2c line instantly. */
  plan?: ReplayPlan;
  /** Injected clock; defaults to the replay module's instant clock. */
  clock?: Clock;
  /** Token shared with the fake server; a fixed test value by default. */
  token?: string;
  /** Budget for the first connection and every reconnect (milliseconds). */
  connectTimeoutMs?: number;
  /** Budget for the whole replay (milliseconds). */
  finishTimeoutMs?: number;
  /**
   * Called after each frame is collected, with the live socket, so a case can
   * inject a client-side break. A thrown error fails the run (and still cleans
   * up).
   */
  onFrame?: (frame: ReplayFrame, socket: EngineSocket) => void;
};

/** What a finished replay leaves behind. */
export type ReplayThroughResult = {
  /** Server handle; already closed, with `emitted`/`received` intact. */
  server: FakeServerHandle;
  /** Every s2c frame the client received, in arrival order. */
  frames: ReplayFrame[];
  /** Raw text of every received frame, parallel to `frames`. */
  received: string[];
};

/**
 * Replay a fixture through the fake server and a client socket.
 *
 * Starts the server in `replay` mode, connects with a pre-open `message`
 * listener (see the file comment), collects every s2c frame as raw text plus
 * parsed JSON, stops when the plan's emission count has arrived, and closes the
 * socket and the server before resolving or rejecting.
 *
 * @param options Fixture, optional plan/clock, and the budgets.
 */
export async function replayThrough(options: ReplayThroughOptions): Promise<ReplayThroughResult> {
  const module = await loadReplayModule();
  const plan = options.plan ?? {};
  const steps = module.buildReplaySteps(options.fixture, plan);
  const expectedFrames = countFrames(steps);
  const resumeAfter = resumePoints(steps);
  const clock = options.clock ?? module.createInstantClock();
  const token = options.token ?? DEFAULT_TOKEN;
  const fakeServer = await loadFakeServerModule();
  const server = await fakeServer.startFakeServer({
    mode: "replay",
    token,
    replay: { fixture: options.fixture, plan, clock },
  });

  try {
    return await collect(server, {
      options,
      expectedFrames,
      resumeAfter,
      token,
    });
  } finally {
    await server.close();
  }
}

/** Everything {@link collect} needs after the plan has been resolved. */
type CollectContext = {
  options: ReplayThroughOptions;
  expectedFrames: number;
  resumeAfter: ReadonlySet<number>;
  token: string;
};

/**
 * Connect, collect, and return the result; the caller owns the server shutdown.
 *
 * The `finally` here releases the client socket, so a connection failure, a
 * non-JSON frame, a callback error, a budget overrun and a client-side break all
 * leave no socket behind.
 */
async function collect(
  server: FakeServerHandle,
  context: CollectContext,
): Promise<ReplayThroughResult> {
  const { options, expectedFrames, resumeAfter, token } = context;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const finishTimeoutMs = options.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS;
  const frames: ReplayFrame[] = [];
  const received: string[] = [];
  let socket: EngineSocket | null = null;
  let settled = false;

  let settle!: (error?: Error) => void;

  const done = new Promise<Error | undefined>((resolve) => {
    settle = resolve;
  });

  /** Resolve the run once; later calls (a late close, a doubled error) are no-ops. */
  const finish = (error?: Error): void => {
    if (settled) {
      return;
    }

    settled = true;
    settle(error);
  };

  /** One received text frame, shared by the first socket and every reconnect. */
  const receive = (text: string, current: EngineSocket): void => {
    if (settled) {
      return;
    }

    let json: unknown;

    try {
      json = JSON.parse(text);
    } catch (error) {
      finish(
        new Error(`replayThrough: received a non-JSON s2c frame "${text}": ${detailOf(error)}`),
      );
      return;
    }

    const frame: ReplayFrame = { text, json };

    frames.push(frame);
    received.push(text);

    if (options.onFrame !== undefined) {
      try {
        options.onFrame(frame, current);
      } catch (error) {
        finish(toError(error));
        return;
      }
    }

    if (frames.length >= expectedFrames) {
      finish();
    }
  };

  /** Decide what a closed socket means: a planned resume, or the end. */
  const closed = (): void => {
    if (settled) {
      return;
    }

    if (frames.length >= expectedFrames) {
      finish();
      return;
    }

    // A close is only followed by a reconnect where the plan says so; any other
    // close means no further frame can reach this client.
    if (resumeAfter.has(frames.length)) {
      void reconnect();
      return;
    }

    finish();
  };

  /** Reopen the socket after a planned disconnect with `resume: true`. */
  async function reconnect(): Promise<void> {
    try {
      const next = await openSocket(server.url, token, connectTimeoutMs, {
        onText: (text, from) => receive(text, from),
        onClose: closed,
      });

      socket = next;

      if (settled) {
        releaseSocket(next);
      }
    } catch (error) {
      finish(toError(error));
    }
  }

  const timer = setTimeout(() => {
    finish(
      new Error(
        `replayThrough: the replay did not finish within ${finishTimeoutMs}ms ` +
          `(${frames.length} of ${expectedFrames} s2c frames received)`,
      ),
    );
  }, finishTimeoutMs);
  timer.unref();

  try {
    const first = await openSocket(server.url, token, connectTimeoutMs, {
      onText: (text, from) => receive(text, from),
      onClose: closed,
    });

    socket = first;

    // A plan with no s2c step has nothing to wait for once the socket is open.
    if (frames.length >= expectedFrames) {
      finish();
    }

    const error = await done;

    if (error !== undefined) {
      throw error;
    }

    return { server, frames, received };
  } finally {
    clearTimeout(timer);
    releaseSocket(socket);
  }
}

/** Callbacks a socket feeds while it is attached. */
type SocketHandlers = {
  /** One text frame, with the socket it arrived on. */
  onText: (text: string, socket: EngineSocket) => void;
  /** The socket closed after it had opened. */
  onClose: () => void;
};

/**
 * Open one authenticated WebSocket with the listeners already attached.
 *
 * The listener order is the whole point: `message` is registered synchronously
 * after construction, before `open`, so the server's first push batch is not
 * dropped (see the file comment). This is the same client `connectEngine` uses,
 * with the same header, minus the failure taxonomy this harness does not need.
 */
function openSocket(
  url: string,
  token: string,
  timeoutMs: number,
  handlers: SocketHandlers,
): Promise<EngineSocket> {
  return new Promise<EngineSocket>((resolve, reject) => {
    let socket: EngineSocket;

    try {
      socket = new WsWebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: timeoutMs,
      });
    } catch (error) {
      reject(toError(error));
      return;
    }

    let opened = false;

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        return;
      }

      handlers.onText(data.toString("utf8"), socket);
    });
    socket.on("close", () => {
      if (!opened) {
        reject(new Error(`replayThrough: the socket to ${url} closed before it opened`));
        return;
      }

      handlers.onClose();
    });
    socket.on("error", (error: Error) => {
      if (!opened) {
        reject(error);
      }
    });
    socket.on("open", () => {
      opened = true;
      resolve(socket);
    });
  });
}

/** Count the frame steps of a plan, i.e. the s2c emissions it will produce. */
function countFrames(steps: ReplayStep[]): number {
  let count = 0;

  for (const step of steps) {
    if (step.kind === "frame") {
      count += 1;
    }
  }

  return count;
}

/**
 * Frame counts after which the plan drops the socket and resumes.
 *
 * `buildReplaySteps` places a `disconnect` step directly after the emission it
 * follows, so the number of frames seen so far identifies it.
 */
function resumePoints(steps: ReplayStep[]): ReadonlySet<number> {
  const points = new Set<number>();
  let frames = 0;

  for (const step of steps) {
    if (step.kind === "frame") {
      frames += 1;
      continue;
    }

    if (step.resume) {
      points.add(frames);
    }
  }

  return points;
}

/** Terminate a client socket, tolerating one that is already gone. */
function releaseSocket(target: EngineSocket | null): void {
  if (target === null) {
    return;
  }

  try {
    target.terminate();
  } catch {
    // Already closed or never opened.
  }
}

/** Normalize a thrown value to an Error without losing a non-Error payload. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Readable message for a thrown value of unknown shape. */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
