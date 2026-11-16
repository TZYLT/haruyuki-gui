/**
 * the wiring 接线层的验收（`wiring.ts`）。
 *
 * 约束：三条数据流 + 去重表按通道隔离；socket 关闭归属接线，关闭路径必须同时
 * 归属：接线必须让关闭路径同时合上 transport）、§3.6.2（`endpoint` 五条边界）、
 * §6.2（`the wiring` 的接线职责）、《26》§6.6 与 ``。
 *
 * ## 这一套证明什么
 *
 * 1. **去重表按通道隔离**（ §3.2 要求补的那条判据）：两个 agent 的实例
 *    `!==`，同一 agent 两次 `getChannel` 拿到**同一个**实例。这条只能按 identity
 *    断言——只测行为的话，「一个共享表恰好只被一个 agent 用过」也会绿。
 * 2. **关闭路径合上 transport**：`close()` 之后连接确实关了，而不是只关内核。
 * 3. **`openTransport` 那条路**（accept-tick）：测试注入的 opener 收到的 url/token
 *    与端口解析出来的一致，且早到的帧不会丢——注入的 opener 用真实的
 *    `createTransport`，走的是与 `openTransport` 同一个 transport 实现。
 * 4. **`endpoint` 的接线侧观察**：`endpoint` 为 `null` 时通道退化为
 *    `NOT_CONNECTED`，不为 `null` 时能发；端点的 token 只作为脱敏词进入通道，
 *    不出现在 `Object.keys` / `JSON.stringify` / 诊断记录里（边界 2）。
 * 5. **不泄漏**：每个用例用注入的假时钟，`afterEach` 拆干净，最后断言没有遗留
 *    定时器——snapshot assembly 曾因悬挂的 promise 烧掉 93 秒，那类缺陷靠这条抓。
 *
 * ## 纪律
 *
 * - **零 wire id**（pick-path 扫描整个 `client/`）：帧由 `channel-test-support` 的
 *   marker 构造器生成（`responseFrame` / `eventFrame`），能力名用该文件的
 *   `TRACKED` / `SILENT` / `UNTRACKED` 常量。本文件不写任何引擎词汇。
 * - **不拨真网络**：`open` 端口注入内存 socket（`scripted-harness` 的
 *   `makeSocketDouble`，那是 stub 不是第二份类型）。
 * - **不用 `setTimeout` 等竞态**：连接是异步建立的，用 `await Promise.resolve()`
 *   让微任务队列跑完，不赌墙钟。
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  ENGINE_VERSION,
  fakeEngineSource,
  fakeEngineSpec,
  makeRoot,
  releaseFixtures,
  startHandshakeStub,
  startTracking,
} from "../engine-test-support";
import type { Engine } from "../engine";
import type { EngineState } from "../types";
import {
  assertNoLeakedTimers,
  eventFrame,
  makeClock,
  makeProbe,
  makeReader,
  responseFrame,
  SILENT,
  trackClock,
  TRACKED,
  UNTRACKED,
} from "./channel-test-support";
import type { FakeClock } from "./channel-test-support";
import type { Channel, ChannelPool, CommandResult, Endpoint } from "./types";
import { createTransport } from "./transport";
import type { EngineTransport } from "./transport";
import type { TransportOpener, WiredChannel } from "./wiring";
import {
  CLIENT_MODULE_NAME,
  createWiredChannelFactory,
  createWiredChannelPool,
  wiringStateOf,
  WIRING_STATE,
} from "./index";
import type { WiringState } from "./index";
import { makeSocketDouble } from "./scripted-harness";
import type { SocketDouble } from "./scripted-harness";

/* ------------------------------------------------------------------------- */
/* The rig                                                                   */
/* ------------------------------------------------------------------------- */

/** The engine facade the wiring reads. A literal, never a real `Engine`. */
type Source = { endpoint: Endpoint | null };

/** One channel's connection, as this rig builds it. */
interface Opened {
  readonly url: string;
  readonly token: string;
  readonly socket: SocketDouble;
  readonly transport: EngineTransport;
}

/** The rig: a pool over in-memory connections, plus everything a case observes. */
interface Rig {
  readonly pool: ChannelPool;
  readonly clock: FakeClock;
  readonly source: Source;
  /** Every dial this rig performed, in call order. */
  readonly opened: Opened[];
  /** Ids the wiring minted, in call order, so a case never parses a frame. */
  readonly minted: string[];
  /** Make the facade report an endpoint (or nothing) without rebuilding the pool. */
  setEndpoint(endpoint: Endpoint | null): void;
  /** The opener this rig injected; one entry in {@link opened} per call. */
  readonly open: TransportOpener;
  /** Settle the pending dial(s): microtask turns, never a wall-clock wait. */
  settle(): Promise<void>;
  /** One agent's connection; throws when it was never opened. */
  connection(agentId: string): Opened;
  /** Record which agent the next synchronous dial belongs to. */
  assign(agentId: string): void;
}

/** Rig ids are plain strings; nothing here is an engine concept. */
const AGENTS = ["ada", "grace"] as const;

/**
 * Build a rig over the real kernel, the real transport and a real socket stub.
 *
 * The transport is `createTransport` - the same implementation `openTransport`
 * wraps - so a frame written by a channel, a frame delivered to a socket and a
 * close reported by a socket all travel the production path. Only the dial is
 * replaced, which is the one step that would need a network.
 *
 * The opener receives only a URL and a token, by design (the transport needs
 * nothing else), so the agent id is attached by {@link openChannel} right after
 * the synchronous `getChannel` call that triggered the dial. That mapping is
 * explicit rather than inferred from array order, so an off-by-one cannot hide.
 *
 * @param options the endpoint the facade starts out with
 * @returns the rig, closed by {@link rigOf}'s teardown
 */
function makeRig(options: { readonly endpoint?: Endpoint | null } = {}): Rig {
  const clock = trackClock(makeClock());
  const opened: Opened[] = [];
  const byAgent = new Map<string, Opened>();
  // `undefined` means "the rig's default"; `null` is a real value here (the
  // facade has no endpoint), so `??` would erase the case under test.
  const source: Source = {
    endpoint: options.endpoint === undefined ? endpointFor(AGENTS[0]) : options.endpoint,
  };
  let nextAgent: string | null = null;
  const minted: string[] = [];
  const mint = (): string => {
    const id = `minted-${String(minted.length + 1)}`;
    minted.push(id);
    return id;
  };

  const open: TransportOpener = (url, token) => {
    const socket = makeSocketDouble();
    const transport = createTransport(socket.socket, { now: () => clock.clock.now() });
    const entry: Opened = { url, token, socket, transport };
    opened.push(entry);

    if (nextAgent !== null) {
      byAgent.set(nextAgent, entry);
    }

    return Promise.resolve(transport);
  };

  const pool = createWiredChannelPool(source, {
    open,
    clock: clock.clock,
    reader: makeReader(),
    probe: makeProbe(),
    knownEventTypes: MODELLED,
    // Injected so a case knows the id without parsing a frame: reading the
    // correlation field out of the bytes would mean this test file restates wire
    // vocabulary, which no file under `client/` may contain.
    mintRequestId: mint,
  });

  return {
    pool,
    clock,
    source,
    opened,
    minted,
    open,
    setEndpoint: (endpoint) => {
      source.endpoint = endpoint;
    },
    settle: async () => {
      // The factory starts the dial and returns; a microtask turn is what it takes
      // for the injected opener's resolved promise to run its `then`. Twice,
      // because the rejection path in one case goes through one more hop.
      await Promise.resolve();
      await Promise.resolve();
    },
    connection: (agentId) => {
      const found = byAgent.get(agentId);
      if (found === undefined) {
        throw new Error(`the rig never opened a connection for "${agentId}"`);
      }
      return found;
    },
    assign: (agentId) => {
      nextAgent = agentId;
    },
  };
}

/** Every rig the current case built, torn down in `afterEach`. */
const liveRigs: { pool: ChannelPool; opened: Opened[] }[] = [];

/**
 * Open one agent's channel and record it for teardown.
 *
 * `getChannel` runs the factory synchronously, and the factory calls the injected
 * opener synchronously before returning, so {@link Rig.assign} is in place for
 * exactly the one dial this call makes.
 *
 * @param rig the rig
 * @param agentId the agent to open
 * @returns the wired channel the pool handed out
 */
function openChannel(rig: Rig, agentId: string): WiredChannel {
  rig.assign(agentId);
  try {
    return rig.pool.getChannel(agentId) as WiredChannel;
  } finally {
    rig.assign("");
  }
}

/**
 * The wiring state of a channel, failing the case when it is absent.
 *
 * @param channel the channel the pool handed out
 * @returns its wiring state
 */
function stateOf(channel: Channel): WiringState {
  const state = wiringStateOf(channel);
  if (state === undefined) {
    throw new Error("the pool handed out a channel the wiring did not build");
  }
  return state;
}

/** A per-agent endpoint. The URL names the agent so a shared one is visible. */
function endpointFor(agentId: string): Endpoint {
  return { url: `ws://127.0.0.1:7022/${agentId}`, token: `token-for-${agentId}` };
}

/**
 * The event types this rig's channels are told they model.
 *
 * The rig's frames are `channel-test-support`'s markers, so the modelled set is
 * exactly those - naming a real engine type here would be a wire id.
 */
const MODELLED: ReadonlySet<string> = new Set(["test.ping", "test.status"]);

afterEach(() => {
  while (liveRigs.length > 0) {
    const rig = liveRigs.pop();
    if (rig === undefined) {
      continue;
    }
    try {
      rig.pool.closeAll();
    } catch {
      // Teardown must not fail the case it is cleaning up after.
    }
    for (const entry of rig.opened) {
      try {
        entry.transport.close();
      } catch {
        // Same reasoning.
      }
    }
  }

  assertNoLeakedTimers();
});

/**
 * Build a rig and register it for teardown.
 *
 * @param options see {@link makeRig}
 * @returns the registered rig
 */
function rigOf(options: { readonly endpoint?: Endpoint | null } = {}): Rig {
  const rig = makeRig(options);
  liveRigs.push({ pool: rig.pool, opened: rig.opened });
  return rig;
}

/**
 * Send one tracked request and answer it immediately, on the same agent's socket.
 *
 * A tracked send waits for a correlated answer, so a case that just awaited one
 * would hang until the test timeout - the failure mode Spent 93 seconds on.
 * Answering is also the only honest way to assert `ok: true`: a send that was
 * written but never acknowledged has not succeeded.
 *
 * The answer is built from the request's own id, read back out of the bytes the
 * channel wrote. That keeps the case free of any minting rule: whatever id the
 * wiring chose is the id that comes back.
 *
 * @param rig the rig
 * @param agentId the agent whose socket answers
 * @param channel that agent's channel
 * @param request the request to send
 * @returns the settled result
 */
async function answered(
  rig: Rig,
  agentId: string,
  channel: Channel,
  request: Parameters<Channel["send"]>[0],
): Promise<CommandResult> {
  const socket = rig.connection(agentId).socket;
  const before = socket.sent.length;
  const knownBefore = rig.minted.length;
  const pending = channel.send(request);

  await rig.settle();

  if (socket.sent.length === before) {
    throw new Error(`the channel wrote no frame for ${request.capability}`);
  }

  // The id the wiring used, taken from the rig's own mint instead of the bytes.
  // A supplied id wins over the mint, so `request.requestId` is preferred.
  const id = request.requestId ?? rig.minted[knownBefore] ?? "";
  socket.emitMessage(responseFrame(String(id)));

  return pending;
}

/* ------------------------------------------------------------------------- */
/* The barrel                                                                */
/* ------------------------------------------------------------------------- */

describe("client barrel", () => {
  it("names itself, so it is not a pure forwarding module", () => {
    // `scripts/check-module-ownership.mjs` rejects a module whose every statement
    // forwards, and this is the local declaration that keeps this one out of that
    // class. Asserting the value pins the export that `core/index.ts` and a log
    // line will both read.
    expect(CLIENT_MODULE_NAME).toBe("@haruyuki/core/engine/client");
  });

  it("re-exports the wiring entry point a shell calls", () => {
    expect(typeof createWiredChannelPool).toBe("function");
    expect(typeof createWiredChannelFactory).toBe("function");
    expect(typeof wiringStateOf).toBe("function");
    expect(typeof WIRING_STATE).toBe("symbol");
  });
});

/* ------------------------------------------------------------------------- */
/* Per-channel dedupe (V-9 extension,  §3.2)                          */
/* ------------------------------------------------------------------------- */

describe("per-channel dedupe table", () => {
  it("gives two agents two different tables", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    const grace = openChannel(rig, AGENTS[1]);
    await rig.settle();

    // Identity, not behaviour: a shared table could still pass a behaviour-only
    // assertion as long as only one agent happened to use it.
    expect(stateOf(ada).dedupe).not.toBe(stateOf(grace).dedupe);
  });

  it("gives one agent the same table across two getChannel calls", async () => {
    const rig = rigOf();
    const first = openChannel(rig, AGENTS[0]);
    const second = rig.pool.getChannel(AGENTS[0]) as WiredChannel;

    // Same instance is the pool's documented "one channel per agent"; the
    // dedupe table has to follow the channel, or a rebuilt channel would inherit a
    // half-used table.
    expect(second).toBe(first);
    expect(stateOf(second).dedupe).toBe(stateOf(first).dedupe);
  });

  it("does not let one agent's id suppress another's", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    const grace = openChannel(rig, AGENTS[1]);
    await rig.settle();

    const shared = "caller-supplied-id";
    const adaResult = await answered(rig, AGENTS[0], ada, {
      capability: TRACKED,
      body: {},
      runtime: { agent_id: AGENTS[0], conversation_id: "c-ada" },
      requestId: shared,
    });
    const graceResult = await answered(rig, AGENTS[1], grace, {
      capability: TRACKED,
      body: {},
      runtime: { agent_id: AGENTS[1], conversation_id: "c-grace" },
      requestId: shared,
    });

    // Both are accepted: the same id is only "taken" inside one agent's table. A
    // module-level singleton would refuse the second as a duplicate, which is the
    // outbound flavour of the cross-talk a per-agent connection exists to prevent.
    expect(adaResult.ok).toBe(true);
    expect(graceResult.ok).toBe(true);
    expect(rig.connection(AGENTS[0]).socket.sent).toHaveLength(1);
    expect(rig.connection(AGENTS[1]).socket.sent).toHaveLength(1);
  });

  it("refuses a repeated id on the same channel, without writing twice", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    const request = {
      capability: TRACKED,
      body: {},
      runtime: { agent_id: AGENTS[0], conversation_id: "c-ada" },
      requestId: "one-shot",
    } as const;

    const first = await answered(rig, AGENTS[0], ada, request);
    const second = await ada.send(request);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("REJECTED");
    }
    // One frame, not two: the second send never reached the socket.
    expect(rig.connection(AGENTS[0]).socket.sent).toHaveLength(1);
  });

  it("does not track the capabilities whose wire carries no id", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    // Each of these is sent twice with the same body. None of them may enter the
    // table, so both go out - "two keystrokes are two keystrokes".
    for (const capability of UNTRACKED) {
      const request = {
        capability,
        body: {},
        runtime: { agent_id: AGENTS[0], conversation_id: "c-ada" },
      } as const;
      await ada.send(request);
      await ada.send(request);
    }

    expect(stateOf(ada).dedupe.size).toBe(0);
    expect(rig.connection(AGENTS[0]).socket.sent).toHaveLength(UNTRACKED.length * 2);
  });

  it("claims an id for a silent capability, which carries one but is never answered", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    const capability = SILENT[0];
    const request = {
      capability,
      body: {},
      runtime: { agent_id: AGENTS[0], conversation_id: "c-ada" },
      requestId: "silent-id",
    } as const;

    await ada.send(request);
    // A silent capability has a correlation id on the wire, so a second send of
    // the same id is a duplicate even though nothing ever answers the first.
    const again = await ada.send(request);

    expect(again.ok).toBe(false);
    expect(stateOf(ada).dedupe.has("silent-id")).toBe(true);
  });

  it("mints an id for a tracked send that the caller left open", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    // The id is minted by the wiring, so the case reads it from the rig's mint
    // rather than from the frame bytes - naming the wire field would put a
    // protocol literal in `client/`, which this directory forbids.
    const knownBefore = rig.minted.length;
    const pending = ada.send({
      capability: TRACKED,
      body: {},
      runtime: { agent_id: AGENTS[0], conversation_id: "c-ada" },
    });

    await rig.settle();
    const written = rig.connection(AGENTS[0]).socket.sent[0];
    expect(typeof written).toBe("string");

    const id = rig.minted[knownBefore];
    expect(typeof id).toBe("string");

    rig.connection(AGENTS[0]).socket.emitMessage(responseFrame(String(id)));
    const result = await pending;
    expect(result.ok).toBe(true);
    // The table holds exactly the id the wiring chose.
    expect(stateOf(ada).dedupe.size).toBe(1);
    expect(stateOf(ada).dedupe.has(String(id))).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* Closing                                                                   */
/* ------------------------------------------------------------------------- */

describe("close path", () => {
  it("closes the transport, not only the kernel", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    const connection = rig.connection(AGENTS[0]);
    expect(connection.transport.isOpen).toBe(true);

    ada.close();

    // The half the wiring must own: a kernel-only close leaves this socket open
    // and leaks the connection.
    expect(connection.transport.isOpen).toBe(false);
    expect(ada.isClosed()).toBe(true);
  });

  it("reports closure through isClosed so the pool drops the entry", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    ada.close();

    // `pool.ts` duck-types `isClosed`; a wrapper that dropped it would leave a
    // zombie entry and hand every later send a closed channel.
    expect(rig.pool.channels()).toHaveLength(0);
    const rebuilt = rig.pool.getChannel(AGENTS[0]) as WiredChannel;
    expect(rebuilt).not.toBe(ada);
  });

  it("closes only its own connection when the pool closes one agent", async () => {
    const rig = rigOf();
    openChannel(rig, AGENTS[0]);
    openChannel(rig, AGENTS[1]);
    await rig.settle();

    rig.pool.closeChannel(AGENTS[0]);

    expect(rig.connection(AGENTS[0]).transport.isOpen).toBe(false);
    // The neighbour is untouched: one agent's close is one agent's close.
    expect(rig.connection(AGENTS[1]).transport.isOpen).toBe(true);
  });
  it("refuses a send after the connection is closed", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    rig.connection(AGENTS[0]).socket.emitClose("the peer went away");
    await rig.settle();

    const result = await ada.send({
      capability: TRACKED,
      body: {},
      runtime: { agent_id: AGENTS[0], conversation_id: "c-ada" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_CONNECTED");
    }
    // The wiring recorded why, which is what a field report needs.
    expect(stateOf(ada).closeReasons()).toEqual(["the peer went away"]);
  });
});

/* ------------------------------------------------------------------------- */
/* The dialect: url/token reach the opener, frames go both ways               */
/* ------------------------------------------------------------------------- */

describe("transport wiring", () => {
  it("dials the endpoint the facade published, per agent", async () => {
    const rig = rigOf({ endpoint: endpointFor(AGENTS[0]) });
    openChannel(rig, AGENTS[0]);
    openChannel(rig, AGENTS[1]);
    await rig.settle();

    // Both agents get the *same* engine endpoint: one engine process, one URL -
    // the pool is what gives each agent its own connection.
    expect(rig.opened).toHaveLength(2);
    for (const entry of rig.opened) {
      expect(entry.url).toBe(endpointFor(AGENTS[0]).url);
      expect(entry.token).toBe(endpointFor(AGENTS[0]).token);
    }
  });

  it("ingests an inbound frame as an event with its marker intact", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    const events: unknown[] = [];
    ada.onEvent((frame) => {
      events.push((frame.raw as { marker?: unknown }).marker);
    });

    rig.connection(AGENTS[0]).socket.emitMessage(eventFrame("test.ping", { marker: "m-1" }));

    // `raw` is not rewritten: the marker the engine wrote is the marker read back.
    expect(events).toEqual(["m-1"]);
  });

  it("resolves a tracked send when a correlated answer arrives", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    const pending = ada.send({
      capability: TRACKED,
      body: {},
      runtime: { agent_id: AGENTS[0], conversation_id: "c-ada" },
      requestId: "correlated",
    });

    rig.connection(AGENTS[0]).socket.emitMessage(responseFrame("correlated", { data: { ok: 1 } }));

    const result: CommandResult = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ ok: 1 });
    }
  });

  it("reports the transport failure instead of hanging when the dial fails", async () => {
    const rig = rigOf();
    const failing: TransportOpener = () => Promise.reject(new Error("the port was closed"));
    const pool = createWiredChannelPool(rig.source, { open: failing, reader: makeReader() });
    const channel = pool.getChannel(AGENTS[0]) as WiredChannel;
    await rig.settle();
    await Promise.resolve();

    // No unhandled rejection, a recorded reason, and a send that answers quickly.
    expect(stateOf(channel).openFailure()).toBe("the port was closed");
    const result = await channel.send({
      capability: TRACKED,
      body: {},
      runtime: { agent_id: AGENTS[0], conversation_id: "c-ada" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_CONNECTED");
    }
    pool.closeAll();
  });
});

/* ------------------------------------------------------------------------- */
/* The endpoint seam, from this side                                          */
/* ------------------------------------------------------------------------- */

describe("endpoint seam, as the wiring observes it", () => {
  it("refuses to build a channel while the facade has no endpoint", async () => {
    const rig = rigOf({ endpoint: null });
    const channel = rig.pool.getChannel(AGENTS[0]);

    // The pool degrades this one agent instead of caching a stand-in: nothing was
    // dialled, and the caller gets a NOT_CONNECTED answer rather than a channel
    // that could never send.
    expect(rig.opened).toHaveLength(0);
    expect(rig.pool.channels()).toHaveLength(0);

    const result = await channel.send({
      capability: TRACKED,
      body: {},
      runtime: { agent_id: AGENTS[0], conversation_id: "c-ada" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_CONNECTED");
      // The "never came up" wording, which B3 branches on.
      expect(result.error.detail).toContain("has not become ready");
    }
  });

  it("builds a channel once the endpoint appears", async () => {
    const rig = rigOf({ endpoint: null });
    rig.setEndpoint(endpointFor(AGENTS[0]));

    const channel = openChannel(rig, AGENTS[0]);
    await rig.settle();

    expect(rig.opened).toHaveLength(1);
    expect(rig.connection(AGENTS[0]).url).toBe(endpointFor(AGENTS[0]).url);
    expect(channel.isClosed()).toBe(false);
  });

  it("keeps the token off every surface a log or a crash record reads", async () => {
    const rig = rigOf({ endpoint: endpointFor(AGENTS[0]) });
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    const token = endpointFor(AGENTS[0]).token;
    const url = endpointFor(AGENTS[0]).url;

    // The token is a plaintext leak surface. The
    // channel does not carry the endpoint at all, so no enumeration can recover it.
    expect(Object.keys(ada)).not.toContain("endpoint");
    expect(Object.keys(ada)).not.toContain("token");
    expect(JSON.stringify(ada)).not.toContain(token);
    expect(JSON.stringify(ada)).not.toContain(url);
    expect(Object.keys(rig.pool)).not.toContain("endpoint");
    expect(JSON.stringify(rig.pool)).not.toContain(token);
  });

  it("scrubs the token out of a diagnostic the engine echoed back", async () => {
    const rig = rigOf({ endpoint: endpointFor(AGENTS[0]) });
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    const token = endpointFor(AGENTS[0]).token;
    const subjects: string[] = [];
    const texts: (string | undefined)[] = [];
    ada.onDiagnostic((record) => {
      subjects.push(record.subject);
      texts.push(record.engineText);
    });

    // An engine that echoes the credential back **bare**, inside a refusal: the
    // one shape where the token would reach a record without the wiring
    // configuring it as a secret.  shape rules run either way, and a short
    // test token (`token-for-ada`) matches none of them - no `Bearer` prefix, no
    // 32-character run - so only the per-channel `secrets` list can erase it
    //  §3.6.2 boundary 2, and `ChannelOptions.secrets` on why the list
    // exists).
    const pending = ada.send({
      capability: TRACKED,
      body: {},
      runtime: { agent_id: AGENTS[0], conversation_id: "c-ada" },
      requestId: "echoes-token",
    });
    rig.connection(AGENTS[0]).socket.emitMessage(
      responseFrame("echoes-token", {
        ok: false,
        error: { code: "REJECTED", detail: "refused", engineText: `refused for ${token}` },
      }),
    );
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.join("|")).not.toContain(token);
    expect(texts.join("|")).toContain("<redacted-token>");
    expect(subjects.join("|")).not.toContain(token);
  });

  it("keeps the wiring state off the enumerable surface", async () => {
    const rig = rigOf();
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    // The state handle is a symbol precisely so a spread or a `JSON.stringify`
    // cannot carry it into a log. It also must not leak the token through it.
    expect(JSON.stringify(ada)).not.toContain("dedupe");
    expect(Object.keys(stateOf(ada))).not.toContain("endpoint");
    expect(JSON.stringify(rig.connection(AGENTS[0]).socket.sent)).not.toContain(
      endpointFor(AGENTS[0]).token,
    );
  });
});

/* ------------------------------------------------------------------------- */
/*  `endpoint` vs `state`, driven through the real facade                */
/* ------------------------------------------------------------------------- */

/**
 * Start a fake engine through the real `start` path, returning the live facade.
 *
 * The child is the shared launcher (`fakeEngineSource`), so it prints the same
 * `WebSocket:` line a real engine does and the facade discovers the URL from
 * stdout - which is precisely why the caller cannot reconstruct the endpoint and
 * why `Engine.endpoint` had to exist (`` §3.6.1).
 *
 * Lives here rather than in a new file under `engine/`: `client/wiring.test.ts`
 * is one of the three files this work package owns, and the assertion is about
 * the seam the wiring reads, not about B1's own behaviour.
 *
 * @param options `answer: false` makes the stub park in `handshaking`
 * @returns the engine and the transitions it reported
 */
async function startFakeEngine(
  options: { readonly answer?: boolean; readonly handshakeTimeoutMs?: number } = {},
): Promise<{ engine: Engine; states: EngineState[] }> {
  const root = await makeRoot();
  const stub = await startHandshakeStub(options.answer === false ? { answer: false } : {});
  const engine = startTracking();
  const states: EngineState[] = [];
  engine.onState((state) => states.push(state));

  await engine.start({
    spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, `${root}/engine.pid`), root),
    tokenDir: root,
    expectedEngineVersion: ENGINE_VERSION,
    portTimeoutMs: 5_000,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 2_000,
  });

  return { engine, states };
}

describe("endpoint: non-null only in ready", () => {
  it("is null on a fresh facade", async () => {
    const engine = startTracking();

    expect(engine.state).toBe("idle");
    expect(engine.endpoint).toBeNull();
    // Registered for teardown even though nothing started; `releaseFixtures`
    // stops it and `kill` is a no-op on an idle facade.
    await Promise.resolve();
  });

  it("exposes nothing in spawning or handshaking, and everything in ready", async () => {
    const root = await makeRoot();
    const stub = await startHandshakeStub();
    const engine = startTracking();

    // Sampled inside the listener, which runs after the internal field was
    // written (`transition` notifies last) - the window a caller observes.
    const observed: { state: EngineState; hasEndpoint: boolean }[] = [];
    engine.onState((state) => {
      observed.push({ state, hasEndpoint: engine.endpoint !== null });
    });

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, `${root}/engine.pid`), root),
      tokenDir: root,
      expectedEngineVersion: ENGINE_VERSION,
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    expect(engine.state).toBe("ready");
    expect(engine.endpoint).not.toBeNull();

    // The this case regression line: a `socketState`-proxy getter turns `handshaking`
    // non-null, because the socket opens before the handshake answer arrives.
    const beforeReady = observed.filter((row) => row.state !== "ready");
    expect(beforeReady.length).toBeGreaterThan(0);
    for (const row of beforeReady) {
      expect(row, `state "${row.state}" must not expose an endpoint`).toEqual({
        state: row.state,
        hasEndpoint: false,
      });
    }

    const ready = observed.filter((row) => row.state === "ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]?.hasEndpoint).toBe(true);
  });

  it("is null at the moment the socket opens but the handshake has not answered", async () => {
    const root = await makeRoot();
    const stub = await startHandshakeStub();
    const engine = startTracking();

    // The one window `this case` is about, sampled from inside it. A frame listener
    // runs when the raw frame arrives - which is *after* `openSocket` set
    // `socketState = "open"` and *before* the handshake promise resumes the
    // `start` continuation that transitions to `ready`. So this callback is the
    // only place a test can stand in the gap without racing a timer.
    const samples: {
      state: EngineState;
      socketState: string;
      hasEndpoint: boolean;
    }[] = [];
    engine.onFrame(() => {
      samples.push({
        state: engine.state,
        socketState: engine.socketState,
        hasEndpoint: engine.endpoint !== null,
      });
    });

    await engine.start({
      spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, `${root}/engine.pid`), root),
      tokenDir: root,
      expectedEngineVersion: ENGINE_VERSION,
      portTimeoutMs: 5_000,
      handshakeTimeoutMs: 2_000,
    });

    // At least one sample was taken in the gap, and it is the shape that proves
    // which gate the getter uses: the transport says "open", the facade says
    // "handshaking", and the endpoint says "not yet".
    const inTheGap = samples.filter((row) => row.state === "handshaking");
    expect(inTheGap.length).toBeGreaterThan(0);
    for (const row of inTheGap) {
      expect(row.socketState).toBe("open");
      expect(row.hasEndpoint).toBe(false);
    }

    // A `socketState`-proxy getter would answer `true` above; this asserts the
    // facade agrees with itself once it is genuinely ready.
    expect(engine.state).toBe("ready");
    expect(engine.endpoint).not.toBeNull();
  });

  it("reports the discovered url and a real token, stable and frozen", async () => {
    const { engine } = await startFakeEngine();
    const endpoint = engine.endpoint;

    expect(endpoint).not.toBeNull();
    if (endpoint === null) {
      return;
    }

    // The URL is the one the child printed: a wrong URL never completes the
    // handshake against this stub, so reaching `ready` proves it.
    expect(endpoint.url.startsWith("ws://127.0.0.1:")).toBe(true);
    // `generateToken()` is 32 bytes of random material; a short value would mean
    // this field is not the token.
    expect(endpoint.token.length).toBeGreaterThan(12);
    expect(endpoint.token).not.toContain(" ");

    // One object per ready attempt, so a caller can compare or cache it.
    expect(engine.endpoint).toBe(endpoint);
    // Frozen: the value is a report, not a control.
    expect(Object.isFrozen(endpoint)).toBe(true);
    expect(() => {
      (endpoint as { url: string }).url = "ws://127.0.0.1:1/nope";
    }).toThrow();
  });

  it("returns to null after stopGraceful", async () => {
    const { engine } = await startFakeEngine();
    expect(engine.endpoint).not.toBeNull();

    await engine.stopGraceful(1_000);

    expect(engine.state).toBe("closed");
    expect(engine.endpoint).toBeNull();
  });

  it("returns to null after kill", async () => {
    const { engine } = await startFakeEngine();
    expect(engine.endpoint).not.toBeNull();

    engine.kill();

    expect(engine.endpoint).toBeNull();
  });

  it("never exposes an endpoint during a start that fails in handshaking", async () => {
    const root = await makeRoot();
    // The stub accepts the upgrade and never answers, so the socket reaches
    // `"open"` while the facade is still `handshaking` - the exact window
    // §3.6.2.1 describes, driven end to end.
    const stub = await startHandshakeStub({ answer: false });
    const engine = startTracking();

    const observed: { state: EngineState; hasEndpoint: boolean }[] = [];
    engine.onState((state) => {
      observed.push({ state, hasEndpoint: engine.endpoint !== null });
    });

    await expect(
      engine.start({
        spawnSpec: fakeEngineSpec(fakeEngineSource(stub.url, `${root}/engine.pid`), root),
        tokenDir: root,
        expectedEngineVersion: ENGINE_VERSION,
        portTimeoutMs: 5_000,
        handshakeTimeoutMs: 150,
      }),
    ).rejects.toThrow();

    expect(engine.state).toBe("failed");
    expect(engine.endpoint).toBeNull();

    for (const row of observed) {
      expect(row, `state "${row.state}" must not expose an endpoint`).toEqual({
        state: row.state,
        hasEndpoint: false,
      });
    }
  });
});
