/**
 * The diagnostics export panel: a same-window modal (`RD-05`) rather than a second
 * `BrowserWindow`, which would add focus, close and crash lifecycles for no gain and
 * could not keep the window responsive during an export.
 *
 * Main sends `open`, then `progress` and one terminal event on one channel, so every
 * inbound payload is parsed rather than cast -- the renderer is not the trusted side.
 * `window.haruyuki` is read when used, never at module scope, so a preload that failed
 * to load is a sentence inside the panel rather than an import error.
 */

import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import { Alert, Button, Dialog, useT, type Translator } from "@haruyuki/ui";

import type { DiagnosticsOptions } from "../shared/diagnostics.js";

/** The channel requests go out on and events come back on. */
const EXPORT_CHANNEL = "bridge:control.diagnostics.export";

/** The three stages main reports while building the bundle. */
type ProgressPhase = "collect" | "compress" | "write";

/**
 * What this panel displays. Narrower than `DiagnosticsEvent`: `omitted` and the failure
 * `code` are the bundle's bookkeeping, not something the panel says.
 */
type PanelMessage =
  | { kind: "open"; sessionAvailable: boolean }
  | { kind: "progress"; phase: ProgressPhase; done: number; total: number }
  | { kind: "done"; path: string; bytes: number }
  | { kind: "failed"; detail: string }
  | { kind: "cancelled" };

/**
 * The parts of the preload this panel uses. Structural rather than imported from
 * `shared/bridge.ts`: the renderer needs only these two members.
 */
export interface DiagnosticsBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

/** What the panel is doing, as one value. Four states, four sets of controls. */
type Status =
  | { kind: "idle" }
  | { kind: "running"; phase: ProgressPhase; done: number; total: number }
  | { kind: "done"; path: string; bytes: number }
  | { kind: "failed"; detail: string };

/** Props of {@link DiagnosticsPanel}. */
export interface DiagnosticsPanelProps {
  /**
   * Whether main has a session source to read from. Optional because a direct
   * `?panel=diagnostics` load has no `open` message; `undefined` means "not told".
   */
  sessionAvailable?: boolean;
  /** Called when the user closes the panel. */
  onClose?: () => void;
  /** Whether the panel starts visible. Defaults to `false`. */
  initialOpen?: boolean;
}

/** A checkbox and its label on one line. */
const ROW: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--ui-space-2)",
};

/** The progress track and its fill. Colours and sizes are tokens, never literals. */
const TRACK: CSSProperties = {
  height: "var(--ui-space-2)",
  backgroundColor: "var(--ui-color-surface-2)",
  borderRadius: "var(--ui-radius-1)",
  overflow: "hidden",
};

const FILL: CSSProperties = {
  height: "100%",
  backgroundColor: "var(--ui-color-accent-1)",
};

/**
 * The bridge, if the preload put one on the window and it has the two members used here.
 * A missing bridge is an ordinary state: the caller gets `null` and renders a sentence.
 *
 * @returns the bridge, or `null` when it is absent or incomplete
 */
function readBridge(): DiagnosticsBridge | null {
  const candidate = (window as unknown as { haruyuki?: unknown }).haruyuki;

  if (typeof candidate !== "object" || candidate === null) return null;

  const members = candidate as Partial<DiagnosticsBridge>;

  if (typeof members.invoke !== "function" || typeof members.on !== "function") return null;
  return candidate as DiagnosticsBridge;
}

/** @param value untrusted payload @returns whether it can be read field by field */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param value untrusted phase @returns whether it names one of the three stages */
function isPhase(value: unknown): value is ProgressPhase {
  return value === "collect" || value === "compress" || value === "write";
}

/**
 * Validate one inbound message, field by field: a `done` without a path or a `failed`
 * without a detail would leave the user looking at a state the panel cannot describe.
 *
 * @param payload the raw message from the channel
 * @returns the message, or `null` when it is not one this panel understands
 */
function parseMessage(payload: unknown): PanelMessage | null {
  if (!isRecord(payload)) return null;

  const kind = payload["kind"];

  if (kind === "open") {
    const sessionAvailable = payload["sessionAvailable"];
    return typeof sessionAvailable === "boolean" ? { kind, sessionAvailable } : null;
  }
  if (kind === "progress") {
    const phase = payload["phase"];
    const done = payload["done"];
    const total = payload["total"];
    if (!isPhase(phase) || typeof done !== "number" || typeof total !== "number") return null;
    return { kind, phase, done, total };
  }
  if (kind === "done") {
    const path = payload["path"];
    const bytes = payload["bytes"];
    if (typeof path !== "string" || typeof bytes !== "number") return null;
    return { kind, path, bytes };
  }
  if (kind === "failed") {
    const detail = payload["detail"];
    return typeof detail === "string" ? { kind, detail } : null;
  }

  return kind === "cancelled" ? { kind } : null;
}

/**
 * Read the refusal out of an `invoke` reply. Main answers `{ok:false, detail}` when it
 * will not start an export; taking that as success would leave the panel "working".
 *
 * @param reply the resolved `invoke` value
 * @param fallback text to use when main gave no detail
 * @returns the detail, or `null` when the reply is not a refusal
 */
function failureDetailOf(reply: unknown, fallback: string): string | null {
  if (!isRecord(reply) || reply["ok"] !== false) return null;

  const detail = reply["detail"];

  return typeof detail === "string" && detail !== "" ? detail : fallback;
}

/** @param error a rejected promise value @returns a sentence for the user */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @param t translator @param phase stage @returns its translated name */
function phaseLabel(t: Translator, phase: ProgressPhase): string {
  switch (phase) {
    case "collect":
      return t("common.diagnostics.phaseCollect");
    case "compress":
      return t("common.diagnostics.phaseCompress");
    case "write":
      return t("common.diagnostics.phaseWrite");
  }
}

/** @param status in-flight export @returns completion clamped to a non-negative track */
function percentOf(status: { done: number; total: number }): number {
  if (status.total <= 0) return 0;

  return Math.min(100, Math.round((status.done / status.total) * 100));
}

/**
 * The options panel for exporting a diagnostics bundle. Both checkboxes start unchecked:
 * the default bundle must contain neither session content nor a minidump (`32` 4.8).
 *
 * @param props initial visibility, session fact and close handler
 * @returns the dialog
 */
export function DiagnosticsPanel({
  sessionAvailable,
  onClose,
  initialOpen = false,
}: DiagnosticsPanelProps): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(initialOpen);
  const [sessionContent, setSessionContent] = useState(false);
  const [minidump, setMinidump] = useState(false);
  const [session, setSession] = useState<boolean | undefined>(sessionAvailable);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [bridgeMissing, setBridgeMissing] = useState(false);

  // One subscription for the panel's whole life, including while hidden: `open` is the
  // message that makes it visible, so unsubscribing on close would make reopening
  // impossible. StrictMode mounts twice; the cleanup below keeps exactly one listener.
  useEffect(() => {
    const bridge = readBridge();

    if (bridge === null) {
      setBridgeMissing(true);
      return;
    }

    let unsubscribe: (() => void) | null = null;

    try {
      unsubscribe = bridge.on(EXPORT_CHANNEL, (payload) => {
        const message = parseMessage(payload);

        if (message === null) return;

        switch (message.kind) {
          case "open":
            setOpen(true);
            setSession(message.sessionAvailable);
            // Reopening resets a finished panel, but must not erase a running export.
            setStatus((current) => (current.kind === "running" ? current : { kind: "idle" }));
            break;
          case "progress": {
            const { phase, done, total } = message;
            setStatus({ kind: "running", phase, done, total });
            break;
          }
          case "done":
            setStatus({ kind: "done", path: message.path, bytes: message.bytes });
            break;
          case "failed":
            setStatus({ kind: "failed", detail: message.detail });
            break;
          case "cancelled":
            setStatus({ kind: "idle" });
            break;
        }
      });
    } catch {
      // `on` throws for a refused channel; the user outcome is the same as a missing bridge.
      setBridgeMissing(true);
      return;
    }

    return () => {
      if (unsubscribe !== null) unsubscribe();
    };
  }, []);

  /** Send one request, turning a refusal or a rejected invoke into a visible failure. */
  const send = (
    request: { kind: "start"; options: DiagnosticsOptions } | { kind: "cancel" },
  ): void => {
    const bridge = readBridge();

    if (bridge === null) {
      setBridgeMissing(true);
      return;
    }
    if (request.kind === "start") {
      setStatus({ kind: "running", phase: "collect", done: 0, total: 0 });
    }

    void bridge
      .invoke(EXPORT_CHANNEL, request)
      .then((reply) => {
        const failure = failureDetailOf(reply, t("error.unexpected"));
        if (failure !== null) setStatus({ kind: "failed", detail: failure });
      })
      .catch((error: unknown) => {
        setStatus({ kind: "failed", detail: detailOf(error) });
      });
  };

  /** Start an export with the two choices as they currently stand. */
  const startExport = (): void =>
    send({
      kind: "start",
      options: { includeSessionContent: sessionContent, includeMinidump: minidump },
    });

  // The terminal `cancelled` event returns the panel to idle; returning early would show "done" for an export that produced no file.
  const cancelExport = (): void => send({ kind: "cancel" });

  /** Hide the panel and tell the caller, which may own more than visibility. */
  const close = (): void => {
    setOpen(false);
    onClose?.();
  };

  const running = status.kind === "running";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t("common.diagnostics.title")}
      footer={
        <>
          {status.kind === "failed" ? (
            <Button variant="primary" onClick={startExport} disabled={bridgeMissing}>
              {t("common.diagnostics.retry")}
            </Button>
          ) : null}
          {running ? (
            <Button variant="secondary" onClick={cancelExport}>
              {t("common.diagnostics.cancel")}
            </Button>
          ) : (
            <Button variant="primary" onClick={startExport} disabled={bridgeMissing}>
              {t("common.diagnostics.export")}
            </Button>
          )}
          <Button variant="secondary" onClick={close}>
            {t("common.diagnostics.close")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--ui-space-4)" }}>
        {bridgeMissing ? (
          <Alert tone="danger">{t("common.diagnostics.bridgeUnavailable")}</Alert>
        ) : null}

        <label style={ROW}>
          <input
            type="checkbox"
            checked={sessionContent}
            disabled={running || bridgeMissing}
            onChange={(event) => setSessionContent(event.target.checked)}
          />
          <span>{t("common.diagnostics.sessionContent")}</span>
        </label>

        <label style={ROW}>
          <input
            type="checkbox"
            checked={minidump}
            disabled={running || bridgeMissing}
            onChange={(event) => setMinidump(event.target.checked)}
          />
          <span>{t("common.diagnostics.minidump")}</span>
        </label>

        {/* `false` is the only value that earns the note. `undefined` means nobody has
            told the panel yet, and inventing a session fact is the one thing it must not do. */}
        {session === false ? (
          <Alert tone="info" title={t("common.diagnostics.noSession")}>
            {t("common.diagnostics.emptySessionNote")}
          </Alert>
        ) : null}

        {status.kind === "running" ? (
          <>
            <p>{phaseLabel(t, status.phase)}</p>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={status.total}
              aria-valuenow={status.done}
              style={TRACK}
            >
              <div style={{ ...FILL, width: `${String(percentOf(status))}%` }} />
            </div>
            <p>{t("common.diagnostics.progress", { done: status.done, total: status.total })}</p>
          </>
        ) : null}

        {status.kind === "done" ? (
          <Alert tone="success">
            {t("common.diagnostics.exported", { path: status.path, size: status.bytes })}
          </Alert>
        ) : null}

        {status.kind === "failed" ? (
          <Alert tone="danger" title={t("common.diagnostics.failed")}>
            {status.detail}
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
