/**
 * The host-side replay point: one `boot` per return to visibility.
 *
 * A panel that is switched away from and back is still the same document with
 * the same JavaScript context, but it is no longer a document anyone was
 * refreshing. The core keeps emitting frames the whole time, and the webview
 * keeps its own last-seen cursors, so a return to visibility that said nothing
 * would leave the screen showing whatever the panel last rendered before the
 * user left. This module is the one place that answers for that: when the panel
 * becomes visible again it re-announces itself, the webview answers with a fresh
 * `ready`, and the core answers that with a full snapshot.
 *
 * What triggers a replay, and what cannot
 *   Only the host can see a panel being hidden. Inside the webview
 *   `document.visibilityState` stays `"visible"` and `visibilitychange` never
 *   fires -- measured in a real extension host -- so a panel-side listener would
 *   silently never run. `WebviewPanel.onDidChangeViewState` is therefore the
 *   only source for this transition, and it is the source this module uses.
 *
 *   `onDidDispose` is not part of it: hiding a panel with
 *   `retainContextWhenHidden` neither disposes it nor tears down its document,
 *   so a replay must not be confused with a rebuild.
 *
 * Exactly once per transition
 *   The event fires for more than a hide and a show: an active tab switch inside
 *   the same group reports `active` changes with `visible` unchanged. The
 *   previous value is kept here, so a notification that does not cross the
 *   hidden/visible boundary sends nothing, and the hidden-to-visible edge sends
 *   exactly one `boot`. Nothing is coalesced, delayed or retried.
 *
 * What is deliberately absent: a queue for the hidden period
 *   Frames the core emits while the panel is hidden are dropped, not buffered.
 *   Buffering them would be a second session store: it would have to answer how
 *   long to keep them, what to do when the panel never returns, and how a
 *   replay interacts with a backlog that is already stale. A replay asks for a
 *   fresh snapshot instead, which is always the current truth and bounded by the
 *   snapshot pager rather than by how long the user was away.
 *
 * This module owns the visibility edge only
 *   `boot` in, and the panel's `ready` back. Frames and command replies are the
 *   other direction's business and live in `command-path.ts`; the two meet in
 *   the composition root that creates one outbox and hands it to both.
 */

/**
 * The `boot` message this module posts.
 *
 * Declared structurally, like the panel below: the host half binds the VSCode
 * API, and a module that imports it can only be tested by launching an editor.
 * The webview's own reader is the authority on this shape.
 */ export interface BootMessage {
  readonly kind: "boot";
  readonly appVersion: string;
  readonly bridgeVersion: string;
  readonly frameProtocolVersion: number;
}

/** One visibility notification, as much of it as this module reads. */
export interface ViewStateEvent {
  readonly webviewPanel: { readonly visible: boolean };
}

/**
 * The parts of a `WebviewPanel` this module touches.
 *
 * `postMessage` is typed `unknown` on purpose: the real one returns a thenable
 * that answers `true` even for a hidden panel (measured), so a caller cannot
 * learn anything from it that would change this module's decision -- and a
 * type that promises a thenable would make the test double stricter than the
 * behaviour worth testing.
 */
export interface WebviewPanelLike {
  readonly visible: boolean;
  readonly webview: { postMessage(message: unknown): unknown };
  onDidChangeViewState(listener: (event: ViewStateEvent) => void): { dispose(): void };
}

/** Diagnostic sink: codes and counters, never a message body. */
export type FramePathLog = (code: string, detail?: Record<string, unknown>) => void;

/** What the composition root injects. */
export interface FramePathOptions {
  /** Version of this shell, reported in `boot`; diagnostic only. */
  readonly appVersion: string;
  /** The bridge protocol version the core expects. */
  readonly bridgeVersion: string;
  /** The frame envelope version the core serializes. */
  readonly frameProtocolVersion: number;
  /** Reported in `boot` and used by the panel to build its receiver. */
  readonly log?: FramePathLog;
}

/** The handle the composition root keeps for the visibility edge. */
export interface FramePath {
  /** Replays performed so far: one per hidden-to-visible transition. */
  readonly replayed: number;
  /** Whether the panel is visible as far as this module last observed. */
  readonly visible: boolean;
  /**
   * Post one `boot` now.
   *
   * The composition root calls this once when it creates the panel: a fresh
   * document needs the version facts as much as a returning one does. It is
   * separate from the visible edge so the edge stays exactly one announcement.
   *
   * @returns whether the message was handed to the panel
   */
  announce(): boolean;
  /** Drop the visibility subscription. Idempotent. */
  dispose(): void;
}

/** The message family this module writes, for the composition root's type. */
export type FramePathMessage = BootMessage;
/**
 * Watch one panel's visibility and re-announce on every return.
 *
 * @param panel the panel whose document this module speaks to
 * @param options the version facts and the diagnostic sink
 * @returns the edge, subscribed immediately
 */
export function createFramePath(panel: WebviewPanelLike, options: FramePathOptions): FramePath {
  const log = options.log ?? ((): void => undefined);

  let visible = panel.visible;
  let replayed = 0;
  let disposed = false;

  /**
   * Post one boot message to the panel.
   *
   * @returns whether it was handed over without throwing
   */
  function post(): boolean {
    const message: BootMessage = {
      kind: "boot",
      appVersion: options.appVersion,
      bridgeVersion: options.bridgeVersion,
      frameProtocolVersion: options.frameProtocolVersion,
    };

    try {
      panel.webview.postMessage(message);

      return true;
    } catch {
      // A disposed panel refuses the message; there is nothing to retry, and a
      // retry loop would deliver a second boot for one transition.
      log("HOST_BOOT_POST_FAILED", {});

      return false;
    }
  }

  let subscription: { dispose(): void } | null = null;

  try {
    subscription = panel.onDidChangeViewState((event) => {
      if (disposed) return;

      const next = event.webviewPanel.visible;

      // An active-tab change inside the same group reports the event with
      // `visible` unchanged. Only the boundary itself is a replay.
      if (next === visible) return;

      visible = next;

      // Going away: no queue, no timers, nothing to do. The return is the edge
      // this module exists for.
      if (!next) return;

      replayed += 1;

      if (!post()) log("HOST_BOOT_REPLAY_FAILED", { replayed });
    });
  } catch {
    // A panel that has no view-state event is a panel that never replays; the
    // initial announce below still gives it the version facts.
    log("HOST_VIEW_STATE_SUBSCRIBE_FAILED", {});
  }

  return {
    get replayed(): number {
      return replayed;
    },
    get visible(): boolean {
      return visible;
    },
    announce: post,
    dispose(): void {
      if (disposed) return;

      disposed = true;

      const current = subscription;
      subscription = null;

      try {
        current?.dispose();
      } catch {
        log("HOST_VIEW_STATE_UNSUBSCRIBE_FAILED", {});
      }
    },
  };
}
