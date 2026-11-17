/**
 * Turning what the bridge delivers into the signals the phase machine reduces.
 *
 * Why this module exists
 *   `reducePhase` needs three things to advance: a spawn confirmation, an exit,
 *   and the engine's readiness. Nothing produced any of them -- the panel carried
 *   a comment saying engine frames are the only evidence a session exists, and no
 *   code turned a frame into that evidence. A state machine with no producer is a
 *   machine that can only sit in `idle`, which is exactly what the panel did.
 *
 * Why there are two entry points and not one
 *   Three of the signals come from protocol frames. Readiness does not: the
 *   protocol has `terminal_spawned`, `terminal_output` and `terminal_exited`, and
 *   nothing else. Readiness is a fact about this process's connection to the
 *   engine, so its source is the bridge's own lifecycle callback, not a message
 *   the engine sends about a terminal. Two sources, one destination: both
 *   functions return the same `TerminalSignal`, so the reducer cannot tell which
 *   door a signal came through, and a phase that only fires on one door is a bug
 *   in one function rather than in two half-machines.
 *
 * The alternative, and why it is worse
 *   Letting the panel subscribe to the lifecycle callback directly would give the
 *   panel two signal paths -- one that goes through `reducePhase` and one that
 *   does not -- and the second one would have to reimplement the disconnected
 *   transition by hand. That is precisely the shape of every defect found in this
 *   package: one rule with two owners.
 *
 * Why an unknown frame returns `null` instead of throwing
 *   A new engine build may send a frame this build has never heard of. Throwing
 *   would take the whole panel down over an event it could have ignored, and a
 *   terminal that dies because the engine learned to say something new is worse
 *   than a terminal that drops one unread message. Returning `null` is a value the
 *   caller has to handle, so it is not silent either -- and the caller counts it,
 *   because "we received frames we do not understand" is the only warning anyone
 *   would get that the two builds have drifted apart.
 *
 * What this module deliberately does not do
 *   - It does not decide whether an exit was a normal end or a spawn failure. The
 *     same frame carries both meanings, and `reducePhase` already branches on
 *     `error === null`; a second decision here would be a second place to change
 *     it.
 *   - It does not count bytes, decode text, or touch output at all. Output goes to
 *     the sink, which measures it in bytes; a second measurement here would be a
 *     second owner of the same number.
 *
 * Pure: no DOM, no clock, no I/O, no import from the protocol package.
 */

import type { TerminalSignal } from "./state.js";

/**
 * One frame as the bridge hands it over: a discriminator and an unvalidated body.
 *
 * Declared here rather than imported because this package may not load the
 * protocol package, and because the shape it needs is smaller: a `t` and a
 * `body`. Whatever else a frame carries is another layer's business.
 */
export interface TerminalFrame {
  /** The frame's discriminator, in the wire's own spelling. */
  readonly t: string;

  /** The frame's payload, as delivered. Untrusted. */
  readonly body: unknown;
}

/**
 * What the bridge's lifecycle reported.
 *
 * Two shapes rather than one boolean because the two failures are not the same
 * fact. A connection that was never established leaves the panel in `idle` with
 * nothing to reopen; a connection that was established and then ended ends the
 * session, and the engine kills the PTY when it does. `reducePhase` distinguishes
 * them by the phase it is in when readiness arrives, so this only has to carry the
 * boolean -- but the caller's own decision about *when* to call it depends on
 * which of the two happened, and that is why they are named apart.
 */
export type TerminalLifecycleEvent =
  /** The bridge's connection to the engine is up. */
  | { readonly kind: "ready" }
  /** The bridge's connection went away, or never came up. */
  | { readonly kind: "unavailable" };

/**
 * Why the translation produced no signal.
 *
 * Returned instead of a bare `null` so a caller can tell "this frame is not about
 * a terminal" from "this frame is a terminal frame this build does not understand".
 * The first is routine and quiet; the second is a version skew worth counting.
 */
export type FrameRefusal =
  /** Not a frame this module maps to anything. Ignorable. */
  | "unrelated-frame"
  /** A terminal frame whose payload did not validate. */
  | "malformed"
  /** A terminal frame from a newer engine that this build does not understand. */
  | "unknown-terminal-frame";

/** What translating one frame produced. */
export type FrameTranslation =
  | { readonly kind: "signal"; readonly signal: TerminalSignal }
  | { readonly kind: "refused"; readonly because: FrameRefusal; readonly wire: string };

/**
 * Read a property as a non-empty string.
 *
 * @param record the payload
 * @param key the property name
 * @returns the value, or `undefined` when absent or not a non-empty string
 */
function readId(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Read a property as a finite integer.
 *
 * A `pid` or an exit code arrives as JSON, so it can be anything; `Number.isInteger`
 * rejects both a fraction and a `NaN` that `typeof` would accept.
 *
 * @param record the payload
 * @param key the property name
 * @returns the value, or `undefined` when absent or not an integer
 */
function readInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * Translate one bridge frame into a phase signal.
 *
 * Three frames are mapped, and one of them is deliberately not a signal:
 *
 *   - `terminal_spawned { terminal_id, pid }` -- the session exists.
 *   - `terminal_exited  { terminal_id, exitCode, error? }` -- the session ended.
 *     Carried verbatim, both meanings included; the reducer branches.
 *   - `terminal_output` -- output, which goes to the render sink and not through
 *     the state machine. Refused as unrelated, because sending it here would make
 *     the panel re-render for every slice of a `cat`.
 *
 * @param frame one frame, as the bridge delivered it
 * @returns the signal, or why there is none
 */
export function signalFromFrame(frame: TerminalFrame): FrameTranslation {
  switch (frame.t) {
    case "terminal_output":
      // Output is not a state change. It is refused rather than ignored so the
      // caller's counter means "frames that were not signals", which is the
      // number worth watching.
      return { kind: "refused", because: "unrelated-frame", wire: frame.t };

    case "terminal_spawned": {
      const body = frame.body;

      if (typeof body !== "object" || body === null) {
        return { kind: "refused", because: "malformed", wire: frame.t };
      }

      const record = body as Record<string, unknown>;

      if (readId(record, "terminal_id") === undefined) {
        return { kind: "refused", because: "malformed", wire: frame.t };
      }

      const pid = readInteger(record, "pid");

      // No `pid` means the engine did not report one, and a plugin terminal with a
      // fabricated `pid` is a panel that would show "pid 0" for a live process.
      if (pid === undefined) {
        return { kind: "refused", because: "malformed", wire: frame.t };
      }

      return { kind: "signal", signal: { kind: "spawned", pid } };
    }

    case "terminal_exited": {
      const body = frame.body;

      if (typeof body !== "object" || body === null) {
        return { kind: "refused", because: "malformed", wire: frame.t };
      }

      const record = body as Record<string, unknown>;

      if (readId(record, "terminal_id") === undefined) {
        return { kind: "refused", because: "malformed", wire: frame.t };
      }

      const exitCode = readInteger(record, "exitCode");

      if (exitCode === undefined) {
        return { kind: "refused", because: "malformed", wire: frame.t };
      }

      // `error` is carried exactly as the engine sent it: present means the spawn
      // failed, absent means a normal end. An empty string still counts as
      // present, because the engine's own text is untrusted and "it said nothing"
      // is not the same as "it did not speak" -- flattening the two would turn a
      // failed spawn into a clean exit with a code.
      const raw = record["error"];

      return {
        kind: "signal",
        signal: {
          kind: "exited",
          exitCode,
          error: typeof raw === "string" ? raw : null,
        },
      };
    }

    default:
      // A terminal-shaped wire this build does not know, or something else
      // entirely. Distinguished because only one of the two is worth reporting:
      // `terminal_` is this package's own prefix, so a frame wearing it that has
      // no case here is a build skew, not an unrelated message.
      return {
        kind: "refused",
        because: frame.t.startsWith("terminal_") ? "unknown-terminal-frame" : "unrelated-frame",
        wire: frame.t,
      };
  }
}

/**
 * Translate the bridge's lifecycle into the readiness signal.
 *
 * @param event what the bridge reported
 * @returns the signal for the reducer
 */
export function signalFromLifecycle(event: TerminalLifecycleEvent): TerminalSignal {
  // `ready` and `unavailable` are the only two states the bridge has, and the
  // reducer treats readiness as a fact rather than a transition: it is applied to
  // whatever phase the panel is in, which is why this does not need to know the
  // phase or the terminal id.
  return { kind: "engine", ready: event.kind === "ready" };
}
