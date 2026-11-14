/**
 * Tests for the bridge handshake: the version guard that runs before any other
 * frame.
 *
 * The contract under test: the three frozen bodies (`bridge.ready`,
 * `bridge.accept` and `bridge.reject`), exact version equality, `appVersion`
 * as diagnostic only, and silence after `bridge.reject`.
 *
 * Two layers are covered, and the split follows the module's own split:
 *
 * - `evaluateReady` is a pure decision, so it is tested as a table: matching
 *   version, mismatching version, and the exact `expected`/`actual` pair that
 *   travels to the renderer.
 * - `createHandshake` is a lifetime, so it is tested as a sequence: nothing
 *   before ready, exactly one accept, nothing after a verdict, and no state
 *   change on a body that is not a usable ready.
 *
 * The "silent after reject" case is the acceptance criterion itself, so it is
 * asserted three times over: the third, fourth and fifth offers all report no
 * action, which is what "the core sends nothing else" means at this layer.
 */

import { describe, expect, it } from "vitest";

import { BRIDGE_VERSION_MISMATCH, createHandshake, evaluateReady } from "./handshake";
import type {
  BridgeAcceptBody,
  BridgeReadyBody,
  BridgeRejectBody,
  HandshakeOptions,
} from "./handshake";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Options used by most cases; values are distinct so a mix-up is visible. */
function options(overrides: Partial<HandshakeOptions> = {}): HandshakeOptions {
  return {
    expectedBridgeVersion: "1.0.0",
    coreVersion: "0.1.0",
    bulkPages: 3,
    ...overrides,
  };
}

/** A ready body whose version matches `options().expectedBridgeVersion`. */
function ready(overrides: Partial<BridgeReadyBody> = {}): BridgeReadyBody {
  return { appVersion: "9.9.9", bridgeVersion: "1.0.0", ...overrides };
}

/**
 * Narrow the accept branch of a reply, failing the test with a readable message
 * when the action is not `accept`.
 */
function acceptBody(action: { action: string; body?: BridgeAcceptBody | BridgeRejectBody }) {
  expect(action.action).toBe("accept");
  const body = action.body as BridgeAcceptBody | undefined;
  expect(body).toBeDefined();
  return body as BridgeAcceptBody;
}

/** Narrow the reject branch of a reply the same way. */
function rejectBody(action: { action: string; body?: BridgeAcceptBody | BridgeRejectBody }) {
  expect(action.action).toBe("reject");
  const body = action.body as BridgeRejectBody | undefined;
  expect(body).toBeDefined();
  return body as BridgeRejectBody;
}

/* ------------------------------------------------------------------ */
/* evaluateReady: the pure decision                                     */
/* ------------------------------------------------------------------ */

describe("evaluateReady", () => {
  it("accepts a matching bridge version", () => {
    const outcome = evaluateReady(ready(), options());

    expect(outcome).toEqual({ state: "accepted", bulkPages: 3 });
  });

  it("reports the configured bulkPages, not a fixed number", () => {
    const outcome = evaluateReady(ready(), options({ bulkPages: 17 }));

    expect(outcome.state).toBe("accepted");
    expect(outcome).toMatchObject({ bulkPages: 17 });
  });

  it("rejects a mismatching bridge version with both versions", () => {
    const outcome = evaluateReady(ready({ bridgeVersion: "2.0.0" }), options());

    expect(outcome).toEqual({
      state: "rejected",
      code: BRIDGE_VERSION_MISMATCH,
      expected: "1.0.0",
      actual: "2.0.0",
    });
  });

  it("compares the version exactly, with no range or prefix reasoning", () => {
    // Each of these is a plausible "close enough" that must still be refused:
    // a prefix, a build suffix, a leading v, and a patch bump.
    for (const bridgeVersion of ["1", "1.0", "1.0.0-beta.1", "v1.0.0", "1.0.1"]) {
      const outcome = evaluateReady(ready({ bridgeVersion }), options());

      expect(outcome.state).toBe("rejected");
      expect(outcome).toMatchObject({ expected: "1.0.0", actual: bridgeVersion });
    }
  });

  it("does not let appVersion influence the verdict", () => {
    // appVersion is diagnostic only: a wildly
    // different renderer build against a matching bridge version is accepted.
    const outcome = evaluateReady(
      { appVersion: "0.0.0-diagnostic", bridgeVersion: "1.0.0" },
      options(),
    );

    expect(outcome).toEqual({ state: "accepted", bulkPages: 3 });
  });

  it("is pure: a second call returns an equal outcome", () => {
    const shared = options();

    expect(evaluateReady(ready(), shared)).toEqual(evaluateReady(ready(), shared));
    // And the options object it was given is untouched.
    expect(shared).toEqual(options());
  });

  it("freezes the outcome so a caller cannot rewrite a sent verdict", () => {
    const accepted = evaluateReady(ready(), options());
    const rejected = evaluateReady(ready({ bridgeVersion: "2.0.0" }), options());

    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(rejected)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* createHandshake: waiting and accept                                 */
/* ------------------------------------------------------------------ */

describe("createHandshake before ready", () => {
  it("starts in waiting and reports no action", () => {
    const handshake = createHandshake(options());

    expect(handshake.outcome).toEqual({ state: "waiting" });
  });

  it("stays waiting when it is never offered a body", () => {
    const handshake = createHandshake(options());

    expect(handshake.receive(ready())).toEqual({
      action: "accept",
      body: { coreVersion: "0.1.0", bulkPages: 3 },
    });
    // The accept has now happened; before it, `outcome` was waiting, which is
    // asserted by the case above and by the invalid-body cases below.
    expect(handshake.outcome).toEqual({ state: "accepted", bulkPages: 3 });
  });
});

describe("createHandshake accept", () => {
  it("accepts a matching ready once and carries options into the body", () => {
    const handshake = createHandshake(options({ coreVersion: "0.1.0", bulkPages: 3 }));

    const reply = handshake.receive(ready());

    expect(acceptBody(reply)).toEqual({ coreVersion: "0.1.0", bulkPages: 3 });
    expect(handshake.outcome).toEqual({ state: "accepted", bulkPages: 3 });
  });

  it("accepts only once: a second matching ready is silent", () => {
    const handshake = createHandshake(options());

    const first = handshake.receive(ready());
    const second = handshake.receive(ready());

    expect(first.action).toBe("accept");
    expect(second).toEqual({ action: "none" });
    expect(handshake.outcome).toEqual({ state: "accepted", bulkPages: 3 });
  });

  it("does not answer before the ready arrives", () => {
    const handshake = createHandshake(options());

    // Nothing else can produce a verdict: the only input the machine accepts is
    // a ready body, so a machine that has never seen one is still waiting.
    expect(handshake.outcome).toEqual({ state: "waiting" });
  });
});

/* ------------------------------------------------------------------ */
/* createHandshake reject and the silence that follows                 */
/* ------------------------------------------------------------------ */

describe("createHandshake reject", () => {
  it("rejects a mismatching ready with the expected and actual versions", () => {
    const handshake = createHandshake(options({ expectedBridgeVersion: "1.0.0" }));

    const reply = handshake.receive(ready({ bridgeVersion: "2.0.0" }));

    expect(rejectBody(reply)).toEqual({
      code: BRIDGE_VERSION_MISMATCH,
      expected: "1.0.0",
      actual: "2.0.0",
    });
    expect(handshake.outcome).toEqual({
      state: "rejected",
      code: BRIDGE_VERSION_MISMATCH,
      expected: "1.0.0",
      actual: "2.0.0",
    });
  });

  it("stays silent for three further frames after the reject", () => {
    const handshake = createHandshake(options());
    const first = handshake.receive(ready({ bridgeVersion: "2.0.0" }));

    expect(rejectBody(first).code).toBe(BRIDGE_VERSION_MISMATCH);

    // After `bridge.reject` the core sends nothing else. Three more offers,
    // deliberately of three different shapes, must all be silent.
    expect(handshake.receive(ready({ bridgeVersion: "2.0.0" }))).toEqual({ action: "none" });
    expect(handshake.receive(ready())).toEqual({ action: "none" });
    expect(handshake.receive({ t: "bulk.page", body: { page: 1 } })).toEqual({ action: "none" });

    // The verdict itself is unchanged: silence is not a state transition.
    expect(handshake.outcome).toEqual({
      state: "rejected",
      code: BRIDGE_VERSION_MISMATCH,
      expected: "1.0.0",
      actual: "2.0.0",
    });
  });

  it("never accepts after a reject, even for a matching version", () => {
    const handshake = createHandshake(options());

    handshake.receive(ready({ bridgeVersion: "2.0.0" }));
    const late = handshake.receive(ready());

    expect(late).toEqual({ action: "none" });
    expect(handshake.outcome.state).toBe("rejected");
  });

  it("never rejects after an accept, even for a mismatching version", () => {
    const handshake = createHandshake(options());

    handshake.receive(ready());
    const late = handshake.receive(ready({ bridgeVersion: "2.0.0" }));

    expect(late).toEqual({ action: "none" });
    expect(handshake.outcome.state).toBe("accepted");
  });
});

/* ------------------------------------------------------------------ */
/* createHandshake: bodies that are not a usable ready                 */
/* ------------------------------------------------------------------ */

describe("createHandshake invalid bodies", () => {
  const malformed: readonly { label: string; value: unknown }[] = [
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "a string", value: "1.0.0" },
    { label: "a number", value: 1 },
    { label: "an array", value: [] },
    { label: "a non-string appVersion", value: { appVersion: 1, bridgeVersion: "1.0.0" } },
    { label: "a non-string bridgeVersion", value: { appVersion: "9.9.9", bridgeVersion: 1 } },
    { label: "a missing bridgeVersion", value: { appVersion: "9.9.9" } },
    { label: "a missing appVersion", value: { bridgeVersion: "1.0.0" } },
    { label: "a whole frame envelope", value: { v: 1, ch: "control", seq: 1, t: "bridge.ready" } },
  ];

  it.each(malformed)("ignores $label and keeps waiting", ({ value }) => {
    const handshake = createHandshake(options());

    expect(handshake.receive(value)).toEqual({ action: "none" });
    expect(handshake.outcome).toEqual({ state: "waiting" });

    // A malformed body is not a version problem, so a later usable ready still
    // decides the handshake: ignoring it did not consume the machine.
    expect(handshake.receive(ready()).action).toBe("accept");
  });

  it("ignores a malformed body after an accept without changing the verdict", () => {
    const handshake = createHandshake(options());

    handshake.receive(ready());
    const before = handshake.outcome;
    const reply = handshake.receive(null);

    expect(reply).toEqual({ action: "none" });
    expect(handshake.outcome).toBe(before);
  });

  it("tolerates extra fields on an otherwise usable ready", () => {
    // A host may attach diagnostics to a frame body; they must not hide it.
    const handshake = createHandshake(options());
    const reply = handshake.receive({ ...ready(), diagnostic: { retries: 0 } });

    expect(acceptBody(reply).bulkPages).toBe(3);
  });

  it("treats an empty version string as a version mismatch, not a shape error", () => {
    // "" is a well-formed string, so the comparison decides, and the reject body
    // carries the evidence instead of the body being dropped silently.
    const handshake = createHandshake(options());
    const reply = handshake.receive(ready({ bridgeVersion: "" }));

    expect(rejectBody(reply)).toEqual({
      code: BRIDGE_VERSION_MISMATCH,
      expected: "1.0.0",
      actual: "",
    });
  });
});
