/**
 * The core child lifecycle, driven through an injected transport.
 *
 * Nothing here forks: the point is the message order and the exit conditions, and
 * a fake transport makes those observable without a second process. The child's
 * real `process.send`/`process.on` wiring is covered by the host test, which
 * forks a real child.
 */

import { describe, expect, it, vi } from "vitest";

import { runCoreMain, type CoreEngine, type CoreRunner, type CoreTransport } from "../main.js";
import type { CoreStatusSnapshot, CoreToHost } from "../ipc.js";

/** A transport that records what the core sends and lets a test push messages. */
class FakeTransport implements CoreTransport {
  readonly sent: CoreToHost[] = [];

  exitCode: number | null = null;

  /** Set once the core called `exit`, so a test can await it. */
  readonly exited: Promise<number>;

  private settleExit: (code: number) => void = () => {};

  private messageListener: (message: unknown) => void = () => {};

  private disconnectListener: () => void = () => {};

  constructor(
    private readonly options: {
      readonly parentPid?: number;
      readonly parentAlive?: (pid: number) => boolean;
    } = {},
  ) {
    this.exited = new Promise<number>((resolve) => {
      this.settleExit = resolve;
    });
  }

  send(message: CoreToHost): void {
    this.sent.push(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListener = listener;

    return () => {
      this.messageListener = () => {};
    };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListener = listener;

    return () => {
      this.disconnectListener = () => {};
    };
  }

  ppid(): number {
    return this.options.parentPid ?? 4242;
  }

  parentAlive(pid: number): boolean {
    return this.options.parentAlive?.(pid) ?? true;
  }

  exit(code: number): void {
    this.exitCode = code;
    this.settleExit(code);
  }

  /** Deliver one inbound message, exactly as the fork channel would. */
  deliver(message: unknown): void {
    this.messageListener(message);
  }

  /** Simulate the host dying. */
  disconnect(): void {
    this.disconnectListener();
  }

  /** @returns every message of one kind, in order */
  ofKind<K extends CoreToHost["kind"]>(kind: K): Extract<CoreToHost, { kind: K }>[] {
    return this.sent.filter((message): message is Extract<CoreToHost, { kind: K }> => {
      return message.kind === kind;
    });
  }

  /** @returns the phases reported, in order */
  phases(): (CoreStatusSnapshot["phase"] | "unknown")[] {
    return this.ofKind("status").map((status) => status.phase);
  }
}

const INIT = {
  kind: "init",
  paths: { userData: "/u", logs: "/l", cache: "/c", temp: "/t" },
  cwd: "/work",
  locale: "en",
  engine: { kind: "bundled", dir: "/engine", bundlePath: "/engine/haruyuki.js" },
  expectedVersion: "1.0.0",
} as const;

/** A stand-in engine that records its own stop. */
function fakeEngine(stopped: { count: number }): CoreEngine {
  return {
    async stop(): Promise<void> {
      stopped.count += 1;
    },
  };
}

/**
 * Start the loop and wait until it either exited or sent the given message.
 *
 * @param transport the fake child boundary
 * @param options the injected seams
 * @param until a kind to wait for; omitted means "wait for the exit"
 * @returns the runner
 */
async function started(
  transport: FakeTransport,
  options: Parameters<typeof runCoreMain>[0],
  until?: CoreToHost["kind"],
): Promise<CoreRunner> {
  const runner = runCoreMain({ ...options, transport });

  transport.deliver(INIT);

  await waitFor(() =>
    until === undefined ? transport.exitCode !== null : hasKind(transport, until),
  );

  return runner;
}

/** @returns whether the transport already saw that kind */
function hasKind(transport: FakeTransport, kind: CoreToHost["kind"]): boolean {
  return transport.sent.some((message) => message.kind === kind);
}

/** Poll until a condition holds; fails the test instead of hanging. */
async function waitFor(condition: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was never met");

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("runCoreMain", () => {
  it("reports starting, then ready, and emits ready exactly once", async () => {
    const transport = new FakeTransport();
    const stopped = { count: 0 };

    await started(transport, { startEngine: async () => fakeEngine(stopped) }, "ready");

    expect(transport.phases()).toEqual(["starting", "ready"]);
    expect(transport.ofKind("ready")).toHaveLength(1);
    expect(transport.ofKind("status")[1]).toMatchObject({ cwd: "/work", source: "bundled" });
  });

  it("ignores a second init", async () => {
    const transport = new FakeTransport();
    const startEngine = vi.fn(async () => fakeEngine({ count: 0 }));

    await started(transport, { startEngine }, "ready");
    transport.deliver(INIT);

    await waitFor(() => hasKind(transport, "log"));

    expect(startEngine).toHaveBeenCalledTimes(1);
    expect(transport.ofKind("log").map((log) => log.line)).toEqual([
      "ignored a second init; this child starts once",
    ]);
  });

  it("answers a command before ready with a failure instead of hanging", async () => {
    const transport = new FakeTransport();

    // The engine starter never settles, so this child cannot become ready.
    const runner = runCoreMain({ startEngine: () => new Promise<CoreEngine>(() => {}), transport });

    transport.deliver(INIT);
    transport.deliver({
      kind: "command.invoke",
      callId: "call-1",
      call: { capability: "device.info", body: {} },
    });

    await waitFor(() => hasKind(transport, "command.reply"));

    expect(transport.ofKind("command.reply")[0]).toEqual({
      kind: "command.reply",
      callId: "call-1",
      reply: { ok: false, code: "NOT_CONNECTED", detail: "the core is not ready yet" },
    });

    runner.stop();
    await transport.exited;
  });

  it("forwards frames and engine log lines after ready", async () => {
    const transport = new FakeTransport();

    const engine: CoreEngine = {
      async stop(): Promise<void> {},
      onFrame(listener) {
        listener("control", '{"hello":true}');

        return () => {};
      },
      onLog(listener) {
        listener("engine says hello");

        return () => {};
      },
    };

    await started(transport, { startEngine: async () => engine }, "ready");

    expect(transport.ofKind("frame")).toEqual([
      { kind: "frame", channel: "control", payload: '{"hello":true}' },
    ]);
    expect(transport.ofKind("log").map((log) => log.line)).toContain("engine says hello");
  });

  it("replies to a command through the injected dispatcher", async () => {
    const transport = new FakeTransport();

    await started(
      transport,
      {
        startEngine: async () => fakeEngine({ count: 0 }),
        invokeCommand: async (call) => ({ ok: true, completion: "accepted" }),
      },
      "ready",
    );

    transport.deliver({
      kind: "command.invoke",
      callId: "call-9",
      call: { capability: "device.info", body: {} },
    });

    await waitFor(() => hasKind(transport, "command.reply"));

    expect(transport.ofKind("command.reply")[0]).toEqual({
      kind: "command.reply",
      callId: "call-9",
      reply: { ok: true, completion: "accepted" },
    });
  });

  it("answers a command with no dispatcher wired in", async () => {
    const transport = new FakeTransport();

    await started(transport, { startEngine: async () => fakeEngine({ count: 0 }) }, "ready");

    transport.deliver({
      kind: "command.invoke",
      callId: "call-2",
      call: { capability: "device.info", body: {} },
    });

    await waitFor(() => hasKind(transport, "command.reply"));

    expect(transport.ofKind("command.reply")[0]).toMatchObject({
      reply: { ok: false, code: "REJECTED" },
    });
  });

  it("serves the secret store and never echoes the value in a log line", async () => {
    const transport = new FakeTransport();
    const stored = new Map<string, string>([["token", "super-secret"]]);

    await started(
      transport,
      {
        startEngine: async () => fakeEngine({ count: 0 }),
        secureStore: {
          async get(key) {
            return stored.get(key);
          },
          async set(key, value) {
            stored.set(key, value);
          },
          async delete(key) {
            stored.delete(key);
          },
        },
      },
      "ready",
    );

    transport.deliver({ kind: "secure.request", requestId: "r1", op: "get", key: "token" });
    await waitFor(() => transport.ofKind("secure.reply").length === 1);

    expect(transport.ofKind("secure.reply")[0]).toEqual({
      kind: "secure.reply",
      requestId: "r1",
      value: "super-secret",
    });

    transport.deliver({ kind: "secure.request", requestId: "r2", op: "get", key: "absent" });
    await waitFor(() => transport.ofKind("secure.reply").length === 2);

    // An absent key is a reply with no value, never an invented empty string.
    expect(transport.ofKind("secure.reply")[1]).toEqual({
      kind: "secure.reply",
      requestId: "r2",
    });

    expect(JSON.stringify(transport.ofKind("log"))).not.toContain("super-secret");
  });

  it("answers a secret request with an error when no store is wired in", async () => {
    const transport = new FakeTransport();

    await started(transport, { startEngine: async () => fakeEngine({ count: 0 }) }, "ready");

    transport.deliver({ kind: "secure.request", requestId: "r", op: "get", key: "token" });
    await waitFor(() => hasKind(transport, "secure.reply"));

    expect(transport.ofKind("secure.reply")[0]).toMatchObject({
      error: "no secret store is wired into the core",
      requestId: "r",
    });
  });

  it("refuses an unusable host message with a log line, without throwing", async () => {
    const transport = new FakeTransport();

    await started(transport, { startEngine: async () => fakeEngine({ count: 0 }) }, "ready");

    transport.deliver({ kind: "command.whatever" });

    await waitFor(() => transport.ofKind("log").some((log) => log.line.includes("unusable")));

    expect(transport.ofKind("log").at(-1)?.line).toContain("unknown host-to-core kind");
  });

  it("stops the engine once and exits cleanly on shutdown", async () => {
    const transport = new FakeTransport();
    const stopped = { count: 0 };

    await started(transport, { startEngine: async () => fakeEngine(stopped) }, "ready");

    transport.deliver({ kind: "shutdown" });

    await expect(transport.exited).resolves.toBe(0);

    expect(stopped.count).toBe(1);
    expect(transport.phases()).toEqual(["starting", "ready", "stopped"]);
  });

  it("reports a failed start, then exits without a ready", async () => {
    const transport = new FakeTransport();

    const runner = runCoreMain({
      startEngine: async () => {
        throw new Error("engine bundle is missing");
      },
      transport,
    });

    transport.deliver(INIT);

    await expect(transport.exited).resolves.toBe(1);

    expect(transport.ofKind("ready")).toHaveLength(0);
    expect(transport.ofKind("status").at(-1)).toEqual({
      kind: "status",
      phase: "failed",
      failure: { kind: "start-failed", detail: "engine bundle is missing" },
    });

    // A runner whose child already left must not exit a second time.
    runner.stop();
  });

  it("stops the engine and exits when the IPC channel disconnects", async () => {
    const transport = new FakeTransport();
    const stopped = { count: 0 };

    await started(transport, { startEngine: async () => fakeEngine(stopped) }, "ready");

    transport.disconnect();

    await expect(transport.exited).resolves.toBe(1);

    expect(stopped.count).toBe(1);
    expect(transport.phases()).toEqual(["starting", "ready", "stopped"]);
  });

  it("treats a replaced parent as parent loss on the pid probe", async () => {
    const transport = new FakeTransport({ parentPid: 1234, parentAlive: () => false });
    const stopped = { count: 0 };

    const runner = runCoreMain({
      startEngine: async () => fakeEngine(stopped),
      transport,
      watchdogIntervalMs: 10,
    });

    transport.deliver(INIT);

    await expect(transport.exited).resolves.toBe(1);

    expect(stopped.count).toBe(1);
    expect(transport.ofKind("log").map((log) => log.line)).toContain(
      "the host process is gone; stopping the engine",
    );

    runner.stop();
  });

  it("keeps a live parent alive indefinitely", async () => {
    const transport = new FakeTransport({ parentAlive: () => true });

    await started(
      transport,
      {
        startEngine: async () => fakeEngine({ count: 0 }),
        transport,
        watchdogIntervalMs: 5,
      },
      "ready",
    );

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(transport.exitCode).toBeNull();
    expect(transport.phases()).toEqual(["starting", "ready"]);
  });

  it("stops through the handle after the loop already exited, without a second exit", async () => {
    const transport = new FakeTransport();
    const stopped = { count: 0 };

    const runner = await started(
      transport,
      { startEngine: async () => fakeEngine(stopped) },
      "ready",
    );

    runner.stop();
    await expect(transport.exited).resolves.toBe(0);

    runner.stop();

    expect(stopped.count).toBe(1);
  });

  it("exposes a stopped promise that settles when the child leaves", async () => {
    const transport = new FakeTransport();

    const runner = await started(
      transport,
      { startEngine: async () => fakeEngine({ count: 0 }) },
      "ready",
    );

    transport.deliver({ kind: "shutdown" });

    await expect(runner.whenStopped).resolves.toBeUndefined();
  });
});
