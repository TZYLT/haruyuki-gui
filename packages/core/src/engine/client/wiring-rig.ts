/**
 * The shared rig for the wiring tests: one in-memory engine, real transport.
 *
 * `wiring.test.ts` and `wiring-endpoint.test.ts` both need this, and it was
 * extracted so a change to it cannot drift between the two - the alternative,
 * copying it, is how two suites end up proving slightly different things about
 * the same production path.
 *
 * Production shape is deliberate: the transport is `createTransport` (the same
 * implementation `openTransport` wraps), only the dial is replaced, and the pool
 * is the real `createWiredChannelPool`. A rig built on narrower doubles would make
 * a passing case say little about the stack.
 *
 * Not a `*.test.ts` file, so vitest does not collect it and the
 * `capability-names.test.ts` scan treats it as ordinary source - which is
 * correct: the frames it builds come from `channel-test-support`'s marker
 * constructors, and it names no wire id.
 */

import {
  assertNoLeakedTimers,
  makeClock,
  makeReader,
  makeProbe,
  responseFrame,
  trackClock,
  TRACKED,
} from "./channel-test-support";
import type { FakeClock } from "./channel-test-support";
import { makeSocketDouble } from "./scripted-harness";
import type { SocketDouble } from "./scripted-harness";
import { createTransport } from "./transport";
import type { EngineTransport } from "./transport";
import { createWiredChannelPool, wiringStateOf } from "./index";
import type { WiringState } from "./index";
import type { TransportOpener, WiredChannel } from "./wiring";
import type { Channel, ChannelPool, CommandRequest, CommandResult, Endpoint } from "./types";
import type { EngineFrameReader } from "./channel";

/* --- The rig --- */

/** The engine facade the wiring reads. A literal, never a real `Engine`. */
export type Source = { endpoint: Endpoint | null };

/** One channel's connection, as this rig builds it. */
export interface Opened {
  readonly url: string;
  readonly token: string;
  readonly socket: SocketDouble;
  readonly transport: EngineTransport;
}

/** The rig: a pool over in-memory connections, plus everything a case observes. */
export interface Rig {
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
export const AGENTS = ["ada", "grace"] as const;

/**
 * Build a rig over the real kernel, the real transport and a real socket stub.
 *
 * The transport is `createTransport` - the same implementation `openTransport`
 * wraps - so a written frame, a delivered frame and a reported close all travel the
 * production path; only the dial is replaced, which is the one step needing a
 * network. The opener receives only a URL and a token by design, so the agent id is
 * attached by {@link openChannel} right after the synchronous `getChannel` that
 * triggered the dial: an explicit mapping, not one inferred from array order.
 *
 * @param options the endpoint the facade starts out with
 * @returns the rig, torn down by {@link rigOf}'s `afterEach`
 */
export function makeRig(
  options: {
    readonly endpoint?: Endpoint | null;
    /**
     * The frame reader, or `null` to omit the option entirely.
     *
     * Defaults to the test double, so most cases decode this suite's own reply
     * marker. `null` means "pass nothing": the wiring then installs its production
     * default (`createFrameReader`), which is the only way to exercise that path.
     * A plain `undefined` would be ambiguous with an omitted property under
     * `exactOptionalPropertyTypes`, and `??` here would silently substitute the
     * double - which is exactly the bug that made the default untested.
     */
    readonly reader?: EngineFrameReader | null;
  } = {},
): Rig {
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
    // `null` omits the key so the wiring's own default decides; anything else
    // (including the implicit default) passes a concrete reader.
    ...(options.reader === null ? {} : { reader: options.reader ?? makeReader() }),
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
 * Open one agent's channel.
 *
 * `getChannel` runs the factory synchronously, and the factory calls the injected
 * opener synchronously before returning, so {@link Rig.assign} is in place for
 * exactly the one dial this call makes.
 *
 * @param rig the rig
 * @param agentId the agent to open
 * @returns the wired channel the pool handed out
 */
export function openChannel(rig: Rig, agentId: string): WiredChannel {
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
export function stateOf(channel: Channel): WiringState {
  const state = wiringStateOf(channel);
  if (state === undefined) {
    throw new Error("the pool handed out a channel the wiring did not build");
  }
  return state;
}

/** A per-agent endpoint. The URL names the agent so a shared one is visible. */
export function endpointFor(agentId: string): Endpoint {
  return { url: `ws://127.0.0.1:7022/${agentId}`, token: `token-for-${agentId}` };
}

/**
 * The common part of a tracked request for one agent.
 *
 * Every case below sends the same shape, and spelling the runtime out each time
 * made a change to it a multi-site edit. The capability is the one
 * `channel-test-support` marks as needing a correlation id, so a case that wants
 * to observe the id path does not also have to remember which capability it is.
 *
 * @param agentId the agent the request speaks as
 * @returns the fields shared by every tracked request in this file
 */
export function tracked(agentId: string): Pick<CommandRequest, "capability" | "body" | "runtime"> {
  return {
    capability: TRACKED,
    body: {},
    runtime: { agent_id: agentId, conversation_id: `c-${agentId}` },
  };
}

/**
 * The event types this rig's channels are told they model.
 *
 * The rig's frames are `channel-test-support`'s markers, so the modelled set is
 * exactly those - naming a real engine type here would be a wire id.
 */
export const MODELLED: ReadonlySet<string> = new Set(["test.ping", "test.status"]);

/**
 * Close every rig this case built and assert nothing was left running.
 *
 * A plain function rather than an `afterEach` registered here: a module that
 * installs a hook as an import side effect makes the hook's scope depend on who
 * imported it, and a file that forgot to import the module would silently stop
 * cleaning up. Each test file calls this explicitly instead.
 */
export function releaseRigs(): void {
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
}

/**
 * Build a rig and register it for teardown.
 *
 * @param options see {@link makeRig}
 * @returns the registered rig
 */
export function rigOf(options: Parameters<typeof makeRig>[0] = {}): Rig {
  const rig = makeRig(options);
  liveRigs.push({ pool: rig.pool, opened: rig.opened });
  return rig;
}

/**
 * Send one tracked request and answer it immediately on the same agent's socket.
 *
 * A tracked send waits for a correlated answer, so a case that merely awaited one
 * would hang until the test timeout - a failure mode that once cost this suite
 * 93 seconds of wall-clock time.
 * Answering is also the only honest way to assert `ok: true`: a send that was
 * written but never acknowledged has not succeeded. The answer uses the id the
 * wiring itself chose, taken from the rig's mint rather than from the bytes.
 *
 * @param rig the rig
 * @param agentId the agent whose socket answers
 * @param channel that agent's channel
 * @param request the request to send
 * @returns the settled result
 */
export async function answered(
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

  // The id the wiring used, from the rig's mint rather than the bytes; a supplied
  // id wins over the mint, so `request.requestId` is preferred.
  const id = request.requestId ?? rig.minted[knownBefore] ?? "";
  socket.emitMessage(responseFrame(String(id)));

  return pending;
}
