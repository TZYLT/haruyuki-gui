/**
 * Engine facade: the single state machine over one hosted engine process.
 *
 * Shape source: no recursive-B1 sections 3.1 (module split: `engine.ts` is "the only
 * state machine"), 3.2 (the log owns this file), 3.3 (c) (frozen `Engine` surface),
 * 3.3 (e) (state diagram), 3.3 (f) (error classification), 4.2 (work package) and
 * section 8 (invariants).
 *
 * Rules this file exists to enforce:
 *
 * - `ready` means "socket open AND app_server_info answered AND the version
 *   matched". A socket that merely opened is never ready (section 8, rule 2).
 * - `failed` is terminal. A failed engine refuses a second `start` instead of
 *   reconnecting; reconnection belongs to B3 (section 8, rule 5).
 * - Token CONTENT never enters argv (rule 1). `start` writes the token file and
 *   appends only its PATH to `argvPrefix`, which is the element immediately after
 *   the `--ws-token-file` option the host port already put there.
 * - Every transition writes the internal field first and only then notifies the
 *   subscribers, so a callback that reads `engine.state` observes the new value.
 *
 * Process start goes through `startEngineProcess` (`spawn.ts`). How the child
 * argv is composed is that module's contract: `[spec.bundlePath,
 * ...spec.argvPrefix]`. The headless host port describes the engine with
 * and the engine options in `argvPrefix`, which is the F-6 shape
 * `node haruyuki.js server ...`.
 *
 * `attach` is implemented inline on purpose (decision D-10): `attach.ts` 
 * is a sibling package written in the same wave, so this file must not import
 * it. W-13 replaces the inline body with a delegation to
 * `attachToExternalServer`.
 */

import type { ChildProcess } from "node:child_process";

import { connectEngine } from "./connection";
import type { EngineSocket } from "./connection";
import { toEngineError } from "./errors";
import { requestAppServerInfo } from "./handshake";
import { waitForWsUrl } from "./port-discovery";
import {
  killProcess,
  onProcessError,
  onProcessExit,
  startEngineProcess,
  stopGraceful as stopChildGracefully,
} from "./spawn";
import { generateToken, removeTokenFile, writeTokenFile } from "./token";
import type { TokenFile } from "./token";
import type {
  AppServerInfo,
  EngineError,
  EngineErrorCode,
  EngineSpawnSpec,
  EngineState,
} from "./types";

/** Port discovery budget when the caller does not pass one (section 3.3 (c)). */
const DEFAULT_PORT_TIMEOUT_MS = 10_000;

/** Handshake budget when the caller does not pass one (section 3.3 (c)). */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Graceful-stop budget when the caller does not pass one (section 3.3 (c)). */
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

/** The eight fields of the frozen spawn spec (section 3.3 (b)), in data order. */
const SPAWN_SPEC_FIELDS = [
  "exePath",
  "env",
  "argvPrefix",
  "bundlePath",
  "cwd",
  "stdio",
  "windowsHide",
  "detached",
] as const;

/** Socket lifecycle exposed as `Engine.socketState` (section 3.3 (c)). */
export type EngineSocketState = "idle" | "connecting" | "open" | "closed";

type StateListener = (state: EngineState) => void;
type ErrorListener = (error: EngineError) => void;
type FrameListener = (at: number) => void;

/** Options of {@link Engine.start}; mirrors section 3.3 (c). */
export type EngineStartOptions = {
  spawnSpec: EngineSpawnSpec;
  expectedEngineVersion?: string;
  tokenDir: string;
  /** Port discovery budget; 10 s by default. */
  portTimeoutMs?: number;
  /** Handshake budget; 5 s by default. */
  handshakeTimeoutMs?: number;
};

/** Options of {@link Engine.attach}; mirrors section 3.3 (c). */
export type EngineAttachOptions = {
  url: string;
  token: string;
  expectedEngineVersion?: string;
};

/** One classified fault, either awaited or raised by a child-process callback. */
type StartFault = {
  code: EngineErrorCode;
  detail: string;
  wireHint?: string;
};

/**
 * One classified failure, thrown as the facade's rejection value.
 *
 * It is an `Error` (so Node and a debugger keep a stack) that also satisfies the
 * frozen `EngineError` shape: `code`, `detail` and an optional `wireHint`.
 * `isEngineError` accepts it unchanged, so `toEngineError(thrown)` round-trips
 * without a second classification pass.
 */
class EngineStartError extends Error {
  readonly code: EngineErrorCode;

  readonly detail: string;

  readonly wireHint?: string;

  constructor(code: EngineErrorCode, detail: string, wireHint?: string) {
    super(detail);
    this.name = "EngineStartError";
    this.code = code;
    this.detail = detail;
    if (wireHint !== undefined) {
      this.wireHint = wireHint;
    }
  }
}

/**
 * A fault signal that can end an awaited start step early.
 *
 * A child can die between two awaited steps (or while one is pending), and a
 * dead process never produces a WebSocket URL or a handshake answer; without
 * this signal every such failure would wait out the full timeout and be
 * classified as a timeout instead of as the spawn failure it is. The promise is
 * single-shot and always carries a handled rejection, so a fault raised after
 * the start path finished cannot surface as an unhandled rejection.
 */
class FaultSignal {
  readonly promise: Promise<never>;

  // Assigned by the promise executor below, which TypeScript cannot prove.
  private reject!: (error: EngineStartError) => void;

  private settled = false;

  private failure: EngineStartError | null = null;

  constructor() {
    this.promise = new Promise<never>((_resolve, reject) => {
      this.reject = reject;
    });
    this.promise.catch(() => undefined);
  }

  /** The classified fault, or `null` while the child is healthy. */
  get raised(): EngineStartError | null {
    return this.failure;
  }

  /** Raise the fault once; later calls are ignored because the first wins. */
  fail(error: EngineStartError): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.failure = error;
    this.reject(error);
  }
}

/**
 * The one engine facade.
 *
 * Not a singleton: the host may construct one per hosted engine. All mutable
 * state is private, so two instances cannot observe each other's transitions.
 */
export class Engine {
  private currentState: EngineState = "idle";

  private latestFrameAt: number | null = null;

  private currentSocketState: EngineSocketState = "idle";

  private currentAppServerInfo: AppServerInfo | null = null;

  private socket: EngineSocket | null = null;

  private child: ChildProcess | null = null;

  private tokenFilePath: string | null = null;

  private tokenRemoval: Promise<void> | null = null;

  private lastFailureCode: EngineErrorCode | null = null;

  private stopInFlight: Promise<void> | null = null;

  private cleanupInFlight: Promise<void> | null = null;

  private childFault: FaultSignal | null = null;

  private childUnsubscribers: Array<() => void> = [];

  private readonly stateListeners = new Set<StateListener>();

  private readonly errorListeners = new Set<ErrorListener>();

  private readonly frameListeners = new Set<FrameListener>();

  /** Current lifecycle state; the ONLY state machine in B1. */
  get state(): EngineState {
    return this.currentState;
  }

  /** Timestamp of the last WebSocket frame, or `null` before the first one. */
  get lastFrameAt(): number | null {
    return this.latestFrameAt;
  }

  /** Transport-level state of the engine socket, independent of the facade state. */
  get socketState(): EngineSocketState {
    return this.currentSocketState;
  }

  /** What the last successful handshake reported, or `null`. */
  get appServerInfo(): AppServerInfo | null {
    return this.currentAppServerInfo;
  }

  /**
   * Spawn one engine and drive it to `ready`.
   *
   * Order:
   * 1. `spawning`, validate the eight spawn-spec fields;
   * 2. generate the token, write the token file, append its PATH to `argvPrefix`;
   * 3. start the child and subscribe to its `error` / `exit` events;
   * 4. read the `WebSocket:` line out of stdout;
   * 5. `handshaking`, connect, then request `app_server_info`;
   * 6. compare `expectedEngineVersion` when the caller supplied one;
   * 7. `ready`, return the info.
   *
   * Any failure moves to `failed` (terminal), emits `onError`, releases the
   * socket, deletes the token file and stops the child before the rejection.
   */
  async start(options: EngineStartOptions): Promise<AppServerInfo> {
    this.assertCanStart();
    this.beginAttempt("spawning");

    const fault = new FaultSignal();
    this.childFault = fault;

    try {
      assertSpawnSpec(options.spawnSpec);

      const token = generateToken();
      const tokenFile = await this.writeToken(options.tokenDir, token);
      this.tokenFilePath = tokenFile.path;

      const child = this.spawnEngine(options.spawnSpec, tokenFile.path);
      this.child = child;
      this.watchChild(child, fault);

      if (child.stdout === null) {
        throw new EngineStartError(
          "SPAWN_FAILED",
          "the engine child has no piped stdout, so the WebSocket URL cannot be discovered",
        );
      }

      const url = await raceWithFault(
        waitForWsUrl(
          child.stdout,
          normalizeTimeout(options.portTimeoutMs, DEFAULT_PORT_TIMEOUT_MS),
        ),
        fault.promise,
      );

      this.transition("handshaking");

      const socket = await this.openSocket(url, token, fault);
      const info = await raceWithFault(
        requestAppServerInfo(
          socket,
          normalizeTimeout(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS),
        ),
        fault.promise,
      );

      assertExpectedVersion(info, options.expectedEngineVersion);

      // A child that died between the handshake answer and this line would
      // otherwise be promoted to `ready`; the fault is checked once more here.
      const raised = fault.raised;
      if (raised !== null) {
        throw raised;
      }

      this.currentAppServerInfo = info;
      this.transition("ready");
      return info;
    } catch (error) {
      return this.failStart(await this.rootCause(error, fault));
    }
  }

  /**
   * Attach to an engine someone else started: connect, handshake, check the
   * version. No process is spawned and no token file is written or deleted,
   * because both belong to the external engine's owner.
   *
   * Inline by decision D-10 (see the file comment); W-13 replaces this body with
   * a delegation to `attachToExternalServer`.
   */
  async attach(options: EngineAttachOptions): Promise<AppServerInfo> {
    this.assertCanAttach();
    // There is no process to spawn, so attach enters the connecting /
    // handshaking state directly instead of passing through `spawning`.
    this.beginAttempt("handshaking");

    // No child exists, so nothing can raise a fault; the signal keeps the socket
    // and handshake steps identical to `start`.
    const fault = new FaultSignal();
    this.childFault = fault;

    try {
      const socket = await this.openSocket(options.url, options.token, fault);
      const info = await requestAppServerInfo(socket, DEFAULT_HANDSHAKE_TIMEOUT_MS);

      assertExpectedVersion(info, options.expectedEngineVersion);

      this.currentAppServerInfo = info;
      this.transition("ready");
      return info;
    } catch (error) {
      return this.failStart(error);
    }
  }

  /**
   * Stop the engine gracefully: `closing`, close the socket, stop the child,
   * delete the token file, `closed`.
   *
   * Idempotent and never rejects. A call while a stop is in flight returns the
   * same promise; a call on `idle` / `closed` resolves immediately; a call on a
   * failed engine only re-runs the (idempotent) failure cleanup, because `failed`
   * is terminal and must not be rewritten to `closed`.
   */
  async stopGraceful(timeoutMs: number = DEFAULT_STOP_TIMEOUT_MS): Promise<void> {
    if (this.stopInFlight !== null) {
      return this.stopInFlight;
    }

    if (this.currentState === "idle" || this.currentState === "closed") {
      return;
    }

    if (this.currentState === "failed") {
      await this.ensureCleanup();
      return;
    }

    const stopping = this.stopOnce(normalizeTimeout(timeoutMs, DEFAULT_STOP_TIMEOUT_MS));
    this.stopInFlight = stopping;

    try {
      await stopping;
    } finally {
      if (this.stopInFlight === stopping) {
        this.stopInFlight = null;
      }
    }
  }

  /**
   * Hard kill: terminate the child, drop the socket, delete the token file.
   *
   * Synchronous because the emergency path must not wait. The token unlink is
   * started here and awaited by a later `stopGraceful`, so a caller that wants
   * proof of removal can `await engine.stopGraceful()`.
   */
  kill(): void {
    const child = this.child;
    this.child = null;
    this.releaseChildSubscriptions();

    if (child !== null) {
      killProcess(child);
    }

    this.releaseSocket(true);

    const stoppable =
      this.currentState !== "idle" &&
      this.currentState !== "closed" &&
      this.currentState !== "failed";

    if (stoppable) {
      this.transition("closing");
      this.transition("closed");
    }

    void this.ensureTokenRemoved();
  }

  /** Subscribe to lifecycle transitions. Returns an unsubscribe function. */
  onState(callback: StateListener): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  /** Subscribe to classified failures. Returns an unsubscribe function. */
  onError(callback: ErrorListener): () => void {
    this.errorListeners.add(callback);
    return () => {
      this.errorListeners.delete(callback);
    };
  }

  /**
   * Subscribe to inbound WebSocket frames. The timestamp is captured before any
   * listener runs, so every subscriber sees the same `at` and `lastFrameAt`
   * already carries it.
   */
  onFrame(callback: FrameListener): () => void {
    this.frameListeners.add(callback);
    return () => {
      this.frameListeners.delete(callback);
    };
  }

  /** Reset per-attempt bookkeeping and enter the attempt's first state. */
  private beginAttempt(initial: EngineState): void {
    this.latestFrameAt = null;
    this.currentAppServerInfo = null;
    this.lastFailureCode = null;
    this.tokenRemoval = null;
    this.cleanupInFlight = null;
    this.stopInFlight = null;
    this.currentSocketState = "idle";
    this.transition(initial);
  }

  /** Refuse a second start while busy, and refuse one after a failure. */
  private assertCanStart(): void {
    if (this.currentState === "failed") {
      const code = this.lastFailureCode ?? "TIMEOUT";
      throw new EngineStartError(
        code,
        `the engine already failed (${code}); "failed" is terminal and this facade does not ` +
          "reconnect",
      );
    }

    if (this.currentState !== "idle" && this.currentState !== "closed") {
      // Section 3.3 (f) classes a "start precondition" failure as SPAWN_FAILED.
      throw new EngineStartError(
        "SPAWN_FAILED",
        `start() cannot run while the engine is "${this.currentState}"`,
      );
    }
  }

  /** Refuse attach on a busy or failed engine. */
  private assertCanAttach(): void {
    if (this.currentState === "failed") {
      const code = this.lastFailureCode ?? "TIMEOUT";
      throw new EngineStartError(
        code,
        `the engine already failed (${code}); "failed" is terminal and this facade does not ` +
          "reconnect",
      );
    }

    if (this.currentState !== "idle" && this.currentState !== "closed") {
      // Nothing is spawned, so the documented fallback code is the honest one.
      throw new EngineStartError(
        "TIMEOUT",
        `attach() cannot run while the engine is "${this.currentState}"`,
      );
    }
  }

  /** Write the token file; a write failure is a pre-spawn failure. */
  private async writeToken(dir: string, token: string): Promise<TokenFile> {
    try {
      return await writeTokenFile(dir, token);
    } catch (error) {
      throw new EngineStartError(
        "SPAWN_FAILED",
        `could not write the engine token file in ${dir}: ${messageOf(error)}`,
      );
    }
  }

  /**
   * Start the child with the token PATH appended to `argvPrefix`.
   *
   * The spec is copied field by field instead of mutated: the host port owns its
   * spec object, and a mutated `argvPrefix` would grow by one element on every
   * restart. The token path is the last prefix element because the host port's
   * prefix already ends with the `--ws-token-file` option name.
   */
  private spawnEngine(spec: EngineSpawnSpec, tokenFilePath: string): ChildProcess {
    const childSpec: EngineSpawnSpec = {
      exePath: spec.exePath,
      env: spec.env,
      argvPrefix: [...spec.argvPrefix, tokenFilePath],
      bundlePath: spec.bundlePath,
      cwd: spec.cwd,
      stdio: "pipe",
      windowsHide: spec.windowsHide,
      detached: spec.detached,
    };

    try {
      return startEngineProcess(childSpec);
    } catch (error) {
      throw new EngineStartError(
        "SPAWN_FAILED",
        `could not start the engine process: ${messageOf(error)}`,
      );
    }
  }

  /**
   * Subscribe to the child's `error` and `exit` events.
   *
   * A start-time fault is routed through the signal so the pending step fails
   * immediately; a fault after `ready` is a crash and moves the facade to
   * `failed` (section 3.3 (e): any state may fail).
   */
  private watchChild(child: ChildProcess, fault: FaultSignal): void {
    this.childUnsubscribers.push(
      onProcessError(child, (error) => {
        const quick = codeOf(error);
        this.raiseChildFault(
          fault,
          "SPAWN_FAILED",
          `the engine process reported an error: ${messageOf(error)}`,
          quick,
        );
      }),
      onProcessExit(child, (info) => {
        if (this.isStopping()) {
          return;
        }

        // Before the URL exists nothing can be classified as a port or protocol
        // fault, so the process never became a server.
        const code: EngineErrorCode = this.currentState === "spawning" ? "SPAWN_FAILED" : "TIMEOUT";
        this.raiseChildFault(
          fault,
          code,
          `the engine process exited unexpectedly (code ${String(info.code)}, ` +
            `signal ${String(info.signal)})`,
        );
      }),
    );
  }

  /** Classify a child fault for the in-flight attempt and for a later crash. */
  private raiseChildFault(
    fault: FaultSignal,
    code: EngineErrorCode,
    detail: string,
    wireHint?: string,
  ): void {
    const error =
      wireHint === undefined
        ? new EngineStartError(code, detail)
        : new EngineStartError(code, detail, wireHint);

    fault.fail(error);

    if (this.currentState === "ready") {
      this.declareFailure(error);
    }
  }

  /** True while the facade itself is taking the process down. */
  private isStopping(): boolean {
    return (
      this.currentState === "closing" ||
      this.currentState === "closed" ||
      this.currentState === "failed"
    );
  }

  /**
   * Pick the root cause of a failed start step.
   *
   * A dead child is often reported twice: the pending step fails on the closed
   * stdout stream or socket (a symptom) in the same tick the child's `error` /
   * `exit` event fires (the cause). Child events are queued behind the step's
   * rejection, so one macrotask is enough for them to run. A spawn failure then
   * wins over the port or protocol symptom it produced, which is what a field
   * report needs to see.
   */
  private async rootCause(reason: unknown, fault: FaultSignal): Promise<unknown> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const raised = fault.raised;
    if (raised !== null && raised.code === "SPAWN_FAILED") {
      return raised;
    }

    if (this.currentState === "spawning" && this.childIsGone()) {
      return new EngineStartError(
        "SPAWN_FAILED",
        "the engine process exited before a WebSocket URL was discovered",
      );
    }

    return reason;
  }

  /** True when the child has recorded an exit or a terminating signal. */
  private childIsGone(): boolean {
    const child = this.child;
    return child !== null && (child.exitCode !== null || child.signalCode !== null);
  }

  /** Connect and adopt the socket; `socketState` tracks the transport. */
  private async openSocket(url: string, token: string, fault: FaultSignal): Promise<EngineSocket> {
    this.currentSocketState = "connecting";

    const socket = await raceWithFault(connectEngine(url, token), fault.promise);

    this.socket = socket;
    this.currentSocketState = "open";
    socket.on("message", this.handleSocketMessage);
    socket.on("close", this.handleSocketClose);

    return socket;
  }

  /** Capture the frame timestamp first, then notify every subscriber. */
  private handleSocketMessage = (): void => {
    const at = Date.now();
    this.latestFrameAt = at;

    for (const listener of [...this.frameListeners]) {
      try {
        listener(at);
      } catch {
        // A subscriber's exception is caught so one bad listener cannot abort
        // the notification of the others or the transport callback. The facade
        // owns no logging channel; the host logs what it subscribes to.
      }
    }
  };

  /** The transport closed; the facade state is untouched here. */
  private handleSocketClose = (): void => {
    this.currentSocketState = "closed";
  };

  /**
   * Drop the socket, optionally terminating instead of closing politely.
   *
   * Also used when no socket was adopted (a failed upgrade), so the transport
   * state always ends at `closed` after a failure instead of freezing at the
   * `connecting` it reached.
   */
  private releaseSocket(hard: boolean): void {
    const socket = this.socket;
    this.socket = null;

    if (socket !== null) {
      socket.removeListener("message", this.handleSocketMessage);
      socket.removeListener("close", this.handleSocketClose);

      try {
        if (hard) {
          socket.terminate();
        } else {
          socket.close(1000, "engine stopping");
        }
      } catch {
        // Already closed by the peer or by the peer's death; nothing to release.
      }
    }

    this.currentSocketState = "closed";
  }

  /** Detach the child listeners so a stop cannot be mistaken for a crash. */
  private releaseChildSubscriptions(): void {
    for (const unsubscribe of this.childUnsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // The child is already gone; a failed unsubscribe changes nothing.
      }
    }
  }

  /** One graceful stop; the caller owns the in-flight bookkeeping. */
  private async stopOnce(budgetMs: number): Promise<void> {
    this.transition("closing");
    // Polite close, then the child is stopped; once the server is gone the socket
    // closes for real, so no dangling TCP handle keeps the host process alive.
    this.releaseSocket(false);

    const child = this.child;
    this.child = null;
    this.releaseChildSubscriptions();

    if (child !== null) {
      await stopChildGracefully(child, budgetMs);
    }

    await this.ensureTokenRemoved();
    this.transition("closed");
  }

  /**
   * Delete the token file once per attempt and share the promise, so `kill()`
   * can start the unlink without awaiting it and a later `stopGraceful` still
   * observes its completion.
   */
  private ensureTokenRemoved(): Promise<void> {
    if (this.tokenRemoval === null) {
      this.tokenRemoval = this.removeTokenFileOnce();
    }

    return this.tokenRemoval;
  }

  /** Single-point unlink of the token file; never throws. */
  private async removeTokenFileOnce(): Promise<void> {
    const path = this.tokenFilePath;
    this.tokenFilePath = null;

    if (path === null) {
      return;
    }

    try {
      await removeTokenFile(path);
    } catch {
      // Best effort: a locked or already-removed file must not turn a stop into
      // a rejection, and the caller has no recovery action to take.
    }
  }

  /** Shared failure cleanup: socket, then token file, then the child. */
  private ensureCleanup(): Promise<void> {
    if (this.cleanupInFlight === null) {
      this.cleanupInFlight = this.runCleanup();
    }

    return this.cleanupInFlight;
  }

  /** Order matters: the socket first, so no frame can arrive during teardown. */
  private async runCleanup(): Promise<void> {
    this.releaseSocket(true);
    await this.ensureTokenRemoved();

    const child = this.child;
    this.child = null;
    this.releaseChildSubscriptions();

    if (child !== null) {
      await stopChildGracefully(child);
    }
  }

  /**
   * Terminal failure path of `start` / `attach`.
   *
   * The state change and the error event are emitted before the cleanup, exactly
   * as the work package orders them: a subscriber that reacts to `failed` can
   * still see the token file and the child for one tick.
   */
  private async failStart(reason: unknown): Promise<never> {
    const mapped = toEngineError(reason);
    const failure = new EngineStartError(mapped.code, mapped.detail, mapped.wireHint);

    this.lastFailureCode = mapped.code;

    if (this.currentState !== "failed") {
      this.transition("failed");
      this.emitError(mapped);
    }

    await this.ensureCleanup();

    throw failure;
  }

  /** Move to `failed` for a crash outside the start path; idempotent. */
  private declareFailure(error: EngineError): void {
    if (this.isStopping()) {
      return;
    }

    this.lastFailureCode = error.code;
    this.transition("failed");
    this.emitError(error);

    // A callback cannot await; the cleanup is fired and shared with any later
    // `stopGraceful` call.
    void this.ensureCleanup();
  }

  /** Write the state first, then notify; one bad listener cannot abort the rest. */
  private transition(next: EngineState): void {
    if (this.currentState === next) {
      return;
    }

    this.currentState = next;

    for (const listener of [...this.stateListeners]) {
      try {
        listener(next);
      } catch {
        // Isolated on purpose: the state machine must keep notifying the other
        // subscribers. The host owns logging, so there is nowhere to report it.
      }
    }
  }

  /** Notify every error subscriber; one failing listener cannot hide the failure. */
  private emitError(error: EngineError): void {
    for (const listener of [...this.errorListeners]) {
      try {
        listener(error);
      } catch {
        // See `transition`: one failing subscriber must not hide the failure.
      }
    }
  }
}

/** Run `work` and the fault signal in parallel; never leaves a rejection unhandled. */
async function raceWithFault<T>(work: Promise<T>, fault: Promise<never>): Promise<T> {
  const guarded = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const faulted = fault.then(
    () => ({ ok: false as const, error: new Error("engine fault") }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const result = await Promise.race([guarded, faulted]);

  if (result.ok) {
    return result.value;
  }

  throw result.error;
}

/** Compare the reported engine version with the caller's expectation. */
function assertExpectedVersion(info: AppServerInfo, expected: string | undefined): void {
  if (expected === undefined || expected === info.engineVersion) {
    return;
  }

  throw new EngineStartError(
    "PROTOCOL_MISMATCH",
    `engine version mismatch: expected "${expected}", the engine reports "${info.engineVersion}"`,
    info.engineVersion,
  );
}

/** Validate the frozen eight-field spawn spec; throw `SPAWN_FAILED` with all faults. */
function assertSpawnSpec(spec: unknown): void {
  const problems = spawnSpecProblems(spec);

  if (problems.length > 0) {
    throw new EngineStartError("SPAWN_FAILED", `invalid spawn spec: ${problems.join("; ")}`);
  }
}

/**
 * Collect the missing or mistyped spawn-spec fields as human sentences.
 *
 * Missing fields are reported first and on their own line, because a missing
 * field usually means the wrong object was passed and reporting types as well
 * would bury that.
 */
function spawnSpecProblems(spec: unknown): string[] {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return ["spawn spec is not an object"];
  }

  const record = spec as Record<string, unknown>;
  const missing = SPAWN_SPEC_FIELDS.filter((field) => !(field in record));

  if (missing.length > 0) {
    return missing.map((field) => `missing field "${field}"`);
  }

  const problems: string[] = [];

  for (const field of ["exePath", "bundlePath", "cwd"] as const) {
    if (!isNonEmptyString(record[field])) {
      problems.push(`"${field}" must be a non-empty string`);
    }
  }

  if (!isStringRecord(record.env)) {
    problems.push('"env" must be a record of string values');
  }

  const argvPrefix = record.argvPrefix;
  if (!Array.isArray(argvPrefix) || argvPrefix.some((item) => typeof item !== "string")) {
    problems.push('"argvPrefix" must be an array of strings');
  }

  if (record.stdio !== "pipe") {
    problems.push('"stdio" must be "pipe"');
  }

  if (typeof record.windowsHide !== "boolean") {
    problems.push('"windowsHide" must be a boolean');
  }

  if (typeof record.detached !== "boolean") {
    problems.push('"detached" must be a boolean');
  }

  return problems;
}

/** True for a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** True for a record whose every value is a string. */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

/**
 * Normalize a caller-supplied budget: a non-finite value falls back to the
 * documented default and a negative value means "no waiting".
 */
function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

/** Readable message for a thrown value of unknown shape. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

/** Read a Node fault code without trusting the thrown value. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}
