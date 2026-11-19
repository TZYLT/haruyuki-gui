/**
 * The webview's transport seam: the bridge, the window listener, and the layout
 * store React reads.
 *
 * The panel has four moving parts and this module is where they meet:
 *
 * - {@link createWebviewBridge} owns the message vocabulary and the version
 *   guard. It does not know how messages arrive, which keeps it testable
 *   without a window.
 * - The `window` `message` listener is the only inbound edge a webview has. It
 *   is attached once per session and every payload is handed straight to the
 *   bridge, unvalidated: the bridge is the one place that decides what a
 *   message is.
 * - The terminal router batches acknowledgements for rendered bytes. It sits
 *   here rather than in the bridge because batching is a rendering policy (one
 *   ack per 32 KiB plus a 16 ms deadline), while the bridge only knows how to
 *   write one message on the wire.
 * - The layout document is an external store rather than React state. The frame
 *   needs a synchronous read (it compares the document it was handed against
 *   the one it applied) and it must never miss a change that lands between a
 *   render and its effect, which is exactly the contract
 *   `useSyncExternalStore` provides and `useState` plus an effect does not.
 *
 * Why the document stays in memory in this build
 *   Writing it back needs a save request on the host, and this wave does not
 *   carry one: the message family between the panel and the extension host is
 *   `boot`/`frame`/`command.reply`/`status` in, and
 *   `ready`/`command.invoke`/`terminal.ack`/`action` out. So a drag inside the
 *   dock updates this store and nothing else, and a reload of the panel returns
 *   to the default document. That is the honest state of the wiring rather than
 *   an omission: a save no host answers would look like persistence and lose the
 *   user's arrangement at the next restart instead of at the next reload.
 *
 * Why the revision is local
 *   The frame treats a `doc` prop as foreign until it is told something changed,
 *   so it needs a counter, and the document's own version field cannot serve as
 *   one (two documents can share it). The revision therefore only ever moves
 *   inside this module, incremented by the one call that replaces the document.
 */

import { useSyncExternalStore } from "react";
import type { LayoutDoc } from "@haruyuki/protocol";

import {
  createTerminalRouter,
  useT,
  type BannerProps,
  type TermOutputBody,
  type TerminalNotice,
} from "@haruyuki/ui";

import {
  BRIDGE_VERSION_MISMATCH,
  createWebviewBridge,
  type BridgeSnapshot,
  type WebviewBridge,
  type VsCodeApi,
} from "./bridge.js";
import { faultOf, type ShellFaultAction, type FaultInput } from "./errors/fault.js";
import { applyLayoutChange, readLayout } from "./layout.js";

/** The layout document plus the revision the frame compares against. */
export interface LayoutState {
  readonly doc: LayoutDoc;
  readonly revision: number;
}

/** The store the frame reads; every member is stable for the store's lifetime. */
export interface LayoutStore {
  /**
   * Read the current state.
   *
   * The returned object is stable: two calls with no intervening change return
   * the same reference, which is what `useSyncExternalStore` requires.
   *
   * @returns the current document and revision
   */
  getSnapshot(): LayoutState;

  /**
   * Observe changes.
   *
   * @param listener called synchronously after a change
   * @returns a function that removes this listener; calling it twice is safe
   */
  subscribe(listener: () => void): () => void;

  /**
   * Replace the document the frame produced.
   *
   * The document identity is kept, because the frame compares it by reference:
   * `applyLayoutChange` hands the same object back for exactly that reason.
   *
   * @param doc the document from the frame's `onLayoutChange`
   */
  setDoc(doc: LayoutDoc): void;
}

/**
 * Build the layout store over the document already in memory.
 *
 * @returns a store whose first read is the document this panel is showing
 */
export function createLayoutStore(): LayoutStore {
  let state: LayoutState = { doc: readLayout(), revision: 0 };

  const listeners = new Set<() => void>();

  return {
    getSnapshot(): LayoutState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);

      let subscribed = true;

      return () => {
        if (!subscribed) return;

        subscribed = false;
        listeners.delete(listener);
      };
    },

    setDoc(doc: LayoutDoc): void {
      // Memory first, then a fresh state object: the store's identity rule is
      // about the state object, not about the document, so a change always
      // publishes a new reference while the document keeps its own identity for
      // the frame to compare against.
      applyLayoutChange(doc);
      state = { doc, revision: state.revision + 1 };

      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // One consumer's bug must not skip the rest; there is no log here.
        }
      }
    },
  };
}

/** What a caller may observe about the session the transport owns. */
export interface WebviewTransport {
  readonly bridge: WebviewBridge;
  readonly layout: LayoutStore;
  /**
   * Attach the view that renders one terminal.
   *
   * Terminal bytes are handed to it by the router; they never become React
   * state. Registering the same terminal again replaces the view.
   *
   * @param terminalId the terminal a view renders
   * @param write the emulator's own `write(text, done)`
   * @returns a function that detaches the view and drops its queued bytes
   */
  registerTerminal(terminalId: string, write: TerminalWrite): () => void;
  /** Counters for the terminal path, read-only. */
  readonly terminalStats: { readonly delivered: number; readonly noSink: number };
  /** Stop listening to the host and release every timer. Idempotent. */
  dispose(): void;
}

/** The one ability a terminal view has to offer. */
export type TerminalWrite = (text: string, done: () => void) => void;

/** Options a caller may inject; the last two exist for a test's timing. */
export interface WebviewTransportOptions {
  /** The page handle; omitted means "resolve the host global". */
  readonly api?: VsCodeApi | null;
  /** The object the listener is attached to. Defaults to the current `window`. */
  readonly events?: Pick<Window, "addEventListener" | "removeEventListener">;
  /** Where a dropped-bytes notice goes; omitted means "not shown". */
  readonly onNotice?: (notice: TerminalNotice) => void;
}

/**
 * Build one transport session.
 *
 * The listener is attached immediately, so a `boot` the host posts while this
 * module is still evaluating is not lost: a webview has no way to ask for a
 * replay except the visibility change the host already owns.
 *
 * @param options the injected page handle, event target and notice sink
 * @returns the transport, listening
 */
export function createTransport(options: WebviewTransportOptions = {}): WebviewTransport {
  const layout = createLayoutStore();
  const events = options.events ?? window;

  const router = createTerminalRouter({
    ack: (ack) => {
      bridge.ackTerminal(ack);
    },
    onNotice: (notice) => {
      options.onNotice?.(notice);
    },
  });

  const bridge = createWebviewBridge({
    ...(options.api === undefined ? {} : { api: options.api }),
    onTerminal: (slice) => {
      router.deliver(slice as TermOutputBody);
    },
  });

  const onMessage = (event: MessageEvent): void => {
    bridge.receive(event.data);
  };

  events.addEventListener("message", onMessage);

  let disposed = false;

  return {
    bridge,
    layout,

    registerTerminal(terminalId: string, write: TerminalWrite): () => void {
      return router.register(terminalId, { write });
    },

    get terminalStats(): { readonly delivered: number; readonly noSink: number } {
      const stats = router.stats;

      return { delivered: stats.delivered, noSink: stats.noSink };
    },

    dispose(): void {
      if (disposed) return;

      disposed = true;
      events.removeEventListener("message", onMessage);
      router.dispose();
      bridge.dispose();
    },
  };
}

/** Built on the first request; `null` until then so a failure is not cached. */
let transport: WebviewTransport | null = null;

/**
 * The transport every consumer in this webview shares.
 *
 * One per panel session: the store, the terminal views and the handshake verdict
 * all describe one page, so a second instance would be a second page's worth of
 * state with no page to show it.
 *
 * @returns the listening transport
 */
export function webviewTransport(): WebviewTransport {
  transport ??= createTransport();

  return transport;
}

/**
 * Read the layout document in a component.
 *
 * The third argument keeps a server-rendered or hydrating tree from throwing:
 * the document is plain data with no browser-only source, so the server read is
 * the same read.
 *
 * @returns the document and the revision the frame compares against
 */
export function useLayout(): LayoutState {
  const store = webviewTransport().layout;

  return useSyncExternalStore<LayoutState>(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Read the bridge verdict in a component.
 *
 * The bridge notifies on a change and caches its snapshot between changes, so a
 * React consumer sees a stable value and re-renders once per observable change
 * rather than once per message.
 *
 * @returns the verdict and counters this panel currently believes
 */
export function useBridge(): BridgeSnapshot {
  const bridge = webviewTransport().bridge;

  return useSyncExternalStore<BridgeSnapshot>(bridge.subscribe, bridge.snapshot, bridge.snapshot);
}

/**
 * The shell fault the panel should render, or `undefined` when there is none.
 *
 * Read from the same store as {@link useBridge}, so a phase and its failure can
 * never disagree: the transport hands on what the bridge accepted, and the rule
 * for when that is a page lives in `./errors/fault.ts`.
 *
 * @returns the failure, or `undefined` while the shell is not faulted
 */
export function useShellFault(): FaultInput | undefined {
  const snapshot = useBridge();

  return faultOf({
    phase: snapshot.status?.phase ?? null,
    failure: snapshot.status?.failure,
  });
}

/**
 * Send one answer from the fault page back to the host.
 *
 * Bound to the bridge rather than to an `AppFrame` slot: the answers on that page
 * reach the editor's own surfaces, which the bridge's action message already
 * carries.
 *
 * @param action the action name the page decided on
 */
export function sendShellFaultAction(action: ShellFaultAction): void {
  webviewTransport().bridge.sendAction(action);
}

/**
 * The notice a rejected bridge earns, or `undefined` while it is usable.
 *
 * The sentence comes from the catalogue and the reject code travels as data:
 * this module has no way to add a key of its own (the catalogue belongs to the
 * shared package), and inventing an English sentence here would be exactly the
 * second copy of the copy the message keys exist to prevent. What the user needs
 * is that the panel stopped and why, and the catalogue's generic error sentence
 * says both once the code is filled in.
 *
 * @returns the banner to render, or `undefined` when the bridge is usable
 */
export function useBridgeNotice(): BannerProps | undefined {
  const t = useT();
  const snapshot = useBridge();

  if (snapshot.state !== "rejected") return undefined;

  const code = snapshot.code ?? BRIDGE_VERSION_MISMATCH;

  return { tone: "danger", message: t("error.withCode", { code }), "data-testid": "bridge-notice" };
}
