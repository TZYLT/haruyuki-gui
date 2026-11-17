/**
 * Turning what the bridge delivers into signals the phase machine can reduce.
 *
 * Why this module exists
 *   `frames.ts` translates a frame and `state.ts` reduces a signal, and until this
 *   file neither had a caller in production code: the translation was tested,
 *   exported, and never invoked. The panel subscribed to a `subscribe` prop whose
 *   only implementation lived in a test. So a terminal could not reach `running`
 *   outside that test, and the comment above the panel's subscription -- "engine
 *   frames are the only evidence a session exists, so the panel subscribes" --
 *   described a behaviour the shipped code did not have.
 *
 * Why the split is a subscription and not a call
 *   The bridge hands over bytes it received; it does not know what a terminal
 *   phase is, and this package may not import the protocol. So a frame arrives as
 *   a discriminator and an unvalidated body, and everything about "which of those
 *   is a session change" belongs here rather than in the transport.
 *
 * Why this file does not decide anything
 *   It does not check the phase, refuse a signal, or order anything. Two frames
 *   arriving out of order are the reducer's problem, and it already answers every
 *   cell of that table: a `spawned` in `idle` is ignored because no spawn was
 *   requested, an `exited` for a session that ended is ignored, and so on. A second
 *   opinion here would be a second place to change the answer -- and the case that
 *   makes that concrete is a `spawned` frame that races a refusal, which the
 *   reducer settles by phase while a pass-through would have to guess.
 *
 * What is deliberately absent
 *   Output. `terminal_output` is not a state change: it goes to the sink, which
 *   paints it and measures it in bytes. Forwarding it here would re-render the
 *   panel once per slice of a `cat`, so `frames.ts` refuses it and this file
 *   forwards that refusal rather than translating it into a no-op signal.
 *
 * Pure apart from the callbacks it is given: no DOM, no terminal, no clock.
 */

import { signalFromFrame, signalFromLifecycle } from "./frames.js";
import type { FrameRefusal, TerminalFrame, TerminalLifecycleEvent } from "./frames.js";
import type { TerminalSignal } from "./state.js";

/**
 * What became of one frame.
 *
 * Returned rather than swallowed so a host can count what it dropped. A dropped
 * frame and a handled one are indistinguishable to a caller that ignores the
 * return value, and "the panel never left idle" is diagnosed by exactly that
 * difference.
 */
export type FeedResult =
  /** A signal was produced and handed to the receiver. */
  | { readonly kind: "signal"; readonly signal: TerminalSignal }
  /** The frame was not a session change, or was not understood. */
  | { readonly kind: "refused"; readonly because: FrameRefusal; readonly wire: string };

/** What the feed needs from the panel. */
export interface TerminalFeedOptions {
  /**
   * Receives every signal, in the order the frames arrived.
   *
   * This is the panel's own `dispatch`, so a frame and a local intent enter the
   * reducer through the same door and are ordered by arrival rather than by
   * origin.
   */
  readonly receive: (signal: TerminalSignal) => void;

  /**
   * Called for every frame that produced no signal.
   *
   * Optional because a host may not want it, and not silent because the two ways
   * a terminal can fail to appear -- the frame never arriving, and the frame
   * arriving unrecognised -- look identical from the panel.
   */
  readonly onRefused?: (refusal: { readonly because: FrameRefusal; readonly wire: string }) => void;
}

/** The subscription a host registers with the bridge. */
export interface TerminalFeed {
  /**
   * Offer one frame, as the bridge delivered it.
   *
   * @param frame the discriminator and its unvalidated body
   * @returns what became of it
   */
  accept(frame: TerminalFrame): FeedResult;

  /**
   * Offer one bridge lifecycle event.
   *
   * Separate from {@link accept} because readiness is not a frame: the protocol
   * has no message for "this connection is up", so its source is the bridge's own
   * callback. Both produce a `TerminalSignal`, which is what keeps the reducer
   * from needing to know which door a signal came through.
   *
   * @param event what the bridge reported
   * @returns the signal that was handed over
   */
  acceptLifecycle(event: TerminalLifecycleEvent): TerminalSignal;

  /** How many frames were accepted, and how many produced no signal. */
  readonly stats: {
    readonly accepted: number;
    readonly refused: number;
    readonly byRefusal: Readonly<Record<FrameRefusal, number>>;
  };
}

/**
 * Where frames come from.
 *
 * Declared here rather than in the bridge because this package may not import it,
 * and because it is the smallest contract that makes the feed reachable: two
 * subscriptions and nothing else. The host adapts its transport to this shape, so
 * the translation is testable without one and the bridge keeps its own view of
 * what a frame is.
 */
export interface TerminalFrameSource {
  /**
   * Register a receiver for delivered frames.
   *
   * @param listener called once per frame, in arrival order
   * @returns a function that unsubscribes
   */
  subscribe(listener: (frame: TerminalFrame) => void): () => void;

  /**
   * Register a receiver for the bridge's lifecycle.
   *
   * Optional because a source may not report readiness at all -- the shipped
   * bridge has no success callback today, which is why the panel's `engineReady`
   * is passed in separately.
   */
  subscribeLifecycle?(listener: (event: TerminalLifecycleEvent) => void): () => void;
}

/**
 * Build the feed.
 *
 * @param options the panel's receiver and an optional refusal listener
 * @returns the subscription the host registers with the bridge
 */
export function createTerminalFeed(options: TerminalFeedOptions): TerminalFeed {
  let accepted = 0;
  const byRefusal: Record<FrameRefusal, number> = {
    "unrelated-frame": 0,
    malformed: 0,
    "unknown-terminal-frame": 0,
  };
  let refused = 0;

  return {
    accept(frame: TerminalFrame): FeedResult {
      accepted += 1;

      const translation = signalFromFrame(frame);

      if (translation.kind === "refused") {
        refused += 1;
        byRefusal[translation.because] += 1;

        options.onRefused?.({ because: translation.because, wire: translation.wire });

        return translation;
      }

      options.receive(translation.signal);

      return translation;
    },

    acceptLifecycle(event: TerminalLifecycleEvent): TerminalSignal {
      const signal = signalFromLifecycle(event);

      // Counted in neither total on purpose: `accepted` counts frames, and
      // inflating it with a callback that is not one would make "frames received"
      // a number that can exceed what the bridge sent.
      options.receive(signal);

      return signal;
    },

    get stats() {
      return { accepted, refused, byRefusal: { ...byRefusal } };
    },
  };
}

/**
 * Connect a feed to a frame source, and return the two things a caller keeps.
 *
 * This is the seam the panel actually uses: the feed translates, the source
 * delivers, and the receiver is the panel's own `dispatch`. Doing the three-way
 * hookup here rather than at each call site means "no signal can be produced
 * without reaching the reducer" is a property of one function instead of a
 * convention every host has to remember.
 *
 * @param source where frames arrive
 * @param options the panel's receiver and an optional refusal listener
 * @returns the feed, and a function that unsubscribes both listeners
 */
export function connectTerminalFeed(
  source: TerminalFrameSource,
  options: TerminalFeedOptions,
): { readonly feed: TerminalFeed; readonly dispose: () => void } {
  const feed = createTerminalFeed(options);

  const unsubscribes: Array<() => void> = [source.subscribe((frame) => feed.accept(frame))];

  // `receive` is required, so the only optional half is the lifecycle source.
  if (source.subscribeLifecycle !== undefined) {
    unsubscribes.push(source.subscribeLifecycle((event) => feed.acceptLifecycle(event)));
  }

  let disposed = false;

  return {
    feed,
    dispose(): void {
      // Idempotent, because a panel unmounts on paths that may also call it.
      if (disposed) return;

      disposed = true;

      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}
