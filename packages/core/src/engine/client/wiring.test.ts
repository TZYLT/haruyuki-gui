/**
 * 接线本体的验收（`wiring.ts`）。
 *
 * 约束：三条数据流 + 去重表按通道隔离；socket 关闭归属接线，关闭路径必须同时
 * 合上 transport；token 是明文泄漏面，不得进入日志或崩溃记录。
 *
 * 四组判据：
 * 1. **去重表按通道隔离**：两个 agent 的实例 `!==`，同一 agent 两次 `getChannel`
 *    拿到同一个。只能按 identity 断言——只测行为的话，共享表恰好只被一个 agent
 *    用过也会绿。
 * 2. **关闭路径合上 transport**：`close()` 之后连接确实关了，不只关内核。
 * 3. **传输接线**：url/token 到达 opener；帧双向通行；相关答复能 settle；未注入
 *    `reader` 时**默认 reader 生效**。
 * 4. **接线侧的 `endpoint` 观察**：`null` 时退化为 `NOT_CONNECTED`；token 只作为
 *    脱敏词进入通道。
 *
 * `Engine.endpoint` 本身（七条判据 + token 泄漏面）在
 * `wiring-endpoint.test.ts`；两者共用的夹具在 `wiring-rig.ts`。
 *
 * 纪律：零 wire id——帧由 `channel-test-support` 的 marker 构造器生成，
 * 能力名用该文件的常量；不拨真网络（注入 `makeSocketDouble`）；不用 `setTimeout`
 * 等竞态，用微任务轮次。
 */

import { afterEach, describe, expect, it } from "vitest";

import { eventFrame, makeReader, responseFrame, SILENT, UNTRACKED } from "./channel-test-support";
import type { Channel } from "./types";
import type { CommandResult } from "./types";
import {
  AGENTS,
  answered,
  endpointFor,
  openChannel,
  releaseRigs,
  rigOf,
  stateOf,
  tracked,
} from "./wiring-rig";
import type { TransportOpener, WiredChannel } from "./wiring";
import {
  CLIENT_MODULE_NAME,
  createWiredChannelFactory,
  createWiredChannelPool,
  wiringStateOf,
  WIRING_STATE,
} from "./index";

afterEach(() => {
  releaseRigs();
});

/* --- The barrel --- */

describe("client barrel", () => {
  it("names itself, so it is not a pure forwarding module", () => {
    // The module-ownership gate rejects a module whose every statement forwards;
    // this local declaration is what keeps this one out of that class.
    expect(CLIENT_MODULE_NAME).toBe("@haruyuki/core/engine/client");
  });

  it("re-exports the wiring entry point a shell calls", () => {
    expect(typeof createWiredChannelPool).toBe("function");
    expect(typeof createWiredChannelFactory).toBe("function");
    expect(typeof wiringStateOf).toBe("function");
    expect(typeof WIRING_STATE).toBe("symbol");
  });
});

/* --- Per-channel dedupe --- */

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
      ...tracked(AGENTS[0]),
      requestId: shared,
    });
    const graceResult = await answered(rig, AGENTS[1], grace, {
      ...tracked(AGENTS[1]),
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
      ...tracked(AGENTS[0]),
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
      const request = { ...tracked(AGENTS[0]), capability };
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
    const request = { ...tracked(AGENTS[0]), capability, requestId: "silent-id" } as const;

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
      ...tracked(AGENTS[0]),
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

/* --- Closing --- */

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

    const result = await ada.send({ ...tracked(AGENTS[0]) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_CONNECTED");
    }
    // The wiring recorded why, which is what a field report needs.
    expect(stateOf(ada).closeReasons()).toEqual(["the peer went away"]);
  });
});

/* --- Transport wiring --- */

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
      ...tracked(AGENTS[0]),
      requestId: "correlated",
    });

    rig.connection(AGENTS[0]).socket.emitMessage(responseFrame("correlated", { data: { ok: 1 } }));

    const result: CommandResult = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ ok: 1 });
    }
  });

  it("settles a tracked send through the REAL reader when none is injected", async () => {
    // The one path every production caller takes: no `reader` option, so
    // the wiring installs `createFrameReader`. Every other case here passes
    // `makeReader()`, which is why the default went untested - and a default that
    // silently decoded nothing would turn every command into a TIMEOUT on the real
    // stack while the whole file stayed green.
    // `reader: null` is the point: the rig passes no reader key at all, so the
    // wiring's own default decides. Everything else stays production-shaped.
    const rig = rigOf({ endpoint: endpointFor(AGENTS[0]), reader: null });
    const ada = openChannel(rig, AGENTS[0]);
    await rig.settle();

    const pending = ada.send({ ...tracked(AGENTS[0]), requestId: "default-reader" });

    // A real reply shape: the correlation field plus a boolean verdict, which is
    // what `frame-reader.ts` looks for. `responseFrame` cannot be used here - it
    // wraps the answer in this suite's own `reply` marker, which only the test
    // double understands.
    rig
      .connection(AGENTS[0])
      .socket.emitMessage(
        JSON.stringify({ request_id: "default-reader", success: true, value: 7 }),
      );

    // `settle` into ok, not TIMEOUT: a suite whose only reader is a double proves
    // nothing about the reader production actually installs.
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ value: 7 });
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
    const result = await channel.send({ ...tracked(AGENTS[0]) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_CONNECTED");
    }
    pool.closeAll();
  });
});

/* --- The endpoint seam --- */

describe("endpoint seam, as the wiring observes it", () => {
  it("refuses to build a channel while the facade has no endpoint", async () => {
    const rig = rigOf({ endpoint: null });
    const channel = rig.pool.getChannel(AGENTS[0]);

    // The pool degrades this one agent instead of caching a stand-in: nothing was
    // dialled, and the caller gets a NOT_CONNECTED answer rather than a channel
    // that could never send.
    expect(rig.opened).toHaveLength(0);
    expect(rig.pool.channels()).toHaveLength(0);

    const result = await channel.send({ ...tracked(AGENTS[0]) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_CONNECTED");
      // The "never came up" wording, which the reconnect policy branches on.
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
    // configuring it as a secret. The default redaction patterns look for a
    // `Bearer` prefix or a 32-character run, neither of which this short test
    // token (`token-for-ada`) has - so only the per-channel `secrets` list can
    // erase it (`ChannelOptions.secrets` says why the list exists).
    const pending = ada.send({
      ...tracked(AGENTS[0]),
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
