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

import { StrictMode, useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { LayoutDoc, LayoutSnapshotBody, LayoutState } from "@haruyuki/protocol";

import {
  AppFrame,
  LocaleProvider,
  TERMINAL_STYLESHEET,
  TerminalPanel,
  TopBar,
  applyTheme,
  connectTerminalFeed,
  createPageRegistry,
  createTerminalRouter,
  preserveResetTabs,
  registerSamplePages,
  type CommandSender,
  type TerminalRouter,
  type TerminalSignal,
  type ThemeAttrs,
} from "@haruyuki/ui";

import { DEFAULT_LAYOUT } from "./default-layout.js";

import { CrashPage, parseCrashParams } from "./crash-page.js";
import { DiagnosticsPanel } from "./diagnostics-panel.js";
import { BRIDGE_CHANNEL_NAMES, DIAGNOSTICS_CHANNELS } from "../shared/bridge.js";
import { createRendererBridge, type BridgeBoot } from "./bridge.js";
import { terminalNotices } from "./terminal-notices.js";
import { createBridgeFrameSource } from "./terminal-frame-source.js";
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

/**
 * The latest layout the frame should show.
 *
 * A tiny external store rather than React state because the value arrives from
 * the bridge before the frame mounts (and again after every save); a frame that
 * subscribed through props would need the whole Shell to re-render for a
 * revision bump.
 */
let layoutView: { readonly doc: LayoutDoc; readonly revision: number } = {
  doc: DEFAULT_LAYOUT,
  revision: 0,
};
const layoutListeners = new Set<() => void>();

/** Replace the view and wake the frame; identical docs only move the revision. */
function publishLayout(doc: LayoutDoc, revision: number): void {
  layoutView = { doc, revision };
  for (const listener of layoutListeners) listener();
}

/** @param listener called after each layout push @returns unsubscribe */
function subscribeLayout(listener: () => void): () => void {
  layoutListeners.add(listener);

  return () => {
    layoutListeners.delete(listener);
  };
}

/** The page registry is fixed for the app's lifetime; samples stand in for real pages. */
const frameRegistry = createPageRegistry();
registerSamplePages(frameRegistry);

// The bridge is optional: if the preload failed, the page still renders and the
// failure is visible in the console instead of becoming a blank window. A
// missing preload is a D1-level failure, not something D3 should paper over.
const shellBridge = window.haruyuki;

// Notices surface in the panel, one terminal at a time. The two callbacks used to
// be the same `console.info` twice, and only one of them was ever reached: the
// router's `onNotice` fires from `router.notice()`, which nothing calls -- the
// notice arrives on `bridge:stream.terminal.notice` and `createRendererBridge`
// reads it there. So the router keeps a callback that is delivered to the panel,
// and the bridge's callback is the one that renders.
const notices = terminalNotices;

/**
 * The command layer's stand-in, until the engine side exists.
 *
 * Every terminal command answers `not-implemented`, and that is the point: the
 * panel has three distinguishable failures, and this is the one that says "this
 * build cannot do it" rather than "the connection failed, try again". A stub that
 * answered `channel-unavailable` would tell the user to wait for a reconnect that
 * will never bring the feature; one that resolved `sent` would let the panel claim
 * a session it does not have. Returning the honest one means the Reopen button
 * renders "not available yet", which is a true sentence about this build.
 *
 * `detail` names the missing capability rather than apologising, so a field report
 * says which channel to look for.
 *
 * @param command the command that was attempted
 * @returns a failure that says the capability does not exist here
 */
async function sendUnavailable(command: {
  readonly name: string;
}): Promise<{ ok: false; reason: "not-implemented"; detail: string }> {
  return {
    ok: false,
    reason: "not-implemented",
    detail: `the command channel for ${command.name} is not wired in this build`,
  };
}

/** Bound to the panel's contract, so the stub's shape is checked at the call site. */
const send: CommandSender = sendUnavailable;

/**
 * Hand the panel the frames it cannot poll for.
 *
 * Until this existed the panel's subscription had one implementation: the one its
 * test wrote. A terminal therefore reached `running` only in that test, and the
 * comment above the panel's effect -- "engine frames are the only evidence a
 * session exists, so the panel subscribes" -- described a behaviour the shipped
 * code did not have. The chain is now: a deliver channel fires, the adapter reads
 * `{ t, body }`, the feed translates it with `signalFromFrame`, and the panel's own
 * `dispatch` reduces it.
 *
 * No lifecycle half: `bridge.ready` is a frame this renderer sends (c2s), so there
 * is no readiness event to subscribe to, and `engineReady` above is `false` for
 * the same reason. That gap is recorded rather than papered over with a callback
 * that cannot fire.
 *
 * @param receive the panel's dispatch, called once per translated signal
 * @returns a function that unsubscribes
 */
function subscribeToFrames(receive: (signal: TerminalSignal) => void): () => void {
  // Absent when the preload failed. The panel then has no frames and stays idle,
  // which is the truth -- the same reason the whole bridge block above is guarded.
  if (shellBridge === undefined) return () => {};

  const connected = connectTerminalFeed(createBridgeFrameSource(shellBridge), { receive });

  return () => {
    connected.dispose();
  };
}

/**
 * The router this session's output arrives on, or `null` when the preload failed.
 *
 * Module scope rather than inside the block below because the panel needs it as a
 * prop, and the panel is a component: passing it down from a block-scoped local
 * would make the sink's registration depend on render order. `null` rather than
 * `undefined` so the panel's `router` prop stays a value a host may omit.
 */
const terminalRouter: TerminalRouter | null =
  shellBridge === undefined
    ? null
    : createTerminalRouter({
        ack: (ack) => {
          void shellBridge
            .invoke(BRIDGE_CHANNEL_NAMES.terminalAck, ack)
            .catch((error: unknown) => console.error("terminal ack failed", error));
        },
        // Kept because the router calls it whenever a slice is dropped for a terminal
        // that has no sink. Forwarding it to the same notice surface means a future
        // producer of this callback needs no second wiring; today nothing calls
        // `router.notice()`, so this arm is a seam rather than a live path.
        onNotice: (notice) => notices.publish(notice),
      });

if (shellBridge !== undefined && terminalRouter !== null) {
  createRendererBridge({
    bridge: shellBridge,
    boot: boot.bridge,
    terminal: terminalRouter,
    onNotice: (notice) => notices.publish(notice),
    onReadyError: (error) => console.error("bridge ready failed", error),
    onLayoutSnapshot: (body: LayoutSnapshotBody) => {
      const doc = body.items[0];

      if (doc !== undefined) publishLayout(doc, body.revision);
    },
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
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.haruyuki;

    if (bridge === undefined) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const off = bridge.on(RUNTIME_FAILED_CHANNEL, (payload) => {
      const next = asRuntimeFailure(payload);

      if (next !== null) {
        setNotice(null);
        setFailure(next);
      }
    });

    const poll = (): void => {
      void bridge
        .invoke(RUNTIME_STATUS_CHANNEL)
        .then((value) => {
          if (cancelled) return;

          const status = value as RuntimeStatus | undefined;

          if (status?.phase === "failed") {
            setNotice(null);
            setFailure(status.failure);
            return;
          }

          if (status?.phase === "ready") {
            setNotice(status.externalNotice ?? null);
            return;
          }

          timer = setTimeout(poll, 1_000);
        })
        .catch(() => {
          // The status handler is registered after the full tree check; the
          // first invocation can therefore race it. Retry until it exists.
          if (!cancelled) timer = setTimeout(poll, 1_000);
        });
    };

    poll();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      off();
    };
  }, []);

  if (failure !== null) return <RuntimeFailureView failure={failure} setFailure={setFailure} />;

  return (
    <>
      {notice !== null ? (
        <p role="status" style={{ margin: "8px 16px" }}>
          {notice}
        </p>
      ) : null}
      {children}
    </>
  );
}

/** The error page with its four channel-backed actions. */
function RuntimeFailureView({
  failure,
  setFailure,
}: {
  failure: RuntimeFailure;
  setFailure: (failure: RuntimeFailure | null) => void;
}): ReactElement {
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
  const layout = useSyncExternalStore(subscribeLayout, () => layoutView);

  useEffect(() => {
    if (shellBridge === undefined) return;

    void shellBridge
      .invoke(BRIDGE_CHANNEL_NAMES.layoutState)
      .then((value) => {
        const state = value as LayoutState | undefined;

        if (state !== undefined && state.doc !== undefined)
          publishLayout(state.doc, state.revision);
      })
      .catch((error: unknown) => console.error("layout state failed", error));
  }, []);

  const saveLayout = (doc: LayoutDoc): void => {
    if (shellBridge === undefined) return;

    void shellBridge
      .invoke(BRIDGE_CHANNEL_NAMES.layoutSave, {
        baseRevision: layoutView.revision,
        doc,
      })
      .then((value) => {
        const ack = value as { ok?: boolean; revision?: number } | undefined;

        if (ack?.ok === true && typeof ack.revision === "number") {
          // Keep the document identity: only the revision moved, so the frame
          // must not re-apply its own save.
          publishLayout(layoutView.doc, ack.revision);
        }
      })
      .catch((error: unknown) => console.error("layout save failed", error));
  };

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
              <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
                <TopBar
                  version={boot.bridge.appVersion}
                  hasSettings={frameRegistry.get("settings") !== undefined}
                  hasUpdates={false}
                  onExportDiagnostics={() => {
                    if (shellBridge === undefined) return;

                    void shellBridge
                      .invoke(DIAGNOSTICS_CHANNELS.export, {
                        kind: "open",
                        sessionAvailable: false,
                      })
                      .catch((error: unknown) => console.error("diagnostics open failed", error));
                  }}
                  onResetLayout={() => {
                    publishLayout(DEFAULT_LAYOUT, layoutView.revision);
                    saveLayout(DEFAULT_LAYOUT);
                  }}
                />
                <AppFrame
                  registry={frameRegistry}
                  doc={layout.doc}
                  revision={layout.revision}
                  onLayoutChange={saveLayout}
                />
              </div>
              {/*
               * The terminal panel, mounted on the default route so a session has a
               * surface. Three of its inputs are honest placeholders, because the
               * things that would fill them live in another package:
               *
               *   - `send` is a stub that answers `not-implemented` for every
               *     command. The four terminal command channels
               *     (`terminal.spawn`/`input`/`resize`/`kill`) are not in the
               *     preload's allowlist; they belong to the engine command layer.
               *     The stub is not a fallback that pretends to work: the panel
               *     renders the third failure state, so the user reads "this is
               *     not available yet" instead of pressing a button that does
               *     nothing.
               *   - `engineReady` is `false`. The bridge reports a ready *frame it
               *     sends*, not a readiness it is told about, so there is no
               *     signal to read -- and "not ready" is the safe default: the
               *     opposite guess enables a Reopen button that would do nothing.
               *   - `terminalId` is a placeholder. The real id is chosen when the
               *     command layer spawns the session, because the engine echoes
               *     back the id it was given; generating one here would be a
               *     second answer to "which terminal is this".
               */}
              <TerminalPanel
                terminalId="renderer-terminal"
                css={TERMINAL_STYLESHEET}
                send={send}
                engineReady={false}
                subscribe={subscribeToFrames}
                {...(terminalRouter === null ? {} : { router: terminalRouter })}
              />
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
