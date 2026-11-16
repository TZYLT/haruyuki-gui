/**
 * The three diagnostics channels at the main-process boundary.
 *
 * The renderer is untrusted, so the tests that matter are the ones that send
 * malformed requests and assert a structured refusal instead of a throw. The
 * rest pin the routing: `open` goes back out, `start` returns before the export
 * finishes and streams events, `cancel` aborts the one in-flight run, and the
 * two commands call `app` exactly once.
 *
 * A fake `ipcMain` is the whole Electron surface here; no browser process is
 * launched (`33` section 6.2 P7).
 */

import { describe, expect, it } from "vitest";

import {
  BRIDGE_CHANNELS,
  CHANNEL_ALLOWLIST,
  DIAGNOSTICS_CHANNELS,
  createBridge,
  guardChannel,
  type BridgeIpc,
} from "../../shared/bridge.js";
import type {
  DiagnosticsEvent,
  DiagnosticsOptions,
  DiagnosticsResult,
} from "../../shared/diagnostics.js";
import {
  openDiagnosticsPanel,
  registerDiagnosticsIpc,
  type DiagnosticsApp,
  type DiagnosticsCommandResult,
  type DiagnosticsExportRunner,
  type DiagnosticsExportRun,
  type DiagnosticsInvokeEvent,
  type DiagnosticsIpcMain,
  type DiagnosticsSender,
} from "../diagnostics/ipc.js";

interface SentMessage {
  readonly channel: string;
  readonly payload: unknown;
}

class FakeSender implements DiagnosticsSender {
  readonly sent: SentMessage[] = [];

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
}

class FakeIpcMain implements DiagnosticsIpcMain {
  readonly handlers = new Map<
    string,
    (event: DiagnosticsInvokeEvent, ...args: unknown[]) => unknown
  >();

  handleCalls = 0;

  handle(
    channel: string,
    listener: (event: DiagnosticsInvokeEvent, ...args: unknown[]) => unknown,
  ): void {
    this.handleCalls += 1;
    this.handlers.set(channel, listener);
  }

  invoke(channel: string, event: DiagnosticsInvokeEvent, payload: unknown): unknown {
    const handler = this.handlers.get(channel);

    if (handler === undefined) throw new Error(`no handler for ${channel}`);

    return handler(event, payload);
  }
}

class FakeApp implements DiagnosticsApp {
  relaunchCalls = 0;
  quitCalls = 0;

  relaunch(): void {
    this.relaunchCalls += 1;
  }

  quit(): void {
    this.quitCalls += 1;
  }
}

interface Harness {
  readonly ipc: FakeIpcMain;
  readonly sender: FakeSender;
  readonly app: FakeApp;
}

function register(
  runner: DiagnosticsExportRunner,
  options: { readonly sessionAvailable?: boolean } = {},
): Harness {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const app = new FakeApp();

  registerDiagnosticsIpc({
    ipcMain: ipc,
    getWindow: () => ({ webContents: sender }),
    export: runner,
    app,
    sessionAvailable: options.sessionAvailable ?? true,
  });

  return { ipc, sender, app };
}

function resultOf(value: unknown): DiagnosticsCommandResult {
  return value as DiagnosticsCommandResult;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const OPTIONS: DiagnosticsOptions = {
  includeSessionContent: false,
  includeMinidump: false,
};

describe("the diagnostics allowlist", () => {
  it("accepts the three D4 channels and keeps ping", () => {
    for (const channel of Object.values(DIAGNOSTICS_CHANNELS)) {
      expect(guardChannel(channel)).toEqual({ ok: true, channel: "control" });
    }

    expect(guardChannel("bridge:control.app.ping").ok).toBe(true);
  });

  it("freezes exactly ping plus the three diagnostics commands", () => {
    expect([...CHANNEL_ALLOWLIST]).toEqual([
      "bridge:control.app.ping",
      "bridge:control.diagnostics.export",
      "bridge:control.diagnostics.relaunch",
      "bridge:control.diagnostics.quit",
    ]);
  });

  it("still refuses a fourth segment and an unknown diagnostics action", () => {
    expect(guardChannel("bridge:control.diagnostics.export.extra")).toEqual({
      ok: false,
      reason: "bad-shape",
      code: "BRIDGE_CHANNEL_DENIED",
    });
    expect(guardChannel("bridge:control.diagnostics.remove").ok).toBe(false);
  });

  it("does not add a fourth preload member", () => {
    const ipc: BridgeIpc = {
      invoke: () => Promise.resolve(undefined),
      on: () => undefined,
      removeListener: () => undefined,
    };
    const bridge = createBridge(ipc);

    expect(Object.keys(bridge).sort()).toEqual(["channelAllowlist", "invoke", "on"]);
    expect(Object.keys(BRIDGE_CHANNELS)).toEqual(["control", "stream", "bulk"]);
  });
});

describe("the export channel", () => {
  it("sends an open message and returns ok", async () => {
    const harness = register(() => new Promise(() => undefined));
    const result = resultOf(
      harness.ipc.invoke(
        DIAGNOSTICS_CHANNELS.export,
        { sender: harness.sender },
        { kind: "open", sessionAvailable: true },
      ),
    );

    expect(result).toEqual({ ok: true });
    expect(harness.sender.sent).toEqual([
      {
        channel: DIAGNOSTICS_CHANNELS.export,
        payload: { kind: "open", sessionAvailable: true },
      },
    ]);
  });

  it("falls back to the live window when the event has no sender", () => {
    const harness = register(() => new Promise(() => undefined));
    const result = resultOf(
      harness.ipc.invoke(DIAGNOSTICS_CHANNELS.export, {}, { kind: "open", sessionAvailable: true }),
    );

    expect(result).toEqual({ ok: true });
    expect(harness.sender.sent).toHaveLength(1);
  });

  it("starts the runner in the background and forwards its events", async () => {
    const received: DiagnosticsExportRun[] = [];
    const runner: DiagnosticsExportRunner = async (run) => {
      received.push(run);
      run.onEvent({ kind: "progress", phase: "collect", done: 1, total: 1 });
      run.onEvent({ kind: "done", path: "/tmp/export.zip", bytes: 12, omitted: [] });

      return { ok: true, path: "/tmp/export.zip", bytes: 12, omitted: [] };
    };
    const harness = register(runner);
    const result = resultOf(
      harness.ipc.invoke(
        DIAGNOSTICS_CHANNELS.export,
        { sender: harness.sender },
        { kind: "start", options: OPTIONS },
      ),
    );

    expect(result).toEqual({ ok: true });

    await settle();

    expect(received[0]?.options).toEqual(OPTIONS);
    expect(received[0]?.signal.aborted).toBe(false);
    expect(
      harness.sender.sent.map((message) => (message.payload as DiagnosticsEvent).kind),
    ).toEqual(["progress", "done"]);
  });

  it("cancels the in-flight runner through its abort signal", async () => {
    const signals: AbortSignal[] = [];
    const runner: DiagnosticsExportRunner = (run) => {
      signals.push(run.signal);

      return new Promise((resolve) => {
        run.signal.addEventListener(
          "abort",
          () => {
            run.onEvent({ kind: "cancelled" });
            resolve({ ok: false, code: "DIAGNOSTIC_EXPORT_CANCELLED", detail: "cancelled" });
          },
          { once: true },
        );
      });
    };
    const harness = register(runner);

    harness.ipc.invoke(
      DIAGNOSTICS_CHANNELS.export,
      { sender: harness.sender },
      { kind: "start", options: OPTIONS },
    );
    await settle();

    const result = resultOf(
      harness.ipc.invoke(
        DIAGNOSTICS_CHANNELS.export,
        { sender: harness.sender },
        { kind: "cancel" },
      ),
    );

    expect(result).toEqual({ ok: true });
    expect(signals[0]?.aborted).toBe(true);

    await settle();

    expect(harness.sender.sent.at(-1)).toEqual({
      channel: DIAGNOSTICS_CHANNELS.export,
      payload: { kind: "cancelled" },
    });
  });

  it("refuses a second start while one is running", async () => {
    const harness = register(() => new Promise(() => undefined));

    const first = resultOf(
      harness.ipc.invoke(
        DIAGNOSTICS_CHANNELS.export,
        { sender: harness.sender },
        { kind: "start", options: OPTIONS },
      ),
    );
    const second = resultOf(
      harness.ipc.invoke(
        DIAGNOSTICS_CHANNELS.export,
        { sender: harness.sender },
        { kind: "start", options: OPTIONS },
      ),
    );

    expect(first).toEqual({ ok: true });
    expect(second.ok).toBe(false);

    if (second.ok) throw new Error("expected refusal");
    expect(second.detail).toContain("already running");
  });

  it("turns a throwing runner into one failed event", async () => {
    const harness = register(() => Promise.reject(new Error("runner exploded")));

    harness.ipc.invoke(
      DIAGNOSTICS_CHANNELS.export,
      { sender: harness.sender },
      { kind: "start", options: OPTIONS },
    );
    await settle();

    expect(harness.sender.sent.at(-1)).toEqual({
      channel: DIAGNOSTICS_CHANNELS.export,
      payload: {
        kind: "failed",
        code: "DIAGNOSTIC_EXPORT_FAILED",
        detail: "runner exploded",
      },
    });
  });

  it("refuses malformed requests without throwing", () => {
    const harness = register(() => new Promise(() => undefined));

    const cases: unknown[] = [
      null,
      "start",
      [],
      {},
      { kind: "unknown" },
      { kind: "start" },
      { kind: "start", options: { includeSessionContent: "yes", includeMinidump: false } },
      { kind: "open" },
      { kind: "open", sessionAvailable: "yes" },
    ];

    for (const payload of cases) {
      const result = resultOf(
        harness.ipc.invoke(DIAGNOSTICS_CHANNELS.export, { sender: harness.sender }, payload),
      );

      expect(result.ok, JSON.stringify(payload)).toBe(false);

      if (result.ok) throw new Error("expected refusal");
      expect(result.detail).toEqual(expect.any(String));
    }

    expect(harness.sender.sent).toHaveLength(0);
  });
});

describe("the command channels", () => {
  it("relaunches and quits", () => {
    const harness = register(() => new Promise(() => undefined));

    expect(
      resultOf(harness.ipc.invoke(DIAGNOSTICS_CHANNELS.relaunch, { sender: harness.sender }, null)),
    ).toEqual({ ok: true });
    expect(harness.app.relaunchCalls).toBe(1);
    expect(harness.app.quitCalls).toBe(1);

    expect(
      resultOf(harness.ipc.invoke(DIAGNOSTICS_CHANNELS.quit, { sender: harness.sender }, null)),
    ).toEqual({ ok: true });
    expect(harness.app.quitCalls).toBe(2);
  });

  it("is idempotent for the same ipcMain", () => {
    const ipc = new FakeIpcMain();
    const sender = new FakeSender();
    const app = new FakeApp();
    const deps = {
      ipcMain: ipc,
      getWindow: () => ({ webContents: sender }),
      export: () => new Promise<DiagnosticsResult>(() => undefined),
      app,
      sessionAvailable: true,
    };

    registerDiagnosticsIpc(deps);
    registerDiagnosticsIpc(deps);

    expect(ipc.handleCalls).toBe(3);
    expect(ipc.handlers.size).toBe(3);
  });

  it("opens a panel on a specific webContents", () => {
    const sender = new FakeSender();

    expect(openDiagnosticsPanel(sender, false)).toBe(true);
    expect(sender.sent).toEqual([
      {
        channel: DIAGNOSTICS_CHANNELS.export,
        payload: { kind: "open", sessionAvailable: false },
      },
    ]);
  });
});
