import { describe, expect, it } from "vitest";

import type { EngineTransport, Endpoint } from "../client";
import { createTransportWatch, createWatchedChannelFactory } from "./watcher";

const ENDPOINT: Endpoint = { url: "ws://127.0.0.1:1", token: "token-not-used" };

/**
 * A transport whose only interesting behaviour is closing.
 *
 * The watched factory never writes through it in these tests — it only needs to
 * be an object the opener can hand back, and it has to be able to report a close
 * the way a real socket does.
 */
function fakeTransport(): {
  readonly transport: EngineTransport;
  close(reason?: string): void;
} {
  const listeners = new Set<(reason: string) => void>();
  const transport: EngineTransport = {
    isOpen: true,
    send: () => ({ ok: true }),
    onFrame: () => () => {},
    onClose: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      for (const listener of [...listeners]) {
        listener("closed by test");
      }
    },
  };
  return {
    transport,
    close(reason = "socket closed by peer") {
      for (const listener of [...listeners]) {
        listener(reason);
      }
    },
  };
}

/** Lets the wiring's asynchronous open finish before assertions. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("transport watch", () => {
  it("reports a close against the agent whose transport closed", () => {
    const watch = createTransportWatch();
    const a = fakeTransport();
    const b = fakeTransport();
    const seen: Array<[string, string]> = [];
    watch.onClose((agentId, reason) => seen.push([agentId, reason]));

    watch.attach("agent-a", a.transport);
    watch.attach("agent-b", b.transport);
    a.close("peer went away");

    expect(seen).toEqual([["agent-a", "peer went away"]]);
  });

  it("forgets the transport of the agent that closed, and keeps the neighbour", () => {
    const watch = createTransportWatch();
    const a = fakeTransport();
    const b = fakeTransport();
    watch.attach("agent-a", a.transport);
    watch.attach("agent-b", b.transport);

    expect(watch.transportOf("agent-a")).toBe(a.transport);

    a.close();
    expect(watch.transportOf("agent-a")).toBeNull();
    expect(watch.transportOf("agent-b")).toBe(b.transport);
  });

  it("keeps the previous transport's close reportable during a reconnect", () => {
    const watch = createTransportWatch();
    const first = fakeTransport();
    const second = fakeTransport();
    const seen: string[] = [];
    watch.onClose((agentId) => seen.push(agentId));

    watch.attach("agent-a", first.transport);
    // A reconnect opens the replacement before the old socket finishes closing.
    watch.attach("agent-a", second.transport);
    first.close();
    second.close();

    expect(seen).toEqual(["agent-a", "agent-a"]);
    expect(watch.transportOf("agent-a")).toBeNull();
  });

  it("reports one close per transport, never two", () => {
    const watch = createTransportWatch();
    const a = fakeTransport();
    let count = 0;
    watch.onClose(() => {
      count += 1;
    });

    watch.attach("agent-a", a.transport);
    watch.attach("agent-a", a.transport);
    a.close();
    a.close();

    expect(count).toBe(1);
  });

  it("stops reporting after dispose, and refuses late attaches", () => {
    const watch = createTransportWatch();
    const a = fakeTransport();
    let count = 0;
    watch.onClose(() => {
      count += 1;
    });
    watch.attach("agent-a", a.transport);

    watch.dispose();
    a.close();
    watch.attach("agent-b", fakeTransport().transport);

    expect(count).toBe(0);
    expect(watch.transportOf("agent-b")).toBeNull();
  });

  it("unsubscribes a listener that has gone away", () => {
    const watch = createTransportWatch();
    const a = fakeTransport();
    let count = 0;
    const off = watch.onClose(() => {
      count += 1;
    });
    watch.attach("agent-a", a.transport);

    off();
    a.close();

    expect(count).toBe(0);
  });
});

describe("watched channel factory", () => {
  it("pairs each opened transport with the agent id from its own context", async () => {
    const watch = createTransportWatch();
    const transports = new Map<string, ReturnType<typeof fakeTransport>>();
    const opened: string[] = [];

    const factory = createWatchedChannelFactory(
      { endpoint: ENDPOINT },
      {
        open: async (url) => {
          opened.push(url);
          const made = fakeTransport();
          transports.set(`t${transports.size + 1}`, made);
          return made.transport;
        },
      },
      watch,
    );

    factory({
      agentId: "agent-a",
      conversationId: undefined,
      endpoint: ENDPOINT,
      clock: undefined,
    });
    factory({
      agentId: "agent-b",
      conversationId: undefined,
      endpoint: ENDPOINT,
      clock: undefined,
    });
    await settle();

    expect(opened).toHaveLength(2);
    const aTransport = watch.transportOf("agent-a");
    const bTransport = watch.transportOf("agent-b");
    expect(aTransport).not.toBeNull();
    expect(bTransport).not.toBeNull();
    expect(aTransport).not.toBe(bTransport);

    const seen: string[] = [];
    watch.onClose((agentId) => seen.push(agentId));
    // Whichever transport was registered for agent-a is the one that closes.
    for (const made of transports.values()) {
      if (made.transport === aTransport) {
        made.close("agent-a dropped");
      }
    }

    expect(seen).toEqual(["agent-a"]);
  });
});
