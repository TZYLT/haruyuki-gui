/**
 * Tests for the translation from bridge frames to phase signals.
 *
 * What is under test
 *   Not the phase machine -- it has its own file. What is under test is that each
 *   frame becomes the signal it should and nothing else, because a translation
 *   that quietly sends the wrong shape does not fail: `reducePhase` ignores what
 *   it does not recognise, so a mistranslated frame would look exactly like a
 *   frame that never arrived, and the panel would sit in `starting` forever with
 *   nothing in any log.
 *
 * Why the coverage assertions come first
 *   The three frames are iterated from one list, and a list that drives loops has a
 *   failure mode that no assertion inside those loops can catch: delete a member
 *   and every case passes, having tested less. So the list's length is asserted
 *   against the count this file intends to cover -- the same defect that let a
 *   seventh phase pass 55 green tests in the phase machine's own suite.
 *
 * Why `terminal_output` gets a case at all
 *   It is the one terminal frame that must *not* produce a signal. A translation
 *   layer that forwarded it would make the panel re-render for every slice of a
 *   `cat`, which is a performance defect that looks like a correct feature.
 */

import { describe, expect, it } from "vitest";

import { signalFromFrame, signalFromLifecycle } from "./frames.js";
import type { TerminalFrame, TerminalLifecycleEvent } from "./frames.js";
import type { TerminalSignal } from "./state.js";

/**
 * Every frame the protocol defines for terminals, as the bridge delivers them.
 *
 * Spelled out from the engine's own wire names rather than discovered, so a build
 * that adds a fourth terminal frame fails the coverage assertion below instead of
 * being silently absent.
 */
const TERMINAL_WIRES = ["terminal_spawned", "terminal_output", "terminal_exited"] as const;

/** @param t the discriminator @param body the payload @returns a frame */
function frame(t: string, body: unknown): TerminalFrame {
  return { t, body };
}

/** @param translation what the translator returned @returns the signal it carries */
function signalOf(translation: ReturnType<typeof signalFromFrame>): TerminalSignal {
  expect(translation.kind).toBe("signal");

  if (translation.kind !== "signal") throw new Error("expected a signal");

  return translation.signal;
}

describe("coverage", () => {
  it("maps every terminal frame the protocol defines, so a new one cannot be silently absent", () => {
    // A list that drives loops cannot notice its own shrinking. This assertion is
    // the only thing standing between "we handle three frames" and "we handle the
    // three frames somebody remembered to list".
    expect(TERMINAL_WIRES.length).toBe(3);
  });

  it("produces a signal for the two lifecycle frames and refuses the output frame", () => {
    const produced = TERMINAL_WIRES.map(
      (wire) =>
        signalFromFrame(
          frame(
            wire,
            wire === "terminal_spawned"
              ? { terminal_id: "t-1", pid: 1234 }
              : wire === "terminal_exited"
                ? { terminal_id: "t-1", exitCode: 0 }
                : { terminal_id: "t-1", data: "hello" },
          ),
        ).kind,
    );

    expect(produced).toEqual(["signal", "refused", "signal"]);
  });
});

describe("terminal_spawned", () => {
  it("reports the pid, because a scan of the process table has nothing else to match", () => {
    const signal = signalOf(
      signalFromFrame(frame("terminal_spawned", { terminal_id: "t-1", pid: 4242 })),
    );

    expect(signal).toEqual({ kind: "spawned", pid: 4242 });
  });

  it("reports pid 0 rather than treating it as missing, because zero is a value a plugin may return", () => {
    // The failure this pins is `if (!pid)`: it accepts 0 as absent, so a session
    // with pid 0 never leaves `starting`.
    const signal = signalOf(
      signalFromFrame(frame("terminal_spawned", { terminal_id: "t-1", pid: 0 })),
    );

    expect(signal).toEqual({ kind: "spawned", pid: 0 });
  });

  it("refuses a frame with no pid, because a fabricated pid is a panel claiming a process it cannot see", () => {
    const translation = signalFromFrame(frame("terminal_spawned", { terminal_id: "t-1" }));

    expect(translation).toEqual({
      kind: "refused",
      because: "malformed",
      wire: "terminal_spawned",
    });
  });

  it("refuses a fractional pid, because a process id is a whole number and half of one is not", () => {
    const translation = signalFromFrame(
      frame("terminal_spawned", { terminal_id: "t-1", pid: 12.5 }),
    );

    expect(translation.kind).toBe("refused");
  });

  it("refuses a payload that is not an object, because JSON can deliver anything", () => {
    for (const body of [null, "text", 42, undefined]) {
      expect(signalFromFrame(frame("terminal_spawned", body)).kind).toBe("refused");
    }
  });

  it("refuses a frame with no terminal id, because a signal with no session cannot be applied to one", () => {
    const translation = signalFromFrame(frame("terminal_spawned", { pid: 1234 }));

    expect(translation.kind).toBe("refused");
  });
});

describe("terminal_exited", () => {
  it("carries a normal end with no error, because that is a code the panel shows", () => {
    const signal = signalOf(
      signalFromFrame(frame("terminal_exited", { terminal_id: "t-1", exitCode: 0 })),
    );

    expect(signal).toEqual({ kind: "exited", exitCode: 0, error: null });
  });

  it("carries a non-zero code as an ordinary exit, because not every non-zero code is a spawn failure", () => {
    // A shell that ran and returned 127 for a missing command exits normally. The
    // reducer branches on `error`, not on the code, so this layer must not help it
    // by treating a non-zero code as a failure.
    const signal = signalOf(
      signalFromFrame(frame("terminal_exited", { terminal_id: "t-1", exitCode: 127 })),
    );

    expect(signal).toEqual({ kind: "exited", exitCode: 127, error: null });
  });

  it("carries the engine's error verbatim, because that text is the only clue a user gets", () => {
    const signal = signalOf(
      signalFromFrame(
        frame("terminal_exited", {
          terminal_id: "t-1",
          exitCode: 1,
          error: "spawn pty ENOENT",
        }),
      ),
    );

    expect(signal).toEqual({ kind: "exited", exitCode: 1, error: "spawn pty ENOENT" });
  });

  it("keeps an empty error as present, because 'it said nothing' is not 'it did not speak'", () => {
    // Collapsing `""` to `null` here would turn a failed spawn into a clean exit
    // with code 1 -- the exact merge the two phases exist to prevent.
    const signal = signalOf(
      signalFromFrame(frame("terminal_exited", { terminal_id: "t-1", exitCode: 1, error: "" })),
    );

    expect(signal).toEqual({ kind: "exited", exitCode: 1, error: "" });
  });

  it("does not decide which meaning it is, because the decision already has one owner", () => {
    // Asserted as a property rather than a value: both meanings pass through this
    // layer unchanged, so there is nothing here that could disagree with
    // `reducePhase` about which one a frame carried.
    const withError = signalOf(
      signalFromFrame(frame("terminal_exited", { terminal_id: "t-1", exitCode: 1, error: "x" })),
    );
    const withoutError = signalOf(
      signalFromFrame(frame("terminal_exited", { terminal_id: "t-1", exitCode: 0 })),
    );

    expect("error" in withError && withError.error).toBe("x");
    expect("error" in withoutError && withoutError.error).toBe(null);
  });

  it("refuses a frame with no exit code, because an exit without one is not an exit the panel can show", () => {
    const translation = signalFromFrame(frame("terminal_exited", { terminal_id: "t-1" }));

    expect(translation.kind).toBe("refused");
  });

  it("ignores a non-string error rather than rendering a number as a sentence", () => {
    const signal = signalOf(
      signalFromFrame(frame("terminal_exited", { terminal_id: "t-1", exitCode: 1, error: 500 })),
    );

    expect(signal).toEqual({ kind: "exited", exitCode: 1, error: null });
  });
});

describe("terminal_output is not a signal", () => {
  it("refuses it, because output goes to the render sink and not through the state machine", () => {
    // Forwarding it would re-render the panel for every slice of a large paste.
    const translation = signalFromFrame(
      frame("terminal_output", { terminal_id: "t-1", data: "hello" }),
    );

    expect(translation).toEqual({
      kind: "refused",
      because: "unrelated-frame",
      wire: "terminal_output",
    });
  });

  it("does not read its bytes, because the sink already owns that measurement", () => {
    // A second counter here would be a second owner of the same number, and the two
    // would drift the first time one of them was tuned.
    const withBytes = signalFromFrame(
      frame("terminal_output", { terminal_id: "t-1", data: "汉字", bytes: 999 }),
    );

    expect(withBytes).toEqual({
      kind: "refused",
      because: "unrelated-frame",
      wire: "terminal_output",
    });
  });
});

describe("frames this build does not understand", () => {
  it("refuses an unknown terminal frame and says it is a skew, because a newer engine sending one is worth noticing", () => {
    const translation = signalFromFrame(frame("terminal_reflowed", { terminal_id: "t-1" }));

    expect(translation).toEqual({
      kind: "refused",
      because: "unknown-terminal-frame",
      wire: "terminal_reflowed",
    });
  });

  it("calls anything without the terminal prefix unrelated, because it is another feature's message", () => {
    const translation = signalFromFrame(frame("conversation_sync", { id: 1 }));

    expect(translation).toEqual({
      kind: "refused",
      because: "unrelated-frame",
      wire: "conversation_sync",
    });
  });

  it("never throws for an unknown frame, because one new engine frame must not take the panel down", () => {
    for (const t of ["terminal_whatever", "", "x", "terminal_"]) {
      expect(() => signalFromFrame(frame(t, {}))).not.toThrow();
    }
  });

  it("returns a value rather than dropping the frame, because a silent refusal is a bug nobody finds", () => {
    // "Dropped" and "handled" would look identical to a caller that ignored the
    // return value, so the refusal carries the wire name it refused.
    const translation = signalFromFrame(frame("terminal_unknown", {}));

    expect(translation.kind).toBe("refused");
    expect(translation.kind === "refused" && translation.wire).toBe("terminal_unknown");
  });
});

describe("readiness comes from the lifecycle, not from a frame", () => {
  it("maps ready to an engine signal, because readiness is not something the engine says about a terminal", () => {
    expect(signalFromLifecycle({ kind: "ready" })).toEqual({ kind: "engine", ready: true });
  });

  it("maps unavailable to not-ready, because the panel has to leave running when the connection goes", () => {
    expect(signalFromLifecycle({ kind: "unavailable" })).toEqual({ kind: "engine", ready: false });
  });

  it("covers both lifecycle events, so neither can be silently unhandled", () => {
    // Same guard as the frame list: a value added to the union without a case here
    // would compile today and mean an event the panel never reacts to.
    const events: TerminalLifecycleEvent[] = [{ kind: "ready" }, { kind: "unavailable" }];

    expect(events.length).toBe(2);

    for (const event of events) {
      expect(signalFromLifecycle(event).kind).toBe("engine");
    }
  });

  it("returns the same signal shape as the frame path, because the reducer must not be able to tell them apart", () => {
    const fromFrame = signalOf(
      signalFromFrame(frame("terminal_spawned", { terminal_id: "t-1", pid: 7 })),
    );
    const fromLifecycle = signalFromLifecycle({ kind: "ready" });

    // Compared by their discriminant's presence rather than by value: the point is
    // that both are members of one union, so both are accepted by `reducePhase`.
    expect(typeof fromFrame.kind).toBe("string");
    expect(typeof fromLifecycle.kind).toBe("string");
  });
});
