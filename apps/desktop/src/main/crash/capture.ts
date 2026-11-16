/**
 * Crash capture: turn a process death into a `CrashRecord` and tell the shell.
 *
 * These handlers know nothing about Electron. They take the facts a caller
 * already has and a callback to run afterwards, which is what makes the rules
 * (which crashes are recorded, which are not) testable without a window or a
 * child process. Wiring `app.exit`, window rebuilds and page switches is the
 * next layer's job.
 *
 * Two rules come from the requirement and are easy to get wrong:
 *
 *   A start failure is not a crash (`33` R-13). An engine that never reached
 *   `ready` is reported by the bootstrap path, which knows why it failed. A
 *   crash record for it would put "something crashed" in front of a user whose
 *   engine simply is not installed, and the two need different screens.
 *
 *   A main-process uncaught exception is recorded, then the process exits; an
 *   unhandled rejection is recorded and the process continues (`32` section
 *   4.5). Making both fatal would turn a stray promise into an outage.
 */

import { writeCrashRecord, writeCrashRecordSync } from "./records.js";
import type {
  CrashKind,
  CrashMain,
  CrashRecord,
  CrashVersions,
  CrashWriteResult,
} from "./records.js";

/** Facts every capture path needs. */
export interface CrashWriteContext {
  /** Directory from `crashDirFor(userData)`. */
  readonly dir: string;
  readonly versions: CrashVersions;
  /** Clock, injected so tests can pin `at`. */
  readonly now?: () => Date;
}

/** A path that has to announce a crash once the record is handled. */
export interface CrashNotifyContext extends CrashWriteContext {
  /** Called after the record is written; the caller switches the page here. */
  readonly onCrash: (record: CrashRecord) => void;
  /**
   * The watchdog state the parent can justify at crash time.
   *
   * A getter because the engine host installs this watcher before `start()`
   * finishes, when the watchdog verdict does not exist yet; a snapshot would
   * freeze "unknown" into every record.
   */
  readonly watchdog?: () => "active" | "inactive" | "unknown";
}

/** The main process has no one to notify; it exits. */
export interface MainCrashContext extends CrashWriteContext {
  /** Called after the record is written, with the exit code to use. */
  readonly onFatal: (code: number) => void;
}

/** The optional sink for an unhandled rejection's human-readable detail. */
export interface MainCrashHandlersContext extends MainCrashContext {
  readonly onUnhandled?: (detail: string) => void;
}

/** Exit facts as `Engine` exposes them (`33` section 4.1). */
export interface EngineExitLike {
  readonly code: number | null;
  readonly signal: string | null;
  /** Parent-observed watchdog state, when the caller has one. */
  readonly watchdog?: "active" | "inactive" | "unknown";
}

/** The handshake facts a crash record keeps. */
export interface EngineAppServerInfoLike {
  readonly engineVersion: string;
  readonly protocolVersion: number;
}

/**
 * The slice of `Engine` this module reads.
 *
 * Structural on purpose: the crash recorder must not become a second owner of
 * the engine state machine, and a fake with these four members is a faithful
 * stand-in for a test.
 */
export interface EngineLike {
  readonly state: string;
  readonly appServerInfo: EngineAppServerInfoLike | null;
  readonly lastExit: EngineExitLike | null;
  onState(callback: (state: string) => void): () => void;
}

/** What Electron reports for a renderer that disappeared. */
export interface RendererGoneDetails {
  readonly reason: string;
  readonly exitCode: number | null;
}

/**
 * Write to stderr without letting a broken stderr become a thrown exception.
 *
 * Every call here happens on a path that is already handling a failure, so the
 * reporting itself cannot be allowed to fail loudly.
 */
function report(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // There is nowhere left to report to; the process is going down anyway.
  }
}

/** Start a record with the fields every kind shares. */
function baseRecord(kind: CrashKind, code: string, context: CrashWriteContext): CrashRecord {
  const at = context.now?.() ?? new Date();

  return {
    schemaVersion: 1,
    at: at.toISOString(),
    kind,
    code,
    // A copy, so a later mutation of the caller's version object cannot rewrite
    // a record that was already described to the user.
    app: { ...context.versions },
  };
}

/** Turn any thrown value into the fields a person needs to read. */
function describeThrown(value: unknown): CrashMain {
  if (value instanceof Error) {
    const described: CrashMain = { name: value.name, message: value.message };

    if (typeof value.stack === "string") described.stack = value.stack;

    return described;
  }

  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const name = record !== null && typeof record["name"] === "string" ? record["name"] : "NonError";
  const message =
    record !== null && typeof record["message"] === "string"
      ? record["message"]
      : stringifyUnknown(value);
  const described: CrashMain = { name, message };
  const stack = record !== null && typeof record["stack"] === "string" ? record["stack"] : null;

  if (stack !== null) described.stack = stack;

  return described;
}

/** `String` can throw for a hostile object; a crash record cannot. */
function stringifyUnknown(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "unprintable value";
  }
}

/**
 * Record an uncaught main-process exception, then leave.
 *
 * Synchronous by requirement: the record has to be on disk before the
 * process stops existing. A failed write goes to stderr and does not change the
 * exit path -- `R-10` prefers a missing record over a hung crash.
 *
 * @param error the thrown value, whatever it is
 * @param context where to write and how to exit
 */
export function handleMainCrash(error: unknown, context: MainCrashContext): void {
  try {
    const record = baseRecord("main", "MAIN_CRASHED", context);

    record.main = describeThrown(error);

    const result = writeCrashRecordSync(context.dir, record);

    if (!result.ok) report(`crash.main.write.failed ${result.error}`);
  } catch (writeError) {
    // The record builder or the writer failed in a way the writer's own result
    // could not describe. Still exit: a crash handler that hangs is worse.
    report(`crash.main.write.failed ${stringifyUnknown(writeError)}`);
  } finally {
    try {
      context.onFatal(1);
    } catch {
      // The exit path itself failed, possibly because the process is already
      // gone. Nothing can be done from here.
    }
  }
}

/** Report a failed asynchronous write without changing the caller's flow. */
function reportWriteFailure(record: CrashRecord, result: CrashWriteResult): void {
  if (!result.ok) report(`crash.${record.kind}.write.failed ${result.error}`);
}

/**
 * Watch an engine for a runtime crash.
 *
 * Only a transition into `failed` after the handshake counts. `appServerInfo`
 * is the evidence that the engine reached `ready`; when it is `null` the failure
 * belongs to startup, and the bootstrap path owns it (`R-13`). The record is
 * written asynchronously: the error page is more urgent than the file.
 *
 * @param engine the engine facade, or a structural stand-in
 * @param context where to write and whom to notify
 * @returns an unsubscribe function; safe to call more than once
 */
export function createEngineCrashWatcher(
  engine: EngineLike,
  context: CrashNotifyContext,
): () => void {
  let previous = engine.state;
  let stopped = false;

  const unsubscribe = engine.onState((state) => {
    const from = previous;

    previous = state;

    if (stopped || state !== "failed" || from === "failed") return;
    if (engine.appServerInfo === null) return;

    const exit = engine.lastExit;

    if (exit === null) return;

    const record = baseRecord("engine", "ENGINE_CRASHED", context);

    record.engine = {
      exitCode: exit.code,
      signal: exit.signal,
      engineVersion: engine.appServerInfo.engineVersion,
      protocolVersion: engine.appServerInfo.protocolVersion,
      // The parent cannot prove the child watchdog fired. The host's status is
      // the strongest claim it can make; a missing getter is honestly unknown.
      watchdog: context.watchdog?.() ?? "unknown",
    };

    void writeCrashRecord(context.dir, record).then((result) => {
      reportWriteFailure(record, result);

      if (stopped) return;

      try {
        context.onCrash(record);
      } catch (callbackError) {
        report(`crash.engine.notify.failed ${stringifyUnknown(callbackError)}`);
      }
    });
  });

  return () => {
    stopped = true;
    unsubscribe();
  };
}

/**
 * Record a renderer process that disappeared, then rebuild the window.
 *
 * The record is written before `onCrash` so the page that the callback opens can
 * read the same facts from disk. A failed write still opens the page: the user
 * needs an exit from the error surface more than the bundle needs a file.
 *
 * @param details Electron's `render-process-gone` facts
 * @param context where to write and whom to notify
 */
export async function handleRendererGone(
  details: RendererGoneDetails,
  context: CrashNotifyContext,
): Promise<void> {
  const record = baseRecord("renderer", "RENDERER_CRASHED", context);

  record.renderer = { reason: details.reason, exitCode: details.exitCode };

  const result = await writeCrashRecord(context.dir, record);

  reportWriteFailure(record, result);

  try {
    context.onCrash(record);
  } catch (callbackError) {
    report(`crash.renderer.notify.failed ${stringifyUnknown(callbackError)}`);
  }
}

/**
 * The one installed remover, so a second installation cannot stack handlers.
 *
 * The process has exactly one main thread; a caller that installs twice (a
 * reload in a test, a future restart path) gets the existing remover instead of
 * a second pair of listeners. Without this, one uncaught exception would be
 * written twice and the exit would be requested twice.
 */
let installedRemover: (() => void) | null = null;

/**
 * Install the main-process handlers.
 *
 * Must run before `app.whenReady` (`33` section 5.5): a crash during startup is
 * still a crash worth recording. Uncaught exceptions are recorded and exit;
 * unhandled rejections are reported through `onUnhandled` and deliberately do
 * not change Node's default behaviour (`32` section 4.5).
 *
 * @param context directory, versions, exit hook and rejection hook
 * @returns an idempotent uninstall function
 */
export function installMainCrashHandlers(context: MainCrashHandlersContext): () => void {
  if (installedRemover !== null) return installedRemover;

  const onUncaught = (error: unknown): void => {
    handleMainCrash(error, context);
  };

  const onRejection = (reason: unknown): void => {
    const described = describeThrown(reason);

    try {
      context.onUnhandled?.(`${described.name}: ${described.message}`);
    } catch (callbackError) {
      report(`crash.unhandled.notify.failed ${stringifyUnknown(callbackError)}`);
    }
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);

  let removed = false;

  const uninstall = (): void => {
    if (removed) return;

    removed = true;
    installedRemover = null;
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
  };

  installedRemover = uninstall;

  return uninstall;
}
