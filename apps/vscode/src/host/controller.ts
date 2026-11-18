/**
 * The composition root: the one place the parts in this directory are assembled
 * into a running shell.
 *
 * Every other module in `host/` takes its collaborators as injected arguments,
 * which is what makes each of them testable and none of them runnable alone.
 * This file supplies the arguments. It adds no capability of its own; its whole
 * value is the order things are created in, and one step of that order is a hard
 * constraint rather than a preference.
 *
 * The order, and why only this one works
 *
 *   1. The panel exists -- it owns the only message sink this host has.
 *   2. The outbox is bound to that panel's `postMessage`.
 *   3. The frame forwarder subscribes to the core's frames THROUGH the outbox.
 *   4. The command path is created over the same core and outbox.
 *   5. Only now is the child started.
 *
 *   Step 3 before step 5 is the constraint. The core subscribes to its engine and
 *   emits its first frame batch while it starts, before it answers `ready`; a
 *   forwarder installed afterwards therefore loses that batch, and the symptom is
 *   a panel that reports itself connected and then renders nothing. It was
 *   measured, not reasoned about, so a test here records the call order rather
 *   than the end state -- an end-state assertion cannot see this mistake.
 *
 * Lazy, then exactly once
 *
 *   `open()` starts the child at most once per activation, and a second call only
 *   reveals the panel that is already open. This is what keeps a window where
 *   nobody opened the panel free of a forked process and a spawned engine, which
 *   is the cost the lazy-activation design exists to avoid; a second start would
 *   also be a second engine over the same user data.
 *
 * Refusals are shown in the panel, never announced
 *
 *   A shell that cannot find an engine, has no tested build of one, or has no
 *   workspace folder still opens its panel and says so there. The editor's
 *   notification surface is deliberately unused: a toast that appears once and
 *   cannot be reopened is a worse home for "pick an engine directory" than a page
 *   that stays.
 *
 *   The wire message is `status`, which the panel already reads, and its phase
 *   word is the one the status bar rendered -- after that render it is the single
 *   spelling of the state in this process, so no second table here decides how a
 *   phase is named.
 *
 * What this file does not own
 *
 *   - Teardown order and the shutdown budget: `./lifecycle.ts`.
 *   - The editor's API: `../extension.ts` builds this assembly and passes the
 *     answers in, so nothing here imports `vscode`.
 *   - The engine's argv and environment: `./host-port.ts`.
 */

import { join } from "node:path";

import type { CoreHostInit } from "./core-host.js";
import type { EngineSource } from "../core/ipc.js";
import { createCommandPath, createFrameForwarder, createOutbox } from "./command-path.js";
import {
  CoreProcessHost,
  type CoreHost,
  type LogListener,
  type StatusListener,
} from "./core-host.js";
import { resolveEngine, type EngineResolution } from "./engine-source.js";
import { createVSCodeHostPort } from "./host-port.js";
import type { ShellLog } from "./log.js";
import type { PanelHost, PanelLink, PanelLinkFactory } from "./panel.js";
import { createSecureInboundAnswerer } from "./secrets.js";
import type { StatusBar, StatusDetails } from "./status.js";
import { resolveWorkspaceCwd, type WorkspaceResolution } from "./workspace.js";
import { TESTED_ENGINE_VERSION } from "../shared/version.js";

/** Where the built core child sits, relative to the installed extension root. */
const CORE_ENTRY_RELATIVE = join("dist", "core.mjs");

/**
 * How a refusal from `./engine-source.ts` is reported in the runtime's words.
 *
 * The resolver answers in the terms of its search (`missing`, `invalid-dir`,
 * `version-unknown`); the panel's failure kinds are the runtime's. This table is
 * the whole translation, so the two vocabularies meet in exactly one place.
 */
const FAILURE_FOR_REASON: Readonly<Record<string, "missing-engine" | "start-failed">> = {
  missing: "missing-engine",
  "invalid-dir": "start-failed",
  "version-unknown": "missing-engine",
};

/** One resolved engine, as the success arm of the resolver reports it. */
type FoundEngine = Extract<EngineResolution, { ok: true }>;

/** One failure, in the runtime's own vocabulary. */
type ReportedFailure = {
  readonly kind: "missing-engine" | "start-failed" | "crash" | "internal";
  readonly detail: string;
};

/**
 * The `status` message the panel accepts.
 *
 * Only the phase survives the webview's own narrowing, which keeps this shape
 * deliberately: sending more fields would look like a page that received a
 * sentence when it received a word. The sentence a user needs therefore goes to
 * the log and the status bar's tooltip, and the panel learns only that the
 * shell is not connected -- the full text on a page is the panel's own error
 * surface to add, not something this file can invent.
 */
type StatusMessage = {
  readonly kind: "status";
  readonly phase: string;
};

/** Everything the assembly needs, all of it injected. */
export interface ControllerOptions {
  /** The installed extension's root; the core child ships under it. */
  readonly extensionPath: string;
  /** `vscode.SecretStorage`, handed through to the port's own store. */
  readonly secrets: {
    get(key: string): PromiseLike<string | undefined>;
    store(key: string, value: string): PromiseLike<void>;
    delete(key: string): PromiseLike<void>;
  };
  /** `context.globalStorageUri.fsPath`: the parent of the four roots. */
  readonly storageRoot: string;
  /** `vscode.Uri.file`, injected so this file needs no editor import. */
  readonly toFileUri: (absPath: string) => { toString(): string };
  /** `vscode.env.language`, written onto the document by the panel host. */
  readonly locale: string;
  /** `vscode.workspace.workspaceFolders`, read at start rather than at activation. */
  readonly folders: readonly { readonly uri: { readonly fsPath: string } }[] | undefined;
  /** `os.homedir()`, offered as the no-workspace degradation. */
  readonly homeDir?: string;
  /** The engine setting, bound to `vscode.workspace.getConfiguration` by the entry. */
  readonly settings: {
    read(): Promise<string | undefined>;
    write(dir: string): Promise<void>;
  };
  /** `process.env.PATH`, for the second rung of the engine search. */
  readonly pathEnv?: string;
  /** The diagnostic sink; every step below reports itself here. */
  readonly log: ShellLog;
  /** The status bar the core's phases drive, and the source of the phase word. */
  readonly status: Pick<StatusBar, "set" | "apply" | "state">;
  /**
   * Builds the panel host, handing it the two directions this file composes.
   *
   * Injected rather than constructed here because the panel host needs the
   * editor's `Uri`, and this file deliberately binds no editor API.
   */
  readonly createPanel: (link: PanelLinkFactory) => PanelHost;
  /**
   * Receives the child this assembly started and the directory its capability
   * token went into.
   *
   * The entry keeps both so a deactivation can stop the child and remove the
   * token file without reaching into this module's state, and the directory is
   * passed rather than recomputed because only the code that started the child
   * knows where its token went.
   */
  readonly onStarted?: (host: CoreHost, tokenDir: string) => void;
  /**
   * Handles the panel actions that need an editor surface -- the settings page, a
   * folder picker, the log. This file moves the ones that only change its own
   * state; the rest belong to the module that binds the editor's API.
   */
  readonly onAction?: (action: string) => void;
  /** Test seam: the pipe to the child. Defaults to the real forked child. */
  readonly core?: CoreHost;
}

/**
 * The handle the entry keeps.
 *
 * One member opens because that is the whole of what a user can do here; the
 * teardown is `close`, which the lifecycle calls.
 */
export interface Controller {
  /** Open the panel, starting the child the first time. Idempotent per step. */
  open(): void;
  /** Release the panel and both directions through it. Idempotent. */
  close(): Promise<void>;
}

/** Where the assembly is in its own lifecycle. */
type Phase = "idle" | "started" | "closed";

/**
 * Build the assembly.
 *
 * Nothing is started here: this returns a handle whose `open` does the work, so
 * an activation that merely installs it pays for a closure and nothing else.
 *
 * @param options the injected shell answers
 * @returns the handle the entry installs
 */
export function createController(options: ControllerOptions): Controller {
  const { log } = options;

  // The port is built once: it holds the secret store and the shutdown callbacks
  // for the whole session, and a second one would be a second store.
  const port = createVSCodeHostPort({
    secrets: options.secrets,
    storageRoot: options.storageRoot,
    toFileUri: options.toFileUri,
    log: (line) => {
      log.write(line);
    },
  });

  // The child's secret requests are answered from the same store the host's own
  // `secure` calls reach, so the two directions cannot disagree about a value.
  const answerSecret = createSecureInboundAnswerer({
    store: port.secure,
    log: (line) => {
      log.write(line);
    },
  });

  const core: CoreHost =
    options.core ??
    new CoreProcessHost({
      entryPath: join(options.extensionPath, CORE_ENTRY_RELATIVE),
      secureInbound: answerSecret,
    });

  let phase: Phase = "idle";

  /** The panel host, built on the first open and kept for the session. */
  let panel: PanelHost | null = null;

  /** The panel's poster for the one fact the outbox does not carry. */
  let postStatus: ((message: StatusMessage) => void) | null = null;

  /** Subscriptions this file installed, unwound by `close`. */
  const installed: { dispose(): void }[] = [];

  /** The two directions of the panel that is open, while one is. */
  let live: PanelLink | null = null;

  /** The engine whose version check the user overrode, kept for the answer. */
  let untested: FoundEngine | null = null;

  /** Set once the user agreed to work in the home directory without a folder. */
  let confirmedHomeDir = false;

  /**
   * Tell the status bar and the panel the same fact.
   *
   * Written together because a state only one of them learned is a user who sees
   * "starting" forever after a refusal.
   *
   * The phase word is the status bar's own `StatusState`, handed back by the
   * status bar after it renders it, so the two surfaces cannot spell one state
   * two ways. The `failure` here reaches the log and the tooltip details; the
   * panel's own message family carries the phase alone, which is why the sentence
   * a user reads is the one the status item shows rather than a field on the wire.
   *
   * @param state the status-bar word, which is also the phase word on the wire
   * @param failure the failure to record, when the state is a refusal
   * @param details the engine facts the tooltip reports, when there are any
   */
  function report(
    state: "starting" | "failed" | "connected",
    failure?: ReportedFailure,
    details?: StatusDetails,
  ): void {
    options.status.set(state, details);

    if (failure !== undefined) {
      log.event("HOST_START_REFUSED", { kind: failure.kind });
      // Kept whole: this is the only surface that carries the sentence, because
      // the panel's message family has one field and it is the phase.
      log.write(failure.detail);
    }

    postStatus?.({ kind: "status", phase: options.status.state });
  }

  /**
   * Resolve the engine, reporting the case where there is none.
   *
   * @returns the accepted engine, or `null` once the refusal was reported
   */
  async function pickEngine(): Promise<EngineSource | null> {
    let resolved: EngineResolution;

    try {
      resolved = await resolveEngine({
        settings: options.settings,
        ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      report("failed", { kind: "missing-engine", detail });

      return null;
    }

    if (!resolved.ok) {
      report("failed", {
        kind: FAILURE_FOR_REASON[resolved.reason] ?? "missing-engine",
        detail: resolved.detail ?? `the engine could not be found (${resolved.reason})`,
      });

      return null;
    }

    if (!resolved.tested) {
      // Not a refusal to run, a refusal to run without being told: this build was
      // measured against one engine version, and connecting to another is the
      // user's call. The sentence names both versions so the page can say which.
      untested = resolved;
      log.event("HOST_ENGINE_UNTESTED", { version: resolved.version });
      report("failed", {
        kind: "start-failed",
        detail: `the engine reports version ${resolved.version}, and this build was tested against ${resolved.expectedVersion}`,
      });

      return null;
    }

    untested = null;

    return resolved.source;
  }

  /**
   * Resolve the working directory, reporting the case where there is none.
   *
   * @returns the directory, or `null` once the requirement was reported
   */
  function pickWorkspace(): string | null {
    const workspace: WorkspaceResolution = resolveWorkspaceCwd({
      folders: options.folders,
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      confirmedHomeDir,
    });

    if (workspace.ok) return workspace.cwd;

    // A missing folder is not consent to run in the user's home directory, so the
    // refusal is reported and the degradation waits for an explicit answer.
    report("failed", { kind: "start-failed", detail: workspace.detail });

    return null;
  }

  /**
   * Start the child, with the panel already in place to receive it.
   *
   * The forwarder was installed by the panel's link, before this is ever called;
   * see the file comment for why that order is the point of this file.
   *
   * @param engine the accepted engine
   * @param cwd the working directory the child and its engine run in
   */
  async function startCore(engine: EngineSource, cwd: string): Promise<void> {
    const init: CoreHostInit = {
      paths: port.paths,
      cwd,
      locale: options.locale,
      engine,
      expectedVersion: TESTED_ENGINE_VERSION,
    };

    report("starting", undefined, {
      ...(engine.version === undefined ? {} : { engineVersion: engine.version }),
      source: engine.kind,
      cwd,
    });

    try {
      await core.start(init);
    } catch (error) {
      // The child reports its own failures as status snapshots, so this catch is
      // for the ones that never reached it: a fork that could not happen, or a
      // `ready` that never came.
      const detail = error instanceof Error ? error.message : String(error);

      log.failure("CORE_START_FAILED", error);
      report("failed", { kind: "start-failed", detail });

      return;
    }

    log.event("CORE_STARTED", { cwd });

    // The token lives in the child's own temporary root, and the teardown removes
    // it from the same directory, so both sides read it from one place.
    options.onStarted?.(core, port.paths.temp);
  }

  /** Resolve, then start: the whole of a first start and of every plain retry. */
  async function startOnce(): Promise<void> {
    const engine = await pickEngine();

    if (engine === null) return;

    const cwd = pickWorkspace();

    if (cwd === null) return;

    await startCore(engine, cwd);
  }

  /** The two directions for one panel, installed the moment the panel exists. */
  const link: PanelLinkFactory = (concrete): PanelLink => {
    const post = (message: unknown): void => {
      concrete.webview.postMessage(message);
    };

    const pathLog = (code: string, detail?: Record<string, unknown>): void => {
      log.event(code, detail);
    };

    // 1. Where frames and replies leave this host.
    const outbox = createOutbox(post, pathLog);

    // 2. The frames, subscribed before the child is ever started -- the
    //    constraint the whole file exists for.
    const forwarder = createFrameForwarder({ host: core, outbox, log: pathLog });

    // 3. The panel's own messages, answered over the same core and outbox.
    const commandPath = createCommandPath({ host: core, outbox, log: pathLog });

    // The one message the outbox's shape has no room for. Bound per panel: a
    // poster kept from a closed panel writes nowhere.
    postStatus = (message: StatusMessage): void => {
      post(message);
    };

    // A second panel would have a second sink and could not be told apart from
    // the first, so the previous two directions are released rather than leaked.
    live?.dispose();

    const handle: PanelLink = {
      receive(raw: unknown): void {
        // The command path answers `ignored` for the message families it does not
        // own instead of refusing them, which is what leaves the rest to the
        // dispatch below.
        commandPath.receive(raw);

        const action = actionOf(raw);

        if (action !== null) handleAction(action);
      },
      dispose(): void {
        if (live === handle) live = null;

        postStatus = null;

        forwarder.dispose();
        commandPath.dispose();
      },
    };

    live = handle;

    log.event("HOST_LINK_READY", {});

    return handle;
  };

  /** One status snapshot from the child, to both sinks. */
  const onStatus: StatusListener = (snapshot) => {
    // The status bar owns the phase-to-word mapping, so nothing here repeats it.
    options.status.apply(snapshot);

    postStatus?.({ kind: "status", phase: options.status.state });
  };

  /** One log line from the child, tagged so a pasted log names its source. */
  const onLog: LogListener = (entry) => {
    log.write(`[core] ${entry.line}`);
  };

  installed.push({ dispose: core.onStatus(onStatus) });
  installed.push({ dispose: core.onLog(onLog) });

  /**
   * Start a specific engine, bypassing the version verdict the user overrode.
   *
   * @param engine the engine the user chose to connect to
   */
  async function startAccepted(engine: EngineSource): Promise<void> {
    const cwd = pickWorkspace();

    if (cwd === null) return;

    log.event("HOST_ENGINE_CONNECT_ANYWAY", { version: engine.version ?? "unknown" });

    await startCore(engine, cwd);
  }

  /**
   * Handle one action the panel sent, when this file is the one that moves it.
   *
   * @param action the action name
   */
  function handleAction(action: string): void {
    // Cleared on every branch: an answer applies to the refusal that asked for it,
    // and a stale one must not decide a later start.
    const remembered = untested;

    untested = null;

    switch (action) {
      case "retry":
        // Deliberately a fresh resolution rather than a replay of the last one:
        // the user may have changed the setting between the two answers, and
        // starting the directory a log line mentioned instead is unexplainable.
        void startOnce();

        return;

      case "connectAnyway":
        // The user was shown which versions were compared and chose this build.
        // Without a remembered refusal there is nothing to override, so the plain
        // path runs and reports its own verdict.
        void (remembered === null ? startOnce() : startAccepted(remembered.source));

        return;

      case "useHomeDir":
        confirmedHomeDir = true;
        void startOnce();

        return;

      default:
        // Not ours: the entry owns the ones that need the editor's own surfaces.
        options.onAction?.(action);
    }
  }

  return {
    open(): void {
      if (phase === "closed") return;

      // The panel first, always: the outbox is bound to its `postMessage`, and
      // the forwarder has to exist before the child can emit anything. Its own
      // `open` is the idempotent step, so a second call only reveals it.
      panel ??= options.createPanel(link);

      panel.open();

      if (phase !== "idle") return;

      phase = "started";
      log.event("HOST_START_BEGIN", {});

      void startOnce();
    },

    async close(): Promise<void> {
      if (phase === "closed") return;

      phase = "closed";

      live?.dispose();
      live = null;
      postStatus = null;

      for (const subscription of installed.splice(0)) {
        try {
          subscription.dispose();
        } catch {
          log.event("HOST_UNSUBSCRIBE_FAILED", {});
        }
      }

      await panel?.close();
    },
  };
}

/**
 * @param raw one message from the panel
 * @returns the action it names, or `null` when it names none
 */
function actionOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;

  const record = raw as Record<string, unknown>;

  if (record["kind"] !== "action") return null;

  const action = record["action"];

  return typeof action === "string" && action.length > 0 ? action : null;
}
