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
 * - `ready` means "socket open AND app_server_info answered". A socket that
 *   merely opened is never ready (section 8, rule 2). An untested engine build or
 *   NOT gate `ready`: an unrecognised build is a warning, so it lands in
 *   warning, so it lands in `degradations` instead (see `./degradations`).
 * - `failed` is terminal. A failed engine refuses a second `start` instead of
 *   reconnecting; reconnection belongs to B3 (section 8, rule 5).
 * - Token CONTENT never enters argv (rule 1). `start` writes the token file and
 *   appends only its PATH to `argvPrefix`, which is the element immediately after
 *   the `--ws-token-file` option the host port already put there.
 * - Every transition writes the internal field first and only then notifies the
 *   subscribers, so a callback that reads `engine.state` observes the new value.
 * - The facade reports what it cannot fix. A degraded token ACL, a missing
 *   watchdog marker and an untested build/protocol are collected in
 *   `degradations`; none of them turns a usable engine into a failure.
 *
 * Process start goes through `startEngineProcess` (`spawn.ts`). How the child
 * argv is composed is that module's contract: `[spec.bundlePath,
 * ...spec.argvPrefix]`. The headless host port describes the engine with
 * and the engine options in `argvPrefix`, which is the F-6 shape
 * `node haruyuki.js server ...`.
 *
 * `attach` is implemented inline on purpose (decisions D-10 and D-17): `attach.ts`
 *  was written in the same wave, and its `attachToExternalServer` is a
 * PROBE - it closes the socket after the handshake - while the facade has to hand
 * a live socket back. The two therefore stay separate, and this file never
 * imports `attach.ts`.
 */

import type { ChildProcess } from "node:child_process";

import { connectEngine } from "./connection";
import type { EngineSocket } from "./connection";
import {
  expectsWatchdog,
  MarkerWatch,
  tokenAclDegradation,
  versionDegradations,
  watchdogDegradation,
  WATCHDOG_MARKER,
  WATCHDOG_MARKER_GRACE_MS,
} from "./degradations";
import { toEngineError } from "./errors";
import { requestAppServerInfo } from "./handshake";
import { waitForWsUrl } from "./port-discovery";
import {
  killProcess,
  onProcessError,
  onProcessExit,
  onProcessStderr,
  startEngineProcess,
  stopGraceful as stopChildGracefully,
} from "./spawn";
import {
  assertSpawnSpec,
  codeOf,
  EngineStartError,
  FaultSignal,
  messageOf,
  normalizeTimeout,
  raceWithFault,
} from "./start-internals";
import { StderrTail } from "./stderr-tail";
import { generateToken, removeTokenFile, writeTokenFile } from "./token";
import type { TokenFile } from "./token";
import type {
  AppServerInfo,
  EngineDegradation,
  EngineError,
  EngineErrorCode,
  EngineExitInfo,
  EngineSpawnSpec,
  EngineState,
} from "./types";

/** Port discovery budget when the caller does not pass one (section 3.3 (c)). */
const DEFAULT_PORT_TIMEOUT_MS = 10_000;

/** Handshake budget when the caller does not pass one (section 3.3 (c)). */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Graceful-stop budget when the caller does not pass one (section 3.3 (c)). */
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

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

  /**
   * Last child exit, recorded before any `isStopping()` decision.
   *
   * Read-only surface added for D4 (contract v1.1). It records, it
   * does not classify: crash detection stays `state === "failed"`.
   */
  private lastExitInfo: EngineExitInfo | null = null;

  /** Bounded stderr tail, fed by the single reader in `spawn.ts`. */
  private readonly stderrHistory = new StderrTail();

  private degradationList: EngineDegradation[] = [];

  private watchdogWatch: MarkerWatch | null = null;

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
   * Safety and compatibility checks that did not hold, in the order they were
   * discovered; empty when everything held.
   *
   * These are warnings by decision, never failures: docs/13 V-7 and B1-Q09 keep
   * the engine usable with an untested build, R-5 keeps it usable with a degraded
   * ACL, and R-3 keeps it usable without a working watchdog. What the host must
   * not do is lose the fact silently, so every one of them lands here.
   *
   * Read it after `start` / `attach` resolves; a failed start reports the fault
   * through `onError` instead.
   */
  get degradations(): readonly EngineDegradation[] {
    return [...this.degradationList];
  }

  /**
   * PID of the current engine child, or `null` before it exists and after
   * cleanup.
   *
   * Read-only surface added for D4 (contract v1.1). The runner
   * writes it into the runtime marker so the next launch can decide whether a
   * leftover process is this shell's engine; it is never used to signal a
   * process directly.
   */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * How the most recent child exited, or `null` before any exit.
   *
   * Recorded for both a normal stop and a crash; a caller that needs "was this a
   * crash" must still read `state` (`failed`), not this field.
   */
  get lastExit(): EngineExitInfo | null {
    return this.lastExitInfo;
  }

  /**
   * Last lines of the child's stderr, oldest first.
   *
   * The buffer is fed by a subscriber to the one reader in `spawn.ts`; it does
   * not open a second reader . The tail survives cleanup so a crash
   * can be diagnosed after the child is gone, and is cleared when a new attempt
   * starts.
   *
   * @param limit maximum lines; defaults to 200
   */
  stderrTail(limit?: number): readonly string[] {
    return this.stderrHistory.snapshot(limit);
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
      this.noteTokenAcl(tokenFile);

      const child = this.spawnEngine(options.spawnSpec, tokenFile.path);
      this.child = child;
      this.watchChild(child, fault);
      this.watchdogWatch = this.watchWatchdog(child, options.spawnSpec);

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

      await this.settleWatchdog();

      this.transition("handshaking");

      const socket = await this.openSocket(url, token, fault);
      const info = await raceWithFault(
        requestAppServerInfo(
          socket,
          normalizeTimeout(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS),
        ),
        fault.promise,
      );

      this.noteVersionMismatches(info, options.expectedEngineVersion);

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
   * Attach to an engine someone else started: connect, handshake, report an
   * untested version. No process is spawned and no token file is written or
   * deleted, because both belong to the external engine's owner.
   *
   * Inline on purpose (see the file comment): `attach.ts` is a probe
   * that closes its socket, while this entry has to keep one open.
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

      // A different build is a warning, not a veto: an untested combination keeps
      // manual URL + token flow usable with an untested combination, and the
      // mismatch is reported through `degradations` instead of ending the facade
      // in the terminal `failed` state.
      this.noteVersionMismatches(info, options.expectedEngineVersion);

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

    if (this.currentState === "idle") {
      return;
    }

    if (this.currentState === "closed") {
      // `kill()` starts the unlink without awaiting it (the emergency path must
      // not block), so a later `stopGraceful` is the only place a caller can get
      // proof that the token file is gone. Resolving early would make that
      // promise meaningless.
      await this.ensureTokenRemoved();
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
    this.lastExitInfo = null;
    this.stderrHistory.clear();
    this.degradationList = [];
    this.watchdogWatch = null;
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
      const child = startEngineProcess(childSpec);

      // Subscribe immediately after spawn, while the child is still starting.
      // `onProcessStderr` adds a listener to the single reader in `spawn.ts`; it
      // does not create a second reader .
      this.childUnsubscribers.push(
        onProcessStderr(child, (chunk) => {
          this.stderrHistory.push(chunk);
        }),
      );

      return child;
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
        // Record before any stopping decision: a normal stop and a crash both
        // leave an exit fact, and D4 reads this after `failed` (`R-062`-3/6).
        this.lastExitInfo = { code: info.code, signal: info.signal };

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

  /**
   * Record a degraded token-file ACL instead of dropping it.
   *
   * `writeTokenFile` degrades rather than throwing (R-5), which is right - a
   * usable engine beats no engine - but it also means the file may keep the
   * directory's inherited permissions, and on Windows that can be "Everyone can
   * read". The facade cannot fix that, so it must not lose it either.
   */
  private noteTokenAcl(tokenFile: TokenFile): void {
    const degraded = tokenAclDegradation(tokenFile);

    if (degraded !== null) {
      this.degradationList.push(degraded);
    }
  }

  /**
   * Watch the child's stderr for the watchdog self-check marker.
   *
   * The marker is only expected when the spawn spec actually preloads the
   * watchdog: the headless host port composes `NODE_OPTIONS=--require
   * "<abs>/watchdog.cjs"` , and a spec without it - a
   * caller that deliberately runs without orphan protection - must not be
   * reported as degraded.
   */
  private watchWatchdog(child: ChildProcess, spec: EngineSpawnSpec): MarkerWatch | null {
    if (!expectsWatchdog(spec)) {
      return null;
    }

    const watch = new MarkerWatch(WATCHDOG_MARKER);
    onProcessStderr(child, (chunk) => {
      watch.observe(chunk);
    });

    return watch;
  }

  /**
   * Turn "no marker by now" into a `watchdog` degradation.
   *
   * Called once the WebSocket URL is known: the watchdog is preloaded before any
   * engine code runs, so its marker has been written before the engine starts
   * listening. The short wait only pays off in the degraded case (R-3: the fuse
   * disables `--require`, or the path is wrong), where orphan protection is down
   * to the parent process and the host has to be told.
   */
  private async settleWatchdog(): Promise<void> {
    const watch = this.watchdogWatch;

    if (watch === null || watch.found) {
      return;
    }

    await watch.wait(WATCHDOG_MARKER_GRACE_MS);

    if (watch.found) {
      return;
    }

    this.degradationList.push(watchdogDegradation());
  }

  /**
   * Record an untested engine build or wire protocol as a degradation.
   *
   * Neither is a failure: docs/13 B1-Q09 and Q49 decide that an untested
   * combination still connects, and V-7 states the same for an external server.
   * `PROTOCOL_MISMATCH` stays reserved for "the handshake never matched", which is
   * what the classification table in no recursive section 3.3 (f) assigns to it.
   */
  private noteVersionMismatches(info: AppServerInfo, expected: string | undefined): void {
    this.degradationList.push(...versionDegradations(info, expected));
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
      this.recordChildExit(child);
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
      this.recordChildExit(child);
    }
  }

  /**
   * Record the OS exit fact when the child object already carries one.
   *
   * The normal stop path and the failure cleanup both release the child's
   * subscriptions before stopping it, so the `onProcessExit` listener cannot
   * record those. Reading `exitCode` / `signalCode` after the stop is the same
   * fact, and a budget expiry leaves both null (recorded as null, not guessed).
   *
   * @param child the child that has just been stopped
   */
  private recordChildExit(child: ChildProcess): void {
    if (this.lastExitInfo === null && (child.exitCode !== null || child.signalCode !== null)) {
      this.lastExitInfo = { code: child.exitCode, signal: child.signalCode };
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

    // A stop that started while this attempt was still in flight already owns the
    // state: `closing`/`closed` is what the caller asked for, and a late start
    // symptom must not rewrite it to the terminal `failed` (which would also
    // block the next start). The rejection still reports the fault.
    if (!this.isStopping()) {
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
