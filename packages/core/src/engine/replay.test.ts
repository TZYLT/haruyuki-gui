/**
 * Tests for the s2c replay engine and the fake server's 8th mode.
 *
 * The contract covers the plan, options and handle shapes plus the wire fixture
 * line format. The cases assert that only s2c lines are emitted, in order, and
 * that the injected clock drives the timing. The replay engine is loaded through
 * dynamic `import()` of the fixture path, the same way `fake-server.test.ts`
 * loads its fixture, because `fixtures/` is outside the package's tsconfig.
 *
 * Every socket and server opened here is released in `afterEach`, so vitest
 * exits without dangling handles.
 */

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/* ------------------------------------------------------------------ */
/* ws client surface (no bundled declarations)                         */
/* ------------------------------------------------------------------ */

type ClientSocket = {
  on(event: string, listener: (...args: any[]) => void): ClientSocket;
  once(event: string, listener: (...args: any[]) => void): ClientSocket;
  send(data: string): void;
  close(): void;
  terminate(): void;
};

type WebSocketConstructor = new (url: string) => ClientSocket;

const requireFromHere = createRequire(import.meta.url);
const { WebSocket } = requireFromHere("ws") as { WebSocket: WebSocketConstructor };

/* ------------------------------------------------------------------ */
/* fixture module surface                                              */
/* ------------------------------------------------------------------ */

type Clock = { now(): number; sleep(ms: number): Promise<void> };

type FixtureLine = { dir: "c2s" | "s2c"; at: number; msg: Record<string, unknown> };
type WireFixture = { header: Record<string, unknown>; lines: FixtureLine[] };

type ReplayStep =
  | { kind: "frame"; delayMs: number; line: number; text: string }
  | { kind: "disconnect"; delayMs: number; line: number; resume: boolean };

type ReplayPlan = { speed?: "instant" | number; inject?: Record<string, unknown>[] };

type ReplayModule = {
  parseWireFixture(text: string): WireFixture;
  buildReplaySteps(fixture: WireFixture, plan?: ReplayPlan): ReplayStep[];
  createInstantClock(): Clock;
};

type FakeServerOptions = {
  port?: number;
  mode?: string;
  token?: string;
  host?: string;
  replay?: { fixture: WireFixture; plan?: ReplayPlan; clock?: Clock };
};

type FakeServer = {
  url: string;
  port: number;
  received: string[];
  emitted: string[];
  close(): Promise<void>;
};

type FakeServerModule = { startFakeServer(options?: FakeServerOptions): Promise<FakeServer> };

/** packages/core/src/engine -> repo root -> fixtures/engine/<fixture>.mjs */
function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/engine/${name}`, import.meta.url));
}

const REPLAY_PATH = fixturePath("replay.mjs");
const SERVER_PATH = fixturePath("fake-server.mjs");

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

async function loadReplay(): Promise<ReplayModule> {
  return (await import(pathToFileURL(REPLAY_PATH).href)) as ReplayModule;
}

async function loadReplayFixture(
  text: string,
): Promise<{ fixture: WireFixture; module: ReplayModule }> {
  const module = await loadReplay();

  return { fixture: module.parseWireFixture(text), module };
}

async function startServer(options: FakeServerOptions): Promise<FakeServer> {
  const module = (await import(pathToFileURL(SERVER_PATH).href)) as FakeServerModule;
  const server = await module.startFakeServer(options);

  servers.push(server);

  return server;
}

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const HEADER = {
  kind: "wire",
  schemaVersion: 1,
  engine: { version: "0.6.0", commit: "1641a4f" },
  scenario: "replay-test",
  redaction: "r1",
  clock: "virtual",
  recordedAt: "2024-01-01T00:00:00.000Z",
};

function fixtureText(lines: FixtureLine[]): string {
  return [JSON.stringify(HEADER), ...lines.map((line) => JSON.stringify(line))].join("\n") + "\n";
}

/** Four s2c frames around one c2s frame: 1 s2c, 2 c2s, 3/4/5 s2c. */
function standardLines(): FixtureLine[] {
  return [
    { dir: "s2c", at: 0, msg: { type: "app_server_info_response", success: true } },
    { dir: "c2s", at: 5, msg: { type: "input", request_id: "r-1" } },
    { dir: "s2c", at: 10, msg: { type: "stream_delta", i: 1 } },
    { dir: "s2c", at: 20, msg: { type: "stream_delta", i: 2 } },
    { dir: "s2c", at: 30, msg: { type: "turn_finished" } },
  ];
}

function expectedTexts(): string[] {
  return standardLines()
    .filter((line) => line.dir === "s2c")
    .map((line) => JSON.stringify(line.msg));
}

function frameTexts(steps: ReplayStep[]): string[] {
  return steps.flatMap((step) => (step.kind === "frame" ? [step.text] : []));
}

/* ------------------------------------------------------------------ */
/* client helpers                                                      */
/* ------------------------------------------------------------------ */

function openClient(url: string): {
  socket: ClientSocket;
  opened: Promise<void>;
  closed: Promise<number>;
} {
  const socket = new WebSocket(url);

  sockets.push(socket);

  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error: Error) => reject(error));
  });

  const closed = new Promise<number>((resolve) => {
    socket.once("close", (code: number) => resolve(code));
  });

  socket.on("error", () => {
    // An injected close emits this before close; the case asserts on `closed`.
  });

  return { socket, opened, closed };
}

function nextMessage(socket: ClientSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data: unknown) => {
      resolve(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    });
  });
}

function collectMessages(socket: ClientSocket): string[] {
  const messages: string[] = [];

  socket.on("message", (data: unknown) => {
    messages.push(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);

    await sleep(10);
  }
}

/* ------------------------------------------------------------------ */
/* replay: emission order and c2s silence                              */
/* ------------------------------------------------------------------ */

describe("replay emission", () => {
  it("emits only s2c lines, in order, and never answers an incoming c2s frame", async () => {
    const { fixture } = await loadReplayFixture(fixtureText(standardLines()));
    const server = await startServer({ mode: "replay", replay: { fixture } });
    const client = openClient(server.url);

    await client.opened;
    await waitFor(() => server.emitted.length === 4, "the four s2c frames");

    const expected = expectedTexts();

    expect(server.emitted).toEqual(expected);

    const frame = JSON.stringify({ type: "input", request_id: "r-2" });

    client.socket.send(frame);
    await waitFor(() => server.received.length === 1, "the c2s frame");

    expect(server.received).toEqual([frame]);
    expect(server.emitted).toEqual(expected);
  });

  it("a fixture with no s2c line emits nothing and leaves the socket open", async () => {
    const lines: FixtureLine[] = [{ dir: "c2s", at: 0, msg: { type: "input", request_id: "r-1" } }];
    const { fixture } = await loadReplayFixture(fixtureText(lines));
    const server = await startServer({ mode: "replay", replay: { fixture } });
    const client = openClient(server.url);

    await client.opened;

    const frame = sendHandshake(client.socket, "req-no-frames");

    await waitFor(() => server.received.length === 1, "the c2s frame");

    expect(server.received).toEqual([frame]);
    expect(server.emitted).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* replay: the four injections                                         */
/* ------------------------------------------------------------------ */

describe("replay injections", () => {
  it("reorder swaps the two 1-based line indexes", async () => {
    const { fixture, module } = await loadReplayFixture(fixtureText(standardLines()));
    const steps = module.buildReplaySteps(fixture, {
      inject: [{ kind: "reorder", lines: [3, 5] }],
    });
    const expected = expectedTexts();

    // Lines 3 and 5 are the second and the last s2c frame.
    expect(frameTexts(steps)).toEqual([expected[0], expected[3], expected[2], expected[1]]);
  });

  it("duplicate repeats a line times more times right after it", async () => {
    const { fixture, module } = await loadReplayFixture(fixtureText(standardLines()));
    const steps = module.buildReplaySteps(fixture, {
      inject: [{ kind: "duplicate", line: 3, times: 2 }],
    });
    const expected = expectedTexts();

    expect(frameTexts(steps)).toEqual([
      expected[0],
      expected[1],
      expected[1],
      expected[1],
      expected[2],
      expected[3],
    ]);
  });

  it("coalesce emits the listed lines back to back with no wait", async () => {
    const { fixture, module } = await loadReplayFixture(fixtureText(standardLines()));

    const spaced = module.buildReplaySteps(fixture, { speed: 10 });
    const coalesced = module.buildReplaySteps(fixture, {
      speed: 10,
      inject: [{ kind: "coalesce", lines: [3, 4] }],
    });

    expect(spaced.map((step) => step.delayMs)).toEqual([0, 100, 100, 100]);
    expect(coalesced.map((step) => step.delayMs)).toEqual([0, 100, 0, 100]);
    expect(frameTexts(coalesced)).toEqual(expectedTexts());
  });

  it("disconnect with resume false stops the sequence after the line", async () => {
    const { fixture, module } = await loadReplayFixture(fixtureText(standardLines()));
    const steps = module.buildReplaySteps(fixture, {
      inject: [{ kind: "disconnect", atLine: 3, resume: false }],
    });
    const expected = expectedTexts();

    expect(steps.map((step) => step.kind)).toEqual(["frame", "frame", "disconnect"]);
    expect(frameTexts(steps)).toEqual([expected[0], expected[1]]);
  });

  it("disconnect with resume true reconnects and finishes the sequence", async () => {
    const { fixture } = await loadReplayFixture(fixtureText(standardLines()));
    const plan: ReplayPlan = { inject: [{ kind: "disconnect", atLine: 3, resume: true }] };
    const server = await startServer({ mode: "replay", replay: { fixture, plan } });
    const first = openClient(server.url);

    await first.opened;
    await waitFor(() => server.emitted.length === 2, "the frames before the disconnect");
    await first.closed;

    const second = openClient(server.url);
    const tail = collectMessages(second.socket);

    await second.opened;
    await waitFor(() => server.emitted.length === 4, "the frames after the reconnect");
    await waitFor(() => tail.length === 2, "the tail frames");

    expect(server.emitted).toEqual(expectedTexts());
    expect(tail).toEqual(expectedTexts().slice(2));
  });

  it("two identical runs produce identical emitted arrays", async () => {
    const { fixture } = await loadReplayFixture(fixtureText(standardLines()));
    const plan: ReplayPlan = {
      speed: 1,
      inject: [
        { kind: "duplicate", line: 4, times: 1 },
        { kind: "reorder", lines: [3, 5] },
      ],
    };

    const runOnce = async (): Promise<string[]> => {
      const server = await startServer({ mode: "replay", replay: { fixture, plan } });
      const client = openClient(server.url);

      await client.opened;
      await waitFor(() => server.emitted.length === 5, "the replayed sequence");

      return [...server.emitted];
    };

    const first = await runOnce();
    const second = await runOnce();

    expect(second).toEqual(first);
    expect(first).toHaveLength(5);
  });

  it("waits on the injected clock, scaled from the line at deltas", async () => {
    const { fixture } = await loadReplayFixture(fixtureText(standardLines()));
    const waits: number[] = [];
    const clock: Clock = {
      now: () => 0,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    };
    const server = await startServer({
      mode: "replay",
      replay: { fixture, plan: { speed: 2 }, clock },
    });
    const client = openClient(server.url);

    await client.opened;
    await waitFor(() => server.emitted.length === 4, "the four s2c frames");

    expect(waits).toEqual([20, 20, 20]);
  });
});

/* ------------------------------------------------------------------ */
/* fixture parsing                                                     */
/* ------------------------------------------------------------------ */

describe("parseWireFixture", () => {
  it("rejects a bad header and names the 1-based line", async () => {
    const module = await loadReplay();

    expect(() =>
      module.parseWireFixture(JSON.stringify({ kind: "frames", schemaVersion: 1 })),
    ).toThrow(/fixture line 1: header "kind" must be "wire"/);
    expect(() =>
      module.parseWireFixture(JSON.stringify({ kind: "wire", schemaVersion: 2 })),
    ).toThrow(/fixture line 1: header "schemaVersion" must be 1/);
  });

  it("rejects a bad message line and names the 1-based line", async () => {
    const module = await loadReplay();

    const missingAt = [
      JSON.stringify(HEADER),
      JSON.stringify({ dir: "s2c", msg: { type: "x" } }),
    ].join("\n");

    expect(() => module.parseWireFixture(missingAt)).toThrow(/fixture line 2: "at" must be/);

    const brokenJson = [
      JSON.stringify(HEADER),
      JSON.stringify(standardLines()[0]),
      "{not json",
    ].join("\n");

    expect(() => module.parseWireFixture(brokenJson)).toThrow(
      /fixture line 3: message line is not valid JSON/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* old modes regression smoke                                          */
/* ------------------------------------------------------------------ */

describe("fake server old modes", () => {
  it("ok mode still answers the handshake and reports no emissions", async () => {
    const server = await startServer({ mode: "ok" });
    const client = openClient(server.url);

    await client.opened;

    const frame = sendHandshake(client.socket, "req-smoke-1");
    const response = JSON.parse(await nextMessage(client.socket)) as Record<string, unknown>;

    expect(response.type).toBe("app_server_info_response");
    expect(response.request_id).toBe("req-smoke-1");
    expect(response.success).toBe(true);
    expect(server.received).toEqual([frame]);
    expect(server.emitted).toEqual([]);
  });
});
