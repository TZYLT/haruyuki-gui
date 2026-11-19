/**
 * The shell-side command service: one pool per engine, one merger per agent.
 *
 * Two flows meet here and nowhere else:
 *
 *   commands   renderer -> dispatcher -> channel.send, one call in and one of
 *              the three reply arms out; this module owns the pool lookup and
 *              otherwise delegates every envelope decision to the dispatcher.
 *   events     channel.onEvent -> the agent's merger -> `term.output` to the
 *              bridge sink. Of the merger's `changes`, only the terminal
 *              lifecycle passthroughs are rendered, as their own control
 *              frames; everything else still belongs to C2 and is counted and
 *              logged until that consumer lands.
 *
 * Lifetime
 *   The pool is built on the `ready` transition and closed on `closed`/`failed`.
 *   Attach and detach are idempotent: a repeated `ready` must not rebuild a pool
 *   (a second pool would mean a second socket per agent), and a repeated
 *   `closed` must not throw. Reconnection inside one engine lifetime belongs to
 *   the channel, so this module neither retries nor reopens a channel it already
 *   has.
 *
 * Why the pool and merger factories are injected
 *   Both are real compositions - the pool opens sockets, the merger is stateful -
 *   and a test that used only the real ones could not force a ready/closed
 *   sequence without a server. The defaults are the production constructors;
 *   the seams exist so the lifecycle can be tested synchronously.
 *
 * Why the channels are subscribed lazily
 *   The frozen `ChannelPool` has no "channel created" hook, and the pool builds
 *   channels on demand. Wrapping `getChannel` is the one place every path (the
 *   control channel at attach, and every command's channel) passes through, so
 *   that is where the subscription is installed. A channel the pool replaces
 *   after a self-close is unsubscribed before the new one is used.
 *
 * No `electron`: the sink is injected, so the whole service runs in Node.
 */

import {
  CONTROL_AGENT_ID,
  createCommandDispatcher,
  createEventMerger,
  createWiredChannelPool,
} from "@haruyuki/core";
import type {
  Channel,
  ChannelPool,
  CommandCall,
  CommandReply,
  Endpoint,
  EngineEventFrame,
  EngineState,
  EventMerger,
  EventMergerOptions,
  MergerChange,
} from "@haruyuki/core";
import type { CapabilityName, Frame } from "@haruyuki/protocol";

/** The engine facts this service reads; structural so the facade satisfies it. */
export interface CommandServiceEngine {
  /** Non-null only while the engine is ready and has a usable endpoint. */
  readonly endpoint: Endpoint | null;
  /** Lifecycle transitions. Returns an idempotent unsubscribe. */
  onState(callback: (state: EngineState) => void): () => void;
}

/** Builds the pool for one engine. Production passes `createWiredChannelPool`. */
export type CommandPoolFactory = (source: { readonly endpoint: Endpoint | null }) => ChannelPool;

/** Builds one agent's merger. Production passes `createEventMerger`. */
export type CommandMergerFactory = (options: EventMergerOptions) => EventMerger;

/** What the composition root supplies. */
export interface CommandServiceOptions {
  readonly engine: CommandServiceEngine;
  /** The bridge sink; a `term.output` frame leaves through exactly this call. */
  readonly send: (frame: Frame) => void;
  /** Diagnostic sink: codes and agent ids, never frame bodies. */
  readonly log?: (code: string, detail?: Record<string, unknown>) => void;
  /** Test seam for the pool; defaults to the real wired pool. */
  readonly createPool?: CommandPoolFactory;
  /** Test seam for the merger; defaults to the real event merger. */
  readonly createMerger?: CommandMergerFactory;
  /** Optional runtime availability gate, forwarded to the dispatcher. */
  readonly isAvailable?: (capability: CapabilityName) => boolean;
  /**
   * The consumer for every change the merger produced.
   *
   * `changes` is the whole of one frame's reading, and the one consumer that
   * wants all of them is the session store. It is told here, once per change,
   * after the terminal lifecycle passthroughs have been sent: those are this
   * module's own output and must not depend on a consumer that may be absent.
   */
  readonly onMergerChange?: (change: MergerChange) => void;
}

/** The handle the composition root keeps for one engine. */
export interface CommandService {
  /** One command, answered with the dispatcher's three-arm reply. */
  invoke(call: CommandCall): Promise<CommandReply>;
  /** Whether a pool exists right now; `false` answers every invoke with a refusal. */
  readonly ready: boolean;
  /** Unsubscribe, close the pool and drop the mergers; idempotent. */
  dispose(): void;
}

/** The refusal every path gives while there is no pool to send on. */
function unavailable(): CommandReply {
  return { ok: false, code: "COMMAND_CHANNEL_UNAVAILABLE" };
}

/**
 * Engine events that reach the renderer as their own control frame.
 *
 * Only these two. A terminal appearing or ending is a single observable
 * occurrence the renderer cannot derive from `term.output`, and nothing else
 * consumes these passthroughs yet. Every other passthrough still waits for C2
 * instead of leaving through a frame type this module does not own.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(["terminal_spawned", "terminal_exited"]);

/**
 * The control frame for one merger change, or `null` when the change is not a
 * terminal lifecycle event.
 *
 * `body` is the engine's raw event object, untouched. The envelope is the only
 * thing this module adds, so the renderer reads exactly the fields the engine
 * emitted and no decoder here has to track their shape. `seq` is a placeholder
 * because the bridge sink renumbers every frame it sends.
 */
function terminalEventFrame(change: MergerChange): Frame | null {
  if (change.kind !== "passthrough" || !TERMINAL_EVENT_TYPES.has(change.type)) return null;

  return { v: 1, ch: "control", seq: 0, t: change.type, body: change.raw };
}

/**
 * Build the command service.
 *
 * @param options the engine, the bridge sink and the optional test seams
 * @returns the service; pool creation happens later, on the engine's `ready`
 */
export function createCommandService(options: CommandServiceOptions): CommandService {
  const { engine, send, onMergerChange } = options;
  const log = options.log ?? ((): void => undefined);
  const createPool = options.createPool ?? ((source) => createWiredChannelPool(source));
  const createMerger = options.createMerger ?? createEventMerger;

  /** The pool for this engine lifetime, or `null` before ready / after close. */
  let pool: ChannelPool | null = null;
  /** One merger per agent, kept while the pool lives. */
  const mergers = new Map<string, EventMerger>();
  /** The live channel subscription per agent, so a replaced channel is dropped. */
  const subscriptions = new Map<string, { readonly channel: Channel; readonly off: () => void }>();
  /** Total changes observed, for the one log line that says the merger is alive. */
  let changesSeen = 0;
  let disposed = false;

  const dispatcher = createCommandDispatcher({
    getChannel: (agentId) => channelFor(agentId),
    ...(options.isAvailable === undefined ? {} : { isAvailable: options.isAvailable }),
  });

  /** The agent's merger, created on first use and reused afterwards. */
  function mergerFor(agentId: string): EventMerger {
    const existing = mergers.get(agentId);
    if (existing !== undefined) return existing;

    const merger = createMerger({
      agentId,
      // The only producer output in this version: terminal slices go straight to
      // the bridge, which renumbers them. The merger owns ordering and splitting,
      // the sender owns sequencing.
      onFrame: (frame) => send(frame),
    });

    mergers.set(agentId, merger);
    return merger;
  }

  /**
   * Subscribe to one agent's channel, exactly once per channel instance.
   *
   * Keyed by agent rather than by channel because the pool is allowed to replace
   * a self-closed channel: when it does, the old subscription is removed first
   * so one event cannot be ingested twice.
   */
  function ensureSubscribed(agentId: string, channel: Channel): void {
    const current = subscriptions.get(agentId);
    if (current?.channel === channel) return;

    try {
      current?.off();
    } catch {
      // An unsubscribe that throws is a channel bug; the new subscription still
      // has to be installed, or the agent would go silent for good.
    }

    const merger = mergerFor(agentId);

    try {
      const off = channel.onEvent((frame) => {
        let changes: readonly MergerChange[];

        try {
          changes = merger.ingest(frame);
        } catch {
          // The merger contract says it never throws; if that regresses, one
          // frame must not take the channel's other subscribers down with it.
          log("COMMAND_MERGE_FAILED", { agentId });
          return;
        }

        if (changes.length === 0) return;

        // Terminal lifecycle is forwarded first: it is the one change the
        // renderer needs today, and nothing about it depends on C2.
        for (const change of changes) {
          const frame = terminalEventFrame(change);
          if (frame !== null) send(frame);
        }

        // Then the consumer that reads every change for its own state. It runs
        // after the passthroughs so this module's own output cannot be lost to a
        // consumer that is slow, absent or (in a test) a stand-in.
        if (onMergerChange !== undefined) {
          for (const change of changes) onMergerChange(change);
        }

        // The remaining changes are the ones nothing rendered before the
        // consumer above existed. The count stays as the one log line that says
        // the merger is alive, and it is still the only reading for a shell that
        // installs no consumer.
        changesSeen += changes.length;
        log("COMMAND_MERGE_CHANGES", {
          agentId,
          count: changes.length,
          total: changesSeen,
        });
      });

      subscriptions.set(agentId, { channel, off });
    } catch {
      log("COMMAND_SUBSCRIBE_FAILED", { agentId });
    }
  }

  /** The pool lookup every command and the control subscription go through. */
  function channelFor(agentId: string, conversationId?: string): Channel | undefined {
    if (pool === null) return undefined;

    const channel = pool.getChannel(agentId, conversationId);
    ensureSubscribed(agentId, channel);
    return channel;
  }

  /**
   * Build the pool for a ready engine.
   *
   * A ready transition with no endpoint is ignored rather than retried: the
   * facade gates the endpoint on readiness, and a second source of truth about
   * the state would be the bug this module exists to avoid.
   */
  function attach(): void {
    if (disposed || pool !== null) return;

    if (engine.endpoint === null) {
      log("COMMAND_ENDPOINT_MISSING", { phase: "attach" });
      return;
    }

    let next: ChannelPool;

    try {
      next = createPool(engine);
    } catch {
      log("COMMAND_POOL_FAILED", { phase: "attach" });
      return;
    }

    pool = next;

    // The control connection carries every scope-less command, so it is opened
    // eagerly; per-agent connections stay lazy, on first use.
    try {
      channelFor(CONTROL_AGENT_ID);
    } catch {
      log("COMMAND_CONTROL_CHANNEL_FAILED", {});
    }

    log("COMMAND_POOL_READY", {});
  }

  /** Close the pool and forget every per-agent object that belonged to it. */
  function detach(reason: "closed" | "failed" | "dispose"): void {
    const current = pool;
    if (current === null) return;

    pool = null;

    for (const { off } of subscriptions.values()) {
      try {
        off();
      } catch {
        // Same rule as a replaced channel: an unsubscribe bug must not keep the
        // rest of the pool's subscriptions alive.
      }
    }

    subscriptions.clear();
    mergers.clear();

    try {
      current.closeAll();
    } catch {
      log("COMMAND_POOL_CLOSE_FAILED", { reason });
    }

    log("COMMAND_POOL_CLOSED", { reason });
  }

  const offState = engine.onState((state) => {
    if (state === "ready") {
      attach();
      return;
    }

    if (state === "closed" || state === "failed") {
      detach(state);
    }
  });

  // The service is built when the runtime hands over an engine that is already
  // ready, so waiting for a transition would wait forever: the handover happens
  // after the handshake, and `onState` reports transitions rather than the
  // current value. `endpoint` is the facade's own "ready and usable" fact, and
  // `attach` is idempotent, so a later `ready` cannot build a second pool.
  if (engine.endpoint !== null) attach();

  async function invoke(call: CommandCall): Promise<CommandReply> {
    if (disposed || pool === null) return unavailable();

    return dispatcher.invoke(call);
  }

  function dispose(): void {
    if (disposed) return;

    disposed = true;

    try {
      offState();
    } catch {
      // The engine's unsubscribe is documented idempotent; a throw here would
      // only be a facade bug, and the pool still has to be closed.
    }

    detach("dispose");
  }

  return {
    invoke,
    get ready() {
      return !disposed && pool !== null;
    },
    dispose,
  };
}
