/**
 * The terminal page: the dock frame's entry for one shell session.
 *
 * Why the page is a thin adapter
 *   The panel, the phase machine and the four commands belong to the terminal
 *   layer; this file only joins them to the shell's transport. It supplies the
 *   bridge-backed sender, the frame subscription and the readiness flag, and it
 *   gives each dock tab its own stable terminal id. None of those decisions
 *   belong in the panel, which has to stay mountable without a preload.
 *
 * Why the wiring is module scope
 *   A page definition is a component reference the registry holds for the app's
 *   lifetime, and the layout document cannot carry functions. The shell therefore
 *   installs its transport once, before the first render, and every terminal tab
 *   reads it. The terminal id is the tab's instance id: two tabs of the same page
 *   are two sessions, and reopening a tab reuses the id the engine already knows.
 *
 * Why there is a placeholder instead of throwing
 *   The page can be registered before the shell has finished wiring (a test, or a
 *   direct load with no preload). A missing bridge is a state the user can read,
 *   not an import-time crash that takes the whole window down.
 */

import { useSyncExternalStore, type ReactElement } from "react";

import {
  TERMINAL_STYLESHEET,
  TerminalPanel,
  useT,
  type CommandSender,
  type PageDefinition,
  type PageInstanceProps,
  type TerminalRouter,
  type TerminalSignal,
} from "@haruyuki/ui";

/** What the shell supplies once, before the frame mounts. */
export interface TerminalPageWiring {
  /** The terminal command sender, backed by the bridge's command channel. */
  readonly send: CommandSender;
  /** The router `createRendererBridge` already delivers output through, if any. */
  readonly router: TerminalRouter | null;
  /** Registers a receiver for terminal frames; the return value unsubscribes. */
  readonly subscribe: (receive: (signal: TerminalSignal) => void) => () => void;
  /** Whether the bridge handshake has been accepted. */
  readonly isReady: () => boolean;
  /** Observe readiness changes. */
  readonly subscribeReady: (listener: () => void) => () => void;
}

let wiring: TerminalPageWiring | null = null;

/**
 * Install the transport every terminal tab shares.
 *
 * Called by the renderer entry before `createRoot`. A second call replaces the
 * wiring rather than merging it: there is one shell per renderer, and a merge
 * would leave a stale sender reachable.
 *
 * @param next the bridge-backed transport
 */
export function wireTerminalPage(next: TerminalPageWiring): void {
  wiring = next;
}

/** The readiness a panel starts from before the store has been read. */
const NEVER_READY = (): boolean => false;

/** The subscription used when no shell has wired the page. */
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/**
 * Render one terminal tab.
 *
 * `instanceId` is the tab id, which is stable for the life of the tab and unique
 * among tabs; using it as the engine's `terminal_id` keeps the panel's sink and
 * the engine's session keyed by the same value without the panel inventing one.
 *
 * @param props the page instance contract
 * @returns the panel, or a readable placeholder when no bridge is available
 */
function TerminalPage({ instanceId }: PageInstanceProps): ReactElement {
  const t = useT();
  const current = wiring;
  const ready = useSyncExternalStore(
    current?.subscribeReady ?? NO_SUBSCRIPTION,
    current?.isReady ?? NEVER_READY,
    NEVER_READY,
  );

  if (current === null) {
    return (
      <section
        className="hz-terminal-page hz-terminal-page--unwired"
        aria-label={t("page.terminal.title")}
      >
        <p>{t("page.terminal.unavailable")}</p>
      </section>
    );
  }

  return (
    <section className="hz-terminal-page" aria-label={t("page.terminal.title")}>
      <TerminalPanel
        terminalId={instanceId}
        css={TERMINAL_STYLESHEET}
        send={current.send}
        engineReady={ready}
        autoStart
        subscribe={current.subscribe}
        {...(current.router === null ? {} : { router: current.router })}
      />
    </section>
  );
}

/** Registration for the terminal page. */
export const terminalPage: PageDefinition = {
  id: "terminal",
  titleKey: "page.terminal.title",
  icon: "refresh",
  zone: "main",
  minWidth: 480,
  component: TerminalPage,
};
