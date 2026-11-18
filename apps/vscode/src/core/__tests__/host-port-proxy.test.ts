/**
 * The core's proxy to the host port, driven through a fake pipe.
 *
 * The point is the round trip: a `secure` call has to leave as a
 * `secure.request`, be answered by the host side of the same conversation, and
 * settle on the correlated `secure.reply` -- and it has to fail explicitly when
 * the pipe is gone. `createSecureRequestServer` from `../host/secrets.ts` is the
 * host end here: using the real handler instead of a canned reply means the two
 * halves are proven against each other, which is the only way the pair can be
 * shown to agree on a message shape.
 *
 * Nothing here imports `vscode`; the proxy never could.
 */

import { describe, expect, it } from "vitest";

import { createVSCodeHostPortProxy, HostPortError, type HostPipe } from "../host-port-proxy.js";
import { createSecureRequestServer, createHostSecretStore } from "../../host/secrets.js";
import type { CoreToHost, HostToCore } from "../ipc.js";
import type { EngineSource } from "../ipc.js";
import type { EngineSpawnSpec } from "@haruyuki/core";

/**
 * A pipe whose two ends answer each other in the same process.
 *
 * Delivery is synchronous, as it is for a `fork` channel with `send`, so a test
 * never has to await a separate hop to observe the request.
 */
class FakePipe implements HostPipe {
  readonly sent: HostToCore[] = [];

  private messageListener: (raw: unknown) => void = () => {};

  private disconnectListener: () => void = () => {};

  /** Whether `send` still reaches the other side. */
  connected = true;

  send(message: HostToCore): boolean {
    if (!this.connected) return false;

    this.sent.push(message);

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

  /** Deliver one core-to-host message, as the child would. */
  deliver(message: CoreToHost): void {
    this.messageListener(message);
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

/**
 * Wire the proxy's outgoing requests to the host's real handler.
 *
 * @param pipe the fake pipe both ends share
 * @param values the host store the handler writes to
 * @returns the proxy
 */
function proxyOver(pipe: FakePipe, values: Map<string, string>) {
  const host = createSecureRequestServer({
    store: createHostSecretStore({
      get: async (key) => values.get(key),
      store: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    }),
  });

  const originalSend = pipe.send.bind(pipe);

  // The stand-in for the extension host: every request the proxy sends is handed
  // to the real handler, and its reply is delivered back through the same pipe.
  pipe.send = (message: HostToCore): boolean => {
    const delivered = originalSend(message);

    if (!delivered) return false;

    void host(message).then((reply) => {
      if (reply !== null) pipe.deliver(reply);
    });

    return true;
  };

  return createVSCodeHostPortProxy({ pipe, capabilities: CAPABILITIES, paths: PATHS });
}

describe("the core's host port proxy", () => {
  it("reports the host's capability table verbatim, including the two refusals", () => {
    const pipe = new FakePipe();
    const proxy = proxyOver(pipe, new Map());

    expect(proxy.capabilities).toEqual(CAPABILITIES);
    expect(proxy.capabilities.canPopout).toBe(false);
    expect(proxy.capabilities.canFloat).toBe(false);
  });

  it("reports the four roots the host sent in init", () => {
    const pipe = new FakePipe();
    const proxy = proxyOver(pipe, new Map());

    expect(proxy.paths).toEqual(PATHS);
  });

  it("round-trips a get, a set and a delete through the pipe", async () => {
    const pipe = new FakePipe();
    const values = new Map<string, string>([["token", "stored-value"]]);
    const proxy = proxyOver(pipe, values);

    // get
    await expect(proxy.secure.get("token")).resolves.toBe("stored-value");
    expect(pipe.sent.at(-1)).toMatchObject({
      kind: "secure.request",
      op: "get",
      key: "token",
    });

    // set
    await expect(proxy.secure.set("token", "fresh-value")).resolves.toBeUndefined();
    expect(pipe.sent.at(-1)).toMatchObject({
      kind: "secure.request",
      op: "set",
      key: "token",
      value: "fresh-value",
    });
    expect(values.get("token")).toBe("fresh-value");

    // delete
    await expect(proxy.secure.delete("token")).resolves.toBeUndefined();
    expect(pipe.sent.at(-1)).toMatchObject({ kind: "secure.request", op: "delete", key: "token" });
    expect(values.has("token")).toBe(false);
  });

  it("answers an absent key with undefined, not an invented empty string", async () => {
    const pipe = new FakePipe();
    const proxy = proxyOver(pipe, new Map());

    await expect(proxy.secure.get("missing")).resolves.toBeUndefined();
  });

  it("rejects a secure call the host answers with an error", async () => {
    const pipe = new FakePipe();
    const originalSend = pipe.send.bind(pipe);

    // The host answers with an error rather than a value: that is the
    // "unreadable" arm and must not become an absent secret.
    pipe.send = (message: HostToCore): boolean => {
      const delivered = originalSend(message);

      if (delivered && message.kind === "secure.request") {
        pipe.deliver({
          kind: "secure.reply",
          requestId: message.requestId,
          error: "store unavailable",
        });
      }

      return delivered;
    };

    const proxy = createVSCodeHostPortProxy({
      pipe,
      capabilities: CAPABILITIES,
      paths: PATHS,
    });

    await expect(proxy.secure.get("token")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(proxy.secure.set("token", "value")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("fails an in-flight request when the pipe disconnects", async () => {
    const pipe = new FakePipe();
    const values = new Map<string, string>();

    // A host that never answers: the request is still waiting when the pipe
    // closes, which is exactly the case a silent `undefined` would hide.
    const silent = createVSCodeHostPortProxy({
      pipe,
      capabilities: CAPABILITIES,
      paths: PATHS,
      secureTimeoutMs: 5_000,
    });

    const pending = silent.secure.get("token");

    pipe.disconnect();

    await expect(pending).rejects.toBeInstanceOf(HostPortError);
    await expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });

    // And a call made after the disconnect refuses immediately instead of
    // waiting out a budget for a reply that cannot come.
    await expect(silent.secure.get("token")).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(values.size).toBe(0);
  });

  it("never degrades to a plaintext value when the pipe is closed", async () => {
    const pipe = new FakePipe();
    const proxy = proxyOver(pipe, new Map([["token", "stored-value"]]));

    pipe.disconnect();

    await expect(proxy.secure.get("token")).rejects.toMatchObject({ code: "DISCONNECTED" });
  });

  it("runs a shutdown callback when the pipe closes, and honours unsubscribe", async () => {
    const pipe = new FakePipe();
    const proxy = proxyOver(pipe, new Map());
    const calls: string[] = [];

    proxy.onShutdown(() => calls.push("kept"));

    const unsubscribe = proxy.onShutdown(() => calls.push("removed"));
    unsubscribe();

    pipe.disconnect();

    expect(calls).toEqual(["kept"]);
  });

  it("refuses a spawn spec when no provider is wired in, rather than inventing one", async () => {
    const pipe = new FakePipe();
    const proxy = proxyOver(pipe, new Map());
    const source: EngineSource = {
      kind: "bundled",
      dir: "/engine",
      bundlePath: "/engine/haruyuki.js",
    };

    await expect(proxy.getRuntimeSpawnSpec(source)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("asks the injected spawn-spec provider when one is wired in", async () => {
    const spec: EngineSpawnSpec = {
      exePath: "/usr/bin/node",
      env: {},
      argvPrefix: [],
      bundlePath: "/engine/haruyuki.js",
      cwd: "/engine",
      stdio: "pipe",
      windowsHide: true,
      detached: false,
    };

    const seen: EngineSource[] = [];
    const proxy = createVSCodeHostPortProxy({
      pipe: new FakePipe(),
      capabilities: CAPABILITIES,
      paths: PATHS,
      resolveSpawnSpec: async (source) => {
        seen.push(source);

        return spec;
      },
    });

    const source: EngineSource = {
      kind: "external",
      dir: "/engine",
      bundlePath: "/engine/haruyuki.js",
      version: "9.9.9",
    };

    await expect(proxy.getRuntimeSpawnSpec(source)).resolves.toBe(spec);
    expect(seen).toEqual([source]);
  });

  it("refuses to resolve a local resource, because no webview exists here", async () => {
    const pipe = new FakePipe();
    const proxy = proxyOver(pipe, new Map());

    // There is no URI namespace in this process, so a URL would be a guess the
    // consumer could not load. The refusal says which side owns the answer.
    await expect(proxy.resolveLocalResource("/u/a.png")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});
