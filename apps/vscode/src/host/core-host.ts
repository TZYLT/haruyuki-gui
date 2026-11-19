/**
 * The extension host's half of the pipe to the core child process.
 *
 * Architecture: the VS Code extension host (Node) forks a core child (Node ESM),
 * and the core child hosts the engine. The engine is therefore the core's child,
 * not the extension host's, which is why this class never spawns an engine and
 * never looks at `WebSocket:` output: it owns one `fork` and one message
 * protocol (`./ipc.ts`).
 *
 * Two transport facts are load-bearing and were verified in a real extension
 * host:
 *
 * - A VS Code desktop host runs inside Electron, where `process.execPath` is
 *   `Code.exe`. Re-executing that binary as Node requires
 *   `ELECTRON_RUN_AS_NODE=1` in the child's environment.
 * - A plain Node host (remote, or a test runner) has no such binary and must not
 *   receive the variable. The branch reads `process.versions.electron`, so one
 *   class serves both without a caller-side flag.
 *
 * Failure policy, chosen once here so callers can rely on it:
 *
 * - `invoke` NEVER rejects. A timeout, a closed pipe and an unusable payload are
 *   answered with the failure arm of `CommandReply` (`TIMEOUT`,
 *   `NOT_CONNECTED`, `REJECTED`), because a command's type already says how it
 *   fails and every caller branches on `ok`.
 * - `secure` REJECTS with {@link CoreHostError}. Its return type
 *   (`string | undefined`) has no failure channel: `undefined` already means
 *   "absent", and reusing it for "unreachable" would make a missing secret
 *   indistinguishable from a broken store.
 * - `start` REJECTS on a boot timeout, on a refused fork and on a child that
 *   exits before `ready`, and the child is killed first so a failed start never
 *   leaves a process behind.
 *
 * Every in-flight request is settled on reply, on timeout and on stop, and no
 * timer outlives the request that created it.
 *
 * Parent-death coordination on this side is only "do not detach": the child is
 * forked into the host's own process group and keeps its two stdio pipes plus the
 * IPC channel to this process. Those are exactly the handles the child watches
 * itself (see `./main.ts`), so a host crash closes a handle the child is already
 * watching. Nothing has to poll here and no pid has to cross the wire.
 */

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { CommandCall, CommandReply } from "@haruyuki/core";

import {
  isJsonValue,
  narrowCoreToHost,
  type CoreFrame,
  type CoreInit,
  type CoreLog,
  type CoreStatusSnapshot,
  type CoreToHost,
  type HostToCore,
  type SecureOp,
} from "../core/ipc.js";
import type { SecureInboundAnswerer, SecureReplyMessage } from "./secrets.js";

/** Fork budget for `start`: the core boots, validates `init` and answers `ready`. */
const DEFAULT_START_TIMEOUT_MS = 30_000;

/** Budget for one command sent through the pipe to the core. */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Budget for one secret-store operation. */
const DEFAULT_SECURE_TIMEOUT_MS = 10_000;

/** Budget for a graceful shutdown before the child is killed. */
const DEFAULT_STOP_TIMEOUT_MS = 8_000;

/** Budget for the child to finish dying after it was killed. */
const KILLED_EXIT_GRACE_MS = 2_000;

/**
 * What `start` needs, minus the tag.
 *
 * `cwd` is the child's working directory and is also what the child is told to
 * give the engine, so the two can never disagree.
 */
export type CoreHostInit = Omit<CoreInit, "kind">;

/** The closed set of host-side failures. */
export const CORE_HOST_ERROR_CODES = [
  "ALREADY_STARTED",
  "NOT_STARTED",
  "START_TIMEOUT",
  "START_FAILED",
  "SPAWN_FAILED",
  "STOPPED",
  "DISCONNECTED",
  "SECURE_TIMEOUT",
  "BAD_REQUEST",
] as const;

/** One kind of host-side failure. */
export type CoreHostErrorCode = (typeof CORE_HOST_ERROR_CODES)[number];

/** A host-side failure, carrying a code so a caller never parses the message. */
export class CoreHostError extends Error {
  readonly code: CoreHostErrorCode;

  /**
   * @param code the failure this instance represents
   * @param detail an English ASCII sentence for the log, never for branching
   */
  constructor(code: CoreHostErrorCode, detail: string) {
    super(detail);
    this.name = "CoreHostError";
    this.code = code;
  }
}

/** Options of {@link CoreProcessHost}. */
export type CoreHostOptions = {
  /** Absolute path of the core child entry. Must be ESM (`.mjs` when bundled). */
  readonly entryPath: string;
  /** Binary to fork. Defaults to `process.execPath`. */
  readonly execPath?: string;
  /** Extra environment on top of this process's own. */
  readonly env?: Record<string, string>;
  /** Boot budget; see {@link DEFAULT_START_TIMEOUT_MS}. */
  readonly startTimeoutMs?: number;
  /** Per-command budget; see {@link DEFAULT_COMMAND_TIMEOUT_MS}. */
  readonly commandTimeoutMs?: number;
  /** Per-request budget for the secret store. */
  readonly secureTimeoutMs?: number;
  /**
   * The handler for secret requests the child sends.
   *
   * Absent means no such handler is wired in, and then a request from the child
   * has nothing to answer it. It is injected rather than constructed here so
   * this class stays a pipe: `./secrets.ts` owns the store, and the message loop
   * must not grow a second reader of the secret message family.
   */
  readonly secureInbound?: SecureInboundAnswerer;
  /** Graceful-shutdown budget. */
  readonly stopTimeoutMs?: number;
};

/** One frame subscriber. */
export type FrameListener = (frame: CoreFrame) => void;

/** One status subscriber. */
export type StatusListener = (status: CoreStatusSnapshot) => void;

/** One log subscriber. */
export type LogListener = (log: CoreLog) => void;

/** The host side of the pipe to the core child. */
export interface CoreHost {
  /** Fork the child, send `init`, and resolve once it answers `ready`. */
  start(init: CoreHostInit): Promise<void>;
  /** Send one command. A failure is a `CommandReply` failure arm, never a throw. */
  invoke(call: CommandCall): Promise<CommandReply>;
  /** Perform one secret-store operation. Rejects with {@link CoreHostError}. */
  secure(op: SecureOp, key: string, value?: string): Promise<string | undefined>;
  /** Ask the child to shut down, then kill it if it does not. Idempotent. */
  stop(): Promise<void>;
  /** @returns an unsubscribe function */
  onFrame(callback: FrameListener): () => void;
  /** @returns an unsubscribe function */
  onStatus(callback: StatusListener): () => void;
  /** @returns an unsubscribe function */
  onLog(callback: LogListener): () => void;
}

/** One `start` waiting for the child to become ready. */
type ReadyWaiter = {
  readonly resolve: () => void;
  readonly reject: (error: CoreHostError) => void;
};

/** One command waiting for its correlated reply. */
type PendingCommand = {
  readonly resolve: (reply: CommandReply) => void;
  readonly timer: NodeJS.Timeout;
};

/** One secret-store request waiting for its answer. */
type PendingSecure = {
  readonly resolve: (value: string | undefined) => void;
  readonly reject: (error: CoreHostError) => void;
  readonly timer: NodeJS.Timeout;
};

/**
 * The one object the extension host uses to reach the core.
 *
 * Not a singleton: a host may own one instance per session. All mutable state is
 * private; the three subscriptions are the only way out.
 */
export class CoreProcessHost implements CoreHost {
  private readonly entryPath: string;

  private readonly execPath: string;

  private readonly extraEnv: Record<string, string>;

  private readonly startTimeoutMs: number;

  private readonly commandTimeoutMs: number;

  private readonly secureTimeoutMs: number;

  private readonly secureInbound: SecureInboundAnswerer | undefined;

  private readonly stopTimeoutMs: number;

  private child: ChildProcess | null = null;

  /** Resolves once the current child is gone. */
  private exitPromise: Promise<void> | null = null;

  /** Set once the child answered `ready`. */
  private ready = false;

  /** Set while a `stop` is in progress, so an exit is not misreported as a crash. */
  private stopping = false;

  private stopPromise: Promise<void> | null = null;

  private readonly readyWaiters = new Set<ReadyWaiter>();

  private readonly pendingCommands = new Map<string, PendingCommand>();

  private readonly pendingSecure = new Map<string, PendingSecure>();

  private readonly frameListeners = new Set<FrameListener>();

  private readonly statusListeners = new Set<StatusListener>();

  private readonly logListeners = new Set<LogListener>();

  /**
   * @param options entry path, timeouts and the optional exec/env overrides
   */
  constructor(options: CoreHostOptions) {
    this.entryPath = options.entryPath;
    this.execPath = options.execPath ?? process.execPath;
    this.extraEnv = options.env ?? {};
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.secureTimeoutMs = options.secureTimeoutMs ?? DEFAULT_SECURE_TIMEOUT_MS;
    this.secureInbound = options.secureInbound;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  /**
   * Fork the core child and wait for `ready`.
   *
   * @param init paths, engine location, locale and expected version
   * @returns once the child confirmed it accepted `init`
   */
  async start(init: CoreHostInit): Promise<void> {
    if (this.child !== null) {
      throw new CoreHostError("ALREADY_STARTED", "the core child is already running");
    }

    this.stopPromise = null;
    this.stopping = false;
    this.ready = false;

    let child: ChildProcess;

    try {
      child = fork(this.entryPath, [], {
        execPath: this.execPath,
        env: this.childEnv(),
        cwd: init.cwd,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        // Not detached on purpose: see the file comment. A detached child would
        // own another process group and could outlive a crashed host.
        detached: false,
      });
    } catch (error) {
      throw new CoreHostError(
        "SPAWN_FAILED",
        `the core child could not be forked: ${describe(error)}`,
      );
    }

    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });

    // Both stdout pipes are drained: the core relays the engine's stderr through
    // them, and a pipe nobody reads fills up and then blocks the child's event
    // loop for good.
    //
    // Drained is not the same as discarded. The core and the engine behind it
    // report their own failures on stderr -- a spawn that did not happen, a
    // token file that could not be written -- and that sentence is the only
    // explanation a user gets for a panel that refuses to start. It therefore
    // becomes log lines, attributed to the child they came from.
    child.stdout?.resume();
    this.relayStderr(child);

    child.on("message", (message: unknown) => {
      // A replaced child's late message must not be attributed to the current
      // one: correlation ids are only unique within one child lifetime.
      if (this.child !== child) return;

      this.handleMessage(message);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;

      this.handleExit(code, signal);
    });
    child.on("error", (error: Error) => {
      if (this.child !== child) return;

      // A fork that never produced a process reports ENOENT here; a failed send
      // reports a closed channel. Either way every waiter must settle, so this
      // is not a no-op sink.
      const detail = `the core child reported ${describe(error)}`;
      this.failAllPending("DISCONNECTED", detail);
      this.rejectReadyWaiters(new CoreHostError("SPAWN_FAILED", detail));
    });

    // Registered before `init` is sent, so an immediate `ready` cannot be lost.
    const ready = this.waitForReady();

    if (!this.send({ kind: "init", ...init })) {
      this.abandonChild();
      throw new CoreHostError("SPAWN_FAILED", "the core child could not be reached after fork");
    }

    try {
      await ready;
    } catch (error) {
      this.abandonChild();
      throw error;
    }
  }

  /**
   * Send one command and wait for its correlated reply.
   *
   * @param call the command; it must survive the JSON pipe, checked before use
   * @returns the reply, or a failure reply when the pipe cannot answer
   */
  invoke(call: CommandCall): Promise<CommandReply> {
    if (!isJsonValue(call)) {
      return Promise.resolve(
        failureReply("REJECTED", "the command is not a JSON value, so it cannot cross the pipe"),
      );
    }

    if (this.child === null || !this.ready) {
      return Promise.resolve(failureReply("NOT_CONNECTED", "the core child is not running"));
    }

    const callId = mintId();

    return new Promise<CommandReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(callId);
        resolve(
          failureReply("TIMEOUT", `no command reply within ${String(this.commandTimeoutMs)} ms`),
        );
      }, this.commandTimeoutMs);

      this.pendingCommands.set(callId, { resolve, timer });

      if (!this.send({ kind: "command.invoke", callId, call })) {
        this.pendingCommands.delete(callId);
        clearTimeout(timer);
        resolve(failureReply("NOT_CONNECTED", "the core child pipe is closed"));
      }
    });
  }

  /**
   * Perform one secret-store operation through the child.
   *
   * The secret travels in this message only: never in argv, never in an
   * environment variable, never in a log line.
   *
   * @param op read, write or delete
   * @param key the store key
   * @param value the value for `set`; ignored for the other two
   * @returns the stored value for `get`, `undefined` for `set` and `delete`
   */
  secure(op: SecureOp, key: string, value?: string): Promise<string | undefined> {
    if (this.child === null || !this.ready) {
      return Promise.reject(new CoreHostError("NOT_STARTED", "the core child is not running"));
    }

    if (op === "set" && value === undefined) {
      return Promise.reject(new CoreHostError("BAD_REQUEST", "set requires a value"));
    }

    const requestId = mintId();

    return new Promise<string | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSecure.delete(requestId);
        reject(
          new CoreHostError(
            "SECURE_TIMEOUT",
            `no secret-store answer within ${String(this.secureTimeoutMs)} ms`,
          ),
        );
      }, this.secureTimeoutMs);

      this.pendingSecure.set(requestId, { resolve, reject, timer });

      const message: HostToCore =
        op === "set" && value !== undefined
          ? { kind: "secure.request", requestId, op, key, value }
          : { kind: "secure.request", requestId, op, key };

      if (!this.send(message)) {
        this.pendingSecure.delete(requestId);
        clearTimeout(timer);
        reject(new CoreHostError("DISCONNECTED", "the core child pipe is closed"));
      }
    });
  }

  /**
   * Ask the child to stop, then make sure it is gone.
   *
   * Idempotent: every call shares one sequence, and a call after the child has
   * exited resolves immediately.
   *
   * @returns once the child has exited or the kill budget is spent
   */
  stop(): Promise<void> {
    if (this.stopPromise === null) this.stopPromise = this.stopOnce();

    return this.stopPromise;
  }

  /** @returns an unsubscribe function */
  onFrame(callback: FrameListener): () => void {
    return subscribe(this.frameListeners, callback);
  }

  /** @returns an unsubscribe function */
  onStatus(callback: StatusListener): () => void {
    return subscribe(this.statusListeners, callback);
  }

  /** @returns an unsubscribe function */
  onLog(callback: LogListener): () => void {
    return subscribe(this.logListeners, callback);
  }

  /** The child's environment: this process's own, plus the Electron rule above. */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv };

    if (typeof process.versions.electron === "string") {
      env.ELECTRON_RUN_AS_NODE = "1";
    }

    return env;
  }

  /**
   * Hand one message to the child, whichever direction it belongs to.
   *
   * `secure.request` is the one family whose request the child sends and whose
   * answer the host sends, so both directions reach the same handle here.
   *
   * @param message a host-to-core message or the answer to one
   * @returns whether it was handed over
   */
  private send(message: HostToCore | SecureReplyMessage): boolean {
    const child = this.child;

    if (child === null || !child.connected) return false;

    try {
      return child.send(message);
    } catch {
      return false;
    }
  }

  /** The one place inbound messages are narrowed. Never throws. */
  private handleMessage(raw: unknown): void {
    // Offered before narrowing, because the request family belongs to the child's
    // side of this channel: `../core/ipc.ts` narrows it with the host-to-core
    // helpers, so a core-to-host narrowing would refuse every request. The
    // handler is injected and decides ownership itself; see `./secrets.ts`.
    //
    // Only this one message can be answered asynchronously. Narrowing it here
    // too would be a second reader of a shape that module already owns, so a
    // request the handler owns never reaches the switch below.
    if (this.secureInbound?.(raw, (reply) => this.send(reply)) === true) return;

    const narrowed = narrowCoreToHost(raw);

    if (!narrowed.ok) {
      this.emitLog(`core sent an unusable message: ${narrowed.reason}`);
      return;
    }

    this.dispatch(narrowed.message);
  }

  /** Route one narrowed message to its waiter or its subscribers. */
  private dispatch(message: CoreToHost): void {
    switch (message.kind) {
      case "ready":
        this.ready = true;
        this.settleReadyWaiters();
        return;
      case "frame":
        for (const listener of [...this.frameListeners]) listener(message);
        return;
      case "status":
        for (const listener of [...this.statusListeners]) listener(message);
        return;
      case "log":
        for (const listener of [...this.logListeners]) listener(message);
        return;
      case "command.reply": {
        const pending = this.pendingCommands.get(message.callId);

        if (pending === undefined) return;

        this.pendingCommands.delete(message.callId);
        clearTimeout(pending.timer);
        pending.resolve(message.reply);
        return;
      }
      case "secure.reply": {
        const pending = this.pendingSecure.get(message.requestId);

        if (pending === undefined) return;

        this.pendingSecure.delete(message.requestId);
        clearTimeout(pending.timer);

        if (message.error !== undefined) {
          pending.reject(new CoreHostError("DISCONNECTED", message.error));
          return;
        }

        pending.resolve(message.value);
      }
    }
  }

  /** The child exited: settle everything that was waiting on it. */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStopping = this.stopping;

    this.child = null;
    this.ready = false;
    this.stopping = false;

    const detail = `the core child exited (code ${String(code)}, signal ${String(signal)})`;

    this.failAllPending("DISCONNECTED", detail);
    this.rejectReadyWaiters(new CoreHostError("START_FAILED", detail));

    // An unexpected exit is a runtime failure the shell has to show. A requested
    // stop is not, and reporting it as one would flash a failure page on quit.
    if (!wasStopping) {
      for (const listener of [...this.statusListeners]) {
        listener({ phase: "failed", failure: { kind: "crash", detail } });
      }
    }
  }

  /** Kill a child that cannot be used and wait briefly for the handle to clear. */
  private abandonChild(): void {
    const child = this.child;

    if (child === null) return;

    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone: this is the outcome the method exists to produce.
    }

    this.child = null;
    this.ready = false;
  }

  /** Reject every queued `start` waiter, once the child cannot become ready. */
  private rejectReadyWaiters(error: CoreHostError): void {
    for (const waiter of [...this.readyWaiters]) {
      this.readyWaiters.delete(waiter);
      waiter.reject(error);
    }
  }

  /** Resolve every queued `start` waiter. */
  private settleReadyWaiters(): void {
    for (const waiter of [...this.readyWaiters]) {
      this.readyWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  /** One `start` attempt's view of `ready`, bounded by the boot budget. */
  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: CoreHostError) => {
          clearTimeout(timer);
          reject(error);
        },
      };

      const timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(
          new CoreHostError(
            "START_TIMEOUT",
            `the core child did not answer ready within ${String(this.startTimeoutMs)} ms`,
          ),
        );
      }, this.startTimeoutMs);

      this.readyWaiters.add(waiter);
    });
  }

  /** Settle every in-flight command and secret request with one reason. */
  private failAllPending(code: "STOPPED" | "DISCONNECTED", detail: string): void {
    // Every command failure caused by the transport itself is the same answer to
    // the caller's `ok` branch: the pipe cannot carry the command. A secret
    // request keeps the distinction, because its rejection is what a caller
    // logs and a stopped store is not a broken one.
    for (const [callId, pending] of this.pendingCommands) {
      this.pendingCommands.delete(callId);
      clearTimeout(pending.timer);
      pending.resolve(failureReply("NOT_CONNECTED", detail));
    }

    const error = new CoreHostError(code, detail);

    for (const [requestId, pending] of this.pendingSecure) {
      this.pendingSecure.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /** The cooperative stop sequence: `shutdown`, wait, then kill and wait. */
  private async stopOnce(): Promise<void> {
    this.stopping = true;

    const child = this.child;
    const exit = this.exitPromise;

    this.failAllPending("STOPPED", "the core child is stopping");
    this.rejectReadyWaiters(new CoreHostError("STOPPED", "the core child is stopping"));

    if (child === null || exit === null) return;

    if (child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }

    // Asked first, so the child stops the engine and lets it flush its own logs.
    // Its exit is what proves it worked; the budget below is only a cap.
    this.send({ kind: "shutdown" });

    if (await settledWithin(exit, this.stopTimeoutMs)) return;

    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }

    // The kill is unconditional; waiting afterwards only keeps the caller from
    // racing the OS. A child that still refuses to die is reported, not awaited.
    if (!(await settledWithin(exit, KILLED_EXIT_GRACE_MS))) {
      this.emitLog("core child did not exit after being killed");
    }
  }

  /** Hand a line to the log subscribers. */
  private emitLog(line: string): void {
    for (const listener of [...this.logListeners]) listener({ kind: "log", line });
  }

  /**
   * Turn the child's stderr into log lines.
   *
   * The pipe is read whatever happens, so nothing the child writes can block it;
   * what arrives is forwarded as it is rather than parsed, because this process
   * has no business interpreting another process's diagnostics. A line that
   * outlives the child's lifetime still reaches the listeners, which is the
   * whole reason it is captured: the last thing a dying child says is usually
   * the explanation.
   *
   * @param child the forked child, already assigned to `this.child`
   */
  private relayStderr(child: ChildProcess): void {
    const stderr = child.stderr;

    if (stderr === null || stderr === undefined) return;

    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim() !== "") this.emitLog(`[stderr] ${line}`);
      }
    });
    stderr.on("error", () => {
      // A broken pipe on a child that is already gone is not a failure to
      // report and not one a shell can act on.
    });
  }
}

/**
 * The child reply for a failure, in the arm `CommandReply` already defines.
 *
 * @param code a failure code from the frozen command taxonomy
 * @param detail one English sentence for the log
 * @returns the failure arm of `CommandReply`
 */
function failureReply(
  code: "TIMEOUT" | "NOT_CONNECTED" | "REJECTED",
  detail: string,
): CommandReply {
  return { ok: false, code, detail };
}

/** @returns one unique id for a request the host originates */
function mintId(): string {
  return randomUUID();
}

/**
 * @param value thrown value
 * @returns its message when it is an `Error`, else its rendering
 */
function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Bind one callback and return the matching unbind. */
function subscribe<T>(listeners: Set<T>, callback: T): () => void {
  listeners.add(callback);

  return () => {
    listeners.delete(callback);
  };
}

/**
 * Wait for a promise, or give up after a budget.
 *
 * @param promise a promise that never rejects on this path
 * @param timeoutMs budget in milliseconds
 * @returns `true` when the promise settled in time
 */
async function settledWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
