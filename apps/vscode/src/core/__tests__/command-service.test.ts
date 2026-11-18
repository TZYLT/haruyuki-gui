import { createStats } from "@haruyuki/core";
import type {
  Channel,
  ChannelPool,
  CommandCall,
  CommandReply,
  CommandRequest,
  CommandResult,
  Endpoint,
  EngineEventFrame,
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
} from "../command-service.js";

const ENDPOINT: Endpoint = { url: "ws://127.0.0.1:45231", token: "token-1" };

/** A stream frame, the shape a merger hands to the outlet for terminal bytes. */
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

/** A bulk frame; only a test double feeds one through, the merger emits no bulk. */
const BULK_FRAME: Frame<"bulk.page"> = {
  v: 1,
  ch: "bulk",
  seq: 0,
  t: "bulk.page",
  body: { page: 0 },
};

const DEVICE_INFO: CommandCall = { capability: "device.info", body: {} };

/** `terminal.kill` is one-way and needs no scope, but a scoped call still works. */
function terminalKill(agentId: string): CommandCall {
  return {
    capability: "terminal.kill",
    body: { terminal_id: "t1" },
    runtime: { agent_id: agentId, conversation_id: `c-${agentId}` },
  };
}

/** A channel that records sends and can push one frame to its subscribers. */
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
type PoolRig = {
  readonly pool: ChannelPool;
  readonly channels: Map<string, FakeChannel>;
  readonly requested: string[];
  readonly closeAll: ReturnType<typeof vi.fn>;
};

function createPoolRig(): PoolRig {
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

type MergerRecord = {
  readonly options: EventMergerOptions;
  readonly changes: MergerChange[];
  readonly frames: EngineEventFrame[];
  readonly ingest: (frame: EngineEventFrame) => readonly MergerChange[];
};

/** A merger factory that records each agent's merger and returns controlled changes. */
type MergerRig = {
  readonly factory: CommandMergerFactory;
  readonly records: MergerRecord[];
};

function createMergerRig(): MergerRig {
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
        // A connection-boundary reset belongs to the reconnect path; the service
        // does not drive one, so the double records nothing here.
      },
      watermark() {
        return null;
      },
    } satisfies EventMerger;
  };

  return { factory, records };
}

/** A controllable engine seam: the endpoint is whatever the test set. */
function createEngineRig(): {
  readonly engine: CommandServiceEngine;
  setEndpoint(next: Endpoint | null): void;
} {
  let endpoint: Endpoint | null = null;

  return {
    engine: {
      get endpoint() {
        return endpoint;
      },
    },
    setEndpoint(next) {
      endpoint = next;
    },
  };
}

type FrameSubscriber = (channel: string, frame: Frame) => void;

type Setup = {
  readonly service: ReturnType<typeof createCommandService>;
  readonly engineRig: ReturnType<typeof createEngineRig>;
  readonly poolRig: PoolRig;
  readonly mergerRig: MergerRig;
  readonly createPool: ReturnType<typeof vi.fn>;
  readonly frames: Frame[];
  readonly routed: Array<{ channel: string; frame: Frame }>;
  readonly logs: Array<{ code: string; detail: Record<string, unknown> | undefined }>;
};

function setup(): Setup {
  const engineRig = createEngineRig();
  const poolRig = createPoolRig();
  const mergerRig = createMergerRig();
  const createPool = vi.fn(() => poolRig.pool);
  const frames: Frame[] = [];
  const routed: Array<{ channel: string; frame: Frame }> = [];
  const logs: Array<{ code: string; detail: Record<string, unknown> | undefined }> = [];

  const service = createCommandService({
    engine: engineRig.engine,
    createPool,
    createMerger: mergerRig.factory,
    send: (frame) => {
      frames.push(frame);
    },
    log: (code, detail) => {
      logs.push({ code, detail });
    },
  });

  const subscriber: FrameSubscriber = (channel, frame) => {
    routed.push({ channel, frame });
  };
  service.onFrame(subscriber);

  return { service, engineRig, poolRig, mergerRig, createPool, frames, routed, logs };
}

/** Bring a fresh setup to the attached state with a control channel. */
function ready(): Setup {
  const rig = setup();
  rig.engineRig.setEndpoint(ENDPOINT);
  rig.service.attach();
  return rig;
}

/** The merger record for one agent, by the options it was created with. */
function mergerOf(rig: Setup, agentId: string): MergerRecord | undefined {
  return rig.mergerRig.records.find((record) => record.options.agentId === agentId);
}

describe("createCommandService", () => {
  it("refuses every command before attach with a channel refusal, not a throw", async () => {
    const rig = setup();

    expect(rig.service.ready).toBe(false);
    await expect(rig.service.invoke(DEVICE_INFO)).resolves.toEqual({
      ok: false,
      code: "COMMAND_CHANNEL_UNAVAILABLE",
    });
    expect(rig.createPool).not.toHaveBeenCalled();
    expect(rig.poolRig.requested).toEqual([]);
  });

  it("returns the answered arm when the capability is a request-response one", async () => {
    const rig = ready();

    const reply: CommandReply = await rig.service.invoke(DEVICE_INFO);

    expect(reply).toEqual({ ok: true, completion: "answered", data: null });
    // The call went out on the control channel, unchanged.
    expect(rig.poolRig.channels.get("__control__")?.sent).toEqual([
      { capability: "device.info", body: {} },
    ]);
  });

  it("returns the accepted arm when the capability is one-way", async () => {
    const rig = ready();

    const reply: CommandReply = await rig.service.invoke(terminalKill("a1"));

    expect(reply).toEqual({ ok: true, completion: "accepted" });
    expect(rig.poolRig.channels.get("a1")?.sent).toEqual([
      {
        capability: "terminal.kill",
        body: { terminal_id: "t1" },
        runtime: { agent_id: "a1", conversation_id: "c-a1" },
      },
    ]);
  });

  it("returns the ok:false arm with the dispatcher's code for an unknown capability", async () => {
    const rig = ready();

    const reply = await rig.service.invoke({ capability: "not.a.capability", body: {} });

    expect(reply).toMatchObject({ ok: false, code: "COMMAND_UNKNOWN_CAPABILITY" });
    // The refusal is the dispatcher's, so nothing was written to any channel.
    expect(rig.poolRig.channels.get("__control__")?.sent).toEqual([]);
  });

  it("builds exactly one pool when attach is called twice", async () => {
    const rig = setup();
    rig.engineRig.setEndpoint(ENDPOINT);

    rig.service.attach();
    rig.service.attach();

    expect(rig.createPool).toHaveBeenCalledTimes(1);
    // One eager control lookup and one subscription: a second attach would have
    // built a second channel for the same agent, which is a second socket.
    expect(rig.poolRig.requested).toEqual(["__control__"]);
    expect(rig.poolRig.channels.get("__control__")?.subscriberCount()).toBe(1);
    expect(mergerOf(rig, "__control__")).toBeDefined();
    expect(rig.service.ready).toBe(true);
  });

  it("adopts an injected pool instead of building one", async () => {
    const engineRig = createEngineRig();
    const poolRig = createPoolRig();
    const mergerRig = createMergerRig();
    const createPool = vi.fn(() => poolRig.pool);

    const service = createCommandService({
      engine: engineRig.engine,
      channelPool: poolRig.pool,
      createPool,
      createMerger: mergerRig.factory,
    });

    // No endpoint and no factory call: the injected pool is the one to use.
    service.attach();

    expect(createPool).not.toHaveBeenCalled();
    expect(service.ready).toBe(true);
    await expect(service.invoke(DEVICE_INFO)).resolves.toEqual({
      ok: true,
      completion: "answered",
      data: null,
    });
    // The attach lookup plus the command's own: the same channel, not a second one.
    expect(poolRig.channels.size).toBe(1);
    expect(poolRig.requested).toEqual(["__control__", "__control__"]);
  });

  it("ignores attach while the engine has no endpoint", async () => {
    const rig = setup();

    rig.service.attach();

    expect(rig.createPool).not.toHaveBeenCalled();
    expect(rig.service.ready).toBe(false);
    expect(rig.logs.map((entry) => entry.code)).toContain("COMMAND_ENDPOINT_MISSING");
  });

  it("refuses commands after detach instead of answering silently", async () => {
    const rig = ready();

    await rig.service.detach();

    expect(rig.service.ready).toBe(false);
    await expect(rig.service.invoke(DEVICE_INFO)).resolves.toEqual({
      ok: false,
      code: "COMMAND_CHANNEL_UNAVAILABLE",
    });
    await expect(rig.service.invoke(terminalKill("a1"))).resolves.toEqual({
      ok: false,
      code: "COMMAND_CHANNEL_UNAVAILABLE",
    });
    // Nothing was written to a channel after the pool closed.
    expect(rig.poolRig.channels.size).toBe(0);
  });

  it("detaches idempotently: one closeAll and no throw on the second call", async () => {
    const rig = ready();

    await rig.service.detach();
    await rig.service.detach();

    expect(rig.poolRig.closeAll).toHaveBeenCalledTimes(1);
  });

  it("detach unsubscribes every channel and drops the mergers", async () => {
    const rig = ready();
    const control = rig.poolRig.channels.get("__control__");

    await rig.service.invoke(terminalKill("a1"));
    expect(rig.poolRig.channels.get("a1")?.subscriberCount()).toBe(1);

    await rig.service.detach();

    expect(control?.subscriberCount()).toBe(0);

    // A frame that arrives after the close has no merger left to reach.
    rig.mergerRig.records.forEach((record) => {
      record.changes.push({
        authorAgentId: "a1",
        runtimeAgentId: "a1",
        subagentId: null,
        conversationId: "c1",
        at: 1,
        kind: "passthrough",
        type: "terminal_spawned",
        raw: { terminal_id: "t1" },
      });
    });
    control?.emit({ type: "terminal_spawned", raw: { terminal_id: "t1" }, at: 1 });

    expect(rig.frames).toEqual([]);
  });

  it("builds a fresh pool when attach follows a detach", async () => {
    const rig = ready();

    await rig.service.detach();
    rig.service.attach();

    expect(rig.createPool).toHaveBeenCalledTimes(2);
    expect(rig.service.ready).toBe(true);
    await expect(rig.service.invoke(DEVICE_INFO)).resolves.toEqual({
      ok: true,
      completion: "answered",
      data: null,
    });
  });

  it("keeps one merger per agent and subscribes each channel once", async () => {
    const rig = ready();

    await rig.service.invoke(terminalKill("a1"));
    await rig.service.invoke(terminalKill("a2"));
    await rig.service.invoke(terminalKill("a1"));

    expect(rig.mergerRig.records.map((record) => record.options.agentId)).toEqual([
      "__control__",
      "a1",
      "a2",
    ]);
    expect(rig.poolRig.channels.get("a1")?.subscriberCount()).toBe(1);
    expect(rig.poolRig.channels.get("a1")?.sent).toHaveLength(2);
  });

  it("ingests each channel's frames into its agent's merger and counts the changes", () => {
    const rig = ready();
    const control = rig.poolRig.channels.get("__control__");
    const frame: EngineEventFrame = { type: "terminal_output", raw: {}, at: 1 };

    control?.emit(frame);

    expect(mergerOf(rig, "__control__")?.frames).toEqual([frame]);
    expect(rig.logs.some((entry) => entry.code === "COMMAND_MERGE_CHANGES")).toBe(false);

    mergerOf(rig, "__control__")?.changes.push({
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
    });
    control?.emit(frame);

    expect(rig.logs.find((entry) => entry.code === "COMMAND_MERGE_CHANGES")?.detail).toEqual({
      agentId: "__control__",
      count: 1,
      total: 1,
    });
    // A message delta belongs to the session store, not to this layer's outlet.
    expect(rig.frames).toEqual([]);
  });

  it("routes terminal output to the stream route and forwards it once", () => {
    const rig = ready();
    const record = mergerOf(rig, "__control__");

    record?.options.onFrame?.(TERM_FRAME);

    expect(rig.frames).toEqual([TERM_FRAME]);
    expect(rig.routed).toEqual([{ channel: "stream", frame: TERM_FRAME }]);
  });

  it("forwards terminal_spawned as a control frame with the engine's body untouched", () => {
    const rig = ready();
    const raw = { terminal_id: "t-1", pid: 4242 };
    const record = mergerOf(rig, "__control__");

    record?.changes.push({
      authorAgentId: "a1",
      runtimeAgentId: "a1",
      subagentId: null,
      conversationId: "c1",
      at: 1,
      kind: "passthrough",
      type: "terminal_spawned",
      raw,
    });
    rig.poolRig.channels.get("__control__")?.emit({ type: "terminal_spawned", raw, at: 1 });

    expect(rig.frames).toEqual([{ v: 1, ch: "control", seq: 0, t: "terminal_spawned", body: raw }]);
    // Same object, not a copy: nothing between the merger and the outlet may
    // rewrite the engine's payload.
    expect(rig.frames[0]?.body).toBe(raw);
    expect(rig.routed[0]?.channel).toBe("control");
  });

  it("does not render other passthrough types as frames", () => {
    const rig = ready();

    mergerOf(rig, "__control__")?.changes.push({
      authorAgentId: "a1",
      runtimeAgentId: "a1",
      subagentId: null,
      conversationId: "c1",
      at: 1,
      kind: "passthrough",
      type: "memory_updated",
      raw: { agent_id: "a1", used: 12 },
    });
    rig.poolRig.channels.get("__control__")?.emit({ type: "memory_updated", raw: {}, at: 1 });

    expect(rig.frames).toEqual([]);
    expect(rig.routed).toEqual([]);
  });

  it("routes a bulk frame to the bulk route, because the route is the frame's channel", () => {
    const rig = ready();

    // The merger emits only `term.output` frames, so the double feeds the one
    // frame this layer never produces: the outlet is channel-generic, and a
    // later consumer pushes snapshot pages through the same three routes.
    mergerOf(rig, "__control__")?.options.onFrame?.(BULK_FRAME as unknown as Frame<"term.output">);

    expect(rig.frames).toEqual([BULK_FRAME]);
    expect(rig.routed).toEqual([{ channel: "bulk", frame: BULK_FRAME }]);
  });

  it("stops delivering to a subscriber after its unsubscribe, exactly once", () => {
    const rig = setup();
    const seen: Frame[] = [];
    const unsubscribe = rig.service.onFrame((_channel, frame) => {
      seen.push(frame);
    });

    rig.engineRig.setEndpoint(ENDPOINT);
    rig.service.attach();
    mergerOf(rig, "__control__")?.options.onFrame?.(TERM_FRAME);

    expect(seen).toEqual([TERM_FRAME]);
    expect(rig.frames).toEqual([TERM_FRAME]);

    unsubscribe();
    unsubscribe();
    mergerOf(rig, "__control__")?.options.onFrame?.(TERM_FRAME);

    expect(seen).toEqual([TERM_FRAME]);
    // The host sink is not a subscriber: it keeps receiving.
    expect(rig.frames).toEqual([TERM_FRAME, TERM_FRAME]);
  });

  it("isolates a throwing frame subscriber from the sink and the other subscribers", () => {
    const rig = setup();
    const seen: Frame[] = [];

    rig.service.onFrame(() => {
      throw new Error("subscriber bug");
    });
    rig.service.onFrame((_channel, frame) => {
      seen.push(frame);
    });

    rig.engineRig.setEndpoint(ENDPOINT);
    rig.service.attach();
    mergerOf(rig, "__control__")?.options.onFrame?.(TERM_FRAME);

    expect(rig.frames).toEqual([TERM_FRAME]);
    expect(seen).toEqual([TERM_FRAME]);
    expect(rig.logs.some((entry) => entry.code === "COMMAND_FRAME_SUBSCRIBER_FAILED")).toBe(true);
  });

  it("survives a host sink that throws, and still reaches the subscribers", () => {
    const engineRig = createEngineRig();
    const poolRig = createPoolRig();
    const mergerRig = createMergerRig();
    const logs: Array<{ code: string }> = [];
    const seen: Frame[] = [];

    const service = createCommandService({
      engine: engineRig.engine,
      createPool: () => poolRig.pool,
      createMerger: mergerRig.factory,
      send: () => {
        throw new Error("host sink bug");
      },
      log: (code) => {
        logs.push({ code });
      },
    });
    service.onFrame((_channel, frame) => {
      seen.push(frame);
    });

    engineRig.setEndpoint(ENDPOINT);
    service.attach();
    mergerRig.records[0]?.options.onFrame?.(TERM_FRAME);

    expect(seen).toEqual([TERM_FRAME]);
    expect(logs.some((entry) => entry.code === "COMMAND_FRAME_SINK_FAILED")).toBe(true);
  });
});
