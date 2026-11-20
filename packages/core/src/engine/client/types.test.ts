/**
 * Contract tests for the engine client surface.
 *
 * Two kinds of assertion are mixed on purpose, exactly as in
 * `packages/core/src/engine/types.test.ts`:
 *
 * - compile-time, via `satisfies`, exhaustive `Record` mirrors and a handful of
 *   `@ts-expect-error` markers. Vitest does not type-check, so those markers are
 *   certified by `tsc --noEmit -p packages/core`: an `@ts-expect-error` that
 *   stops being an error is itself a `tsc` failure ("unused directive"). That is
 *   what makes "the union must not collapse" a real assertion instead of a
 *   comment.
 * - runtime, via the exported tuples and literal values, so the lists a consumer
 *   iterates are verified too, not just their types.
 *
 * Every assertion here must be able to fail from one deliberate source change.
 * The change each group is designed to catch is named in its description.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CODE_TO_KEY, ENGINE_CLIENT_ERROR_CODES, messageKeyFor } from "./errors";
import type { EngineClientError, EngineClientErrorCode } from "./errors";
import { DIAGNOSTIC_KINDS } from "./types";
import type {
  CapabilitySnapshot,
  Channel,
  ChannelPool,
  CommandRequest,
  CommandResult,
  DiagnosticKind,
  DiagnosticRecord,
  Endpoint,
  EngineEventEnvelope,
  EngineEventFrame,
  RuntimeScope,
} from "./types";

/**
 * Return its argument, typed as the full union.
 *
 * The identity function is what defeats control-flow narrowing: the test that
 * asserts "you must narrow before reading the flag map" has to hold a value the
 * compiler has NOT already narrowed to one member, and a local `const` assigned
 * from a literal is narrowed by construction.
 */
function snapshotOf(snapshot: CapabilitySnapshot): CapabilitySnapshot {
  return snapshot;
}

/**
 * The `unknown` arm, and the compile-time proof that it holds nothing else.
 *
 * The three-state contract is only worth having if the *unprobed* arm cannot
 * carry probe data, and a plain `satisfies UnknownArm` is not enough to show
 * that: an added **optional** field (`booleans?: ...`, which is exactly how a
 * collapse into the two-state shape looks) stays assignable and would slip
 * through. The key-set record below closes both directions:
 *
 * - `{ state: "unknown" } satisfies UnknownArm` fails when the arm gains a
 *   REQUIRED field;
 * - `Record<Exclude<keyof UnknownArm, "state">, never>` is `{}` only while the
 *   arm has no other key at all, so it fails when the arm gains an OPTIONAL
 *   one.
 *
 * The declaration is checked by `tsc`, not by vitest; the test reads it so it is
 * a real value rather than a type-level comment.
 */
type UnknownArm = Extract<CapabilitySnapshot, { state: "unknown" }>;
type UnknownArmExtraKeys = Exclude<keyof UnknownArm, "state">;

const UNKNOWN_ARM_BASE = { state: "unknown" } as const satisfies UnknownArm;
const UNKNOWN_ARM_EXTRA_KEYS: Record<UnknownArmExtraKeys, never> = {};

/**
 * True only when `K` names **exactly** every key of `T`.
 *
 * A `Record<keyof T, true>` mirror catches a member being added or removed, but
 * it cannot see a member being *loosened* (`subject` -> `subject?`), because the
 * key set is unchanged. These two helpers close that gap, and each one is used
 * as `const x: Helper<T, ...> = true`, so a `false` result is a plain type error
 * at the line that names the shape.
 *
 * - `ExactKeys` fails when `T` grows a key the tuple does not list;
 * - `AllRequired` fails when one of the listed keys becomes optional.
 *
 * Both matter for the same reason: an optional field on a discriminated arm is
 * how a tagged union quietly turns back into a bag of optional fields, and the
 * `satisfies` checks elsewhere in this file cannot see it.
 */
type ExactKeys<T, K extends keyof T> = Exclude<keyof T, K> extends never ? true : false;

/** True when a single key `K` of `T` is optional. */
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

/**
 * True only when **every** key in `K` is a required key of `T`.
 *
 * The per-key form matters. The obvious `Record<string, never> extends Pick<T, K>`
 * is a trap: `Record<string, never>` is assignable to an object type with
 * optional members (it just supplies none of them), so that version answers
 * "required" for an all-optional `K` and the check silently passes. Testing each
 * key separately, then asking whether any answer is `true`, is the version that
 * actually fails on `subject?: string`.
 */
type AllRequired<T, K extends keyof T> = true extends { [P in K]: IsOptional<T, P> }[K]
  ? false
  : true;

/** True when `X` and `Y` are the same type (`readonly` is erased by this check). */
type IfEquals<X, Y, A, B> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? A : B;

/**
 * True when `K` is a `readonly` key of `T`.
 *
 * The trick: mapping `{ [P in K]: T[P] }` keeps the modifier while
 * `{ -readonly [P in K]: T[P] }` strips it, and the two are identical exactly
 * when there was no `readonly` to strip.
 *
 * Why it is needed at all: neither `keyof T` nor `Pick` can see `readonly`, so a
 * `Record<keyof T, true>` mirror - and even `ExactKeys` - accepts a field being
 * made mutable. That gap was real: `at` could be made writable with every other
 * assertion still green, and a restamped diagnostic is a diagnostic whose time
 * nobody measured.
 */
type IsReadonly<T, K extends keyof T> = IfEquals<
  { [P in K]: T[P] },
  { -readonly [P in K]: T[P] },
  false,
  true
>;

/** True only when **every** key of `T` is readonly. */
type AllReadonly<T> = false extends { [K in keyof T]-?: IsReadonly<T, K> }[keyof T] ? false : true;

describe("EngineClientErrorCode", () => {
  it("has exactly the seven documented codes, in documentation order", () => {
    expect([...ENGINE_CLIENT_ERROR_CODES]).toEqual([
      "TIMEOUT",
      "UNKNOWN_COMMAND",
      "REJECTED",
      "NOT_CONNECTED",
      "SEND_FAILED",
      "MALFORMED_RESPONSE",
      "AUTH_FAILED",
    ]);
  });

  it("lists each code once, and a new code is a compile error here", () => {
    // Compile-time mirror: removing a code makes this object have a surplus key,
    // adding one makes it miss a key. Either way `tsc` fails on the next line.
    const covered: Record<EngineClientErrorCode, true> = {
      TIMEOUT: true,
      UNKNOWN_COMMAND: true,
      REJECTED: true,
      NOT_CONNECTED: true,
      SEND_FAILED: true,
      MALFORMED_RESPONSE: true,
      AUTH_FAILED: true,
    };

    expect(Object.keys(covered).sort()).toEqual([...ENGINE_CLIENT_ERROR_CODES].sort());
    expect(new Set(ENGINE_CLIENT_ERROR_CODES).size).toBe(ENGINE_CLIENT_ERROR_CODES.length);
    expect(ENGINE_CLIENT_ERROR_CODES).toHaveLength(7);
  });
});

describe("EngineClientError", () => {
  it("builds one error per code with a non-empty ASCII detail and no engineText key", () => {
    const errors = ENGINE_CLIENT_ERROR_CODES.map(
      (code) =>
        ({
          code,
          detail: `simulated ${code.toLowerCase()} failure`,
        }) satisfies EngineClientError,
    );

    expect(errors).toHaveLength(7);

    for (const error of errors) {
      expect(error.detail).not.toBe("");
      // `detail` is ASCII-only so it prints in any terminal locale. This fails
      // the moment a caller puts engine output or a translated string in it.
      expect(/^[\x20-\x7e]+$/.test(error.detail)).toBe(true);
      // exactOptionalPropertyTypes: absent, never an explicit `undefined`.
      expect(Object.hasOwn(error, "engineText")).toBe(false);
    }
  });

  it("keeps the engine's own words in engineText, untouched and non-ASCII", () => {
    const withText = {
      code: "REJECTED",
      detail: "engine refused conversation.sync",
      engineText: "prepare_expired: 预览已过期",
    } satisfies EngineClientError;

    // The branch key is the code; engineText is quoted, not interpreted.
    expect(withText.code).toBe("REJECTED");
    expect(withText.engineText).toBe("prepare_expired: 预览已过期");
  });

  it("is readonly, so a holder cannot rewrite the branch key", () => {
    const error: EngineClientError = { code: "TIMEOUT", detail: "timed out" };

    // @ts-expect-error - `code` is readonly; mutating it would make the branch that produced this value unreproducible.
    error.code = "REJECTED";

    // `readonly` is compile-time only, so the assignment DOES land at run time.
    // Asserting the change (not the absence of one) is what keeps this test
    // meaningful: it fails if the property becomes writable in a way that also
    // stops being a type error, and the directive above covers the other half.
    expect(error.code).toBe("REJECTED");
  });
});

describe("CODE_TO_KEY", () => {
  it("has exactly one message key per code", () => {
    expect(Object.keys(CODE_TO_KEY)).toHaveLength(7);
    expect(Object.keys(CODE_TO_KEY).sort()).toEqual([...ENGINE_CLIENT_ERROR_CODES].sort());
  });

  it("uses the engine.client namespace, lowerCamelCase segments", () => {
    for (const key of Object.values(CODE_TO_KEY)) {
      expect(key).toMatch(/^engine\.client\.[a-z][a-zA-Z0-9]*$/);
    }
  });

  it("keeps every key unique, so no two codes resolve to one message", () => {
    const keys = Object.values(CODE_TO_KEY);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("resolves a code that is only known at run time", () => {
    for (const code of ENGINE_CLIENT_ERROR_CODES) {
      expect(messageKeyFor(code)).toBe(CODE_TO_KEY[code]);
      expect(messageKeyFor(code)).not.toBe("");
    }
  });

  it("keeps the frozen spelling of every key, character for character", () => {
    // The exact table, not a derived pattern: a key is a message id a catalogue
    // resolves by name, so renaming one is a catalogue change and must show up
    // as a failing assertion rather than as a silently missing translation.
    expect(CODE_TO_KEY).toEqual({
      TIMEOUT: "engine.client.timeout",
      UNKNOWN_COMMAND: "engine.client.unknownCommand",
      REJECTED: "engine.client.rejected",
      NOT_CONNECTED: "engine.client.notConnected",
      SEND_FAILED: "engine.client.sendFailed",
      MALFORMED_RESPONSE: "engine.client.malformedResponse",
      AUTH_FAILED: "engine.client.authFailed",
    });
  });
});

describe("CapabilitySnapshot", () => {
  // The three states, each built once. The `satisfies` clauses are the
  // compile-time half: breaking a member's shape breaks the line that names it.
  const unknownSnapshot = { state: "unknown" } satisfies CapabilitySnapshot;

  const probedSnapshot = {
    state: "probed",
    booleans: { agentManagement: true, terminal: false },
    slashCommands: ["/memory", "/compact"],
    probedAt: 1_700_000_000_000,
  } satisfies CapabilitySnapshot;

  const emptySnapshot = {
    state: "confirmed-empty",
    probedAt: 1_700_000_000_000,
  } satisfies CapabilitySnapshot;

  it("keeps the three states distinct, with distinct discriminants", () => {
    const states = [unknownSnapshot.state, probedSnapshot.state, emptySnapshot.state];

    expect(states).toEqual(["unknown", "probed", "confirmed-empty"]);
    expect(new Set(states).size).toBe(3);
  });

  it("records a timestamp for both answered states and none for unknown", () => {
    // "not asked yet" and "asked, nothing there" differ by exactly this: an
    // unknown snapshot has no probe time to report, so it cannot masquerade as
    // an answered one.
    expect(Object.hasOwn(probedSnapshot, "probedAt")).toBe(true);
    expect(Object.hasOwn(emptySnapshot, "probedAt")).toBe(true);
    expect(Object.hasOwn(unknownSnapshot, "probedAt")).toBe(false);
  });

  it("keeps an empty probed snapshot legal and still probed", () => {
    // A probe that answered with nothing is reported as `probed` with empty
    // collections only when it really did answer; it must not be rewritten into
    // `confirmed-empty` by this layer, which does not decide that.
    const probedNothing = {
      state: "probed",
      booleans: {},
      slashCommands: [],
      probedAt: 1_700_000_000_001,
    } satisfies CapabilitySnapshot;

    expect(probedNothing.state).toBe("probed");
    expect(probedNothing.slashCommands).toEqual([]);
    expect(probedNothing.state).not.toBe(emptySnapshot.state);
  });

  it("does not let the unknown state carry probe data", () => {
    // Compile-time: the arm has exactly one key. See UNKNOWN_ARM_EXTRA_KEYS -
    // an optional field added to this arm is the collapse into two states, and
    // that record stops being `{}` the moment it happens.
    expect(Object.keys(UNKNOWN_ARM_BASE)).toEqual(["state"]);
    expect(Object.keys(UNKNOWN_ARM_EXTRA_KEYS)).toEqual([]);

    // @ts-expect-error - `unknown` is its own arm. Attaching the flag map to it
    // is the collapse this union exists to prevent.
    const unknownWithFlags: CapabilitySnapshot = { state: "unknown", booleans: {} };

    expect(unknownWithFlags.state).toBe("unknown");
  });

  it("does not let a probed snapshot omit what the probe found", () => {
    // @ts-expect-error - `probedAt` is required on the probed arm; making it
    // optional is how the three-state union starts collapsing into two.
    const probedWithoutStamp: CapabilitySnapshot = {
      state: "probed",
      booleans: {},
      slashCommands: [],
    };

    expect(probedWithoutStamp.state).toBe("probed");
  });

  it("does not let confirmed-empty borrow the probed fields", () => {
    // Type-level rather than `@ts-expect-error` on an excess property: the
    // excess-property diagnostic is reported at the offending property's
    // position, so a formatter that reflows the object literal moves the line
    // out from under the directive and `tsc` then reports the directive as
    // unused. Pinning the arm's exact key set is formatting-independent and
    // says the same thing: `confirmed-empty` carries a probe time and nothing
    // else.
    type EmptyArm = Extract<CapabilitySnapshot, { state: "confirmed-empty" }>;
    const exact: ExactKeys<EmptyArm, "state" | "probedAt"> = true;
    const required: AllRequired<EmptyArm, "state" | "probedAt"> = true;

    expect([exact, required]).toEqual([true, true]);
    expect(Object.keys(emptySnapshot).sort()).toEqual(["probedAt", "state"]);
  });

  it("does not let one answered state stand in for the other", () => {
    // @ts-expect-error - the two answered states are not interchangeable: only
    // the probed one promises a flag map, and a caller narrowing on it must not
    // be handed an object that never had one.
    const probedFromEmpty: Extract<CapabilitySnapshot, { state: "probed" }> = emptySnapshot;

    expect(probedFromEmpty).toBe(emptySnapshot);
  });

  it("forces a narrowing before the flag map can be read", () => {
    // Passed through a function on purpose: assigning `probedSnapshot` straight
    // to an annotated local narrows the local to that one member, which would
    // make the property access below legal for the wrong reason.
    const snapshot = snapshotOf(probedSnapshot);

    // @ts-expect-error - reading `booleans` requires narrowing on `state` first. If the union ever collapses into one interface with optional fields, this line stops being an error and `tsc` reports the directive as unused - which is the tripwire.
    const flagsWithoutNarrowing = snapshot.booleans;

    // Run time only proves the field is really there once narrowed; the type
    // guard is the directive above.
    expect(flagsWithoutNarrowing).toBeDefined();

    if (snapshot.state === "probed") {
      expect(snapshot.booleans.agentManagement).toBe(true);
      expect(snapshot.slashCommands).toContain("/memory");
    }
  });
});

describe("DiagnosticRecord", () => {
  it("has exactly the six documented kinds, and a new kind is a compile error", () => {
    const covered: Record<DiagnosticKind, true> = {
      timeout: true,
      "unknown-command": true,
      "unknown-event": true,
      rejected: true,
      "send-failed": true,
      malformed: true,
    };

    expect([...DIAGNOSTIC_KINDS]).toEqual([
      "timeout",
      "unknown-command",
      "unknown-event",
      "rejected",
      "send-failed",
      "malformed",
    ]);
    expect(Object.keys(covered).sort()).toEqual([...DIAGNOSTIC_KINDS].sort());
    expect(DIAGNOSTIC_KINDS).toHaveLength(6);
  });

  it("requires a kind and a subject, and keeps engine text optional", () => {
    const bare = {
      at: 1_700_000_000_000,
      kind: "unknown-event",
      subject: "topic_report",
    } satisfies DiagnosticRecord;
    const explained = {
      at: 1_700_000_000_001,
      kind: "rejected",
      subject: "conversation.sync",
      engineText: "prepare_expired",
      engineVersion: "0.6.0",
    } satisfies DiagnosticRecord;

    expect(Object.keys(bare).sort()).toEqual(["at", "kind", "subject"]);
    expect(Object.hasOwn(bare, "engineText")).toBe(false);
    expect(explained.engineText).toBe("prepare_expired");
    expect(explained.engineVersion).toBe("0.6.0");
  });

  it("carries a timestamp, because a diagnostic with no time cannot be matched to 'it broke just now'", () => {
    // The diagnostic surface asks for a code, the operation, a TIME and the
    // engine version. The other four fields are asserted elsewhere; this one is
    // the field that had nowhere to live.
    const record = {
      at: 1_700_000_000_000,
      kind: "timeout",
      subject: "conversation.sync",
    } satisfies DiagnosticRecord;

    expect(typeof record.at).toBe("number");
    expect(Number.isInteger(record.at)).toBe(true);
    // Our clock, in epoch milliseconds: the same unit as `EngineEventFrame.at`,
    // and not a monotonic counter, so it is comparable with `Date.now()`.
    expect(record.at).toBeGreaterThan(1_600_000_000_000);
    expect(record.at).toBeLessThanOrEqual(Date.now());
  });

  it("makes at required, so a record cannot be built without a time", () => {
    // @ts-expect-error - `at` is required. Dropping it is exactly the defect this test exists to prevent: the diagnostic surface would have no time to show, and the record would compile anyway.
    const noTimestamp: DiagnosticRecord = { kind: "malformed", subject: "sync_response" };

    // Run time does not enforce the shape; the directive above is the guard.
    expect(Object.hasOwn(noTimestamp, "at")).toBe(false);
  });

  it("types at as our epoch millis, not as the engine's emitted_at string", () => {
    const record: DiagnosticRecord = { at: Date.now(), kind: "rejected", subject: "message.send" };

    // @ts-expect-error - `at` is a number. A string would invite passing the engine's `emitted_at` (unknown timezone, unknown clock) straight through, which is the comparison the two fields must never allow.
    record.at = "2024-03-01T10:30:00.000Z";

    // Compile-time only: the write lands at run time (see the `code` case in the
    // EngineClientError block), so the assertion records the type guard.
    expect(record.at).toBe("2024-03-01T10:30:00.000Z");
  });

  it("makes at readonly, so a record cannot be restamped after the fact", () => {
    const record: DiagnosticRecord = { at: 1_700_000_000_000, kind: "timeout", subject: "sync" };

    // @ts-expect-error - `at` is readonly. A record's whole value is that it says when the failure happened; letting a later holder overwrite it would make the diagnostic surface show a time nobody measured.
    record.at = 1_700_000_000_001;

    // Compile-time only: the write lands at run time, so the assertion records
    // that the guard is the type (same pattern as `EngineClientError.code`).
    expect(record.at).toBe(1_700_000_000_001);
  });

  it("keeps at, kind and subject required while the two engine fields stay optional", () => {
    // `subject` is what makes a record findable; `at` is what makes it placeable
    // in time. Making either optional would let a diagnostic arrive with no way
    // to say what it is about or when it happened.
    const required: AllRequired<DiagnosticRecord, "at" | "kind" | "subject"> = true;
    const optional: undefined extends DiagnosticRecord["engineText"] ? true : false = true;
    const keys: ExactKeys<
      DiagnosticRecord,
      "at" | "kind" | "subject" | "engineText" | "engineVersion"
    > = true;

    expect([required, optional, keys]).toEqual([true, true, true]);
  });

  it("does not let the optional engine fields become required", () => {
    // The complementary direction to the check above: `AllRequired` proves the
    // three required keys really are required, and this proves the two optional
    // ones did not silently turn required (which would break every caller that
    // has no engine text to attach).
    const engineTextOptional: AllRequired<DiagnosticRecord, "engineText"> = false;
    const engineVersionOptional: AllRequired<DiagnosticRecord, "engineVersion"> = false;

    expect([engineTextOptional, engineVersionOptional]).toEqual([false, false]);
  });

  it("keeps every field readonly, at included", () => {
    // `readonly` is invisible to the key-set checks above, so it gets its own
    // assertion: a record whose `at` can be rewritten is a record whose time is
    // whatever the last holder decided it was.
    const allReadonly: AllReadonly<DiagnosticRecord> = true;
    const atReadonly: IsReadonly<DiagnosticRecord, "at"> = true;
    const allRequiredReadonly: AllReadonly<Pick<DiagnosticRecord, "at" | "kind" | "subject">> =
      true;

    expect([allReadonly, atReadonly, allRequiredReadonly]).toEqual([true, true, true]);
  });
});

describe("RuntimeScope", () => {
  it("carries both ids, with a nullable agent id", () => {
    const bound = { agent_id: "agent-1", conversation_id: "conv-1" } satisfies RuntimeScope;
    const unbound = { agent_id: null, conversation_id: "conv-1" } satisfies RuntimeScope;

    expect(Object.keys(bound).sort()).toEqual(["agent_id", "conversation_id"]);
    // The key stays present with `null` rather than disappearing: a constant
    // shape is what makes the object safe to forward and to log.
    expect(Object.keys(unbound).sort()).toEqual(["agent_id", "conversation_id"]);
    expect(unbound.agent_id).toBeNull();
  });

  it("keeps both keys required, so a scope is never half-specified", () => {
    // `agent_id?` would make "this scope is not bound to an agent" and "the
    // caller forgot the field" the same value, which is exactly the ambiguity
    // the nullable-instead-of-optional choice exists to remove.
    const required: AllRequired<RuntimeScope, "agent_id" | "conversation_id"> = true;
    const keys: ExactKeys<RuntimeScope, "agent_id" | "conversation_id"> = true;
    const nullable: string | null = "agent-1";

    expect([required, keys]).toEqual([true, true]);
    expect(nullable).toBe("agent-1");
  });
});

describe("CommandRequest / CommandResult", () => {
  it("names a command by capability, never by wire id", () => {
    const minimal = { capability: "conversation.sync", body: {} } satisfies CommandRequest;

    expect(minimal.capability).toBe("conversation.sync");
    expect(Object.hasOwn(minimal, "runtime")).toBe(false);
    expect(Object.hasOwn(minimal, "timeoutMs")).toBe(false);
  });

  it("rejects a wire id where a capability name belongs", () => {
    // @ts-expect-error - a wire id is not a capability name. Widening
    // `CommandRequest["capability"]` to `string` makes this line legal and the
    // unused directive fails `tsc`, which is the tripwire for the rule that
    // `packages/core` holds no wire vocabulary.
    const wireIdRequest: CommandRequest = { capability: "runtime_start", body: {} };

    expect(wireIdRequest.body).toEqual({});
  });

  it("accepts the full request form with every optional field set", () => {
    const full = {
      capability: "message.send",
      body: { content: "hi" },
      requestId: "req-1",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      timeoutMs: 10_000,
    } satisfies CommandRequest;

    expect(Object.keys(full).sort()).toEqual([
      "body",
      "capability",
      "requestId",
      "runtime",
      "timeoutMs",
    ]);
  });

  it("separates success from failure, and each arm carries only its own fields", () => {
    const success = {
      ok: true,
      data: { status: "accepted" },
      raw: { any: "frame" },
    } satisfies CommandResult;
    const failure = {
      ok: false,
      error: { code: "NOT_CONNECTED", detail: "no live channel for agent-1" },
    } satisfies CommandResult;

    expect(success.ok).toBe(true);
    expect(Object.hasOwn(success, "error")).toBe(false);
    expect(failure.ok).toBe(false);
    expect(Object.hasOwn(failure, "data")).toBe(false);
    expect(Object.hasOwn(failure, "raw")).toBe(false);
  });

  it("keeps each arm's key set exact, so neither arm grows an optional stray", () => {
    // A mirror of `keyof` alone cannot catch `data?` being added to the failure
    // arm; ExactKeys + AllRequired do, and they are checked by `tsc`.
    const successKeys: ExactKeys<
      Extract<CommandResult, { ok: true }>,
      "ok" | "data" | "raw"
    > = true;
    const failureKeys: ExactKeys<Extract<CommandResult, { ok: false }>, "ok" | "error"> = true;
    const successRequired: AllRequired<
      Extract<CommandResult, { ok: true }>,
      "ok" | "data" | "raw"
    > = true;
    const failureRequired: AllRequired<
      Extract<CommandResult, { ok: false }>,
      "ok" | "error"
    > = true;

    expect([successKeys, failureKeys, successRequired, failureRequired]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("carries the raw answer untouched beside the decoded one", () => {
    const raw = { type: "sync_response", request_id: "req-1", success: true };
    const success = { ok: true, data: { replayed: true }, raw } satisfies CommandResult;

    if (success.ok) {
      // Identity, not deep equality: `raw` is the same object the decoder saw,
      // so a field this layer does not mirror is still reachable.
      expect(success.raw).toBe(raw);
    }
  });
});

describe("EngineEventFrame", () => {
  it("carries the engine's own type as a plain string", () => {
    const frame = {
      type: "some_future_event",
      raw: { type: "some_future_event", anything: 1 },
      at: 1_700_000_000_000,
    } satisfies EngineEventFrame;

    expect(frame.type).toBe("some_future_event");
    expect(frame.at).toBeTypeOf("number");
    // No envelope block on this frame: absent, not an explicit undefined.
    expect(Object.hasOwn(frame, "envelope")).toBe(false);
  });

  it("passes the envelope through verbatim, every field optional", () => {
    const empty: EngineEventEnvelope = {};
    const full = {
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      event_seq: 12,
      emitted_at: "2024-03-01T10:30:00.000Z",
      idempotency_key: "idem-1",
    } satisfies EngineEventEnvelope;

    expect(Object.keys(empty)).toHaveLength(0);
    expect(Object.keys(full).sort()).toEqual([
      "emitted_at",
      "event_seq",
      "idempotency_key",
      "runtime",
    ]);
    // `emitted_at` keeps the wire's string form: converting it here would be
    // interpretation, and `at` on the frame is our own receive clock.
    expect(full.emitted_at).toBeTypeOf("string");
  });

  it("keeps a partial envelope legal, so a half-filled block is not a parse failure", () => {
    const partial = { event_seq: 3 } satisfies EngineEventEnvelope;

    expect(partial.event_seq).toBe(3);
    expect(Object.hasOwn(partial, "runtime")).toBe(false);
  });

  it("keeps every envelope field optional and its key set exact", () => {
    const allOptional: undefined extends EngineEventEnvelope["event_seq"] ? true : false = true;
    const keys: ExactKeys<
      EngineEventEnvelope,
      "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
    > = true;
    // `emitted_at` stays the wire's string form; turning it into a number here
    // would be interpretation, and `at` on the frame is our own clock.
    const stringStamp: EngineEventEnvelope["emitted_at"] = "2024-03-01T10:30:00.000Z";

    expect([allOptional, keys]).toEqual([true, true]);
    expect(stringStamp).toBe("2024-03-01T10:30:00.000Z");
  });

  it("keeps the frame's own three fields required and the envelope optional", () => {
    const required: AllRequired<EngineEventFrame, "type" | "raw" | "at"> = true;
    const envelopeOptional: undefined extends EngineEventFrame["envelope"] ? true : false = true;
    const frameKeys: ExactKeys<EngineEventFrame, "type" | "raw" | "at" | "envelope"> = true;
    const atIsNumber: AllRequired<EngineEventFrame, "at"> = true;

    expect([required, envelopeOptional, frameKeys, atIsNumber]).toEqual([true, true, true, true]);
  });

  it("keeps the frame's own fields readonly, at included", () => {
    // Same gap as the diagnostic record: `at` is the frame's receive time, and a
    // mutable one lets a consumer fake an ordering by restamping.
    const allReadonly: AllReadonly<EngineEventFrame> = true;
    const atReadonly: IsReadonly<EngineEventFrame, "at"> = true;

    expect([allReadonly, atReadonly]).toEqual([true, true]);
  });
});

describe("Channel / ChannelPool", () => {
  it("exposes exactly the six documented Channel members", () => {
    // Compile-time mirror of the signed signature: adding a member to `Channel`
    // makes this record miss a key, removing one makes it have a surplus key.
    const members: Record<keyof Channel, true> = {
      agentId: true,
      send: true,
      onEvent: true,
      onDiagnostic: true,
      capabilities: true,
      close: true,
    };

    expect(Object.keys(members).sort()).toEqual([
      "agentId",
      "capabilities",
      "close",
      "onDiagnostic",
      "onEvent",
      "send",
    ]);
    expect(Object.keys(members)).toHaveLength(6);
  });

  it("pins the Channel signatures: async send, unsubscribe-returning subscriptions", async () => {
    // The signed signature is `Promise<CommandResult>`; a union with a bare
    // result would let an implementation answer synchronously, and every caller
    // that `await`s would still compile while the contract changed.
    const sendIsAsync: Channel["send"] extends (request: CommandRequest) => Promise<CommandResult>
      ? true
      : false = true;
    const unsubscribeShape: Channel["onEvent"] extends (
      subscriber: (frame: EngineEventFrame) => void,
    ) => () => void
      ? true
      : false = true;
    const diagnosticShape: Channel["onDiagnostic"] extends (
      subscriber: (record: DiagnosticRecord) => void,
    ) => () => void
      ? true
      : false = true;
    const snapshotShape: Channel["capabilities"] extends () => CapabilitySnapshot ? true : false =
      true;

    expect([sendIsAsync, unsubscribeShape, diagnosticShape, snapshotShape]).toEqual([
      true,
      true,
      true,
      true,
    ]);

    const send: Channel["send"] = () =>
      Promise.resolve({
        ok: false,
        error: { code: "NOT_CONNECTED", detail: "no live channel for agent-1" },
      } satisfies CommandResult);
    const onEvent: Channel["onEvent"] = (subscriber) => {
      void subscriber;
      return () => undefined;
    };
    const capabilities: Channel["capabilities"] = () => ({ state: "unknown" });
    const close: Channel["close"] = () => undefined;

    const result = send({ capability: "agent.list", body: {} });
    // `send` returns a promise and resolves its failures; it never throws.
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toMatchObject({ ok: false });

    const unsubscribe = onEvent(() => undefined);
    expect(unsubscribe).toBeTypeOf("function");
    expect(unsubscribe()).toBeUndefined();

    expect(capabilities().state).toBe("unknown");
    expect(close()).toBeUndefined();
  });

  it("exposes exactly the four documented ChannelPool members", () => {
    const members: Record<keyof ChannelPool, true> = {
      getChannel: true,
      channels: true,
      closeChannel: true,
      closeAll: true,
    };

    expect(Object.keys(members).sort()).toEqual([
      "channels",
      "closeAll",
      "closeChannel",
      "getChannel",
    ]);
    expect(Object.keys(members)).toHaveLength(4);
  });

  it("takes an optional conversation id as a scope, not a second connection", () => {
    const getChannel: ChannelPool["getChannel"] = (agentId, conversationId) => ({
      agentId,
      send: () =>
        Promise.resolve({
          ok: false,
          error: { code: "NOT_CONNECTED", detail: conversationId ?? "no scope" },
        } satisfies CommandResult),
      onEvent: () => () => undefined,
      onDiagnostic: () => () => undefined,
      capabilities: () => ({ state: "unknown" }),
      close: () => undefined,
    });

    // Both call shapes are legal: with and without a conversation id.
    expect(getChannel("agent-1").agentId).toBe("agent-1");
    expect(getChannel("agent-1", "conv-1").agentId).toBe("agent-1");
  });
});

describe("Endpoint", () => {
  it("holds exactly a url and a token", () => {
    const endpoint = { url: "ws://127.0.0.1:1234", token: "secret" } satisfies Endpoint;

    expect(Object.keys(endpoint).sort()).toEqual(["token", "url"]);
  });

  it("is readonly, so the token cannot be swapped after resolution", () => {
    const endpoint: Endpoint = { url: "ws://127.0.0.1:1234", token: "secret" };

    // @ts-expect-error - both fields are readonly; a mutable token field invites a later "refresh in place" that would bypass the token file.
    endpoint.token = "other";

    // Compile-time only: the write lands at run time, so the assertion records
    // that the guard is the type, not the object (see the `code` case above).
    expect(endpoint.token).toBe("other");
    expect(endpoint.url).toBe("ws://127.0.0.1:1234");
  });
});

describe("wire vocabulary", () => {
  /** The two source files this suite scans, relative to this test. */
  const OWNED_SOURCES = ["types.ts", "errors.ts"] as const;

  /**
   * Distinctive wire ids, the ones a developer would paste after reading the
   * engine's protocol. Deliberately NOT the full `CAPABILITY_TO_WIRE` value set:
   * several real wire ids are ordinary English words (`sync`, `input`,
   * `get_tree`) that a doc comment may legitimately contain, and a scan that
   * flags prose would be deleted rather than fixed.
   */
  const WIRE_ID_SAMPLES = [
    "runtime_start",
    "execute_command",
    "app_server_info",
    "change_device_state",
    "launch_subagent",
  ] as const;

  it("keeps every wire id out of the client layer", async () => {
    for (const file of OWNED_SOURCES) {
      const text = await readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8");

      for (const wireId of WIRE_ID_SAMPLES) {
        expect(text, `${file} must not name the wire id ${wireId}`).not.toContain(wireId);
      }
    }
  });
});
