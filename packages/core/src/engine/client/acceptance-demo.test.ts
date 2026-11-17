/**
 * B2 验收演示 —— 不是测试，是**给用户看的一次演示**。
 *
 * 它跑在测试框架里只因为那是仓库里唯一不需要额外安装东西的 TypeScript
 * 运行器。它做的事是：起一个本机的假引擎，用 B2 的客户端连上去，做四件事，
 * 把每一步**它看见什么**打印出来。
 *
 * 用户看的是打印出来的那几十行，不是测试报告。
 *
 * ## 为什么用假引擎
 *
 * 真引擎要 spawn 子进程、写 token 文件、等它变 ready，而用户机器上不一定装了。
 * 假引擎是仓库里已有的 `fixtures/`（`ws` 服务端），它说的协议与真引擎相同——
 * 下面这四件事是 B2 的职责，与引擎真假无关。
 *
 * ## 这四条为什么值得看
 *
 * 它们是用户能感知的行为，不是实现细节：
 *   1. 连上并完成握手
 *   2. 发一条命令，拿到答复，且**答复被正确配对到这个请求**
 *   3. 引擎主动推送的事件能收到
 *   4. 关掉一个 agent 的通道，另一个 agent 的**不受影响**（一连接对一 agent）
 *
 * 第 4 条是用户当初推翻「一连接挂 2 订阅」时的全部理由，所以它必须能被看见。
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { buildFrame, createChannel, createFrameReader, openTransport } from "./index";
import type { EngineTransport, InboundFrame } from "./transport";

/**
 * `ws` is a dependency of `packages/core`, not of the repo root (pnpm does not
 * hoist), so it is resolved from that package - the same anchor the fixture uses.
 */
const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");

/**
 * The three frame types the demo sends, taken from the contract snapshot rather
 * than spelled here.
 *
 * The wire-vocabulary rule keeps engine vocabulary out of this directory, and the
 * over every file - including test files that would otherwise be a convenient
 * place to write "just this one type name". Reading them from the snapshot keeps
 * the demo honest about speaking the real protocol without becoming a second
 * source of names.
 */
function demoTypes(): {
  readonly handshakeReply: string;
  readonly commandReply: string;
  readonly push: string;
} {
  const snapshot = JSON.parse(
    readFileSync(
      new URL("../../../../protocol/src/contract/snapshot.json", import.meta.url),
      "utf8",
    ),
  ) as { messages: { wire: string }[] };

  const wires = snapshot.messages.map((message) => message.wire);
  const repeats = wires.find((wire) => wire.endsWith("_response"));
  const push = wires.find((wire) => !wire.endsWith("_response"));

  if (repeats === undefined || push === undefined) {
    throw new Error("snapshot.json yielded no usable frame types; the demo needs real vocabulary");
  }

  return { handshakeReply: repeats, commandReply: repeats, push };
}

const TYPES = demoTypes();

/* ------------------------------------------------------------------------- */
/* 一个说人话的假引擎                                                        */
/* ------------------------------------------------------------------------- */

type DemoEngine = {
  readonly url: string;
  readonly connections: number;
  stop: () => Promise<void>;
};

/**
 * Says a fixed set of things, in prose a person can judge.
 *
 * Not the shared fixture: that one exists to exercise protocol corners and its
 * output is unreadable on purpose. A demo needs output a non-developer can read.
 */
async function startDemoEngine(): Promise<DemoEngine> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const tickers = new Set<NodeJS.Timeout>();
  let connections = 0;

  wss.on(
    "connection",
    (socket: {
      readyState: number;
      send: (data: string) => void;
      on: (event: string, handler: (...args: never[]) => void) => void;
    }) => {
      connections += 1;

      // The handshake the client is waiting for.
      socket.send(
        JSON.stringify({
          type: TYPES.handshakeReply,
          request_id: "demo-info",
          success: true,
          letta_code_version: "0.6.0",
          protocol_version: 1,
        }),
      );

      // Answer whatever the client sends, matched by id - the client's job is to
      // pair the answer to the request that is still waiting.
      socket.on("message", (raw: Buffer) => {
        let parsed: { request_id?: unknown; type?: unknown };
        try {
          parsed = JSON.parse(raw.toString("utf8")) as typeof parsed;
        } catch {
          return;
        }
        const id = parsed.request_id;
        if (typeof id !== "string") {
          return;
        }
        socket.send(
          JSON.stringify({
            type: TYPES.commandReply,
            request_id: id,
            success: true,
            agents: [{ id: "demo-agent", name: "Demo Agent" }],
          }),
        );
      });

      // A push the client did not ask for, which is the common case in production.
      const ticker = setInterval(() => {
        if (socket.readyState !== 1) {
          return;
        }
        socket.send(
          JSON.stringify({
            type: TYPES.push,
            runtime: { agent_id: "demo-agent", conversation_id: "demo-conv" },
            delta: "a token of output",
          }),
        );
      }, 100);
      tickers.add(ticker);

      socket.on("close", () => {
        clearInterval(ticker);
        tickers.delete(ticker);
      });
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const url = `ws://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}/ws`;

  return {
    url,
    get connections() {
      return connections;
    },
    stop: async () => {
      for (const ticker of tickers) {
        clearInterval(ticker);
      }
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => {
            resolve();
          });
        });
      });
    },
  };
}

/* ------------------------------------------------------------------------- */
/* 打印                                                                    */
/* ------------------------------------------------------------------------- */

function say(text = ""): void {
  console.log(text);
}

function head(text: string): void {
  say();
  say(`--- ${text} ---`);
}

function ok(text: string): void {
  say(`  OK   ${text}`);
}

function info(text: string): void {
  say(`       ${text}`);
}

function bad(text: string): void {
  say(`  FAIL ${text}`);
}

/**
 * A clock the channel can use, on real time.
 *
 * The channel takes its timer from the caller so tests can drive it; a demo wants
 * the real thing.
 */
const realClock = {
  now: () => Date.now(),
  startTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  stopTimer: (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  },
};

/** Wire one transport to one channel, the two subscriptions the wiring owns. */
function wire(transport: EngineTransport, channel: ReturnType<typeof createChannel>): () => void {
  const offFrame = transport.onFrame((frame: InboundFrame) => {
    channel.ingest(frame.raw);
  });
  const offClose = transport.onClose(() => {
    channel.close();
  });

  return () => {
    offFrame();
    offClose();
  };
}

/* ------------------------------------------------------------------------- */
/* 演示                                                                      */
/* ------------------------------------------------------------------------- */

describe("B2 acceptance demo", () => {
  it("shows four behaviours a person can judge", async () => {
    const engine = await startDemoEngine();
    const teardown: (() => void)[] = [];

    try {
      say();
      say("================================");
      say(" B2 acceptance demo");
      say("================================");
      info(`a stand-in engine is listening at ${engine.url}`);
      info("nothing is installed and no real engine process is started");

      /* 1 ------------------------------------------------------------------ */
      head("1. connect, and complete the handshake");

      const first = await openTransport(engine.url, "demo-token");
      teardown.push(() => {
        first.close();
      });
      ok("the client opened a connection and completed the handshake");
      info(`the transport reports itself open: ${String(first.isOpen)}`);

      /* 2 ------------------------------------------------------------------ */
      head("2. send a command, and match the answer to it");

      const channel = createChannel({
        agentId: "demo-agent",
        // The kernel decides the class and the id; turning those into bytes is the
        // send path's job.
        write: (request, requestId) => {
          first.send(buildFrame(request, {}, requestId).raw);
          return { ok: true };
        },
        // Production wiring installs this by default; the demo sits below that
        // layer so it names the reader explicitly.
        reader: createFrameReader(),
        readiness: () => ({ ready: first.isOpen, everReady: true }),
        clock: realClock,
      });
      teardown.push(() => {
        channel.close();
      });
      teardown.push(wire(first, channel));

      const reply = await channel.send({
        capability: "agent.list",
        body: {},
        requestId: "demo-1",
      });

      if (reply.ok) {
        ok("the engine answered, and the client matched it to the request it sent");
        info(`answer payload: ${JSON.stringify(reply.data)}`);
      } else {
        bad(`the command did not get an answer: ${reply.error.detail}`);
      }

      /* 3 ------------------------------------------------------------------ */
      head("3. events the engine pushes without being asked");

      const pushed: string[] = [];
      const offPush = first.onFrame((frame) => {
        if (frame.raw.includes(TYPES.push)) {
          pushed.push(frame.raw);
        }
      });
      teardown.push(offPush);

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 320);
      });
      ok(
        `the client received ${String(pushed.length)} pushed event(s) in about a third of a second`,
      );
      if (pushed.length > 0) {
        info(`first one: ${(pushed[0] ?? "").slice(0, 90)}`);
      }

      /* 4 ------------------------------------------------------------------ */
      head("4. closing one agent's channel leaves another agent's alone");

      const second = await openTransport(engine.url, "demo-token");
      teardown.push(() => {
        second.close();
      });
      const third = await openTransport(engine.url, "demo-token");
      teardown.push(() => {
        third.close();
      });

      ok(`three connections are open: ${String(first.isOpen && second.isOpen && third.isOpen)}`);

      channel.close();
      ok("closed the first agent's channel");
      // Sampled here, before teardown closes them - asking later would answer
      // "false" for the wrong reason and this step could never fail.
      const neighboursSurvived = second.isOpen && third.isOpen;
      info(`the other two still report open: ${String(neighboursSurvived)}`);
      info(`connections the engine accepted in total: ${String(engine.connections)}`);

      /* 结论 ---------------------------------------------------------------- */
      say();
      say("================================");
      const allGood = reply.ok && pushed.length > 0 && neighboursSurvived;
      say(
        allGood
          ? " RESULT: all four behaviours were visible"
          : " RESULT: at least one behaviour was NOT visible (see FAIL above)",
      );
      say("================================");
      say();

      // The demo doubles as a check: a person reading the output can judge it, and
      // this line makes a silent regression fail loudly.
      expect(allGood).toBe(true);
    } finally {
      for (const off of teardown.reverse()) {
        off();
      }
      await engine.stop();
    }
  });
});
