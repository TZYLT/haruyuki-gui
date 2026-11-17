/**
 * Watches the socket behind every agent's channel.
 *
 * The channel contract deliberately has no close event: a channel is "one
 * agent's commands and events", and what a closed socket *means* — a crash, a
 * reconnect, a user stop — is decided a layer up. That leaves this module the
 * job of noticing a bare transport closing, which it can only do because the
 * wiring accepts a replacement for the step that opens the connection.
 *
 * ## Why the pairing happens here, and not in the opener
 *
 * The opener receives `(url, token, options)` and nothing else. Every agent
 * connects to the same engine, so a registry keyed off the opener alone could
 * only guess which agent a socket belongs to — and a wrong guess reports one
 * agent's disconnect against another. The channel factory receives the agent id,
 * so the pairing is made there, where the two facts meet.
 *
 * ## What this module does not do
 *
 * It does not decide that an agent is degraded, does not retry and does not
 * probe: a silent connection (socket open, nobody answering) never produces a
 * close, so the caller needs a probe for that case. This layer reports only what
 * it can observe.
 */

import { createWiredChannelFactory, openTransport } from "../client";
import type {
  ChannelFactory,
  EngineTransport,
  Endpoint,
  TransportOpener,
  WiringOptions,
} from "../client";

/** Removes one subscription; idempotent. */
export type Unsubscribe = () => void;

/** What a consumer can ask about watched transports. */
export interface TransportWatch {
  /** The transport currently carrying this agent, or `null` if none is open. */
  transportOf(agentId: string): EngineTransport | null;
  /** Called once per transport that closes, with the reason it gave. */
  onClose(listener: (agentId: string, reason: string) => void): Unsubscribe;
  /**
   * Registers a transport for an agent.
   *
   * Called by the watched factory below, never by a consumer: a transport that
   * nobody opened is a transport whose close means nothing.
   */
  attach(agentId: string, transport: EngineTransport): void;
  /** Drops every subscription, including ones already reported. Safe twice. */
  dispose(): void;
}

interface WatchedEntry {
  readonly agentId: string;
  readonly transport: EngineTransport;
  unsubscribe: Unsubscribe;
  closed: boolean;
}

/** Creates an empty watch. One per process, shared by every agent's channel. */
export function createTransportWatch(): TransportWatch {
  const entries = new Set<WatchedEntry>();
  const byAgent = new Map<string, WatchedEntry>();
  const byTransport = new WeakMap<EngineTransport, WatchedEntry>();
  const closeListeners = new Set<(agentId: string, reason: string) => void>();
  let disposed = false;

  return {
    transportOf(agentId: string): EngineTransport | null {
      const entry = byAgent.get(agentId);
      return entry === undefined || entry.closed ? null : entry.transport;
    },

    onClose(listener: (agentId: string, reason: string) => void): Unsubscribe {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },

    attach(agentId: string, transport: EngineTransport): void {
      // One transport, one entry: a second attach is the same fact twice, and a
      // second listener would report the close twice.
      if (disposed || byTransport.has(transport)) {
        return;
      }

      const entry: WatchedEntry = {
        agentId,
        transport,
        unsubscribe: () => {},
        closed: false,
      };
      entry.unsubscribe = transport.onClose((reason: string) => {
        if (entry.closed) {
          return;
        }
        entry.closed = true;
        // The previous transport for this agent is left in `entries` on purpose:
        // a reconnect opens its new socket before the old one closes, so an old
        // close still has to be reported. Only the "current" pointer moves.
        if (byAgent.get(agentId) === entry) {
          byAgent.delete(agentId);
        }
        for (const listener of [...closeListeners]) {
          listener(agentId, reason);
        }
      });

      byTransport.set(transport, entry);
      entries.add(entry);
      byAgent.set(agentId, entry);
    },

    dispose(): void {
      disposed = true;
      for (const entry of entries) {
        entry.unsubscribe();
      }
      entries.clear();
      byAgent.clear();
      closeListeners.clear();
    },
  };
}

/**
 * Builds the pool's channel factory so that every connection it opens is
 * watched.
 *
 * The factory is built per open context rather than once for the whole pool: it
 * is only a closure, and building it per context is what makes the agent id
 * available to the opener at all. Everything else — the frame reader, the
 * capability probe, the request-id mint — behaves exactly as the unwatched
 * factory does, because it is the same function.
 */
export function createWatchedChannelFactory(
  source: { readonly endpoint: Endpoint | null },
  options: WiringOptions,
  watch: TransportWatch,
): ChannelFactory {
  const opener: TransportOpener = options.open ?? openTransport;

  return (context) =>
    createWiredChannelFactory(source, {
      ...options,
      open: async (url, token, transportOptions) => {
        const transport = await opener(url, token, transportOptions);
        watch.attach(context.agentId, transport);
        return transport;
      },
    })(context);
}
