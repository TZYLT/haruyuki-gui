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
import type { EngineSource, RuntimeFailure, RuntimeFailureKind } from "../core/ipc.js";
import { createCommandPath, createFrameForwarder, createOutbox } from "./command-path.js";
import {
  CoreProcessHost,
  type CoreHost,
  type LogListener,
  type StatusListener,
} from "./core-host.js";
import { failureKindFor, missingEntriesOf, searchedPathsOf } from "./engine-failure.js";
import { resolveEngine, type EngineResolution } from "./engine-source.js";
import { createVSCodeHostPort } from "./host-port.js";
import { actionOf, bridgeAnnouncementOf } from "./panel-messages.js";
import type { ShellLog } from "./log.js";
import type { PanelHost, PanelLink, PanelLinkFactory } from "./panel.js";
import { createSecureInboundAnswerer } from "./secrets.js";
import type { StatusBar, StatusDetails } from "./status.js";
import { resolveWorkspaceCwd, type WorkspaceResolution } from "./workspace.js";
import { TESTED_ENGINE_VERSION } from "../shared/version.js";

/** Where the built core child sits, relative to the installed extension root. */
const CORE_ENTRY_RELATIVE = join("dist", "core.mjs");

/** One resolved engine, as the success arm of the resolver reports it. */
type FoundEngine = Extract<EngineResolution, { ok: true }>;

/** One failure, in the runtime's own vocabulary. */
type ReportedFailure = RuntimeFailure;

/**
 * The `status` message the panel accepts.
 *
 * The failure travels with it. It used to be the phase alone, and the sentence a
 * user needed went only to the log and the status bar's tooltip -- which meant a
 * panel could say "not connected" and nothing more, on a page whose whole job is
 * to say which directory to look in. The optional members are the facts the page
 * renders; see `RuntimeFailure` for why they are data rather than prose.
 */
type StatusMessage = {
  readonly kind: "status";
  readonly phase: string;
  readonly failure?: RuntimeFailure;
};

/**
 * The editor surfaces a panel action can ask for.
 *
 * Injected because this file deliberately binds no editor API: the entry owns
 * `vscode.window.showOpenDialog`, `workbench.action.openSettings` and
 * `vscode.openFolder`, and a copy bound here would be a second composition root.
 * Every member is optional, so a test -- and a build that has no editor -- can
 * leave the whole seam out and the actions simply report themselves unanswered.
 */
export interface ControllerEditor {
  /**
   * Ask the user for an engine directory.
   *
   * @returns the absolute directory, or `undefined` when the dialog was dismissed
   */
  pickEngineDirectory?(): Promise<string | undefined>;
  /** Open the editor's settings page on the engine setting. */
  openSettings?(): void;
  /** Ask the editor to open a folder, so the run has a working directory. */
  openFolder?(): void;
}

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
  /**
   * Create one directory and its parents.
   *
   * The four roots hang off `storageRoot` and exist nowhere until something
   * makes them. Injected rather than reached for, so this file keeps no
   * filesystem import and its assembly stays testable without one.
   */
  readonly ensureDirectory: (absPath: string) => void;
  /** `vscode.Uri.file`, injected so this file needs no editor import. */
  readonly toFileUri: (absPath: string) => { toString(): string };
  /** `vscode.env.language`, written onto the document by the panel host. */
  readonly locale: string;
  /**
   * The window's folder list, read at every start.
   *
   * A function rather than the array itself: `workspaceFolders` is a snapshot,
   * and the activation happens on the first view or command, which can easily
   * precede the user opening a folder. Capturing it once meant a window that
   * opened a folder afterwards still reported "no folder is open" -- and offered
   * to write the engine's files into the home directory.
   */
  readonly folders:
    | (() => readonly { readonly uri: { readonly fsPath: string } }[] | undefined)
    | readonly { readonly uri: { readonly fsPath: string } }[]
    | undefined;
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
   * The editor surfaces the panel's actions reach, all optional.
   *
   * A member that is absent is an action this build cannot answer; it reports
   * itself unanswered instead of pretending to have opened something.
   */
  readonly editor?: ControllerEditor;
  /**
   * Handles the panel actions this file does not own at all.
   *
   * Kept as a last resort rather than the main path: every action the error
   * surface offers is answered here, because a button that reaches a logger is
   * a button that does nothing.
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
    ensureDirectory: options.ensureDirectory,
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

  /**
   * Whether teardown has run.
   *
   * A function rather than a comparison because the answer can change during an
   * `await`: this file closes asynchronously, and a start that is waiting for a
   * child may be in flight while it does. Reading the variable directly twice
   * would be narrowed by the compiler to "the same as the first read", which is
   * the opposite of what has to be checked.
   *
   * @returns whether the assembly is closed
   */
  function isClosed(): boolean {
    return phase === "closed";
  }

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
   * The last status this host told any panel.
   *
   * A closed panel is not a stopped core: the child keeps running and the
   * status bar keeps its word, so a panel that is opened again is a new document
   * looking at a phase nobody will re-report. Without this replay the reopened
   * panel would show a frame and no status until the next unrelated change --
   * which for a refused start is never.
   */
  let lastStatus: StatusMessage | null = null;

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

      // Still written whole: a pasted log has to contain the sentence even when
      // the panel is not open, and this line is what a bug report quotes.
      log.write(failure.detail);
    }

    // The failure travels with the phase, which is the whole point of the added
    // members: the panel renders the facts, and a panel that shows nothing is
    // now a rendering bug rather than a missing field.
    postStatus?.({
      kind: "status",
      phase: options.status.state,
      ...(failure === undefined ? {} : { failure }),
    });
  }

  /**
   * Resolve the engine, reporting the case where there is none.
   *
   * @returns the accepted engine, or `null` once the refusal was reported
   */
  async function pickEngine(): Promise<FoundEngine | null> {
    // Read here as well as inside the resolver: the resolver owns the walk, but
    // this is the rung the page has to name, and asking a second time is cheaper
    // than making the resolver return its inputs alongside its verdict.
    const configured = await readEngineSetting();

    let resolved: EngineResolution;

    try {
      resolved = await resolveEngine({
        settings: options.settings,
        ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      report("failed", {
        kind: "missing-engine",
        detail,
        // A throw carries no resolution, so nothing was inspected.
        ...searchedPathsOf(configured, undefined),
      });

      return null;
    }

    if (!resolved.ok) {
      report("failed", {
        kind: failureKindFor(resolved.reason),
        detail: resolved.detail ?? `the engine could not be found (${resolved.reason})`,
        // Only the directories worth a user's attention. The raw `PATH` is
        // deliberately absent; see the helper for why.
        ...searchedPathsOf(configured, resolved.inspected),
        // What a folder has to hold and does not. The resolver reports it in a
        // sentence; the page needs the entries, because that is a repair list.
        ...missingEntriesOf(resolved.detail),
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
        kind: "untested-engine",
        detail: `the engine reports version ${resolved.version}, and this build was tested against ${resolved.expectedVersion}`,
        // Both versions as data: a page that showed only the sentence would be
        // showing English under a translated heading, and the pair is the one
        // fact the decision turns on.
        expectedVersion: resolved.expectedVersion,
        actualVersion: resolved.version,
        candidateDir: resolved.source.dir,
      });

      return null;
    }

    untested = null;

    return resolved;
  }

  /**
   * Resolve the working directory, reporting the case where there is none.
   *
   * @returns the directory, or `null` once the requirement was reported
   */
  function pickWorkspace(): string | null {
    const workspace: WorkspaceResolution = resolveWorkspaceCwd({
      folders: typeof options.folders === "function" ? options.folders() : options.folders,
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      confirmedHomeDir,
    });

    if (workspace.ok) return workspace.cwd;

    // A missing folder is not consent to run in the user's home directory, so the
    // refusal is reported and the degradation waits for an explicit answer. The
    // offered directory travels as data because the page shows it *before* the
    // user agrees, and the answer is about that exact path.
    report("failed", {
      kind: "no-workspace",
      detail: workspace.detail,
      homeDir: workspace.homeDir,
    });

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
  async function startCore(engine: EngineSource, cwd: string, origin: string): Promise<void> {
    // The one gate a fork passes through, guarded rather than each caller: the
    // engine search reads a setting, so every path here has an await before it,
    // and a window that closes during one of them used to leave a start in
    // flight that forked a child into a torn-down activation. Teardown is the
    // end of an activation, so nothing may start a process after it.
    if (isClosed()) {
      log.event("HOST_START_AFTER_CLOSE", {});

      return;
    }

    const init: CoreHostInit = {
      paths: port.paths,
      cwd,
      locale: options.locale,
      engine,
      expectedVersion: TESTED_ENGINE_VERSION,
      // The host's own table, carried rather than restated: the child used to
      // hold a hardcoded copy, so the two could disagree without either failing.
      capabilities: port.capabilities,
    };

    report("starting", undefined, {
      ...(engine.version === undefined ? {} : { engineVersion: engine.version }),
      // The rung, not the coarse kind: "external" tells the user nothing about
      // where the engine came from, and the tooltip exists to say where to look.
      source: origin,
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

    // The gate at the top of this function is checked before the fork, and the
    // fork can take the whole boot budget. A close that landed in that window
    // already ran its teardown, so the child this line just started is one no
    // teardown knows about: `onStarted` would write it into a shell whose
    // deactivation is over, and nothing would ever stop it or the engine behind
    // it. The same gate therefore has to be passed twice, once on each side of
    // the await that can outlive the activation.
    if (isClosed()) {
      log.event("HOST_START_AFTER_CLOSE", {});
      await core.stop().catch(() => {
        // The teardown is already over, so a failed stop has no reporter left.
        // The child is asked to go either way; the log above records why.
      });

      return;
    }

    log.event("CORE_STARTED", { cwd });

    // The token lives in the child's own temporary root, and the teardown removes
    // it from the same directory, so both sides read it from one place.
    options.onStarted?.(core, port.paths.temp);
  }

  /** Resolve, then start: the whole of a first start and of every plain retry. */
  /**
   * The start that is currently resolving, if one is.
   *
   * A second answer that arrives while the first is still reading the setting
   * joins that start rather than beginning a rival. The child is a process and
   * the engine behind it is another, so two forks for one click is two engines
   * and two sockets, and only one of them is reachable to stop.
   */
  let starting: Promise<void> | null = null;

  async function startOnce(): Promise<void> {
    // Joined, not dropped: a caller that asked for a start is answered by the
    // one already running, which is the same outcome it asked for.
    if (starting !== null) {
      await starting;

      return;
    }

    starting = resolveAndStart();

    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  /** The start itself: resolve the engine, then fork it once. */
  async function resolveAndStart(): Promise<void> {
    const engine = await pickEngine();

    if (engine === null) return;

    const cwd = pickWorkspace();

    if (cwd === null) return;

    await startCore(engine.source, cwd, engine.origin);
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

    // A second panel would have a second sink and could not be told apart from
    // the first, so the previous directions are released rather than leaked.
    //
    // Released BEFORE the new poster is installed, because the previous handle's
    // `dispose` clears `postStatus` as part of letting go. The other order looks
    // identical and silently leaves every later status with nowhere to go.
    live?.dispose();

    // The one message the outbox's shape has no room for. Bound per panel: a
    // poster kept from a closed panel writes nowhere.
    const mine = (message: StatusMessage): void => {
      lastStatus = message;
      post(message);
    };

    postStatus = mine;

    const handle: PanelLink = {
      receive(raw: unknown): void {
        // The command path answers `ignored` for the message families it does not
        // own instead of refusing them, which is what leaves the rest to the
        // dispatch below.
        commandPath.receive(raw);

        // The panel announces itself after every `boot`, and the answer has to
        // come from the process that owns the bridge version. Without this the
        // announcement reached nothing: the command path ignores it and it names
        // no action, so the one message that says "a panel is here" was dropped.
        const announced = bridgeAnnouncementOf(raw);

        if (announced !== null) core.announce(announced.appVersion, announced.bridgeVersion);

        const action = actionOf(raw);

        if (action !== null) handleAction(action);
      },
      dispose(): void {
        if (live === handle) live = null;

        // Only the poster this handle installed. An unconditional clear here
        // would wipe the next document's poster, because a rebuild disposes the
        // previous link after the new one exists.
        if (postStatus === mine) postStatus = null;

        forwarder.dispose();
        commandPath.dispose();
      },
    };

    live = handle;

    log.event("HOST_LINK_READY", {});

    // Everything this host already knows, said to the document that just
    // appeared. A panel reopened after a close is a fresh webview with an empty
    // store, and nothing else will repeat a phase that was settled a while ago.
    if (lastStatus !== null) postStatus(lastStatus);

    return handle;
  };

  /** One status snapshot from the child, to both sinks. */
  const onStatus: StatusListener = (snapshot) => {
    // The status bar owns the phase-to-word mapping, so nothing here repeats it.
    options.status.apply(snapshot);

    // The child's own failure is forwarded whole. It is the crash and
    // start-failed case, and the panel has to be able to render it: the phase
    // alone would leave the error surface with a heading and no facts.
    postStatus?.({
      kind: "status",
      phase: options.status.state,
      ...(snapshot.failure === undefined ? {} : { failure: snapshot.failure }),
    });
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
  async function startAccepted(engine: FoundEngine): Promise<void> {
    const cwd = pickWorkspace();

    if (cwd === null) return;

    log.event("HOST_ENGINE_CONNECT_ANYWAY", { version: engine.version });

    await startCore(engine.source, cwd, engine.origin);
  }

  /**
   * Handle one action the panel sent, when this file is the one that moves it.
   *
   * @param action the action name
   */
  function handleAction(action: string): void {
    switch (action) {
      case "connectAnyway": {
        // The user was shown which versions were compared and chose this build.
        // Without a remembered refusal there is nothing to override, so the plain
        // path runs and reports its own verdict.
        const remembered = untested;

        untested = null;
        void (remembered === null ? startOnce() : startAccepted(remembered));

        return;
      }

      case "retry":
        // Deliberately a fresh resolution rather than a replay of the last one:
        // the user may have changed the setting between the two answers, and
        // starting the directory a log line mentioned instead is unexplainable.
        untested = null;
        void startOnce();

        return;

      case "useHomeDir":
        // The confirmation has already happened: the page shows the directory and
        // requires a second, explicit answer before it sends this. Nothing here
        // may treat an unconfirmed run as consent.
        untested = null;
        confirmedHomeDir = true;
        void startOnce();

        return;

      case "chooseEngineDir":
        // Kept until a directory is actually picked: a dismissed dialog answers
        // nothing, so the refusal the page is still showing is still the one the
        // next "connect anyway" means.
        void chooseEngineDir();

        return;

      case "openSettings":
      case "openFolder":
        // Navigation only. The page is unchanged, so a remembered refusal stays
        // exactly as valid after one of these as it was before.
        answerWith(action);

        return;

      case "openLogs":
        // The log is this module's own sink, so there is no editor seam for it.
        log.show();

        return;

      default:
        // Not ours: the entry owns whatever is left.
        options.onAction?.(action);
    }
  }

  /**
   * Ask the user for an engine directory, then start from it.
   *
   * The picker is the editor's, so the seam answers it; the write is the
   * resolver's, so the setting keeps what actually worked. A dismissed dialog is
   * not a failure -- the page is left exactly as it was, because the user did
   * not answer the question it asked.
   */
  async function chooseEngineDir(): Promise<void> {
    const pick = options.editor?.pickEngineDirectory;

    if (pick === undefined) {
      answerWith("chooseEngineDir");

      return;
    }

    const picked = await pick().catch(() => undefined);

    if (picked === undefined || picked.trim() === "") {
      log.event("HOST_ENGINE_PICK_CANCELLED", {});

      // Dismissing a picker answers nothing: the page is still the one the user
      // was looking at, so the status it is showing is still true. Re-post the
      // last one whole rather than its phase alone -- a phase without its
      // failure is a message the panel refuses, which empties the page the
      // dismissal was explicitly not supposed to change.
      if (lastStatus !== null) postStatus?.(lastStatus);

      return;
    }

    const dir = picked.trim();

    // Written before the start rather than after it: the resolver reads this
    // setting first, so a write that came second would be a start from the old
    // directory followed by a setting change nothing acted on.
    await options.settings.write(dir).catch((error: unknown) => {
      log.failure("HOST_ENGINE_PICK_WRITE_FAILED", error);
    });

    log.event("HOST_ENGINE_PICKED", { dir });

    // The remembered refusal belongs to the old directory, so it is dropped: the
    // answer the user just gave supersedes the question this file was holding.
    untested = null;

    await startOnce();
  }

  /**
   * Report an action this build cannot answer.
   *
   * Logged rather than swallowed, so a button that does nothing says so
   * somewhere. Not an OS notification: this is a diagnostic, not a status.
   *
   * @param action the action name
   */
  function answerWith(action: string): void {
    if (options.editor === undefined) {
      log.event("PANEL_ACTION_UNHANDLED", { action });

      return;
    }

    switch (action) {
      case "openSettings":
        if (options.editor.openSettings === undefined) {
          log.event("PANEL_ACTION_UNHANDLED", { action });

          return;
        }

        options.editor.openSettings();

        return;

      case "openFolder":
        if (options.editor.openFolder === undefined) {
          log.event("PANEL_ACTION_UNHANDLED", { action });

          return;
        }

        options.editor.openFolder();

        return;

      default:
        log.event("PANEL_ACTION_UNHANDLED", { action });
    }
  }

  /**
   * Read the engine setting outside a resolution.
   *
   * @returns the configured directory, or `undefined` when none is set
   */
  async function readEngineSetting(): Promise<string | undefined> {
    try {
      return await options.settings.read();
    } catch {
      // A setting that cannot be read is the resolver's failure to report, not
      // this one's: the search still runs and still records where it looked.
      return undefined;
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
