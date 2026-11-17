import { createStats } from "@haruyuki/core";
import type {
  Channel,
  ChannelPool,
  CommandCall,
  CommandRequest,
  CommandResult,
  Endpoint,
  EngineEventFrame,
  EngineState,
  EventMerger,
  EventMergerOptions,
  MergerChange,
} from "@haruyuki/core";
import type { Frame } from "@haruyuki/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  createCommandService,
  type CommandMergerFactory,
  type CommandServiceEngine,
} from "../service.js";

const ENDPOINT: Endpoint = { url: "ws://127.0.0.1:45231", token: "token-1" };

const TERM_FRAME: Frame<"term.output"> = {
  v: 1,
  ch: "stream",
  seq: 0,
  t: "term.output",
  body: {
    terminal_id: "t1",
    slice: 0,
    slices: 1,
    offset: 0,
    bytes: 2,
    final: true,
    text: "hi",
  },
};

const CHANGE: MergerChange = {
  authorAgentId: "a1",
  runtimeAgentId: "a1",
  subagentId: null,
  conversationId: "c1",
  at: 1,
  kind: "message.delta",
  messageId: "m1",
  runId: null,
  runSeq: 1,
  text: "hi",
  parts: [],
  first: true,
};

/** A controllable engine facade: the endpoint is set by the test, states are emitted. */
function createEngineRig(): {
  engine: CommandServiceEngine;
  setEndpoint(next: Endpoint | null): void;
  emit(state: EngineState): void;
  listenerCount(): number;
} {
  const listeners = new Set<(state: EngineState) => void>();
  let endpoint: Endpoint | null = null;

  return {
    engine: {
      get endpoint() {
        return endpoint;
      },
      onState(callback) {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    },
    setEndpoint(next) {
      endpoint = next;
    },
    emit(state) {
      for (const listener of [...listeners]) listener(state);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

/** A channel that records sends and can push one event to its subscribers. */
type FakeChannel = Channel & {
  readonly sent: CommandRequest[];
  emit(frame: EngineEventFrame): void;
  closeCalls(): number;
  subscriberCount(): number;
};

function createFakeChannel(agentId: string): FakeChannel {
  const listeners = new Set<(frame: EngineEventFrame) => void>();
  const sent: CommandRequest[] = [];
  let closes = 0;

  return {
    agentId,
    sent,
    async send(request): Promise<CommandResult> {
      sent.push(request);
      return { ok: true, data: null, raw: null };
    },
    onEvent(subscriber) {
      listeners.add(subscriber);
      return () => {
        listeners.delete(subscriber);
      };
    },
    onDiagnostic() {
      return () => undefined;
    },
    capabilities() {
      return { state: "unknown" };
    },
    close() {
      closes += 1;
      listeners.clear();
    },
    emit(frame) {
      for (const listener of [...listeners]) listener(frame);
    },
    closeCalls() {
      return closes;
    },
    subscriberCount() {
      return listeners.size;
    },
  };
}

/** A pool whose channels are created on demand and handed to the service. */
function createPoolRig(): {
  pool: ChannelPool;
  channels: Map<string, FakeChannel>;
  requested: string[];
  closeAll: ReturnType<typeof vi.fn>;
} {
  const channels = new Map<string, FakeChannel>();
  const requested: string[] = [];
  const closeAll = vi.fn(() => {
    for (const channel of channels.values()) channel.close();
    channels.clear();
  });

  return {
    channels,
    requested,
    closeAll,
    pool: {
      getChannel(agentId) {
        requested.push(agentId);
        let channel = channels.get(agentId);
        if (channel === undefined) {
          channel = createFakeChannel(agentId);
          channels.set(agentId, channel);
        }
        return channel;
      },
      channels() {
        return [...channels.values()];
      },
      closeChannel(agentId) {
        channels.get(agentId)?.close();
        channels.delete(agentId);
      },
      closeAll,
    },
  };
}

interface MergerRecord {
  readonly options: EventMergerOptions;
  readonly changes: MergerChange[];
  readonly frames: EngineEventFrame[];
  readonly ingest: (frame: EngineEventFrame) => readonly MergerChange[];
}

/** A merger factory that records each agent's merger and returns controlled changes. */
function createMergerRig(): {
  factory: CommandMergerFactory;
  records: MergerRecord[];
} {
  const records: MergerRecord[] = [];
  const stats = createStats();

  const factory: CommandMergerFactory = (options) => {
    const record: MergerRecord = {
      options,
      changes: [],
      frames: [],
      ingest(frame) {
        record.frames.push(frame);
        return record.changes;
      },
    };
    records.push(record);

    return {
      ingest: record.ingest,
      subscribe() {
        return () => undefined;
      },
      stats() {
        return stats.snapshot();
      },
      reset() {
        // The service does not reset mergers yet; a reconnect keeps C2's future
        // state intact until that consumer exists.
      },
      watermark() {
        return null;
      },
    } satisfies EventMerger;
  };

  return { factory, records };
}

interface Setup {
  service: ReturnType<typeof createCommandService>;
  engineRig: ReturnType<typeof createEngineRig>;
  poolRig: ReturnType<typeof createPoolRig>;
  mergerRig: ReturnType<typeof createMergerRig>;
  createPool: ReturnType<typeof vi.fn>;
  frames: Frame[];
  logs: Array<{ code: string; detail: Record<string, unknown> | undefined }>;
}

function setup(): Setup {
  const engineRig = createEngineRig();
  const poolRig = createPoolRig();
  const mergerRig = createMergerRig();
  const createPool = vi.fn(() => poolRig.pool);
  const frames: Frame[] = [];
  const logs: Array<{ code: string; detail: Record<string, unknown> | undefined }> = [];

  const service = createCommandService({
    engine: engineRig.engine,
    send: (frame) => {
      frames.push(frame);
    },
    log: (code, detail) => {
      logs.push({ code, detail });
    },
    createPool,
    createMerger: mergerRig.factory,
  });

  return { service, engineRig, poolRig, mergerRig, createPool, frames, logs };
}

/** Bring a fresh setup to the ready state with a control channel. */
function ready(): Setup {
  const rig = setup();
  rig.engineRig.setEndpoint(ENDPOINT);
  rig.engineRig.emit("ready");
  return rig;
}

const DEVICE_INFO = { capability: "device.info", body: {} } as const;

function terminalKill(agentId: string): {
  capability: "terminal.kill";
  body: { terminal_id: string };
  runtime: { agent_id: string; conversation_id: string };
} {
  return {
    capability: "terminal.kill",
    body: { terminal_id: "t1" },
    runtime: { agent_id: agentId, conversation_id: `c-${agentId}` },
  };
}

describe("createCommandService", () => {
  it("stays unavailable until the engine is ready with an endpoint", async () => {
    const rig = setup();

    expect(rig.service.ready).toBe(false);
    await expect(rig.service.invoke(DEVICE_INFO)).resolves.toEqual({
      ok: false,
      code: "COMMAND_CHANNEL_UNAVAILABLE",
    });

    rig.engineRig.emit("spawning");
    rig.engineRig.emit("ready");

    expect(rig.createPool).not.toHaveBeenCalled();
    expect(rig.service.ready).toBe(false);

    rig.engineRig.setEndpoint(ENDPOINT);
    rig.engineRig.emit("ready");

    expect(rig.createPool).toHaveBeenCalledTimes(1);
    expect(rig.createPool).toHaveBeenCalledWith(rig.engineRig.engine);
    expect(rig.poolRig.requested).toEqual(["__control__"]);
    expect(rig.service.ready).toBe(true);
  });

  it("builds one pool and one control merger even if ready is emitted twice", () => {
    const rig = ready();

    rig.engineRig.emit("ready");

    expect(rig.createPool).toHaveBeenCalledTimes(1);
    expect(rig.poolRig.requested).toEqual(["__control__"]);
    expect(rig.mergerRig.records.map((record) => record.options.agentId)).toEqual(["__control__"]);
    expect(rig.poolRig.channels.get("__control__")?.subscriberCount()).toBe(1);
  });

  it("keeps one merger per agent, sends commands to that agent, and forwards terminal frames", async () => {
    const rig = ready();

    await expect(rig.service.invoke(terminalKill("a1"))).resolves.toEqual({
      ok: true,
      completion: "accepted",
    });
    await expect(rig.service.invoke(terminalKill("a2"))).resolves.toEqual({
      ok: true,
      completion: "accepted",
    });
    // A second command for an existing agent must reuse its channel and merger.
    await rig.service.invoke(terminalKill("a1"));

    expect(rig.mergerRig.records.map((record) => record.options.agentId)).toEqual([
      "__control__",
      "a1",
      "a2",
    ]);
    expect(rig.poolRig.channels.get("a1")?.sent).toEqual([
      {
        capability: "terminal.kill",
        body: { terminal_id: "t1" },
        runtime: { agent_id: "a1", conversation_id: "c-a1" },
      },
      {
        capability: "terminal.kill",
        body: { terminal_id: "t1" },
        runtime: { agent_id: "a1", conversation_id: "c-a1" },
      },
    ]);

    const a1 = rig.mergerRig.records.find((record) => record.options.agentId === "a1");
    a1?.options.onFrame?.(TERM_FRAME);

    expect(rig.frames).toEqual([TERM_FRAME]);
  });

  it("ingests each channel's frames into its agent's merger and logs changes", () => {
    const rig = ready();
    const control = rig.poolRig.channels.get("__control__");
    const frame: EngineEventFrame = { type: "terminal_output", raw: {}, at: 1 };

    control?.emit(frame);

    const record = rig.mergerRig.records[0];
    expect(record?.frames).toEqual([frame]);
    expect(rig.logs.some((entry) => entry.code === "COMMAND_MERGE_CHANGES")).toBe(false);

    record?.changes.push(CHANGE);
    control?.emit(frame);

    const logged = rig.logs.find((entry) => entry.code === "COMMAND_MERGE_CHANGES");
    expect(logged?.detail).toEqual({ agentId: "__control__", count: 1, total: 1 });
    // The merger's changes are counted, not sent: only `onFrame` reaches the bridge.
    expect(rig.frames).toEqual([]);
  });

  it("closes the pool and forgets mergers on closed, then builds a fresh pool on a later ready", async () => {
    const rig = ready();
    const control = rig.poolRig.channels.get("__control__");

    rig.engineRig.emit("closed");

    expect(rig.poolRig.closeAll).toHaveBeenCalledTimes(1);
    expect(control?.closeCalls()).toBe(1);
    expect(control?.subscriberCount()).toBe(0);
    expect(rig.service.ready).toBe(false);
    await expect(rig.service.invoke(DEVICE_INFO)).resolves.toEqual({
      ok: false,
      code: "COMMAND_CHANNEL_UNAVAILABLE",
    });

    // A repeated terminal state must not close an already-closed pool again.
    rig.engineRig.emit("closed");
    expect(rig.poolRig.closeAll).toHaveBeenCalledTimes(1);

    rig.engineRig.emit("ready");

    expect(rig.createPool).toHaveBeenCalledTimes(2);
    expect(
      rig.mergerRig.records.filter((record) => record.options.agentId === "__control__"),
    ).toHaveLength(2);
    expect(rig.service.ready).toBe(true);
  });

  it("treats failed like closed", () => {
    const rig = ready();

    rig.engineRig.emit("failed");

    expect(rig.poolRig.closeAll).toHaveBeenCalledTimes(1);
    expect(rig.service.ready).toBe(false);
  });

  it("delegates to the dispatcher while ready", async () => {
    const rig = ready();

    await expect(rig.service.invoke(DEVICE_INFO)).resolves.toEqual({
      ok: true,
      completion: "answered",
      data: null,
    });
    expect(rig.poolRig.channels.get("__control__")?.sent).toEqual([
      { capability: "device.info", body: {} },
    ]);

    await expect(
      rig.service.invoke({ capability: "not.a.capability", body: {} } as unknown as CommandCall),
    ).resolves.toMatchObject({ ok: false, code: "COMMAND_UNKNOWN_CAPABILITY" });
  });

  it("disposes idempotently: unsubscribes the engine and closes the pool exactly once", () => {
    const rig = ready();

    rig.service.dispose();

    expect(rig.engineRig.listenerCount()).toBe(0);
    expect(rig.poolRig.closeAll).toHaveBeenCalledTimes(1);
    expect(rig.service.ready).toBe(false);

    rig.service.dispose();
    expect(rig.poolRig.closeAll).toHaveBeenCalledTimes(1);

    // A state transition after dispose must not resurrect the service.
    rig.engineRig.emit("ready");
    expect(rig.createPool).toHaveBeenCalledTimes(1);
    expect(rig.service.ready).toBe(false);
  });
});
