/**
 * The `bridge.ready` / `bridge.accept` / `bridge.reject` handshake: the version
 * guard that runs before the core sends any other frame.
 *
 * The three frozen bodies are {@link BridgeReadyBody}, {@link BridgeAcceptBody}
 * and {@link BridgeRejectBody}; the rules around them are exact version
 * equality, `appVersion` as diagnostic only, and terminal states staying silent.
 *
 * Why the bodies are declared here
 *   `@haruyuki/protocol` exports the frame envelope and the frame type table,
 *   but none of the three handshake bodies (checked against its public surface
 *   at the time of writing). The protocol package is not ours to widen in this
 *   work package, so the bodies are declared here, verbatim from the frozen
 *   shapes, and stay module-local until that package decides to own them.
 *
 * The two halves of the round trip
 *   {@link evaluateReady} is the pure decision: one already-validated ready body
 *   plus the local expectations, producing the outcome. {@link createHandshake}
 *   is the state machine the sender wiring holds: it validates the incoming
 *   value, asks the decision, and remembers that the answer is final. Splitting
 *   them keeps the decision testable without a lifetime, and keeps the lifetime
 *   free of version logic.
 *
 * Terminal states are silent
 *   An accept and a reject are both final. Consider the reject case: after
 *   `bridge.reject` the core sends no further frame, so a receiver that kept
 *   answering could only produce frames the transport is forbidden to send. The
 *   machine therefore reports `"none"` forever once it has left `waiting`, which
 *   makes "reject once, then silence" a property of the machine rather than a
 *   flag the caller has to remember. The same rule covers a second
 *   `bridge.ready`: the accept is produced exactly once.
 *
 * Version equality is exact
 *   `bridgeVersion` is compared with `===` and never parsed or otherwise
 *   reasoned about (C5-Q07: the version comes from the protocol package version
 *   and only an exact match is accepted). `appVersion` is diagnostic only: it
 *   describes the renderer build and never takes part in the decision.
 *
 * Invalid bodies are ignored, not rejected
 *   {@link HandshakeState.receive} takes `unknown`. A value that is not an
 *   object, that is an array, or whose `appVersion`/`bridgeVersion` is not a
 *   string is a producer bug, not a version problem: answering `bridge.reject`
 *   would claim `BRIDGE_VERSION_MISMATCH` for something that has no version to
 *   compare, and the renderer would then show "the versions disagree" for what
 *   is in fact a wiring mistake. The machine keeps its current state and reports
 *   `"none"`; counting such violations is the frame entry's job, where the
 *   frame type and the transport context are visible.
 *
 * No timers, no I/O and no protocol value import: the module is pure data
 * handling, so a host can run it in the renderer's environment as cheaply as in
 * the core's.
 */

/**
 * Body of a `bridge.ready` frame, sent by the renderer as its first control
 * frame (ui -> core).
 *
 * Frozen shape: fixed by the bridge protocol and pinned by handshake.test.ts.
 */
export interface BridgeReadyBody {
  /** Version of the renderer bundle; diagnostic only, never a verdict input. */
  appVersion: string;
  /** Bridge protocol version the renderer speaks; the only field compared. */
  bridgeVersion: string;
}

/**
 * Body of a `bridge.accept` frame (core -> ui), sent when the bridge versions
 * match.
 *
 * Frozen shape: fixed by the bridge protocol and pinned by handshake.test.ts.
 */
export interface BridgeAcceptBody {
  /** Version of the shared core that accepted the handshake. */
  coreVersion: string;
  /** Number of bulk pages the renderer should expect before the stream opens. */
  bulkPages: number;
}

/**
 * Body of a `bridge.reject` frame (core -> ui), sent when the bridge versions
 * differ.
 *
 * Frozen shape: fixed by the bridge protocol and pinned by handshake.test.ts. The code is
 * carried as data rather than as prose because the renderer picks its own
 * message; the two versions travel with it so a log can explain the refusal
 * without a second round trip.
 */
export interface BridgeRejectBody {
  code: "BRIDGE_VERSION_MISMATCH";
  /** Version the core required, i.e. what `options.expectedBridgeVersion` held. */
  expected: string;
  /** Version the renderer announced in `bridge.ready`. */
  actual: string;
}

/**
 * The only failure code this handshake can produce.
 *
 * Declared as a value, not just a type, so both the reject body and a caller
 * branching on the outcome name the same symbol instead of retyping a literal.
 */
export const BRIDGE_VERSION_MISMATCH = "BRIDGE_VERSION_MISMATCH" as const;

/**
 * The decision the handshake reached about the renderer that announced itself.
 *
 * `"waiting"` is the state before a well-formed `bridge.ready` has been seen;
 * `"accepted"` and `"rejected"` are terminal for the life of the machine.
 */
export type HandshakeOutcome =
  | { state: "accepted"; bulkPages: number }
  | {
      state: "rejected";
      code: typeof BRIDGE_VERSION_MISMATCH;
      expected: string;
      actual: string;
    }
  | { state: "waiting" };

/**
 * What the local side expects from a handshake.
 *
 * Values are supplied once, when the machine is created, and are copied: a
 * later mutation of the caller's object must not be able to change a verdict
 * that has already been sent. `bulkPages` is part of the options rather than a
 * computed value because the snapshot pager decides how many pages it
 * will emit before the handshake runs, so this layer only reports the number.
 */
export interface HandshakeOptions {
  /** The only `bridgeVersion` value this core accepts (exact match). */
  expectedBridgeVersion: string;
  /** Reported to the renderer in `bridge.accept`. */
  coreVersion: string;
  /** Reported to the renderer in `bridge.accept`; copied verbatim. */
  bulkPages: number;
}

/**
 * What a receiver should do with one incoming candidate body.
 *
 * `"none"` means "emit no frame". It covers both "still waiting for a usable
 * ready" and "already answered", so a caller only ever forwards `accept` and
 * `reject` to the transport.
 */
export interface HandshakeReply {
  action: "none" | "accept" | "reject";
  body?: BridgeAcceptBody | BridgeRejectBody;
}

/**
 * The long-lived half of the handshake: state plus a receiver for candidate
 * `bridge.ready` bodies.
 */
export interface HandshakeState {
  /** Current decision; `{ state: "waiting" }` until a usable ready arrives. */
  readonly outcome: HandshakeOutcome;
  /**
   * Offer one candidate `bridge.ready` body.
   *
   * The value is `unknown` on purpose: this is where the frame entry hands over
   * whatever the transport decoded. A value whose shape is wrong is ignored
   * (see the module comment), and so is everything offered after the machine
   * has already answered.
   *
   * @param body the decoded candidate body, not the whole frame envelope
   * @returns the action the caller should perform, with the body to send
   */
  receive(body: unknown): HandshakeReply;
}

/**
 * Decide the handshake for one ready body.
 *
 * Pure: the same body and options always produce the same outcome, and neither
 * argument is retained or mutated. The caller is responsible for having checked
 * the body's shape first; {@link createHandshake} does that, and a caller with
 * an unvalidated value should go through it rather than through this function.
 *
 * @param ready a body whose `appVersion` and `bridgeVersion` are strings
 * @param options the local expectations
 * @returns `accepted` with `options.bulkPages`, or `rejected` with both versions
 */
export function evaluateReady(ready: BridgeReadyBody, options: HandshakeOptions): HandshakeOutcome {
  if (ready.bridgeVersion !== options.expectedBridgeVersion) {
    return Object.freeze({
      state: "rejected",
      code: BRIDGE_VERSION_MISMATCH,
      expected: options.expectedBridgeVersion,
      actual: ready.bridgeVersion,
    });
  }

  return Object.freeze({ state: "accepted", bulkPages: options.bulkPages });
}

/**
 * Create the handshake machine for one bridge.
 *
 * One machine per bridge session: the outcome is terminal, so reusing it across
 * reconnections would silently swallow the second handshake. The options are
 * copied and the returned outcome objects are frozen, which is what makes the
 * `readonly outcome` in {@link HandshakeState} an honest promise.
 *
 * @param options the local expectations, copied at creation time
 * @returns a machine that starts in `waiting`
 */
export function createHandshake(options: HandshakeOptions): HandshakeState {
  return new Handshake(options);
}

/** Outcome shared by every machine that has not seen a usable ready yet. */
const WAITING_OUTCOME: HandshakeOutcome = Object.freeze({ state: "waiting" });

/** No-frame reply, shared to keep the "silent" paths allocation-free. */
const NO_ACTION: HandshakeReply = Object.freeze({ action: "none" });

/**
 * The state machine behind {@link createHandshake}.
 *
 * Kept private so the class cannot be constructed with a hand-written state:
 * every instance starts in `waiting`, and only `receive` can move it.
 */
class Handshake implements HandshakeState {
  readonly #options: HandshakeOptions;
  #outcome: HandshakeOutcome = WAITING_OUTCOME;

  constructor(options: HandshakeOptions) {
    this.#options = { ...options };
  }

  get outcome(): HandshakeOutcome {
    return this.#outcome;
  }

  receive(body: unknown): HandshakeReply {
    // Terminal states are silent: an accept or a reject is already on the wire
    // (or about to be), and no frame may follow a reject. Checking this
    // before validation also means junk after a verdict costs nothing.
    if (this.#outcome.state !== "waiting") {
      return NO_ACTION;
    }

    const ready = readReadyBody(body);

    if (ready === null) {
      // Not a version problem, so no verdict: stay waiting and stay silent.
      return NO_ACTION;
    }

    const outcome = evaluateReady(ready, this.#options);
    this.#outcome = outcome;

    if (outcome.state === "accepted") {
      return {
        action: "accept",
        body: { coreVersion: this.#options.coreVersion, bulkPages: outcome.bulkPages },
      };
    }

    if (outcome.state === "rejected") {
      return {
        action: "reject",
        body: { code: outcome.code, expected: outcome.expected, actual: outcome.actual },
      };
    }

    // Unreachable: `evaluateReady` is total over a well-formed body and returns
    // only `accepted` or `rejected`. The branch exists because its declared
    // return type is the whole outcome union, and it falls back to exactly the
    // waiting behaviour: no frame, no state change.
    return NO_ACTION;
  }
}

/**
 * Narrow an unknown value to a usable {@link BridgeReadyBody}, or `null`.
 *
 * Only the shape is checked, and only the two fields the contract names: extra
 * fields are carried by real frames (a host may add diagnostics) and must not
 * turn a usable ready into a silent one. The *content* is deliberately not
 * validated here: an empty or nonsensical version string is a well-formed
 * string, and the comparison is what rejects it, with `expected`/`actual` in
 * the reject body. Reporting it as a shape error instead would lose that
 * evidence.
 *
 * @param body the decoded candidate body
 * @returns a fresh body with exactly the two known fields, or `null`
 */
function readReadyBody(body: unknown): BridgeReadyBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const candidate = body as Record<string, unknown>;
  const { appVersion, bridgeVersion } = candidate;

  if (typeof appVersion !== "string" || typeof bridgeVersion !== "string") {
    return null;
  }

  return { appVersion, bridgeVersion };
}
