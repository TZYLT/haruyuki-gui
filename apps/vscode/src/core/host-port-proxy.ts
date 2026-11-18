/**
 * The core child's view of the extension host port.
 *
 * The child is a separate Node process: it has no `vscode` module, no webview
 * and no `ExtensionContext`. Everything it knows about its host arrived as data
 * in the `init` message, and the one member it can act on at runtime - the
 * secret store - is a request/response pair over the pipe.
 *
 * This module therefore owns three things and nothing else:
 *
 *   secure      Each call mints an id, sends `secure.request` and settles on the
 *               correlated `secure.reply`. A rejection is the only failure
 *               channel, because `Promise<string | undefined>` has no failure
 *               arm: `undefined` already means "the user stored no such key",
 *               and reusing it for "the host is unreachable" would let a broken
 *               store look like an absent secret. There is no plaintext
 *               fallback and no cached copy.
 *   shutdown    A callback list that runs when the host pipe closes, which is
 *               the child's only reliable signal that the shell is going away.
 *   failures    A closed pipe is explicit: every in-flight request rejects, and
 *               every later call rejects instead of waiting for a reply that
 *               cannot come.
 *
 * Two members cannot cross the pipe at all, because `../core/ipc.ts` carries no
 * message for them. They are answered here with an explicit sentence rather
 * than a guess:
 *
 * - `getRuntimeSpawnSpec` is the seam the engine start path fills in. The host
 *   answered that question when it was asked; the child is handed the result.
 * - `resolveLocalResource` needs the `Webview` instance that owns the URI
 *   namespace, and no webview exists in this process. The host resolves a local
 *   path when it puts it into a frame.
 *
 * Nothing here may import `vscode`: this file runs in the child, where that
 * module does not exist and importing it would only fail after the engine is
 * already expected to be running.
 */

import { randomUUID } from "node:crypto";

import type { EngineSpawnSpec } from "@haruyuki/core";

import { narrowCoreToHost, type EngineSource, type HostToCore, type SecureOp } from "./ipc.js";
import type { SecureStore } from "./main.js";

/** Budget for one secret-store round trip; the host answers in milliseconds. */
const DEFAULT_SECURE_TIMEOUT_MS = 10_000;

/** The closed set of ways a proxied member can fail. */
export const HOST_PORT_ERROR_CODES = ["DISCONNECTED", "SECURE_TIMEOUT", "UNAVAILABLE"] as const;

/** One kind of proxy failure. */
export type HostPortErrorCode = (typeof HOST_PORT_ERROR_CODES)[number];

/** A proxied member's failure, carrying a code so a caller never parses text. */
export class HostPortError extends Error {
  readonly code: HostPortErrorCode;

  /**
   * @param code the failure this instance represents
   * @param detail an English ASCII sentence; never a secret
   */
  constructor(code: HostPortErrorCode, detail: string) {
    super(detail);
    this.name = "HostPortError";
    this.code = code;
  }
}

/**
 * The pipe, narrowed to what this proxy uses.
 *
 * The same three members `CoreTransport` offers the message loop, minus the
 * process boundary: the proxy subscribes to one message stream and listens for
 * the one disconnect signal, and it never decides when the child exits.
 */
export type HostPipe = {
  /** Deliver one message to the extension host. */
  send(message: HostToCore): boolean | void;
  /** @returns the unsubscribe function */
  onMessage(listener: (raw: unknown) => void): () => void;
  /** @returns the unsubscribe function */
  onDisconnect(listener: () => void): () => void;
};

/** What the core sees of its host. */
export type VSCodeHostPortProxy = {
  /** The host's own answers, handed over as data when the child started. */
  readonly capabilities: {
    readonly canNotify: boolean;
    readonly canPopout: boolean;
    readonly canFloat: boolean;
    readonly canOpenExternal: boolean;
    readonly canPickFiles: boolean;
    readonly canReadDroppedFiles: boolean;
  };
  readonly paths: {
    readonly userData: string;
    readonly logs: string;
    readonly cache: string;
    readonly temp: string;
  };
  /** The seam the engine start path fills in; see the file comment. */
  getRuntimeSpawnSpec(source: EngineSource): Promise<EngineSpawnSpec>;
  readonly secure: SecureStore;
  /** Always rejects here; see the file comment. */
  resolveLocalResource(path: string): Promise<string>;
  /** @returns an unsubscribe function */
  onShutdown(callback: () => void): () => void;
};

/** Options of {@link createVSCodeHostPortProxy}. */
export type VSCodeHostPortProxyOptions = {
  /** The pipe to the extension host. */
  readonly pipe: HostPipe;
  /** The capability table the host reported. */
  readonly capabilities: VSCodeHostPortProxy["capabilities"];
  /** The four roots, as they arrived in `init`. */
  readonly paths: VSCodeHostPortProxy["paths"];
  /**
   * Where the spawn spec comes from once the engine start path exists.
   *
   * Absent means the member refuses by name instead of inventing a spec: a
   * fabricated `exePath` would spawn the wrong interpreter, and a fabricated
   * `cwd` would write the engine's tree somewhere nobody chose.
   */
  readonly resolveSpawnSpec?: (source: EngineSource) => Promise<EngineSpawnSpec>;
  /** Per-request budget; see {@link DEFAULT_SECURE_TIMEOUT_MS}. */
  readonly secureTimeoutMs?: number;
};

/** One secret request waiting for its correlated reply. */
type PendingSecure = {
  readonly resolve: (value: string | undefined) => void;
  readonly reject: (error: HostPortError) => void;
  readonly timer: NodeJS.Timeout;
};

/**
 * Build the proxy.
 *
 * @param options the pipe, the host's data and the spawn-spec seam
 * @returns the port as the core sees it
 */
export function createVSCodeHostPortProxy(
  options: VSCodeHostPortProxyOptions,
): VSCodeHostPortProxy {
  const { pipe } = options;
  const secureTimeoutMs = options.secureTimeoutMs ?? DEFAULT_SECURE_TIMEOUT_MS;

  const pending = new Map<string, PendingSecure>();
  const shutdownCallbacks = new Set<() => void>();

  /** Set once the host is gone; a later request must not wait on it. */
  let disconnected = false;

  /**
   * Settle every in-flight request with one reason.
   *
   * @param error the failure each waiter receives
   */
  function failPending(error: HostPortError): void {
    for (const [requestId, waiting] of pending) {
      pending.delete(requestId);
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
  }

  /** @returns whether the message was handed to the pipe */
  function send(message: HostToCore): boolean {
    try {
      return pipe.send(message) !== false;
    } catch {
      return false;
    }
  }

  /** Route one narrowed message to its waiter. Other kinds are not ours. */
  function onReply(raw: unknown): void {
    const narrowed = narrowCoreToHost(raw);

    if (!narrowed.ok) return;
    if (narrowed.message.kind !== "secure.reply") return;

    const reply = narrowed.message;
    const waiting = pending.get(reply.requestId);

    if (waiting === undefined) return;

    pending.delete(reply.requestId);
    clearTimeout(waiting.timer);

    // A reply carrying an error is a store the host could not use. It must not
    // be reported as an absent secret.
    if (reply.error !== undefined) {
      waiting.reject(new HostPortError("UNAVAILABLE", reply.error));
      return;
    }

    waiting.resolve(reply.value);
  }

  /** The host is gone: fail everything now and refuse every later call. */
  function onDisconnect(): void {
    disconnected = true;

    failPending(new HostPortError("DISCONNECTED", "the extension host pipe is closed"));

    const callbacks = [...shutdownCallbacks];

    shutdownCallbacks.clear();

    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        // A shutdown callback's failure must not escape into the child's loop;
        // the pipe is already gone, so there is nowhere useful to report it.
      }
    }
  }

  pipe.onMessage(onReply);
  pipe.onDisconnect(onDisconnect);

  /** One secret-store round trip. */
  async function secureCall(
    op: SecureOp,
    key: string,
    value?: string,
  ): Promise<string | undefined> {
    if (disconnected) {
      throw new HostPortError("DISCONNECTED", "the extension host pipe is closed");
    }

    if (op === "set" && value === undefined) {
      throw new HostPortError("UNAVAILABLE", "set requires a value");
    }

    const requestId = randomUUID();

    return new Promise<string | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(
          new HostPortError(
            "SECURE_TIMEOUT",
            `no secret reply within ${String(secureTimeoutMs)} ms`,
          ),
        );
      }, secureTimeoutMs);

      pending.set(requestId, { resolve, reject, timer });

      const delivered =
        op === "set" && value !== undefined
          ? send({ kind: "secure.request", requestId, op, key, value })
          : send({ kind: "secure.request", requestId, op, key });

      if (delivered) return;

      pending.delete(requestId);
      clearTimeout(timer);
      reject(new HostPortError("DISCONNECTED", "the extension host pipe is closed"));
    });
  }

  return {
    capabilities: options.capabilities,
    paths: options.paths,

    async getRuntimeSpawnSpec(source: EngineSource): Promise<EngineSpawnSpec> {
      const resolve = options.resolveSpawnSpec;

      if (resolve === undefined) {
        throw new HostPortError(
          "UNAVAILABLE",
          "no spawn-spec provider is wired into the core for this engine",
        );
      }

      return await resolve(source);
    },

    secure: {
      get(key: string): Promise<string | undefined> {
        return secureCall("get", key);
      },
      async set(key: string, value: string): Promise<void> {
        await secureCall("set", key, value);
      },
      async delete(key: string): Promise<void> {
        await secureCall("delete", key);
      },
    },

    resolveLocalResource(_path: string): Promise<string> {
      // No webview exists in this process, so there is no URI namespace an
      // answer could be valid in. See the file comment. The path is not even
      // inspected: refusing a relative one here would only hide the real reason.
      return Promise.reject(
        new HostPortError(
          "UNAVAILABLE",
          "a local resource is resolved by the extension host, which owns the webview",
        ),
      );
    },

    onShutdown(callback: () => void): () => void {
      shutdownCallbacks.add(callback);

      return () => {
        shutdownCallbacks.delete(callback);
      };
    },
  };
}
