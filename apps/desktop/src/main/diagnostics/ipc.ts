/**
 * The three diagnostics channels: one request/response channel and two commands.
 *
 * `bridge:control.diagnostics.export` is bidirectional, which is unusual for
 * this bridge: the renderer `invoke`s `start`/`cancel`, and main pushes
 * `progress`/`done`/`failed`/`cancelled` back on the same channel. The `kind`
 * field is the discriminator, so there is exactly one subscription to manage
 * and no second channel that could disagree about whether an export is running.
 *
 * The renderer is untrusted, so every request is parsed rather than cast: an
 * unknown `kind`, a missing options pair or a non-boolean flag returns
 * `{ok:false, detail}`. Nothing here throws at the IPC boundary -- a handler
 * that throws becomes an opaque rejected `invoke` in the renderer, which is the
 * least useful form of "the button did nothing".
 *
 * The export itself is injected. That keeps the flow testable without Electron
 * and lets `main.ts` be the single composition root that binds P6 and the native
 * dialogs. `open` is also available as a helper for the menu item P10 owns; it
 * sends to a specific `webContents` instead of guessing a global window.
 */

import type {
  DiagnosticsEvent,
  DiagnosticsOptions,
  DiagnosticsRequest,
  DiagnosticsResult,
} from "../../shared/diagnostics.js";
import { DIAGNOSTICS_CHANNELS } from "../../shared/bridge.js";
import type { Logger } from "../log.js";

/** The renderer-visible reply to `open`/`start`/`cancel`/`relaunch`/`quit`. */
export type DiagnosticsCommandResult =
  { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** The payload an export runner receives. */
export interface DiagnosticsExportRun {
  readonly options: DiagnosticsOptions;
  readonly onEvent: (event: DiagnosticsEvent) => void;
  readonly signal: AbortSignal;
}

/** `runDiagnosticsExport`, bound to a context by the caller. */
export type DiagnosticsExportRunner = (run: DiagnosticsExportRun) => Promise<DiagnosticsResult>;

/** The part of `WebContents` a reply needs. */
export interface DiagnosticsSender {
  send(channel: string, payload: unknown): void;
}

/** The part of a `BrowserWindow` the handler may fall back to. */
export interface DiagnosticsWindow {
  readonly webContents: DiagnosticsSender;
  readonly isDestroyed?: () => boolean;
}

/** The part of `IpcMainInvokeEvent` a handler reads. */
export interface DiagnosticsInvokeEvent {
  readonly sender?: DiagnosticsSender;
}

/** The part of `IpcMain` registration needs. */
export interface DiagnosticsIpcMain {
  handle(
    channel: string,
    listener: (event: DiagnosticsInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
}

/** The part of Electron's `app` the two commands use. */
export interface DiagnosticsApp {
  relaunch(): void;
  quit(): void;
}

/** Everything `registerDiagnosticsIpc` needs. */
export interface DiagnosticsIpcDeps {
  readonly ipcMain: DiagnosticsIpcMain;
  readonly getWindow: () => DiagnosticsWindow | null;
  readonly export: DiagnosticsExportRunner;
  readonly app: DiagnosticsApp;
  readonly logger?: Logger;
  /** Whether a session source is registered; the panel's "no active session" hint. */
  readonly sessionAvailable: boolean;
}

/** One `ipcMain` per process in production; the set is only to make re-entry a no-op. */
const registered = new WeakSet<object>();

function detailOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  return value as Record<string, unknown>;
}

/** Parse the untrusted request, or return the reason it is unusable. */
function parseRequest(payload: unknown): DiagnosticsRequest | string {
  const record = asRecord(payload);

  if (record === null) return "request must be an object";

  const kind = record["kind"];

  if (kind === "open") {
    const sessionAvailable = record["sessionAvailable"];

    if (typeof sessionAvailable !== "boolean") {
      return "open requires a boolean sessionAvailable";
    }

    return { kind: "open", sessionAvailable };
  }

  if (kind === "start") {
    const options = asRecord(record["options"]);

    if (options === null) return "start requires an options object";

    const includeSessionContent = options["includeSessionContent"];
    const includeMinidump = options["includeMinidump"];

    if (typeof includeSessionContent !== "boolean" || typeof includeMinidump !== "boolean") {
      return "start options must be two booleans";
    }

    return { kind: "start", options: { includeSessionContent, includeMinidump } };
  }

  if (kind === "cancel") return { kind: "cancel" };

  return `unknown diagnostics request kind: ${typeof kind === "string" ? kind : "non-string"}`;
}

/** Prefer the event's sender; fall back to the live window for menu-originated calls. */
function resolveSender(
  event: DiagnosticsInvokeEvent,
  getWindow: () => DiagnosticsWindow | null,
): DiagnosticsSender | null {
  if (event.sender !== undefined) return event.sender;

  const window = getWindow();

  if (window === null || window.isDestroyed?.() === true) return null;

  return window.webContents;
}

/** What main may push on the export channel. */
type DiagnosticsOutbound = DiagnosticsEvent | { kind: "open"; sessionAvailable: boolean };

/** Send one main-to-renderer event, without letting a dead window break the export. */
function sendEvent(
  sender: DiagnosticsSender,
  event: DiagnosticsOutbound,
  logger: Logger | undefined,
): void {
  // `progress` fires per entry, and a destroyed webContents throws on every one.
  // Logging the first failure would be noise; the export still finishes because
  // the file is the deliverable, not the progress bar.
  try {
    sender.send(DIAGNOSTICS_CHANNELS.export, event);
  } catch (error) {
    logger?.warn("diagnostics.export.send-failed", { detail: detailOf(error) });
  }
}

/** The terminal event implied by a runner's result, for a runner that sent none. */
function terminalEventOf(result: DiagnosticsResult): DiagnosticsEvent {
  if (result.ok) {
    return { kind: "done", path: result.path, bytes: result.bytes, omitted: result.omitted };
  }

  if (result.code === "DIAGNOSTIC_EXPORT_CANCELLED") return { kind: "cancelled" };

  return { kind: "failed", code: "DIAGNOSTIC_EXPORT_FAILED", detail: result.detail };
}

/**
 * Register the three channels.
 *
 * Registration is idempotent per `ipcMain`: `main.ts` calls this once, and a
 * test (or a future hot-reload path) calling it twice must not stack two
 * handlers on one channel. A second `ipcMain` is a second process boundary, so
 * it gets its own registration.
 *
 * @param deps the IPC surface, the export runner and the app commands
 */
export function registerDiagnosticsIpc(deps: DiagnosticsIpcDeps): void {
  if (registered.has(deps.ipcMain as object)) return;

  registered.add(deps.ipcMain as object);

  // The controller belongs to this registration, so a second window cannot
  // cancel an export it did not start.
  let inflight: AbortController | null = null;

  deps.ipcMain.handle(DIAGNOSTICS_CHANNELS.export, (event, payload) => {
    const request = parseRequest(payload);

    if (typeof request === "string") return { ok: false, detail: request };

    if (request.kind === "open") {
      const sender = resolveSender(event, deps.getWindow);

      if (sender === null) return { ok: false, detail: "no window to open the panel in" };

      // Main owns the fact: a renderer cannot claim a session exists. The
      // requested value is logged so a caller that disagrees is visible.
      deps.logger?.info("diagnostics.panel.open", {
        requested: request.sessionAvailable,
        sessionAvailable: deps.sessionAvailable,
      });

      sendEvent(sender, { kind: "open", sessionAvailable: deps.sessionAvailable }, deps.logger);

      return { ok: true };
    }

    if (request.kind === "cancel") {
      if (inflight !== null) {
        inflight.abort();
        deps.logger?.info("diagnostics.export.cancel");
      }

      return { ok: true };
    }

    if (inflight !== null) return { ok: false, detail: "an export is already running" };

    const sender = resolveSender(event, deps.getWindow);

    if (sender === null) return { ok: false, detail: "no window to report progress to" };

    const controller = new AbortController();
    let terminalSent = false;

    inflight = controller;

    const emit = (eventPayload: DiagnosticsEvent): void => {
      if (terminalSent) return;

      if (eventPayload.kind !== "progress") terminalSent = true;

      sendEvent(sender, eventPayload, deps.logger);
    };

    deps.logger?.info("diagnostics.export.start", {
      includeSessionContent: request.options.includeSessionContent,
      includeMinidump: request.options.includeMinidump,
    });

    void deps
      .export({ options: request.options, onEvent: emit, signal: controller.signal })
      .then((result) => {
        if (!terminalSent) emit(terminalEventOf(result));

        if (result.ok) {
          deps.logger?.info("diagnostics.export.done", {
            bytes: result.bytes,
            omitted: result.omitted.length,
          });
        } else {
          deps.logger?.warn("diagnostics.export.failed", {
            code: result.code,
            detail: result.detail,
          });
        }
      })
      .catch((error: unknown) => {
        // The runner is expected to resolve; if it throws, the renderer still
        // needs a terminal event or its progress UI never leaves "working".
        if (!terminalSent) {
          emit({
            kind: "failed",
            code: "DIAGNOSTIC_EXPORT_FAILED",
            detail: detailOf(error),
          });
        }
      })
      .finally(() => {
        if (inflight === controller) inflight = null;
      });

    return { ok: true };
  });

  deps.ipcMain.handle(DIAGNOSTICS_CHANNELS.relaunch, () => {
    deps.logger?.info("diagnostics.relaunch");

    try {
      deps.app.relaunch();
      deps.app.quit();

      return { ok: true };
    } catch (error) {
      return { ok: false, detail: detailOf(error) };
    }
  });

  deps.ipcMain.handle(DIAGNOSTICS_CHANNELS.quit, () => {
    deps.logger?.info("diagnostics.quit");

    try {
      deps.app.quit();

      return { ok: true };
    } catch (error) {
      return { ok: false, detail: detailOf(error) };
    }
  });
}

/**
 * Ask one window to open the diagnostics panel.
 *
 * Used by the menu and crash page (`RD-05`): those are main-process callers and
 * have no `event.sender`, so they pass the exact webContents they mean instead
 * of this module reaching for a global window.
 *
 * @param webContents the window that should show the panel
 * @param sessionAvailable whether a session source is registered
 * @returns whether the message was handed to the webContents
 */
export function openDiagnosticsPanel(
  webContents: DiagnosticsSender,
  sessionAvailable: boolean,
): boolean {
  try {
    webContents.send(DIAGNOSTICS_CHANNELS.export, { kind: "open", sessionAvailable });

    return true;
  } catch {
    return false;
  }
}
