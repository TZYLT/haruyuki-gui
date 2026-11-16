/**
 * The renderer entry.
 *
 * Mounts the sample page, applying the theme and locale the main process resolved.
 *
 * Why this is the sample page and not a real shell surface: D1's job is the shell, and
 * the requirement says so explicitly (`D1-Q01`). What has to be proven is that a page
 * built from `packages/ui` renders inside the sandboxed renderer under the real CSP.
 * The sample page is the fixture for that proof; it is replaced when E1 builds the
 * page framework, not by D1 growing a second one.
 *
 * Both values arrive in the URL the main process loaded, rather than being read here.
 * The renderer has no `process` (sandboxed, `contextIsolation: true`) and no access to
 * the settings file, so a renderer that decided its own theme would be a second source
 * of truth for a value the main process also needs for the window's background.
 */

import { StrictMode, useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { LocaleProvider, applyTheme, createTerminalRouter, type ThemeAttrs } from "@haruyuki/ui";
import { SamplePage } from "@haruyuki/ui/examples";

import { CrashPage, parseCrashParams } from "./crash-page.js";
import { DiagnosticsPanel } from "./diagnostics-panel.js";
import { BRIDGE_CHANNEL_NAMES } from "../shared/bridge.js";
import { createRendererBridge, type BridgeBoot } from "./bridge.js";
import { ErrorBoundary, RendererErrorPage } from "./error-page.js";
import { RuntimeErrorPage } from "./runtime-error.js";
import {
  RUNTIME_FAILED_CHANNEL,
  RUNTIME_LOG_CHANNEL,
  RUNTIME_PICK_CHANNEL,
  RUNTIME_RESET_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
  type RuntimePickResult,
  type RuntimeResetResult,
} from "../shared/runtime-channels.js";
import type { RuntimeFailure, RuntimeLogResult, RuntimeStatus } from "../shared/runtime.js";

/**
 * What the preload exposes.
 *
 * Declared rather than imported: the preload is plain JavaScript with no module graph
 * the renderer can see, and `apps/desktop` deliberately does not depend on Electron's
 * types from the renderer side. Only the members the renderer uses are named.
 */
interface ShellBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
  readonly channelAllowlist: readonly string[];
}

declare global {
  interface Window {
    /** The preload's exposed surface. Absent if the preload failed to load. */
    haruyuki?: ShellBridge;
  }
}

/**
 * Read the boot parameters from the loaded URL.
 *
 * A query string rather than an injected `<script>`: the CSP forbids inline script, and
 * a preload-injected global would make the renderer depend on the bridge for something
 * as basic as which theme to paint -- so a preload regression would blank the page
 * instead of only disabling IPC.
 *
 * Every value is validated here. The URL is not secret, and a malformed one must
 * produce the default page rather than an exception before the first render.
 *
 * `panel` and `crash` are the routes. They are query parameters rather than something
 * main sets, because a direct load of `?panel=diagnostics` or `?crash=engine` is how
 * each surface is exercised without a real crash -- and because main's URL builder is
 * shared machinery this work does not need to grow a second parameter into.
 *
 * `crash` is narrowed to the kind alone; the details are parsed by the page, so the
 * validation lives in one place (`parseCrashParams`). An unknown `crash` value is not
 * a route: the shell shows its normal page rather than a page it cannot describe.
 */
function bootPayload(): {
  theme: ThemeAttrs;
  locale: string;
  panel: "diagnostics" | null;
  crash: "engine" | "renderer" | null;
  bridge: BridgeBoot;
} {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("theme") === "dark" ? "dark" : "light";
  const contrast = params.get("contrast") === "high" ? "high" : "normal";
  const requested = params.get("locale");
  const crash = parseCrashParams(window.location.search);
  const appVersion = params.get("appVersion");
  const bridgeVersion = params.get("bridgeVersion");
  const frameProtocolVersion = Number(params.get("frameProtocolVersion") ?? "1");

  return {
    theme: { mode, contrast },
    locale: requested !== null && requested !== "" ? requested : "en",
    panel: params.get("panel") === "diagnostics" ? "diagnostics" : null,
    crash: crash === null ? null : crash.kind,
    bridge: {
      appVersion: appVersion !== null && appVersion !== "" ? appVersion : "0.0.0",
      bridgeVersion: bridgeVersion !== null && bridgeVersion !== "" ? bridgeVersion : "1",
      frameProtocolVersion: Number.isFinite(frameProtocolVersion) ? frameProtocolVersion : 1,
    },
  };
}

const container = document.getElementById("root");

if (container === null) {
  throw new Error("the renderer document needs a #root element");
}

const boot = bootPayload();

// Before the first paint, so the page never flashes the wrong theme.
applyTheme(boot.theme);

// The bridge is optional: if the preload failed, the page still renders and the
// failure is visible in the console instead of becoming a blank window. A
// missing preload is a D1-level failure, not something D3 should paper over.
const shellBridge = window.haruyuki;

if (shellBridge !== undefined) {
  const terminalRouter = createTerminalRouter({
    ack: (ack) => {
      void shellBridge
        .invoke(BRIDGE_CHANNEL_NAMES.terminalAck, ack)
        .catch((error: unknown) => console.error("terminal ack failed", error));
    },
    onNotice: (notice) => {
      // D3 has no visible notice surface; E3 renders the marker. The console is
      // the seam until then, so a dropped terminal slice is still observable.
      console.info("terminal notice", notice.terminal_id, notice.droppedBytes);
    },
  });

  createRendererBridge({
    bridge: shellBridge,
    boot: boot.bridge,
    terminal: terminalRouter,
    onNotice: (notice) => console.info("terminal notice", notice.terminal_id, notice.droppedBytes),
    onReadyError: (error) => console.error("bridge ready failed", error),
  });
}

/**
 * Show the runtime error page when the engine could not start, without
 * unmounting the providers above it.
 *
 * The failed push can arrive before this component mounts; the status request on
 * mount covers that race. The reverse (a failure arriving twice) is harmless:
 * setting the same failure again renders the same page.
 *
 * @param props the routed children
 * @returns the error page, or the children
 */
function RuntimeGate({ children }: { children: ReactElement }): ReactElement {
  const [failure, setFailure] = useState<RuntimeFailure | null>(null);

  useEffect(() => {
    const bridge = window.haruyuki;

    if (bridge === undefined) return;

    const off = bridge.on(RUNTIME_FAILED_CHANNEL, (payload) => {
      const next = asRuntimeFailure(payload);

      if (next !== null) setFailure(next);
    });

    void bridge
      .invoke(RUNTIME_STATUS_CHANNEL)
      .then((value) => {
        const status = value as RuntimeStatus | undefined;

        if (status?.phase === "failed") setFailure(status.failure);
      })
      .catch(() => undefined);

    return off;
  }, []);

  if (failure === null) return children;

  return (
    <RuntimeErrorPage
      failure={failure}
      onPick={() => {
        void pickRuntimeEngine(setFailure);
      }}
      onUseBundled={() => {
        void resetRuntimeEngine(setFailure);
      }}
      onOpenLog={async () => {
        const bridge = window.haruyuki;

        if (bridge === undefined) return { ok: false, detail: "The bridge is unavailable." };

        const result = await bridge.invoke(RUNTIME_LOG_CHANNEL);

        return isRuntimeLogResult(result)
          ? result
          : { ok: false, detail: "The log channel returned an unexpected response." };
      }}
    />
  );
}

/** Pick a directory and clear the page only when the engine actually restarted. */
async function pickRuntimeEngine(
  setFailure: (failure: RuntimeFailure | null) => void,
): Promise<void> {
  const bridge = window.haruyuki;

  if (bridge === undefined) return;

  const result = (await bridge.invoke(RUNTIME_PICK_CHANNEL)) as RuntimePickResult | undefined;

  if (result?.ok === true) {
    setFailure(null);
    return;
  }

  if (result !== undefined && result.ok === false) {
    setFailure({
      kind: result.failureKind,
      detail: result.detail ?? "The selected engine could not be used.",
    });
  }
}

/** Clear the external pick and return to the bundled engine. */
async function resetRuntimeEngine(
  setFailure: (failure: RuntimeFailure | null) => void,
): Promise<void> {
  const bridge = window.haruyuki;

  if (bridge === undefined) return;

  const result = (await bridge.invoke(RUNTIME_RESET_CHANNEL)) as RuntimeResetResult | undefined;

  if (result?.ok === true) {
    setFailure(null);
    return;
  }

  setFailure({
    kind: "start-failed",
    detail: result?.detail ?? "The bundled engine could not be started.",
  });
}

/** Validate a pushed failure instead of trusting a channel payload. */
function asRuntimeFailure(value: unknown): RuntimeFailure | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as Record<string, unknown>;
  const kind = candidate["kind"];
  const detail = candidate["detail"];

  if (
    kind !== "missing-bundle" &&
    kind !== "entry-mismatch" &&
    kind !== "tree-mismatch" &&
    kind !== "external-invalid" &&
    kind !== "start-failed"
  ) {
    return null;
  }

  if (typeof detail !== "string") return null;

  return {
    kind,
    detail,
    ...(typeof candidate["engineDir"] === "string" ? { engineDir: candidate["engineDir"] } : {}),
    ...(typeof candidate["expectedSha256"] === "string"
      ? { expectedSha256: candidate["expectedSha256"] }
      : {}),
    ...(typeof candidate["actualSha256"] === "string"
      ? { actualSha256: candidate["actualSha256"] }
      : {}),
    ...(typeof candidate["logPath"] === "string" ? { logPath: candidate["logPath"] } : {}),
  };
}

/** Validate the log result's two possible shapes. */
function isRuntimeLogResult(value: unknown): value is RuntimeLogResult {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;

  if (candidate["ok"] === true) return true;
  if (candidate["ok"] === false) {
    return candidate["detail"] === undefined || typeof candidate["detail"] === "string";
  }

  return false;
}

/**
 * The mounted shell.
 *
 * Three routes: the sample page proves the component library renders inside the
 * sandbox, the diagnostics panel is the first real surface, and the crash page is
 * what main reloads the window into when a process dies. All sit under the same
 * providers so a route cannot quietly opt out of the theme or the catalogue.
 *
 * The crash route also mounts the panel hidden: its export button sends `open` on the
 * same channel the menu uses, so the panel has to be listening before the user clicks.
 *
 * @returns the routed page inside its providers
 */
function Shell(): ReactElement {
  const [locale] = useState(boot.locale);

  // The document's own `lang` follows the resolved locale: a screen reader picks its
  // voice from this attribute, and a page that says `en` while showing Chinese is read
  // aloud in the wrong language.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <LocaleProvider locale={locale}>
      <ErrorBoundary
        fallback={(error, reset) => <RendererErrorPage error={error} onRetry={reset} />}
      >
        <RuntimeGate>
          {boot.crash !== null ? (
            <>
              <CrashPage />
              <DiagnosticsPanel initialOpen={false} />
            </>
          ) : boot.panel === "diagnostics" ? (
            <DiagnosticsPanel initialOpen />
          ) : (
            <>
              <SamplePage locale={locale} />
              {/*
               * Mounted hidden on the default route so the menu's `open` message has a
               * listener without reloading the page. The panel renders nothing until
               * that message arrives (`initialOpen` is false).
               */}
              <DiagnosticsPanel initialOpen={false} />
            </>
          )}
        </RuntimeGate>
      </ErrorBoundary>
    </LocaleProvider>
  );
}

createRoot(container).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
