/**
 * The secret-store leg, end to end across the real pipe seam.
 *
 * A `secure.request` is the one message on this channel that travels against its
 * own family: the child asks it and the host answers it. Every test below
 * therefore starts at the child's end of a pipe and ends at the host's write
 * back, using the real `createVSCodeHostPortProxy` and the real handler from
 * `../secrets.ts`. Neither end is a canned reply, so what is proven is that the
 * two halves agree on a message shape rather than that each agrees with a mock.
 *
 * Two of the tests go through a real `fork`ed child as well, because the seam is
 * a method on `CoreProcessHost` and a host whose injection point is wrong is a
 * host whose unit tests all pass.
 *
 * Nothing here imports `vscode`, and no collected log may contain a stored
 * value: several tests assert exactly that over the whole recorded output.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createVSCodeHostPortProxy,
  HostPortError,
  type HostPipe,
} from "../../core/host-port-proxy.js";
import type { CoreToHost, HostToCore } from "../../core/ipc.js";
import { CoreProcessHost, type CoreHostInit } from "../core-host.js";
import {
  createSecureInboundAnswerer,
  createSecureRequestServer,
  MALFORMED_REQUEST,
  STORE_TIMEOUT,
  STORE_UNAVAILABLE,
  type HostSecretStore,
  type SecureReplyMessage,
} from "../secrets.js";

/** The value every test stores. No recorded line may ever contain it. */
const SECRET = "s3cr3t-value";

/** The fragment a leak assertion looks for, so a partial echo is caught too. */
const SECRET_FRAGMENT = "s3cr3t";

/** Operations the wire helpers can record without a store at all. */
type HostAnswer = (raw: unknown) => Promise<SecureReplyMessage | null>;

/**
 * A pipe whose two ends answer each other in this process.
 *
 * `send` is the child's send: it records the message and hands it to the host,
 * whose answer is delivered back through the message listener the proxy
 * subscribed. Delivery is queued rather than recursive so a handler that awaits
 * a store behaves exactly as it does across a real channel.
 */
class FakePipe implements HostPipe {
  /** Every message the child sent, in order. */
  readonly sent: HostToCore[] = [];

  /** Every answer the host wrote back, in order. */
  readonly answered: CoreToHost[] = [];

  private messageListener: (raw: unknown) => void = () => {};

  private disconnectListener: () => void = () => {};

  private host: HostAnswer = () => Promise.resolve(null);

  /** Whether `send` still reaches the other side. */
  connected = true;

  /** Install the host handler the child's requests are handed to. */
  serveWith(host: HostAnswer): void {
    this.host = host;
  }

  send(message: HostToCore): boolean {
    if (!this.connected) return false;

    this.sent.push(message);

    void Promise.resolve().then(async () => {
      const reply = await this.host(message);

      if (reply === null) return;

      this.answered.push(reply);
      this.messageListener(reply);
    });

    return true;
  }

  onMessage(listener: (raw: unknown) => void): () => void {
    this.messageListener = listener;

    return () => {
      this.messageListener = () => {};
    };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListener = listener;

    return () => {
      this.disconnectListener = () => {};
    };
  }

  /** Close the pipe: nothing is delivered and every send is refused. */
  disconnect(): void {
    this.connected = false;
    this.disconnectListener();
  }
}

/** The host's answers, handed over as the `init` data they arrive as. */
const CAPABILITIES = {
  canNotify: true,
  canPopout: false,
  canFloat: false,
  canOpenExternal: true,
  canPickFiles: true,
  canReadDroppedFiles: false,
} as const;

const PATHS = { userData: "/u", logs: "/l", cache: "/c", temp: "/t" } as const;

/** A store whose contents and recorded output one test owns. */
type Fixture = {
  readonly proxy: ReturnType<typeof createVSCodeHostPortProxy>;
  readonly pipe: FakePipe;
  readonly values: Map<string, string>;
  readonly lines: string[];
};

/**
 * Wire the core's proxy to the host's real handler over one fake pipe.
 *
 * @param store the host store; defaults to a working map
 * @param storeTimeoutMs budget for one store call, when a test needs a short one
 * @param secureTimeoutMs budget for the proxy's own wait, likewise
 * @returns the proxy, the pipe, the store contents and the log lines
 */
function wire(store?: HostSecretStore, storeTimeoutMs?: number, secureTimeoutMs?: number): Fixture {
  const pipe = new FakePipe();
  const values = new Map<string, string>();
  const lines: string[] = [];

  const hostStore: HostSecretStore = store ?? {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };

  pipe.serveWith(
    createSecureRequestServer({
      store: hostStore,
      log: (line) => lines.push(line),
      ...(storeTimeoutMs === undefined ? {} : { timeoutMs: storeTimeoutMs }),
    }),
  );

  const proxy = createVSCodeHostPortProxy({
    pipe,
    capabilities: CAPABILITIES,
    paths: PATHS,
    ...(secureTimeoutMs === undefined ? {} : { secureTimeoutMs }),
  });

  return { proxy, pipe, values, lines };
}

/** @returns a promise that never settles, standing in for a hung store call */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Deliberately never settles: a budget is what must answer instead.
  });
}

describe("the secure round trip", () => {
  it("carries a set, a get and a delete between the core and the real store", async () => {
    const { proxy, pipe, values } = wire();

    await expect(proxy.secure.set("token", SECRET)).resolves.toBeUndefined();
    expect(values.get("token")).toBe(SECRET);

    // The request that crossed was a shape the host could read, and the answer
    // was the correlated reply: a write carries no value back.
    expect(pipe.sent.at(-1)).toMatchObject({
      kind: "secure.request",
      op: "set",
      key: "token",
      value: SECRET,
    });
    expect(pipe.answered.at(-1)).toMatchObject({ kind: "secure.reply" });
    expect(pipe.answered.at(-1)).not.toHaveProperty("value");

    await expect(proxy.secure.get("token")).resolves.toBe(SECRET);

    await expect(proxy.secure.delete("token")).resolves.toBeUndefined();
    expect(values.has("token")).toBe(false);
    await expect(proxy.secure.get("token")).resolves.toBeUndefined();
  });

  it("keeps an absent key distinguishable from an empty one across the pipe", async () => {
    const { proxy, pipe } = wire({
      get: async (key) => (key === "blank" ? "" : undefined),
      set: async () => undefined,
      delete: async () => undefined,
    });

    // An empty string is a stored value and must survive as one.
    await expect(proxy.secure.get("blank")).resolves.toBe("");

    // A key nobody stored answers no value at all, never an invented "".
    await expect(proxy.secure.get("missing")).resolves.toBeUndefined();

    // The distinction is on the wire, not only in the proxy: the second reply
    // has no `value` field at all.
    const values = pipe.answered.map((reply) => Object.hasOwn(reply, "value"));

    expect(values).toEqual([true, false]);
  });

  it("correlates two concurrent calls instead of answering them in one order", async () => {
    const { proxy } = wire({
      get: async (key) => (key === "slow" ? never<string>() : `value-of-${key}`),
      set: async () => undefined,
      delete: async () => undefined,
    });

    const slow = proxy.secure.get("slow");
    const fast = proxy.secure.get("fast");

    // The later call answers first, which a reply keyed by arrival order would
    // hand to the wrong caller.
    await expect(fast).resolves.toBe("value-of-fast");
    await Promise.resolve();

    // The slow one is still in flight; the test ends it by closing the pipe.
    let settled = false;

    void slow.catch(() => {
      settled = true;
    });

    await Promise.resolve();

    expect(settled).toBe(false);
  });
});

describe("the secure failure paths", () => {
  it("answers a slow store with its own code rather than the generic failure", async () => {
    const { proxy, lines } = wire(
      { get: () => never<string>(), set: () => never<void>(), delete: () => never<void>() },
      20,
    );

    const pending = proxy.secure.get("token");

    // The host's timeout crosses the pipe as a reply error, so the core sees
    // the proxy's `UNAVAILABLE` arm carrying the timeout's own sentence.
    await expect(pending).rejects.toBeInstanceOf(HostPortError);
    await expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE", message: STORE_TIMEOUT });

    // And the log names the operation that timed out, not the generic failure.
    expect(lines.at(-1)).toContain("did not answer");
    expect(lines.at(-1)).toContain("get request");
    expect(STORE_TIMEOUT).not.toBe(STORE_UNAVAILABLE);
  });

  it("answers a store that throws with the fixed unavailable code", async () => {
    const { proxy, lines } = wire({
      get: async () => {
        throw new Error(`decryption failed for ${SECRET}`);
      },
      set: async () => {
        throw new Error(`keychain locked while writing ${SECRET}`);
      },
      delete: async () => {
        throw new Error("keychain locked");
      },
    });

    await expect(proxy.secure.get("token")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(proxy.secure.set("token", SECRET)).rejects.toMatchObject({ code: "UNAVAILABLE" });

    // The store's own message is not forwarded: it may quote the value it
    // failed on, so neither the reply nor the log carries any part of it.
    const rendered = JSON.stringify({ lines });

    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(SECRET_FRAGMENT);
    expect(rendered).not.toContain("decryption failed");
    expect(rendered).not.toContain("keychain locked");
  });

  it("fails an in-flight call when the pipe closes, and never answers plaintext", async () => {
    const { proxy, pipe } = wire(undefined, undefined, 5_000);

    // A host that never answers: the request is still in flight when the pipe
    // closes, which is exactly the case a silent `undefined` would hide.
    pipe.serveWith(() => never<SecureReplyMessage>());

    const pending = proxy.secure.get("token");

    pipe.disconnect();

    await expect(pending).rejects.toBeInstanceOf(HostPortError);
    await expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });

    // A call made after the close refuses immediately rather than waiting out a
    // budget for a reply that cannot come.
    await expect(proxy.secure.get("token")).rejects.toMatchObject({ code: "DISCONNECTED" });
  });

  it("keeps a timeout and a closed pipe apart by code", async () => {
    // No handler at all: the proxy's own budget is the only thing that answers.
    const silent = wire(undefined, undefined, 10);
    const closed = wire();

    silent.pipe.serveWith(() => never<SecureReplyMessage>());
    closed.pipe.disconnect();

    await expect(silent.proxy.secure.get("token")).rejects.toMatchObject({
      code: "SECURE_TIMEOUT",
    });
    await expect(closed.proxy.secure.get("token")).rejects.toMatchObject({ code: "DISCONNECTED" });
  });
});

describe("the secure log", () => {
  it("never carries a value through a whole set, get and delete cycle", async () => {
    const { proxy, pipe, lines } = wire();

    await proxy.secure.set("token", SECRET);
    await expect(proxy.secure.get("token")).resolves.toBe(SECRET);
    await proxy.secure.delete("token");

    const rendered = JSON.stringify({ lines });

    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(SECRET_FRAGMENT);

    // The value did cross twice -- the get's answer is the proof -- so the
    // assertions above are about a cycle that happened, not an empty one.
    expect(JSON.stringify(pipe.answered)).toContain(SECRET);
    expect(pipe.answered).toHaveLength(3);
  });

  it("names the operation but never the key or the value on a failing store", async () => {
    const { proxy, lines } = wire({
      get: async () => {
        throw new Error(`cannot read the token ${SECRET}`);
      },
      set: async () => undefined,
      delete: async () => undefined,
    });

    await expect(proxy.secure.get("token")).rejects.toMatchObject({ code: "UNAVAILABLE" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("failed the get request");
    expect(lines[0]).not.toContain("token");
    expect(lines[0]).not.toContain(SECRET_FRAGMENT);
  });
});

describe("the inbound answerer", () => {
  it("owns a well-formed request and refuses one it cannot read", async () => {
    const delivered: SecureReplyMessage[] = [];
    const answerer = createSecureInboundAnswerer({
      store: {
        get: async () => SECRET,
        set: async () => undefined,
        delete: async () => undefined,
      },
    });

    // A message that is not a request belongs to the next handler.
    expect(answerer({ kind: "command.invoke", callId: "c1" }, () => true)).toBe(false);
    expect(answerer("not a message", () => true)).toBe(false);

    // Without a usable id there is nothing to correlate, so it is not ours.
    expect(
      answerer({ kind: "secure.request", requestId: "", op: "get", key: "k" }, () => true),
    ).toBe(false);

    // A request with an id but unusable fields is owned and refused, because the
    // core is waiting on an answer for that id.
    expect(
      answerer({ kind: "secure.request", requestId: "r1", op: "set", key: "token" }, (reply) => {
        delivered.push(reply);

        return true;
      }),
    ).toBe(true);

    await expect.poll(() => delivered.length, { timeout: 1_000 }).toBe(1);

    expect(delivered).toEqual([
      { kind: "secure.reply", requestId: "r1", error: MALFORMED_REQUEST },
    ]);
  });

  it("answers through the delivered sink and reports a closed pipe by code", async () => {
    const lines: string[] = [];
    const answerer = createSecureInboundAnswerer({
      store: {
        get: async () => SECRET,
        set: async () => undefined,
        delete: async () => undefined,
      },
      log: (line) => lines.push(line),
    });

    const delivered: SecureReplyMessage[] = [];

    expect(
      answerer({ kind: "secure.request", requestId: "r2", op: "get", key: "token" }, (reply) => {
        delivered.push(reply);

        return true;
      }),
    ).toBe(true);

    // One settled store call later the reply is handed over exactly once.
    await expect.poll(() => delivered.length, { timeout: 1_000 }).toBe(1);

    expect(delivered[0]).toEqual({ kind: "secure.reply", requestId: "r2", value: SECRET });
    expect(lines).toEqual([]);

    // A second request whose sink refuses the write is reported once, by code.
    answerer({ kind: "secure.request", requestId: "r3", op: "get", key: "token" }, () => false);

    await expect.poll(() => lines.length, { timeout: 1_000 }).toBe(1);

    expect(lines[0]).toContain("dropped a secret reply");
    expect(JSON.stringify(lines)).not.toContain(SECRET_FRAGMENT);
  });
});

/** Children forked by a test, force-killed in `afterEach`. */
const started = new Set<CoreProcessHost>();

/** Temp roots created by a test, removed in `afterEach`. */
const roots: string[] = [];

afterEach(async () => {
  for (const host of started) {
    started.delete(host);
    await host.stop().catch(() => {
      // A host that cannot stop shows up as the next test's timeout.
    });
  }

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The init every forked test sends; the child only reads `cwd`. */
const INIT: CoreHostInit = {
  paths: { userData: "/u", logs: "/l", cache: "/c", temp: "/t" },
  cwd: tmpdir(),
  locale: "en",
  engine: { kind: "bundled", dir: "/engine", bundlePath: "/engine/haruyuki.js" },
  expectedVersion: "1.0.0",
};

/**
 * Write a child that asks its host one secret question once it is ready.
 *
 * The child reports the answer as a frame carrying its JSON, which is the only
 * channel a generated script can use to prove what it received; a frame's
 * payload is opaque to the host, so the host never parses it in production.
 *
 * @param body the messages the child sends after `ready`
 * @returns the entry path
 */
function makeAskingChild(body: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "haruyuki-secure-path-"));

  roots.push(root);

  const entry = path.join(root, "child.mjs");

  writeFileSync(
    entry,
    `process.on("message", (message) => {
  if (message.kind === "init") {
    process.send({ kind: "ready" });
    ${body}
    return;
  }

  if (message.kind === "secure.reply") {
    process.send({ kind: "frame", channel: "control", payload: JSON.stringify(message) });
  }
});
setInterval(() => {}, 1000);
`,
    "utf8",
  );

  return entry;
}

/**
 * Wait for the first frame and parse its payload as a reply.
 *
 * @param host the host under test
 * @param budgetMs how long the whole exchange may take
 * @returns the reply the child reported
 */
async function firstReply(host: CoreProcessHost, budgetMs = 10_000): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no secure.reply reached the child within ${String(budgetMs)} ms`));
    }, budgetMs);

    const off = host.onFrame((frame) => {
      clearTimeout(timer);
      off();
      resolve(JSON.parse(frame.payload) as unknown);
    });
  });
}

describe("the secure pipe seam", () => {
  it("answers a value request the child sent, over the real fork channel", async () => {
    const entry = makeAskingChild(
      `process.send({ kind: "secure.request", requestId: "r1", op: "get", key: "token" });`,
    );

    const lines: string[] = [];
    const host = new CoreProcessHost({
      entryPath: entry,
      stopTimeoutMs: 500,
      secureInbound: createSecureInboundAnswerer({
        store: {
          get: async (key) => (key === "token" ? SECRET : undefined),
          set: async () => undefined,
          delete: async () => undefined,
        },
        log: (line) => lines.push(line),
      }),
    });

    started.add(host);

    const reply = firstReply(host);

    await host.start(INIT);

    // The child's own report of what it received: a correlated reply carrying
    // the stored value, which is the only place that value may appear.
    await expect(reply).resolves.toEqual({
      kind: "secure.reply",
      requestId: "r1",
      value: SECRET,
    });

    expect(JSON.stringify(lines)).not.toContain(SECRET_FRAGMENT);
  });

  it("answers an unusable request with a refusal the child can correlate", async () => {
    const entry = makeAskingChild(
      `process.send({ kind: "secure.request", requestId: "r5", op: "set", key: "token" });`,
    );

    // The store would accept anything, so a value written here would prove the
    // host had answered a request that carried no value at all.
    const written: string[] = [];
    const host = new CoreProcessHost({
      entryPath: entry,
      stopTimeoutMs: 500,
      secureInbound: createSecureInboundAnswerer({
        store: {
          get: async () => undefined,
          set: async (key, value) => {
            written.push(`${key}=${value}`);
          },
          delete: async () => undefined,
        },
      }),
    });

    started.add(host);

    const reply = firstReply(host);

    await host.start(INIT);

    await expect(reply).resolves.toEqual({
      kind: "secure.reply",
      requestId: "r5",
      error: MALFORMED_REQUEST,
    });
    expect(written).toEqual([]);
  });

  it("answers nothing when no handler is wired in, and does not crash the loop", async () => {
    const entry = makeAskingChild(
      `process.send({ kind: "secure.request", requestId: "r7", op: "get", key: "token" });`,
    );

    // No `secureInbound`: the request belongs to a message family this host was
    // not given a handler for, so it is refused as a value. The core's own
    // budget then answers its caller, which is explicit rather than silent.
    const host = new CoreProcessHost({ entryPath: entry, stopTimeoutMs: 500 });
    const lines: string[] = [];

    started.add(host);
    host.onLog((log) => lines.push(log.line));

    await host.start(INIT);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(lines.filter((line) => line.includes("unusable")).length).toBe(1);

    // The host is still usable for everything else after the refusal.
    expect(host.secure).toBeTypeOf("function");
  });
});

describe("the secure value's reach", () => {
  it("never reaches the child's argv or environment", async () => {
    // The child inspects itself and reports what it found. A value handed over
    // as `argv` or as an environment entry would be visible to every process on
    // the machine, which is why this is asserted rather than commented.
    const entry = makeAskingChild(
      `process.send({
         kind: "frame",
         channel: "control",
         payload: JSON.stringify({
           argv: process.argv,
           env: Object.entries(process.env).filter(([, value]) => value.includes(${JSON.stringify(
             SECRET_FRAGMENT,
           )})),
         }),
       });`,
    );

    const values = new Map<string, string>([["token", SECRET]]);
    const host = new CoreProcessHost({
      entryPath: entry,
      stopTimeoutMs: 500,
      secureInbound: createSecureInboundAnswerer({
        store: {
          get: async (key) => values.get(key),
          set: async (key, value) => {
            values.set(key, value);
          },
          delete: async (key) => {
            values.delete(key);
          },
        },
      }),
    });

    started.add(host);

    const report = firstReply(host);

    await host.start(INIT);

    const seen = (await report) as { argv: string[]; env: [string, string][] };

    // The child was forked, so it has an argv of its own; nothing in it is the
    // secret, and no environment entry quotes it either.
    expect(seen.argv.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen.argv)).not.toContain(SECRET_FRAGMENT);
    expect(seen.env).toEqual([]);
  });
});
