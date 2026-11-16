/**
 * 接线层：把 transport、channel、pool、去重表接到 B1 的 `Engine` 门面上。
 *
 
 
 * 路径同时合上 transport"）、§3.6.2（`endpoint` 是开第 2..N 条连接的唯一来源），
 
 *
 * ## 这一层为什么存在
 *
 * `channel.ts` 不碰 socket（它只认 `write` 端口），`transport.ts` 不碰命令（它
 * 只搬文本），`pool.ts` 不碰连接（它只认工厂）。三者之间有一个**环**：transport
 * 要 channel 去 `ingest`，channel 要 transport 去写。环必须有一个人来合上，那个人
 * 就是这里；`pool.ts` 的注释把它叫作"whoever builds both"。
 *
 * 合环的同时也解决四个**只有这一层能解决**的问题：
 *
 * 1. **去重表按通道隔离**：`OutboundDedupe` 曾经从未在
 *    真实栈里被构造。这里**每个通道持有一个实例**，不是模块级单例——单例会让两个
 *    agent 的同名 `request_id` 互相顶掉，那是 `` 要消灭的串台换到出站侧。
 * 2. **关闭路径合上 transport**（ §5.1）：冻结的 `Channel` 面上没有关闭事件，
 *    也没有 transport 的引用；`close()` 归内核，socket 归建了两者的人。少了这一半，
 *    `closeChannel(agentId)` 会留下一条活着的连接，也就是泄漏。
 * 3. **`getChannel` 是同步的，连接是异步的**：工厂必须在返回内核之后**继续**把连接
 *    建起来（`pool.ts` §5.1 裁定的同步签名），所以这里返回的通道一开始不 ready，
 *    连上之后才 ready——期间的 `send` 得到 `NOT_CONNECTED` 的"还没起来"措辞。
 * 4. **token 只作为脱敏词进入通道**：通道不需要端点，只需要知道"这些字永远不许进
 *    诊断"。`secrets` 就是它唯一该知道的那一半。
 *
 * ## 纪律
 *
 * - **零 wire id**：本文件不写任何帧字段名、命令名或
 *   事件名。它按能力名工作，而能力名→wire 的解析在 `send.ts` 里。
 * - **不自己 `new Engine`、不调用 `start`/`attach`**：门面由壳的 `engine-host` 起
 *   （master `seq 127`），这里只**读**它的 `endpoint`。
 * - **不存端点**：`endpointOf` 每次现读，通道只拿到一次性传给工厂的那一份，用完
 *   就随闭包丢掉。
 */

import { completionOf } from "./capability-names";
import { createChannel } from "./channel";
import type { CapabilityProbePort, EngineChannel, EngineFrameReader } from "./channel";
import { duplicateIdError } from "./channel-errors";
import { OutboundDedupe } from "./dedupe";
import type { ChannelFactory, ChannelOpenContext } from "./pool";
import { createChannelPool as createPool } from "./pool";
import { buildFrame } from "./send";
import { openTransport } from "./transport";
import type { EngineTransport, TransportOptions } from "./transport";
import type {
  Channel,
  ChannelPool,
  CommandRequest,
  CommandResult,
  DiagnosticRecord,
  Endpoint,
  EngineEventFrame,
} from "./types";

/* ------------------------------------------------------------------------- */
/* The endpoint seam                                                         */
/* ------------------------------------------------------------------------- */

/**
 * What this layer needs from the engine facade: a read-only endpoint.
 *
 * Declared structurally rather than as `Engine` so this file does **not** import
 * `engine.ts`: the dependency edge would run `client -> engine`, and `engine.ts`
 * is D4's file with its own window. A caller passes the real `Engine`, which
 * satisfies this by construction, and a test passes a literal.
 *
 * One member, not three. `state` is deliberately **not** read here: the facade
 * already gates `endpoint` on `ready`, and a second gate on this side would be a
 * gate on this side would be a second source of truth about readiness - exactly
 * come from proxying `socketState`.
 */
export interface EndpointSource {
  /** The endpoint, or `null` while the facade is not ready. */
  readonly endpoint: Endpoint | null;
}

/**
 * Opens one channel's transport.
 *
 * A port rather than a direct call for one reason only: `openTransport` dials a
 * real socket, and a test that had to dial one would be testing the network stack
 * instead of the wiring. Production passes {@link openTransport} (the default),
 * which is the path that keeps early frames - captured inside the `open`
 * handler, not installed afterwards.
 */
export type TransportOpener = (
  url: string,
  token: string,
  options: TransportOptions,
) => Promise<EngineTransport>;

/* ------------------------------------------------------------------------- */
/* Wiring state exposed to tests and to the pool                             */
/* ------------------------------------------------------------------------- */

/**
 * Key of the diagnostics hook a wired channel carries.
 *
 * A **symbol**, so the three facts below stay off every surface that matters:
 * `Object.keys(channel)`, `JSON.stringify(channel)` and any accidental spread
 * cannot see them, which is the same reason the token never appears there
 * frozen `Channel` surface does not grow a
 * member for a test's convenience; the wiring attaches the handle instead.
 */
export const WIRING_STATE: unique symbol = Symbol("haruyuki.wiring.state");

/** What the wiring can report about one channel it built. */
export interface WiringState {
  /**
   * This channel's own outbound dedupe table.
   *
   * Exposed so the "one instance per channel, never a module singleton" rule is
   * assertable by identity instead of by behaviour alone: two agents must not be
   * `===`, and two reads for one agent must be.
   */
  readonly dedupe: OutboundDedupe;
  /** The transport, or `null` while it is still being opened. */
  readonly transport: () => EngineTransport | null;
  /** Close reasons the transport reported, in order (peer-initiated closes only). */
  readonly closeReasons: () => readonly string[];
  /** The reason the connection could not be opened, when it could not. */
  readonly openFailure: () => string | null;
}

/** A channel as this layer builds it: the frozen surface plus two local facts. */
export interface WiredChannel extends Channel {
  /** Whether {@link Channel.close} ran. `pool.ts` duck-types this to drop zombies. */
  isClosed(): boolean;
  /** See {@link WIRING_STATE}. */
  readonly [WIRING_STATE]: WiringState;
}

/**
 * Reads the wiring state off a channel, if it has one.
 *
 * @param channel any channel - a wired one, or a test double without the handle
 * @returns the state, or `undefined` for a channel this layer did not build
 */
export function wiringStateOf(channel: Channel): WiringState | undefined {
  return (channel as Partial<WiredChannel>)[WIRING_STATE];
}

/* ------------------------------------------------------------------------- */
/* Options                                                                   */
/* ------------------------------------------------------------------------- */

/** What {@link createWiredChannelFactory} is configured with. */
export interface WiringOptions {
  /**
   * Opens one connection. Defaults to {@link openTransport}.
   *
   * The default is what production uses and it is the only one that dials; a test
   * that injects its own opener is replacing the network, not the wiring.
   */
  readonly open?: TransportOpener;
  /**
   * Decodes one inbound frame: its event type, and the correlated answer when the
   * frame carries one.
   *
   * **Required to make a tracked send resolve.** The kernel's default reader
   * routes on `type` only and reports no response (`channel.ts`'s
   * `DEFAULT_READER`), because recognising an answer means reading the
   * correlation field and the success flag - both wire vocabulary, which lives in
   * the send path and not in the kernel. So a stack wired without a reader can
   * write every command and watch every event, but a `send` that expects an
   * answer waits for a frame nobody correlates and ends in `TIMEOUT`.
   *
   * This is the one production gap of the wiring layer and it is **not fillable
   * here**: no production reader exists in this package yet (the only
   * implementations are test doubles and `channel-test-support`'s). The port is
   * threaded through so the work package that owns the frame decode  can
   * pass one in without touching this file again.
   */
  readonly reader?: EngineFrameReader;
  /**
   * Feeds the capability snapshot from inbound frames.
   *
   * Omitted means the snapshot stays `unknown` forever, which is the honest state
   * for a build that cannot read the engine's capability fields - and `unknown` is
   * a distinct state from `confirmed-empty` precisely so nothing renders "no
   * commands" on the strength of a missing reading.
   */
  readonly probe?: CapabilityProbePort;
  /**
   * Event types this build models, forwarded to the kernel.
   *
   * Omitted means "this channel has no type table" and then no `unknown-event` is
   * reported (see `ChannelOptions.knownEventTypes`) - the honest behaviour for a
   * build that has no list, not a silently empty one.
   */
  readonly knownEventTypes?: ReadonlySet<string>;
  /**
   * Mints one request id for a tracked send.
   *
   * Defaults to a per-channel counter plus noise. Injected only by tests that need
   * a predictable id; the shape is deliberately not derived from the engine's.
   */
  readonly mintRequestId?: () => string;
}

/* ------------------------------------------------------------------------- */
/* Per-channel state                                                         */
/* ------------------------------------------------------------------------- */

/**
 * The id a tracked send will carry, minted here when the caller gave none.
 *
 * Minting at this layer rather than leaving it to the kernel is what lets the
 * dedupe table be consulted at all: the kernel mints internally, so an id minted
 * there would be claimed after the decision to send had already been made.
 *
 * Only the classes that actually carry a correlation id are minted for. The five
 * wire-untracked capabilities must not enter any table (two keystrokes of the
 * the same key are two keystrokes, and a table entry would eat one), so they fall
 * out of this function with `undefined` and never reach {@link OutboundDedupe.claim}.
 *
 * @param request the caller's request
 * @param mint mints a fresh id
 * @returns the id that should travel, or `undefined` when the wire carries none
 */
function correlationIdOf(request: CommandRequest, mint: () => string): string | undefined {
  const mode = completionOf(request.capability);

  if (mode !== "response" && mode !== "silent") {
    // `untracked` (5) and `duplex` (1): no field on the wire, so nothing to claim.
    return undefined;
  }

  const supplied = request.requestId;
  // An empty string is "no id", the same reading `send.ts` uses: a supplied empty
  // id would otherwise be written as an id the engine echoes back as empty.
  if (supplied !== undefined && supplied !== "") {
    return supplied;
  }

  return mint();
}

/* ------------------------------------------------------------------------- */
/* The factory                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Build the pool's channel factory, bound to one engine facade.
 *
 * The returned factory is what `createChannelPool` is given. It performs, in this
 * order: build the kernel, start opening the connection, install the two
 * subscriptions the transport needs, and hand back the handle the pool stores.
 *
 * The connection is started **after** the kernel exists (so `write` has something
 * to write through) and **without awaiting** it (the pool's `getChannel` is
 * synchronous by design). A failure to connect closes this one channel and
 * channel and nothing else.
 *
 * The endpoint comes from `context.endpoint`, which the pool resolved from
 * `endpointOf` once per creation. It is used and dropped: this factory keeps the
 * URL and token only inside the closures that need them, never on the channel.
 *
 * @param source the engine facade (read: `endpoint`), consulted per creation
 * @param options transport opener, modelled event types, id mint
 * @returns a `ChannelFactory` for `createChannelPool`
 */
export function createWiredChannelFactory(
  source: { readonly endpoint: Endpoint | null },
  options: WiringOptions = {},
): ChannelFactory {
  const open = options.open ?? openTransport;

  return (context: ChannelOpenContext): Channel => {
    const endpoint = context.endpoint;
    if (endpoint === null) {
      // Throwing is the documented degradation path: the pool catches it, records
      // nothing and hands this caller an `unconnected()` stand-in that reports
      // `NOT_CONNECTED`, without caching the stand-in (pool.ts). Building a channel
      // with no endpoint to dial would be a worse answer: a channel that looks real
      // and can never send.
      throw new Error(
        `no endpoint to open a channel for agent "${context.agentId}"` +
          (source.endpoint === null ? ": the engine is not ready" : ""),
      );
    }

    let counter = 0;
    const mint =
      options.mintRequestId ??
      (() => {
        counter += 1;
        return `req-${counter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      });

    // Per channel, and that is the whole point. A module-level
    // instance would let agent A's `request_id` suppress agent B's.
    const dedupe = new OutboundDedupe();

    /** The connection, once it exists. `null` until then, by construction. */
    let transport: EngineTransport | null = null;
    let openFailure: string | null = null;
    const closeReasons: string[] = [];
    const readiness = { ready: false, everReady: false };

    /**
     * Whether a command may be written right now.
     *
     * Both halves matter: the flag says the dial succeeded (and latches
     * `everReady`), the transport's own `isOpen` says the connection has not gone
     * away since. Reading both is what keeps a close that arrives between the two
     * from being treated as writable.
     */
    const readyNow = (): boolean => readiness.ready && transport !== null && transport.isOpen;

    const engine: EngineChannel = createChannel({
      agentId: context.agentId,
      write: (request, requestId) => {
        const frame = buildFrame(request, {}, requestId);
        const live = transport;
        if (live === null) {
          // Reachable only in the window between the factory returning and the
          // connection opening; `readiness` normally refuses the send first. The
          // throw is still the right answer: a write with no transport did not
          // happen, and `SEND_FAILED` says so instead of pretending it went out.
          throw new Error("the transport is not open yet");
        }
        const outcome = live.send(frame.raw);
        if (!outcome.ok) {
          throw new Error(outcome.detail);
        }
      },
      // The token, and only the token: the channel never holds the endpoint, it
      // only knows what to erase from a diagnostic.
      secrets: [endpoint.token],
      ...(options.reader === undefined ? {} : { reader: options.reader }),
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.knownEventTypes === undefined
        ? {}
        : { knownEventTypes: options.knownEventTypes }),
      ...(context.clock === undefined ? {} : { clock: context.clock }),
      // Two facts, composed: this agent's connection is open, and it was open at
      // least once. The second latches so "was up, then dropped" keeps its wording
      // forever - that is what tells B3 a replay is worth attempting.
      readiness: () => ({
        ready: readyNow(),
        everReady: readiness.everReady,
      }),
    });

    // `void`: the pool cannot await (see the doc comment above). The failure is
    // absorbed here and surfaces as a closed channel, never as an unhandled
    // rejection at process level.
    void open(endpoint.url, endpoint.token, {
      ...(context.clock === undefined ? {} : { now: () => context.clock?.now() ?? Date.now() }),
    }).then(
      (opened) => {
        transport = opened;
        readiness.ready = true;
        readiness.everReady = true;

        // The two subscriptions the wiring owns. The frame half is
        // what makes an inbound answer reachable at all; the close half is what
        // makes a dropped connection visible - in-flight requests settle and later
        // sends are refused, instead of waiting for an answer that cannot come.
        opened.onFrame((frame) => {
          engine.ingest(frame.raw);
        });
        opened.onClose((reason) => {
          closeReasons.push(reason);
          readiness.ready = false;
          engine.close();
        });
      },
      (error: unknown) => {
        openFailure = error instanceof Error ? error.message : String(error);
        // One agent's connection failure closes one agent's channel. The pool
        // rebuilds it on the next `getChannel`, so a transient dial failure is not
        // a permanently dead agent (`closeAll` is not a terminal dispose either).
        engine.close();
      },
    );

    const state: WiringState = {
      dedupe,
      transport: () => transport,
      closeReasons: () => closeReasons,
      openFailure: () => openFailure,
    };

    const handle: WiredChannel = {
      agentId: context.agentId,
      send: (request: CommandRequest): Promise<CommandResult> => {
        const id = correlationIdOf(request, mint);

        if (id === undefined) {
          // No field on the wire, so nothing to claim and nothing to refuse:
          // `untracked` (5) and `duplex` (1) go straight through, uncounted and
          // unmemoised.
          return engine.send(request);
        }

        if (!readyNow()) {
          // Nothing will be written, so nothing may be memorised. Claiming here
          // would turn the caller's legitimate retry - queued while the engine was
          // still coming up - into a phantom duplicate after it comes up. The
          // kernel owns the refusal, and its NOT_CONNECTED wording is the one that
          // distinguishes "never came up" from "was up and dropped".
          return engine.send(request);
        }

        const verdict = dedupe.claim(id);

        if (verdict.kind === "duplicate") {
          // Refused here rather than written twice: two frames on one `request_id`
          // would make the engine answer once and one waiter hang until its
          // timeout. `REJECTED` is the code `channel-errors` already assigns to a
          // duplicate id (`duplicateIdError`), so no new code is invented.
          //
          // A `SEND_FAILED` below, by contrast, keeps its claim on purpose: that
          // code means the connection was open and the write still failed, so
          // whether the frame left is unknown, and an unknown write is treated as
          // possibly-sent. Forgetting it would let the caller's retry put two
          // frames on one id, which is the defect this table exists to prevent.
          return Promise.resolve({
            ok: false,
            error: duplicateIdError(request.capability, id),
          });
        }

        return engine.send({ ...request, requestId: id });
      },
      onEvent: (subscriber: (frame: EngineEventFrame) => void) => engine.onEvent(subscriber),
      onDiagnostic: (subscriber: (record: DiagnosticRecord) => void) =>
        engine.onDiagnostic(subscriber),
      capabilities: () => engine.capabilities(),
      close: () => {
        // The half the frozen surface cannot express: the kernel first, so no
        // first, so no frame is ingested into a closing channel, then the
        // connection. Skipping the second line leaves the socket open - the leak
        // `multichannel.test.ts` measures.
        engine.close();
        transport?.close();
      },
      isClosed: () => engine.isClosed(),
      [WIRING_STATE]: state,
    };

    return handle;
  };
}

/* ------------------------------------------------------------------------- */
/* The composition                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Build the whole client for one engine: pool + wiring + endpoint reader.
 *
 * This is the one call the shell makes. It composes the three injected ports the
 * pool needs and nothing else:
 *
 * - `createChannel`: the wired factory above;
 * - `endpointOf`: `() => source.endpoint` - read **per creation**, so a pool that
 *   outlives one engine attempt does not hand a stale endpoint to a new one, and
 *   the pool still never stores the endpoint;
 * - `clock`: forwarded unchanged when the caller injected one.
 *
 * @param source the engine facade (read: `endpoint`)
 * @param options factory options plus an optional clock
 * @returns the pool; `getChannel` is synchronous and may fail per agent
 */
export function createWiredChannelPool(
  source: { readonly endpoint: Endpoint | null },
  options: WiringOptions & { readonly clock?: ChannelOpenContext["clock"] } = {},
): ChannelPool {
  const createChannelFor = createWiredChannelFactory(source, options);

  // The concrete class is returned as the frozen interface: callers must not be
  // able to reach `open`, `unconnected` or the entries map through the type.
  return createPool({
    createChannel: createChannelFor,
    endpointOf: () => source.endpoint,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}
