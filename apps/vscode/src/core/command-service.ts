/**
 * The command service of the VSCode shell: one pool per engine, one merger per
 * agent, and a frame outlet that routes by channel.
 *
 * What this module owns
 *   Commands   `invoke` takes the call, asks the dispatcher which channel it
 *              belongs to and returns one of the dispatcher's three reply arms.
 *              Every envelope decision stays there; this module only supplies
 *              the channel lookup and the "is there a pool at all" gate.
 *   Events     Each channel's event stream is ingested by that agent's merger.
 *              Terminal output leaves through the frame outlet with its own
 *              channel, and the terminal lifecycle notices leave as control
 *              frames. Every other change is counted and logged: its consumer
 *              is the session store, which is not this layer.
 *   Frames     `onFrame` is the outlet. A frame is routed by `frame.ch`, so
 *              the three channels are three routes, and a consumer that wants
 *              only terminal bytes never has to filter them out of control
 *              traffic.
 *
 * Lifetime
 *   `attach` builds the pool once and opens the control channel eagerly;
 *   `detach` closes it and forgets every per-agent object. Both are idempotent:
 *   a repeated `attach` cannot produce a second pool (a second pool would mean
 *   a second socket per agent), and a repeated `detach` must not throw. A
 *   re-`attach` after `detach` is a new engine lifetime and builds a fresh
 *   pool; the pool contract says `closeAll` is "close the window", not a
 *   terminal dispose, so an injected pool can be adopted again after a detach.
 *
 * Why every external ability arrives as a parameter
 *   Nothing here imports a host API. The extension host is the one that knows
 *   when the engine is ready and where frames go, so the pool (or its factory),
 *   the merger factory and the frame sink all arrive from the composition root.
 *   That is what lets this file run in plain Node and be tested without an
 *   extension host, an engine process or a socket.
 *
 * Why the channels are subscribed lazily
 *   The pool has no "channel created" hook and builds channels on demand.
 *   Wrapping `getChannel` is the one point every path passes through (the
 *   control channel at attach and every command's channel), so the subscription
 *   is installed there. A channel the pool replaces after it self-closed is
 *   unsubscribed first, so one event cannot be ingested twice.
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
  EventMerger,
  EventMergerOptions,
  MergerChange,
} from "@haruyuki/core";
import type { Frame, FrameChannel } from "@haruyuki/protocol";

/** The engine fact this service reads. Structural, so the engine facade fits it. */
export interface CommandServiceEngine {
  /** Non-null only while the engine is ready and has a usable endpoint. */
  readonly endpoint: Endpoint | null;
}

/** Builds the pool for one engine. Production passes `createWiredChannelPool`. */
export type CommandPoolFactory = (source: { readonly endpoint: Endpoint | null }) => ChannelPool;

/** Builds one agent's merger. Production passes `createEventMerger`. */
export type CommandMergerFactory = (options: EventMergerOptions) => EventMerger;

/**
 * One frame outlet callback: the route the frame travels on, and the frame.
 *
 * The channel is passed as its own argument rather than being left to
 * `frame.ch`, so a consumer that wants one route never has to narrow the frame
 * first. Both are still readable from the frame; the argument is the routing
 * decision made for the consumer, not a second source of truth.
 */
export type CommandFrameSubscriber = (channel: FrameChannel, frame: Frame) => void;

/** What the composition root supplies. */
export interface CommandServiceOptions {
  /** The engine seam; only `endpoint` is read, and only when a pool is built. */
  readonly engine: CommandServiceEngine;
  /**
   * An already built pool. Takes precedence over {@link createPool}: the pool
   * belongs to this service's lifetime, so passing both would leave two owners.
   */
  readonly channelPool?: ChannelPool;
  /** Test seam for the pool; defaults to the real wired pool. */
  readonly createPool?: CommandPoolFactory;
  /** Test seam for the merger; defaults to the real event merger. */
  readonly createMerger?: CommandMergerFactory;
  /**
   * The host sink: every frame this service emits is handed to it once, after
   * routing. Optional, because a consumer may subscribe with {@link
   * CommandService.onFrame} instead.
   */
  readonly send?: (frame: Frame) => void;
  /** Diagnostic sink: codes and agent ids, never frame bodies or endpoints. */
  readonly log?: (code: string, detail?: Record<string, unknown>) => void;
  /** Runtime availability gate, forwarded to the dispatcher. */
  readonly isAvailable?: (capability: string) => boolean;
}

/** The handle the composition root keeps for one engine. */
export interface CommandService {
  /** One command, answered with the dispatcher's three-arm reply. */
  invoke(call: CommandCall): Promise<CommandReply>;
  /** Build the pool and open the control channel; idempotent. */
  attach(): void;
  /** Unsubscribe, close the pool and drop the mergers; idempotent. */
  detach(): Promise<void>;
  /** Subscribe to every frame from now on; returns an idempotent unsubscribe. */
  onFrame(callback: CommandFrameSubscriber): () => void;
  /** Whether a pool exists right now; `false` answers every invoke with a refusal. */
  readonly ready: boolean;
}

/** The refusal every path gives while there is no pool to send on. */
function unavailable(): CommandReply {
  return { ok: false, code: "COMMAND_CHANNEL_UNAVAILABLE" };
}

/**
 * Engine events that reach the renderer as their own control frame.
 *
 * Only these two. A terminal appearing or ending is one observable occurrence a
 * consumer cannot derive from `term.output`, and no other change type has a
 * frame shape this layer is entitled to invent.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(["terminal_spawned", "terminal_exited"]);

/**
 * The control frame for one merger change, or `null` when the change is not a
 * terminal lifecycle event.
 *
 * `body` is the engine's raw object, untouched: the envelope is the only thing
 * added here. `seq` is a placeholder because the host's sender renumbers every
 * frame it emits.
 */
function terminalEventFrame(change: MergerChange): Frame | null {
  if (change.kind !== "passthrough" || !TERMINAL_EVENT_TYPES.has(change.type)) return null;

  return { v: 1, ch: "control", seq: 0, t: change.type, body: change.raw };
}

/**
 * Build the command service.
 *
 * @param options the engine, the injected pool or its factory, and the sinks
 * @returns the service; nothing is built until `attach`
 */
export function createCommandService(options: CommandServiceOptions): CommandService {
  const { engine } = options;
  const log = options.log ?? ((): void => undefined);
  const send = options.send ?? ((): void => undefined);
  const createPool = options.createPool ?? ((source) => createWiredChannelPool(source));
  const createMerger = options.createMerger ?? createEventMerger;

  /** The pool for this engine lifetime, or `null` before attach / after detach. */
  let pool: ChannelPool | null = null;
  /** One merger per agent, kept while the pool lives. */
  const mergers = new Map<string, EventMerger>();
  /** The live channel subscription per agent, so a replaced channel is dropped. */
  const subscriptions = new Map<string, { readonly channel: Channel; readonly off: () => void }>();
  /** Frame subscribers; they outlive a detach, because the pool is what closes. */
  const subscribers = new Set<CommandFrameSubscriber>();
  /** Total changes observed, so one log line can say the merger is alive. */
  let changesSeen = 0;

  /**
   * The three routes. Splitting on `ch` here is what keeps a control frame from
   * being read as terminal bytes: the channel is part of the envelope, so no
   * consumer has to decode a body first to learn where a frame belongs.
   */
  const routes: Readonly<Record<FrameChannel, (frame: Frame) => void>> = {
    control: (frame) => deliver("control", frame),
    stream: (frame) => deliver("stream", frame),
    bulk: (frame) => deliver("bulk", frame),
  };

  /** Hand one frame to the host sink and then to every subscriber. */
  function deliver(channel: FrameChannel, frame: Frame): void {
    try {
      send(frame);
    } catch {
      // The host sink failed for this frame. Retrying would duplicate the write
      // if the failure was in the acknowledgement rather than in the write.
      log("COMMAND_FRAME_SINK_FAILED", { channel });
    }

    for (const subscriber of [...subscribers]) {
      try {
        subscriber(channel, frame);
      } catch {
        // A throwing subscriber loses its own frame, never the next subscriber's.
        log("COMMAND_FRAME_SUBSCRIBER_FAILED", { channel });
      }
    }
  }

  /** Route one frame by its channel. `ch` is a closed union, so all three exist. */
  function route(frame: Frame): void {
    routes[frame.ch](frame);
  }

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
      // Terminal slices go straight to the outlet, which renumbers them. The
      // merger owns ordering and splitting; the sender owns sequencing.
      onFrame: (frame) => {
        route(frame);
      },
    });

    mergers.set(agentId, merger);
    return merger;
  }

  /**
   * Subscribe to one agent's channel, exactly once per channel instance.
   *
   * Keyed by agent rather than by channel because the pool may replace a
   * self-closed channel: the old subscription is removed first so one event
   * cannot be ingested twice.
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
          // The merger promises never to throw; if that regresses, one frame
          // must not take the channel's other subscribers down with it.
          log("COMMAND_MERGE_FAILED", { agentId });
          return;
        }

        if (changes.length === 0) return;

        for (const change of changes) {
          const frame = terminalEventFrame(change);
          if (frame !== null) route(frame);
        }

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
   * Open the control channel eagerly: it carries every scope-less command, so
   * leaving it lazy would put the first device-wide command on the open path.
   * Per-agent channels stay lazy, on first use.
   */
  function openControlChannel(): void {
    try {
      channelFor(CONTROL_AGENT_ID);
    } catch {
      log("COMMAND_CONTROL_CHANNEL_FAILED", {});
    }
  }

  /**
   * Build the pool for a ready engine.
   *
   * A ready engine with no endpoint is ignored rather than retried: the engine
   * facade gates `endpoint` on readiness, and a second source of truth about the
   * state would be the bug this module exists to avoid.
   */
  function attach(): void {
    if (pool !== null) return;

    const injected = options.channelPool;
    if (injected !== undefined) {
      pool = injected;
      openControlChannel();
      log("COMMAND_POOL_READY", { source: "injected" });
      return;
    }

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
    openControlChannel();
    log("COMMAND_POOL_READY", { source: "factory" });
  }

  /** Close the pool and forget every per-agent object that belonged to it. */
  async function detach(): Promise<void> {
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
      log("COMMAND_POOL_CLOSE_FAILED", {});
    }

    log("COMMAND_POOL_CLOSED", {});
  }

  async function invoke(call: CommandCall): Promise<CommandReply> {
    if (pool === null) return unavailable();

    return dispatcher.invoke(call);
  }

  function onFrame(callback: CommandFrameSubscriber): () => void {
    subscribers.add(callback);

    let subscribed = true;

    return () => {
      if (!subscribed) return;

      subscribed = false;
      subscribers.delete(callback);
    };
  }

  return {
    invoke,
    attach,
    detach,
    onFrame,
    get ready() {
      return pool !== null;
    },
  };
}
