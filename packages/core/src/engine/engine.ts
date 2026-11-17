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
 * What is NOT here. The four collaborators below used to be private
 * methods of this class, and they made one file carry five responsibilities:
 * `SocketSession` (the transport), `ChildWatch` (the process),
 * `TokenLifecycle` (the token file), `WatchdogWatch` (the engine's self-check)
 * and `Teardown` (stop and failure cleanup). Each owns its own state and talks to
 * this facade through a narrow host interface, so no private field is exposed and
 * `Engine`'s public surface — frozen by the signed facade contract and extended
 * once since — is unchanged. What stays here is exactly what the file
 * comment claims: the state machine, the entry points, and the ordering
 * guarantees that only a single owner can give.
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

import { ChildWatch } from "./child-watch";
import type { ChildWatchHost } from "./child-watch";
import { versionDegradations } from "./degradations";
import { toEngineError } from "./errors";
import { requestAppServerInfo } from "./handshake";
import { waitForWsUrl } from "./port-discovery";
import { Teardown } from "./shutdown";
import { SocketSession } from "./socket-session";
import type { EngineSocketState } from "./socket-session";
import {
  assertSpawnSpec,
  EngineStartError,
  FaultSignal,
  normalizeTimeout,
  raceWithFault,
} from "./start-internals";
import { TokenLifecycle } from "./token-lifecycle";
import type { TokenLifecycleHost } from "./token-lifecycle";
import { generateToken } from "./token";
import { WatchdogWatch } from "./watchdog-watch";
import type { WatchdogHost } from "./watchdog-watch";
import type {
  AppServerInfo,
  EngineDegradation,
  EngineError,
  EngineErrorCode,
  EngineExitInfo,
  EngineSpawnSpec,
  EngineState,
} from "./types";

/** Re-exported so the frozen `Engine.socketState` type keeps its home. */
export type { EngineSocketState };

/** Port discovery budget when the caller does not pass one (section 3.3 (c)). */
const DEFAULT_PORT_TIMEOUT_MS = 10_000;

/** Handshake budget when the caller does not pass one (section 3.3 (c)). */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Graceful-stop budget when the caller does not pass one (section 3.3 (c)). */
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

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

  private currentAppServerInfo: AppServerInfo | null = null;

  /** The current attempt's endpoint; see {@link endpoint}. */
  #readyEndpoint: { readonly url: string; readonly token: string } | null = null;

  private lastFailureCode: EngineErrorCode | null = null;

  private degradationList: EngineDegradation[] = [];

  private readonly stateListeners = new Set<StateListener>();

  private readonly errorListeners = new Set<ErrorListener>();

  private readonly session = new SocketSession();

  /** The one socket host; `release` is called with it from both teardown paths. */
  private readonly socketHost = {
    released: (): void => {
      this.#readyEndpoint = null;
    },
  };

  private readonly children = new ChildWatch();

  private readonly tokens = new TokenLifecycle();

  private readonly watchdog = new WatchdogWatch();

  /**
   * The collaborators' view of this facade.
   *
   * Built once with arrow functions so every read is live: `getState` is a
   * method rather than a property for exactly that reason — a snapshot taken at
   * construction would misclassify a crash that happens after `ready`.
   */
  private readonly childHost: ChildWatchHost = {
    getState: () => this.currentState,
    isStopping: () => this.isStopping(),
    declareFailure: (error) => {
      this.declareFailure(error);
    },
  };

  private readonly tokenHost: TokenLifecycleHost = {
    note: (degradation) => {
      this.degradationList.push(degradation);
    },
  };

  private readonly watchdogHost: WatchdogHost = {
    note: (degradation) => {
      this.degradationList.push(degradation);
    },
  };

  private readonly teardown = new Teardown({
    transition: (next) => {
      this.transition(next);
    },
    onSocketReleased: () => {
      this.#readyEndpoint = null;
    },
    session: this.session,
    tokens: this.tokens,
    children: this.children,
  });

  /** Current lifecycle state; the ONLY state machine in B1. */
  get state(): EngineState {
    return this.currentState;
  }

  /** Timestamp of the last WebSocket frame, or `null` before the first one. */
  get lastFrameAt(): number | null {
    return this.session.lastFrameAt;
  }

  /** Transport-level state of the engine socket, independent of the facade state. */
  get socketState(): EngineSocketState {
    return this.session.state;
  }

  /** What the last successful handshake reported, or `null`. */
  get appServerInfo(): AppServerInfo | null {
    return this.currentAppServerInfo;
  }

  /**
   * The endpoint of this engine, or `null` while it is not usable. The facade needs
   * B2 needs `url` + `token` for the second and later connections of a multi-agent
   * and the endpoint has to be exposed because `url` is a local in `start`.
   *
   * Non-null **only** in `ready`, and this state test is the whole gate. The field
   * behind it is filled in earlier (when the attempt starts) and is deliberately
   * not cleared on every socket close: were it populated only in `ready` and
   * cleared everywhere else, this test and a `socketState`-based one would answer
   * identically, no test could tell them apart, and the state guard would be
   * decoration. `socketState` flips to `"open"` while the handshake answer is still
   * unknown, so reaching the token through it would open N connections on an engine
   * engine that may yet fail. It carries the plaintext token, so it must never be
   * must never be logged, put in a diagnostic or attached to a crash record
   * (boundary 2) - also why the field is `#private`: a TypeScript `private` is
   * erased at runtime, leaving the token on the object a crash reporter serialises.
   */
  get endpoint(): { readonly url: string; readonly token: string } | null {
    if (this.currentState !== "ready") {
      return null;
    }

    return this.#readyEndpoint;
  }

  /** Writes one already-serialised frame; the text passes through unmodified. */
  send(raw: string): void {
    this.session.send(raw);
  }

  /**
   * Subscribe to inbound raw frames; returns an idempotent unsubscribe.
   *
   * Distinct from {@link onFrame}, which hands out the arrival timestamp for a
   * heartbeat and stays as it is (D4 reads it). This one hands out the
   * frame text, because a client correlating a reply has to see the body.
   */
  onMessage(callback: (data: string) => void): () => void {
    return this.session.onMessage(callback);
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
    return this.children.pid;
  }

  /**
   * How the most recent child exited, or `null` before any exit.
   *
   * Recorded for both a normal stop and a crash; a caller that needs "was this a
   * crash" must still read `state` (`failed`), not this field.
   */
  get lastExit(): EngineExitInfo | null {
    return this.children.lastExit;
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
    return this.children.stderrTail(limit);
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
    this.children.fault = fault;

    try {
      assertSpawnSpec(options.spawnSpec);

      const token = generateToken();
      const tokenFile = await this.tokens.write(options.tokenDir, token);
      this.tokens.noteAcl(tokenFile, this.tokenHost);

      const child = this.children.spawn(options.spawnSpec, tokenFile.path);
      this.children.watch(child, fault, this.childHost);
      this.watchdog.watch(child, options.spawnSpec);

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

      await this.watchdog.settle(this.watchdogHost);

      // Store it when the attempt starts, not when it succeeds: the gate is what
      // keeps it unreachable, so storing it here changes nothing a caller can
      // observe, but storing it only on success would make that gate untestable -
      // every non-ready state would hold `null` anyway, so the mutation that
      // (`currentState` -> `socketState`) would stay green.
      this.#readyEndpoint = Object.freeze({ url, token });
      this.transition("handshaking");

      const socket = await this.session.open(url, token, fault);
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
      return this.failStart(await this.children.rootCause(error, fault, this.childHost));
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
    this.children.fault = fault;

    try {
      const socket = await this.session.open(options.url, options.token, fault);
      const info = await requestAppServerInfo(socket, DEFAULT_HANDSHAKE_TIMEOUT_MS);

      // A different build is a warning, not a veto: an untested combination keeps
      // manual URL + token flow usable with an untested combination, and the
      // mismatch is reported through `degradations` instead of ending the facade
      // in the terminal `failed` state.
      this.noteVersionMismatches(info, options.expectedEngineVersion);

      this.currentAppServerInfo = info;
      // See `start`: assigned before the transition, which is safe because the
      // getter gates on `state`, and a `ready` subscriber must already see it.
      this.#readyEndpoint = Object.freeze({ url: options.url, token: options.token });
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
    if (this.teardown.stopInFlight !== null) {
      return this.teardown.stopInFlight;
    }

    if (this.currentState === "idle") {
      return;
    }

    if (this.currentState === "closed") {
      // `kill()` starts the unlink without awaiting it (the emergency path must
      // not block), so a later `stopGraceful` is the only place a caller can get
      // proof that the token file is gone. Resolving early would make that
      // promise meaningless.
      await this.tokens.ensureRemoved();
      return;
    }

    if (this.currentState === "failed") {
      await this.teardown.ensureCleanup();
      return;
    }

    const stopping = this.teardown.stopOnce(normalizeTimeout(timeoutMs, DEFAULT_STOP_TIMEOUT_MS));
    this.teardown.stopInFlight = stopping;

    try {
      await stopping;
    } finally {
      if (this.teardown.stopInFlight === stopping) {
        this.teardown.stopInFlight = null;
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
    const child = this.children.takeChild();
    this.children.releaseSubscriptions();

    if (child !== null) {
      this.children.kill(child);
    }

    this.session.release(true, this.socketHost);

    const stoppable =
      this.currentState !== "idle" &&
      this.currentState !== "closed" &&
      this.currentState !== "failed";

    if (stoppable) {
      this.transition("closing");
      this.transition("closed");
    }

    void this.tokens.ensureRemoved();
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
    return this.session.onFrame(callback);
  }

  /** Reset per-attempt bookkeeping and enter the attempt's first state. */
  private beginAttempt(initial: EngineState): void {
    this.session.reset();
    this.children.reset();
    this.tokens.reset();
    this.watchdog.reset();
    this.teardown.reset();
    this.currentAppServerInfo = null;
    // A new attempt must not read the previous attempt's endpoint.
    this.#readyEndpoint = null;
    this.lastFailureCode = null;
    this.degradationList = [];
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

  /** True while the facade itself is taking the process down. */
  private isStopping(): boolean {
    return (
      this.currentState === "closing" ||
      this.currentState === "closed" ||
      this.currentState === "failed"
    );
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

    await this.teardown.ensureCleanup();

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
    void this.teardown.ensureCleanup();
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
