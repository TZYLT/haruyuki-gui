/**
 * Tests for the transport seam, whose main job is not losing the first frames a
 * server writes on accept.
 *
 * Contract: the defect's mechanism and measured before/after, what the replay
 * server can and cannot answer, and the rule that a first frame must not be lost.
 * Every case names the deliberate change that turns it red.
 *
 * The accept-tick group talks to a real server over a real socket, because the bug
 * lives in the gap between the socket's `open` event and the moment our promise
 * resumes - a fake socket cannot have that gap. Those cases run on `localhost`
 * and are bounded to a couple of hundred milliseconds each, which is the budget
 * the suite sets for network cases.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { WebSocketServer } from "ws";

import { createTransport, openTransport } from "./transport";
import type { EngineTransport, InboundFrame } from "./transport";
import type { EngineSocket, EngineSocketEventMap } from "../connection";

const sockets: WebSocketServer[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const wss of sockets.splice(0, sockets.length)) {
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
  }
  for (const server of servers.splice(0, servers.length)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

/**
 * A server that writes `frames` in the same tick it accepts the upgrade.
 *
 * This is the shape that reproduced the defect: 4 frames written on accept, 0
 * received when the listener attached after `open`.
 *
 * @param frames texts to write immediately on accept
 * @returns the ws:// URL
 */
async function serverWritingOnAccept(frames: readonly string[]): Promise<string> {
  const server = createServer();
  servers.push(server);

  const wss = new WebSocketServer({ server });
  sockets.push(wss);

  wss.on("connection", (client) => {
    // No await, no setImmediate: write inside the accept callback, which is the
    // tick a real engine answers the handshake in.
    for (const frame of frames) {
      client.send(frame);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return `ws://127.0.0.1:${String(address.port)}`;
}

/** Wait until `predicate` holds or the budget expires. */
async function until(predicate: () => boolean, budgetMs = 300): Promise<boolean> {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  return predicate();
}

/* A fake socket, for the cases that need no gap                     */

type FakeListener = (...args: readonly never[]) => void;

/**
 * Minimal in-memory socket.
 *
 * Written by hand rather than mocked with `vi.fn` so the tests exercise the same
 * `on`/`removeListener` contract the real adapter relies on.
 */
function makeFakeSocket(): {
  readonly socket: EngineSocket;
  readonly sent: string[];
  emitMessage(text: string, isBinary?: boolean): void;
  emitClose(reason?: string): void;
  readonly closed: boolean;
  failNextSend(error: Error): void;
} {
  const listeners = new Map<string, Set<FakeListener>>();
  const sent: string[] = [];
  let closed = false;
  let sendFault: Error | undefined;

  const add = (event: string, listener: FakeListener): void => {
    const set = listeners.get(event) ?? new Set<FakeListener>();
    set.add(listener);
    listeners.set(event, set);
  };

  const remove = (event: string, listener: FakeListener): void => {
    listeners.get(event)?.delete(listener);
  };

  const fire = (event: string, ...args: readonly unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (...rest: readonly unknown[]) => void)(...args);
    }
  };

  const socket: EngineSocket = {
    readyState: 1,
    send(data: string): void {
      if (sendFault !== undefined) {
        throw sendFault;
      }
      sent.push(data);
    },
    close(): void {
      closed = true;
      fire("close", 1000, Buffer.from(""));
    },
    terminate(): void {
      closed = true;
    },
    on<E extends keyof EngineSocketEventMap>(
      event: E,
      listener: (...args: EngineSocketEventMap[E]) => void,
    ): EngineSocket {
      add(event, listener as FakeListener);
      return socket;
    },
    once<E extends keyof EngineSocketEventMap>(
      event: E,
      listener: (...args: EngineSocketEventMap[E]) => void,
    ): EngineSocket {
      const wrapper = (...args: EngineSocketEventMap[E]): void => {
        remove(event, wrapper as FakeListener);
        listener(...args);
      };
      add(event, wrapper as FakeListener);
      return socket;
    },
    removeListener<E extends keyof EngineSocketEventMap>(
      event: E,
      listener: (...args: EngineSocketEventMap[E]) => void,
    ): EngineSocket {
      remove(event, listener as FakeListener);
      return socket;
    },
  };

  return {
    socket,
    sent,
    emitMessage(text: string, isBinary = false): void {
      fire("message", Buffer.from(text, "utf8"), isBinary);
    },
    emitClose(reason = ""): void {
      closed = true;
      fire("close", 1000, Buffer.from(reason, "utf8"));
    },
    get closed(): boolean {
      return closed;
    },
    failNextSend(error: Error): void {
      sendFault = error;
    },
  };
}

/* the first frames reach the first subscriber                        */

describe("frames written on accept are not lost", () => {
  it("delivers all four frames a server writes in the accept tick", async () => {
    // Red when: the message listener is installed after the promise resolves.
    // Measured before the fix: 0 of 4. This is the assertion that pins the fix.
    const url = await serverWritingOnAccept(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);

    const transport = await openTransport(url, "token");
    const seen: InboundFrame[] = [];
    transport.onFrame((frame) => seen.push(frame));

    // The early frames were captured before `openTransport` resolved, so the
    // first subscriber must already have them without waiting.
    expect(seen).toHaveLength(4);
    expect(seen.map((frame) => frame.raw)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);

    transport.close();
  });

  it("keeps the arrival order when the server writes several frames", async () => {
    // Red when: the buffer is a Set, a Map keyed by content, or drained LIFO.
    const url = await serverWritingOnAccept(['{"n":1}', '{"n":2}', '{"n":3}']);

    const transport = await openTransport(url, "token");
    const seen: string[] = [];
    transport.onFrame((frame) => seen.push(frame.raw));

    expect(seen).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);

    transport.close();
  });

  it("gives each early frame a timestamp from the injected clock", async () => {
    // Red when: the capture path skips the clock, leaving early frames with no
    // `at` or with wall time while later frames use the fake clock.
    const url = await serverWritingOnAccept(['{"n":1}']);
    let tick = 1_700_000_000_000;

    const transport = await openTransport(url, "token", {
      now: () => {
        tick += 1;
        return tick;
      },
    });

    const seen: InboundFrame[] = [];
    transport.onFrame((frame) => seen.push(frame));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.at).toBeGreaterThan(1_700_000_000_000);

    transport.close();
  });

  it("delivers the early frames to the first subscriber only, once", async () => {
    // Red when: the replay runs per subscriber instead of once, so the second
    // subscriber sees the same frames again.
    //
    // The guard is `replayed`, and the queue is emptied by `splice`, so disabling
    // the guard alone is equivalent to keeping it - there is nothing left to
    // replay. This case therefore also pins the count, which a "copy instead of
    // splice" implementation would break while the guard stayed green: with a
    // copy, every later subscriber would receive the same early frames again.
    const url = await serverWritingOnAccept(['{"n":1}', '{"n":2}']);

    const transport = await openTransport(url, "token");
    const first: string[] = [];
    const second: string[] = [];
    const third: string[] = [];

    transport.onFrame((frame) => first.push(frame.raw));

    await until(() => !transport.isOpen, 30);

    transport.onFrame((frame) => second.push(frame.raw));
    transport.onFrame((frame) => third.push(frame.raw));

    expect(first).toEqual(['{"n":1}', '{"n":2}']);
    expect(second, "a second subscriber must not replay the early queue").toEqual([]);
    expect(third, "nor a third").toEqual([]);

    transport.close();
  });
});

/* The seam itself                                                    */

describe("sending", () => {
  it("reports ok and writes the exact text", () => {
    // Red when: `send` re-serialises or reshapes what it was given.
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket);

    const result = transport.send('{"type":"x"}');

    expect(result).toEqual({ ok: true });
    expect(fake.sent).toEqual(['{"type":"x"}']);
  });

  it("reports a fault instead of throwing, so the caller can classify it", () => {
    // Red when: the write is not guarded. A throwing send would escape through
    // whatever called it - often a render-path handler.
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket);
    fake.failNextSend(new Error("socket went away"));

    const result = transport.send('{"type":"x"}');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("socket went away");
    }
    expect(fake.sent).toEqual([]);
  });

  it("refuses to write after the transport closed", () => {
    // Red when: `isOpen` is not checked, so a write goes to a dead socket and
    // reports success.
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket);
    transport.close();

    expect(transport.isOpen).toBe(false);
    const result = transport.send('{"type":"x"}');
    expect(result.ok).toBe(false);
    expect(fake.sent).toEqual([]);
  });
});

describe("receiving", () => {
  it("gives each frame the locally observed time, not a value from the frame", () => {
    // Red when: `at` is taken from the frame body, which would make it the
    // engine's clock - a value from another clock cannot be compared.
    //
    // The frame carries an `emitted_at` precisely so a stray parse-and-parse-back
    // cannot hide: if the implementation read it, `at` would be the string's
    // value rather than the injected 42.
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket, { now: () => 42 });
    const seen: InboundFrame[] = [];
    transport.onFrame((frame) => seen.push(frame));

    fake.emitMessage('{"emitted_at":1700000000000}');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.at).toBe(42);
    expect(seen[0]?.raw).toBe('{"emitted_at":1700000000000}');
  });

  it("does not rewrite the frame text", () => {
    // Red when: the transport parses and re-serialises, which would change key
    // order and could drop fields it does not know.
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket);
    const seen: string[] = [];
    transport.onFrame((frame) => seen.push(frame.raw));

    const original = '{"z":1,"a":2,"nested":{"y":[]}}';
    fake.emitMessage(original);

    expect(seen[0]).toBe(original);
  });

  it("keeps delivering to the other subscribers when one throws", () => {
    // Red when: the fan-out is a bare loop. One bad subscriber would take down
    // the socket's message handler and stop delivery for everyone.
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket);
    const survivor: string[] = [];

    transport.onFrame(() => {
      throw new Error("subscriber bug");
    });
    transport.onFrame((frame) => survivor.push(frame.raw));

    fake.emitMessage('{"n":1}');

    expect(survivor).toEqual(['{"n":1}']);
  });

  it("stops delivering to an unsubscribed listener", () => {
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket);
    const seen: string[] = [];
    const off = transport.onFrame((frame) => seen.push(frame.raw));

    fake.emitMessage('{"n":1}');
    off();
    fake.emitMessage('{"n":2}');

    expect(seen).toEqual(['{"n":1}']);
  });

  it("tolerates an unsubscribe called twice", () => {
    // Red when: the unsubscribe closes over a counter or a non-idempotent hook.
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket);
    const off = transport.onFrame(() => undefined);

    off();
    expect(() => {
      off();
    }).not.toThrow();
  });

  it("ignores binary frames", () => {
    // Red when: binary frames are decoded as UTF-8 and handed on as JSON.
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket);
    const seen: string[] = [];
    transport.onFrame((frame) => seen.push(frame.raw));

    fake.emitMessage("\u0000\u0001binary", true);

    expect(seen).toEqual([]);
  });
});

describe("closing", () => {
  it("notifies close subscribers once and flips isOpen", () => {
    // Red when: the close path runs per event with no guard, or `isOpen` keeps
    // reporting true after the socket went away.
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket);
    const reasons: string[] = [];
    transport.onClose((reason) => reasons.push(reason));

    fake.emitClose("engine said bye");
    fake.emitClose("engine said bye");

    expect(reasons).toEqual(["engine said bye"]);
    expect(transport.isOpen).toBe(false);
  });

  it("is idempotent and reports closed immediately after close()", () => {
    const fake = makeFakeSocket();
    const transport = createTransport(fake.socket);

    transport.close();

    expect(transport.isOpen).toBe(false);
    expect(() => {
      transport.close();
    }).not.toThrow();
  });

  it("swallows a throwing close, because the intent is already satisfied", () => {
    // Red when: close propagates, so one already-destroyed socket makes the
    // caller's cleanup path throw and the rest of the shutdown does not run.
    const fake = makeFakeSocket();
    const socket: EngineSocket = {
      ...fake.socket,
      close(): void {
        throw new Error("already destroyed");
      },
    };
    const transport: EngineTransport = createTransport(socket);

    expect(() => {
      transport.close();
    }).not.toThrow();
    expect(transport.isOpen).toBe(false);
  });
});

/* Real-socket sanity: the transport works against a live peer   */

describe("against a live server", () => {
  it("receives a frame the server sends later", async () => {
    // Confirms the capture path did not break ordinary delivery: a frame written
    // after the handshake must arrive through the same listener.
    const server = createServer();
    servers.push(server);
    const wss = new WebSocketServer({ server });
    sockets.push(wss);

    let sendLater: ((text: string) => void) | undefined;
    wss.on("connection", (client) => {
      sendLater = (text: string): void => {
        client.send(text);
      };
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address() as AddressInfo;

    const transport = await openTransport(`ws://127.0.0.1:${String(address.port)}`, "token");
    const seen: string[] = [];
    transport.onFrame((frame) => seen.push(frame.raw));

    sendLater?.('{"later":true}');

    expect(await until(() => seen.length > 0)).toBe(true);
    expect(seen).toEqual(['{"later":true}']);

    transport.close();
  });
});

/* The two things the returned object must not get wrong                */

describe("openTransport's wrapper keeps the transport's own answers", () => {
  it("reports isOpen false once the connection has gone away", async () => {
    // Red when: `isOpen` is spread in rather than re-declared. Spreading evaluates
    // the getter once and freezes the answer, so the copy says `true` forever -
    // including after the socket closed. `wiring.ts` gates three decisions on this
    // flag, so a frozen `true` means it keeps claiming it can write.
    //
    // Measured before the fix: `createTransport().isOpen` went false while
    // `openTransport().isOpen` stayed true.
    const url = await serverWritingOnAccept(['{"n":1}']);

    const transport = await openTransport(url, "token");
    expect(transport.isOpen).toBe(true);

    transport.close();

    expect(transport.isOpen, "a closed transport must not still report open").toBe(false);
  });

  it("delivers each captured frame to the first subscriber exactly once", async () => {
    // Red when: the capture listener stays attached after the transport takes the
    // socket over. A frame arriving in that window then lands in BOTH queues - the
    // capture buffer and the transport's own early queue - and the first subscriber
    // receives it twice.
    //
    // The window has to be manufactured: the server writes a second frame *after*
    // the transport exists but *before* anyone subscribes. Writing only on accept
    // would put every frame in the capture buffer alone, and removing the detach
    // would then change nothing - a test that passes for the wrong reason.
    const server = createServer();
    servers.push(server);
    const wss = new WebSocketServer({ server });
    sockets.push(wss);

    let writeLate: (() => void) | undefined;
    wss.on("connection", (client) => {
      client.send('{"n":1}');
      // Fires on a later tick, after `openTransport` has resolved.
      writeLate = () => {
        client.send('{"n":2}');
      };
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address() as AddressInfo;

    const transport = await openTransport(`ws://127.0.0.1:${String(address.port)}`, "token");

    writeLate?.();
    // Let the late frame reach the socket before subscribing, so it is queued in
    // whichever buffers are listening.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    const seen: string[] = [];
    transport.onFrame((frame) => seen.push(frame.raw));

    expect(seen, "each frame once, in order").toEqual(['{"n":1}', '{"n":2}']);

    transport.close();
  });
});
