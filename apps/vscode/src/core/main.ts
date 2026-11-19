/**
 * The core child process entry.
 *
 * This file is the far side of the pipe the extension host owns: the host forks
 * this process, sends exactly one `init`, and from then on talks to it only
 * through `./ipc.ts` messages. It deliberately does NOT start an engine. Spawn
 * description, the token file, port discovery, the handshake and the expected
 * version check are a separate concern, and keeping them out means this whole
 * lifecycle can be exercised in a plain Node process against a fake engine.
 *
 * Three seams, all injected, and nothing guessed:
 *
 * - `startEngine(init)` resolves with a handle to the running engine. A
 *   rejection is reported as a `failed` status and then this child exits,
 *   because a core without an engine has nothing to offer.
 * - `invokeCommand(call)` answers `command.invoke`. Without it every command is
 *   refused by name instead of hanging until the host's budget runs out.
 * - `secureStore` answers the host's secret-store requests. Without it the
 *   request is answered with an error rather than a silent `undefined`, so a
 *   missing store can never look like an absent secret.
 *
 * Lifecycle, in order:
 *
 *   1. `init` -> `status: starting` -> `startEngine` -> `status: ready` + `ready`.
 *      Until `ready`, every other message is answered with a failure, so the host
 *      never waits out a command budget for a reply that cannot come.
 *   2. `shutdown` -> stop the engine -> `status: stopped` -> exit.
 *   3. The host dies (IPC `disconnect`, or `process.ppid` is no longer the
 *      process that started us) -> stop the engine -> exit. This is the child
 *      half of the parent watch; the host side only has to avoid detaching the
 *      child, because the handles watched here are exactly the ones a host crash
 *      closes.
 *
 * A secret travels only inside the `secure.reply` value. It is never echoed to a
 * log line, never placed in argv and never put in an environment variable.
 */

import { BRIDGE_VERSION } from "../shared/version.js";
import { frameMessage } from "./frame-path.js";
import { isJsonValue, narrowHostToCore } from "./ipc.js";
import type {
  CoreInit,
  CoreStatusSnapshot,
  CoreToHost,
  FrameChannel,
  HostToCore,
  RuntimeFailure,
} from "./ipc.js";

import { nextSeq } from "@haruyuki/core";
import type { CommandCall, CommandReply } from "@haruyuki/core";
import type { Frame } from "@haruyuki/protocol";

/** Default cadence of the parent-pid check. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;

/** Exit code for a stop the host asked for. */
const CLEAN_EXIT_CODE = 0;

/** Exit code for a stop this child initiated (parent loss, failed start). */
const FAILED_EXIT_CODE = 1;

/** The running engine, as this child sees it. */
export type CoreEngine = {
  /** Stop the engine and release its resources. Must be idempotent. */
  stop(): Promise<void>;
  /** Subscribe to engine frames; the returned function unsubscribes. */
  onFrame?: (listener: (channel: FrameChannel, payload: string) => void) => () => void;
  /** Subscribe to engine log lines; the returned function unsubscribes. */
  onLog?: (listener: (line: string) => void) => () => void;
  /**
   * Subscribe to the engine's own state changes; the returned function
   * unsubscribes.
   *
   * Without this, an engine that dies after `ready` is invisible: the facade
   * behind it knows, this child does not, and the host goes on showing a
   * connected panel over a socket with nothing behind it. The facade is a child
   * of this process, so this is the only place the fact can enter the shell.
   */
  onState?: (listener: (state: string) => void) => () => void;
};

/** Start the engine described by `init`. */
export type EngineStarter = (init: CoreInit) => Promise<CoreEngine>;

/** Answer one command. */
export type CommandInvoker = (call: CommandCall) => Promise<CommandReply>;

/** The secret store the host reaches through the pipe. */
export type SecureStore = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/**
 * The process boundary, narrowed to what this file uses.
 *
 * Injected so a test can run the whole lifecycle without forking anything. The
 * default is the real `process`, built by {@link nodeTransport}.
 */
export type CoreTransport = {
  /** Deliver one message to the extension host. */
  send(message: CoreToHost): void;
  /** @returns the unsubscribe function */
  onMessage(listener: (message: unknown) => void): () => void;
  /** @returns the unsubscribe function */
  onDisconnect(listener: () => void): () => void;
  /** The parent pid captured at startup; compared later to detect a replaced parent. */
  ppid(): number;
  /** @returns whether the parent process still exists */
  parentAlive(pid: number): boolean;
  /** Terminate this process. */
  exit(code: number): void;
};

/** Everything {@link runCoreMain} needs. */
export type CoreMainOptions = {
  readonly startEngine: EngineStarter;
  /** The command seam; absent means every command is refused by name. */
  readonly invokeCommand?: CommandInvoker;
  /** The secret-store seam; absent means every request is answered with an error. */
  readonly secureStore?: SecureStore;
  /** Override for the parent-pid cadence. */
  readonly watchdogIntervalMs?: number;
  /** Override for the process boundary; used by tests. */
  readonly transport?: CoreTransport;
};

/** The handle the embedder keeps. */
export type CoreRunner = {
  /** Resolves once this child has stopped, just before it asks for its exit. */
  readonly whenStopped: Promise<void>;
  /** Stop the engine and exit. Idempotent. */
  stop(): void;
};

/**
 * The real process boundary.
 *
 * `process.send` exists only when the parent forked with an `ipc` stdio slot,
 * which is the normal case; the check keeps a hand-run of this file from
 * throwing before it can report why.
 *
 * @returns the transport backed by `process`
 */
export function nodeTransport(): CoreTransport {
  return {
    send(message: CoreToHost): void {
      process.send?.(message);
    },
    onMessage(listener: (message: unknown) => void): () => void {
      const handler = (message: unknown): void => {
        listener(message);
      };

      process.on("message", handler);

      return () => {
        process.off("message", handler);
      };
    },
    onDisconnect(listener: () => void): () => void {
      const handler = (): void => {
        listener();
      };

      process.on("disconnect", handler);

      return () => {
        process.off("disconnect", handler);
      };
    },
    ppid(): number {
      return process.ppid;
    },
    parentAlive(pid: number): boolean {
      if (pid <= 0) return false;

      try {
        // Signal 0 is the existence probe: it delivers nothing.
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM means the pid exists and belongs to another user: still alive.
        return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    exit(code: number): void {
      process.exit(code);
    },
  };
}

/** @returns an error's message when it is one, else its rendering */
function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Run the child's message loop.
 *
 * @param options the engine, command and store seams, plus transport overrides
 * @returns the handle; the process stays alive on behalf of the transport
 */
export function runCoreMain(options: CoreMainOptions): CoreRunner {
  const transport = options.transport ?? nodeTransport();
  const watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  let init: CoreInit | null = null;
  let engine: CoreEngine | null = null;
  let ready = false;
  let stopping: Promise<void> | null = null;
  let leaving = false;
  let engineSubscriptions: (() => void)[] = [];

  let resolveStopped: () => void = () => {};

  const whenStopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  /** Send one message, tolerating a pipe that is already gone. */
  function send(message: CoreToHost): void {
    if (!isJsonValue(message)) {
      emitLog("refused to send a message that is not a JSON value");
      return;
    }

    try {
      transport.send(message);
    } catch {
      // A closed pipe is the parent-loss path, which the disconnect listener and
      // the pid check already handle; rethrowing here would only hide it.
    }
  }

  /** Hand one status snapshot to the host. */
  function emitStatus(status: CoreStatusSnapshot): void {
    send({ kind: "status", ...status });
  }

  /** Hand one log line to the host. Never carries a secret. */
  function emitLog(line: string): void {
    send({ kind: "log", line });
  }

  /** Bind every engine subscription point to the pipe. */
  function attachEngine(running: CoreEngine): void {
    if (running.onFrame !== undefined) {
      engineSubscriptions.push(
        running.onFrame((channel, payload) => {
          send({ kind: "frame", channel, payload });
        }),
      );
    }

    if (running.onLog !== undefined) {
      engineSubscriptions.push(
        running.onLog((line) => {
          send({ kind: "log", line });
        }),
      );
    }

    if (running.onState !== undefined) {
      engineSubscriptions.push(
        running.onState((state) => {
          // Only the end of the engine is news here. Every other state is one
          // this child produced itself, and re-reporting it would make the host
          // see the same transition twice.
          if (state !== "failed" && state !== "stopped") return;

          // The engine was lost after this child said `ready`. The requirement
          // keeps the panel's content and reports the disconnection; it does not
          // bring the engine back, so this is a report and nothing more.
          ready = false;

          emitStatus({
            phase: "failed",
            failure: {
              kind: "engine-lost",
              detail: `the engine stopped after it was ready (state: ${state})`,
            },
          });
        }),
      );
    }
  }

  /** Stop the engine once, whatever the trigger. */
  function stopEngine(): Promise<void> {
    stopping ??= (async () => {
      for (const unsubscribe of engineSubscriptions.splice(0)) unsubscribe();

      const running = engine;
      engine = null;
      ready = false;

      if (running === null) return;

      try {
        await running.stop();
      } catch (error) {
        emitLog(`the engine did not stop cleanly: ${describe(error)}`);
      }
    })();

    return stopping;
  }

  /**
   * Stop the engine, publish the final phase, then ask for the exit.
   *
   * @param code the process exit code this child deserves
   * @param phase the snapshot the host should end on
   */
  async function leave(code: number, phase: CoreStatusSnapshot): Promise<void> {
    if (leaving) return;

    leaving = true;
    await stopEngine();
    emitStatus(phase);
    resolveStopped();
    transport.exit(code);
  }

  /** The `init` path: validate once, start the engine, then answer `ready`. */
  async function onInit(message: CoreInit): Promise<void> {
    if (init !== null) {
      emitLog("ignored a second init; this child starts once");
      return;
    }

    init = message;

    emitStatus({
      phase: "starting",
      cwd: message.cwd,
      source: message.engineOrigin ?? message.engine.kind,
    });

    let running: CoreEngine;

    try {
      running = await options.startEngine(message);
    } catch (error) {
      const failure: RuntimeFailure = { kind: "start-failed", detail: describe(error) };

      await leave(FAILED_EXIT_CODE, { phase: "failed", failure });
      return;
    }

    // The host may have died while the engine was starting. Adopting the
    // handle now would leave a running engine behind a process that is already
    // leaving, so it is stopped instead.
    if (leaving) {
      await running.stop().catch(() => {});

      return;
    }

    engine = running;
    ready = true;
    attachEngine(running);
    emitStatus({
      phase: "ready",
      cwd: message.cwd,
      source: message.engineOrigin ?? message.engine.kind,
      ...(message.engine.version === undefined ? {} : { engineVersion: message.engine.version }),
    });

    send({ kind: "ready" });
  }

  /** The command path: hand the call to the injected dispatcher, then reply. */
  async function onCommand(callId: string, call: CommandCall): Promise<void> {
    if (!ready) {
      send({
        kind: "command.reply",
        callId,
        reply: { ok: false, code: "NOT_CONNECTED", detail: "the core is not ready yet" },
      });
      return;
    }

    const invoke = options.invokeCommand;

    if (invoke === undefined) {
      send({
        kind: "command.reply",
        callId,
        reply: {
          ok: false,
          code: "REJECTED",
          detail: "no command dispatcher is wired into the core",
        },
      });
      return;
    }

    try {
      send({ kind: "command.reply", callId, reply: await invoke(call) });
    } catch (error) {
      send({
        kind: "command.reply",
        callId,
        reply: { ok: false, code: "REJECTED", detail: describe(error) },
      });
    }
  }

  /** The secret-store path. Never logs the value. */
  async function onSecure(
    requestId: string,
    op: "get" | "set" | "delete",
    key: string,
    value?: string,
  ): Promise<void> {
    const store = options.secureStore;

    if (store === undefined) {
      send({ kind: "secure.reply", requestId, error: "no secret store is wired into the core" });
      return;
    }

    try {
      if (op === "get") {
        const read = await store.get(key);

        send(
          read === undefined
            ? { kind: "secure.reply", requestId }
            : { kind: "secure.reply", requestId, value: read },
        );
        return;
      }

      if (op === "set") {
        if (value === undefined) {
          send({ kind: "secure.reply", requestId, error: "set requires a value" });
          return;
        }

        await store.set(key, value);
        send({ kind: "secure.reply", requestId });
        return;
      }

      await store.delete(key);
      send({ kind: "secure.reply", requestId });
    } catch (error) {
      send({ kind: "secure.reply", requestId, error: describe(error) });
    }
  }

  /**
   * Answer the panel's announcement.
   *
   * The comparison is the panel's bridge version against this process's, which
   * is what the requirement asks the core to judge: a panel speaking another
   * generation of the message family has to be refused rather than allowed to
   * half-work. The verdict goes back as a frame, because that is the channel the
   * panel already reads for control traffic.
   *
   * @param appVersion the panel's build, echoed back for the log
   * @param bridgeVersion the message family the panel speaks
   */
  function onBridgeReady(appVersion: string, bridgeVersion: string): void {
    const accepted = bridgeVersion === BRIDGE_VERSION;
    const detail = accepted
      ? `${appVersion} speaks bridge ${bridgeVersion}`
      : `the panel speaks bridge ${bridgeVersion}, this core speaks ${BRIDGE_VERSION}`;

    if (!accepted) emitLog(`bridge refused: ${detail}`);

    // A frame, not a private message: the sequencer's own contract says the
    // acceptance is what establishes the renderer's watermark, so it has to
    // travel in the frame envelope and take a number from the one issuer.
    const frame: Frame = {
      v: 1,
      ch: "control",
      seq: nextSeq(),
      t: accepted ? "bridge.accept" : "bridge.reject",
      body: accepted ? {} : { code: "bridge-version", detail },
    };

    const encoded = frameMessage("control", frame);

    if (!encoded.ok) {
      emitLog(`the bridge verdict could not be encoded: ${encoded.reason}`);

      return;
    }

    send(encoded.message);
  }

  /** Route one narrowed host message. */
  function dispatch(message: HostToCore): void {
    switch (message.kind) {
      case "init":
        void onInit(message);
        return;
      case "command.invoke":
        void onCommand(message.callId, message.call);
        return;
      case "secure.request":
        void onSecure(message.requestId, message.op, message.key, message.value);
        return;
      case "shutdown":
        void leave(CLEAN_EXIT_CODE, { phase: "stopped" });
        return;
      case "bridge.ready":
        onBridgeReady(message.appVersion, message.bridgeVersion);
    }
  }

  const unsubscribeMessage = transport.onMessage((raw: unknown) => {
    const narrowed = narrowHostToCore(raw);

    if (!narrowed.ok) {
      emitLog(`the host sent an unusable message: ${narrowed.reason}`);
      return;
    }

    dispatch(narrowed.message);
  });

  const unsubscribeDisconnect = transport.onDisconnect(() => {
    emitLog("the host pipe closed; stopping the engine");
    void leave(FAILED_EXIT_CODE, { phase: "stopped" });
  });

  // The pid probe is the second half of the parent watch, for the platforms
  // where the IPC channel outlives the host. It is unref'd so it never keeps the
  // process alive by itself, and it is cleared by `stop`.
  const parentPid = transport.ppid();

  const watchdog = setInterval(() => {
    if (transport.parentAlive(parentPid)) return;

    emitLog("the host process is gone; stopping the engine");
    void leave(FAILED_EXIT_CODE, { phase: "stopped" });
  }, watchdogIntervalMs);

  watchdog.unref();

  return {
    whenStopped,
    stop(): void {
      unsubscribeMessage();
      unsubscribeDisconnect();
      clearInterval(watchdog);
      void leave(CLEAN_EXIT_CODE, { phase: "stopped" });
    },
  };
}
