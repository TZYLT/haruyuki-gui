/**
 * Tests for the send path.
 *
 * The module under test is a pure function, so the evidence has to come from
 * somewhere other than timing: every expectation below is compared either with
 * **the contract's own data** (`capabilities.json` for the 68 rows,
 * `snapshot.json` for each command's fields and for which reply frames exist) or
 * with a **hand-written frame**, and never with the module's own output.
 *
 * Why the contract is read at test time rather than transcribed:
 *
 * - A transcribed expectation is a second copy of the table that cannot disagree
 *   with it, so it proves only that the copy was typed twice. `snapshot.json`
 *   says which wire declares `request_id`, whether it is optional, and whether it
 *   carries a `runtime` object; deriving from it means a contract change moves
 *   these tests with it instead of leaving them asserting the old shape.
 * - The one property carried by prose - "which frame acknowledges which command" -
 *   is derived by a rule (`<wire>_` prefix over the message list) that
 *   deliberately fails for the single capability whose acknowledgement is not
 *   `<wire>_response`, and the suite pins that both ways.
 *
 * Every case names the edit that turns it red in the comment above it. A case
 * without such an edit would not be a test.
 *
 * No wire id literal appears in this file: pick-path scans the whole `client/`
 * directory, so the wire vocabulary is always read from the contract or reached
 * through `wireIdOf`. The literals a leak guard needs live in
 * `capability-names.test.ts`, which is the file exempted for that purpose.
 *
 * There is no promise here to settle: `buildFrame` is synchronous, writes nothing
 * and starts no timer. The `expectSettles` discipline that `channel.ts` needs
 * to `channel.ts`, not to this module - and the gate run at the end proves no
 * handle leaked anyway.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_NAMES,
  completionOf,
  findCapability,
  hasOptionalRequestId,
  scopeCarrierOf,
  tracksInFlight,
  tracksInFlightWith,
  wireIdOf,
} from "./capability-names";
import type { CapabilityName, CompletionMode } from "./capability-names";
import { buildFrame } from "./send";
import type { OutgoingFrame } from "./send";
import { defaultTimeoutMs, maxTimeoutMs, resolveTimeout } from "./timeouts";
import type { CommandRequest, RuntimeScope } from "./types";

/* ------------------------------------------------------------------------- */
/* Contract truth sources                                                    */
/* ------------------------------------------------------------------------- */

const CAPABILITIES_URL = new URL(
  "../../../../protocol/src/contract/capabilities.json",
  import.meta.url,
);
const SNAPSHOT_URL = new URL("../../../../protocol/src/contract/snapshot.json", import.meta.url);

/** One field of one snapshot command. */
interface SnapshotField {
  readonly name: string;
  readonly optional: boolean;
}

/** One snapshot command, narrowed to what the send path has to honour. */
interface SnapshotCommand {
  readonly wire: string | undefined;
  readonly fields: readonly SnapshotField[];
}

/** Narrow an unknown to a JSON object, failing loudly rather than silently. */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Read and parse one JSON artifact from the contract package. */
function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

/** The snapshot's command records, keyed by wire id. */
const SNAPSHOT_COMMANDS: ReadonlyMap<string, SnapshotCommand> = (() => {
  const root = requireRecord(readJson(SNAPSHOT_URL), "snapshot.json");
  const rows = root["commands"];
  if (!Array.isArray(rows)) {
    throw new Error("snapshot.json: commands must be an array");
  }
  const table = new Map<string, SnapshotCommand>();
  for (const row of rows as readonly Record<string, unknown>[]) {
    const wire = String(row["wire"]);
    const fields = Array.isArray(row["fields"]) ? row["fields"] : [];
    table.set(wire, {
      wire,
      fields: (fields as readonly Record<string, unknown>[]).map((field) => ({
        name: String(field["name"]),
        optional: field["optional"] === true,
      })),
    });
  }
  return table;
})();

/** Every server-to-client wire id, in contract order. */
const MESSAGE_WIRES: readonly string[] = (() => {
  const root = requireRecord(readJson(SNAPSHOT_URL), "snapshot.json");
  const rows = root["messages"];
  if (!Array.isArray(rows)) {
    throw new Error("snapshot.json: messages must be an array");
  }
  return (rows as readonly Record<string, unknown>[]).map((row) => String(row["wire"]));
})();

/**
 * The acknowledgment frame for one command wire, derived by a prefix rule.
 *
 * `<wire>_response` is the spelling 67 of the 68 capabilities use; the rule
 * accepts any message starting with `<wire>_` so the exception is found too -
 * and the "exactly one exception" test below is what makes that leniency honest
 * rather than a hole.
 *
 * @param wire the command wire id
 * @returns the reply wire, or `undefined` when nothing answers the command
 */
function derivedReplyFor(wire: string): string | undefined {
  return MESSAGE_WIRES.find((message) => message.startsWith(`${wire}_`));
}

/** The command's snapshot record, failing loudly when the contract lost one. */
function snapshotFor(name: CapabilityName): SnapshotCommand {
  const command = SNAPSHOT_COMMANDS.get(wireIdOf(name));
  if (command === undefined) {
    throw new Error(`snapshot.json: no command record for capability ${name}`);
  }
  return command;
}

/** Whether the command's wire declares a field with this name. */
function declares(name: CapabilityName, field: string): boolean {
  return snapshotFor(name).fields.some((entry) => entry.name === field);
}

/** Whether the command's wire declares `request_id` as optional. */
function declaresOptionalRequestId(name: CapabilityName): boolean {
  return snapshotFor(name).fields.some((entry) => entry.name === "request_id" && entry.optional);
}

/** A scope every scoped capability can be addressed with. */
const SCOPE: RuntimeScope = { agent_id: "agent-1", conversation_id: "conversation-1" };

/** Whether this capability needs a scope to be sendable at all. */
function scoped(name: CapabilityName): boolean {
  return scopeCarrierOf(name) !== "none";
}

/** A request that is valid for any capability, with a scope where one is needed. */
function requestFor(name: CapabilityName, overrides: Partial<CommandRequest> = {}): CommandRequest {
  const base: CommandRequest = {
    capability: name,
    body: {},
    ...(scoped(name) ? { runtime: SCOPE } : {}),
  };
  return { ...base, ...overrides };
}

/** Parse a frame back, and fail with the raw text when it is not JSON. */
function parseFrame(frame: OutgoingFrame): Record<string, unknown> {
  return requireRecord(JSON.parse(frame.raw) as unknown, `frame for ${frame.raw}`);
}

/** The keys of a frame, sorted, so an assertion can state the whole set. */
function keysOf(value: Record<string, unknown>): readonly string[] {
  return Object.keys(value).sort();
}

/** Build a frame with no optional ports and no minted id. */
function frameOf(request: CommandRequest, mintedId?: string): OutgoingFrame {
  return buildFrame(request, {}, mintedId);
}

/* ------------------------------------------------------------------------- */
/* The envelope the send path owns                                           */
/* ------------------------------------------------------------------------- */

describe("the send path builds the envelope", () => {
  it("emits exactly the fields a command needs, and nothing else", () => {
    // Red when: a field is added (event_seq, emitted_at, idempotency_key) or
    // dropped (type, request_id, runtime). The expected set is written out by
    // hand precisely so that "what the send path writes" is not derived from
    // "what the send path decided to write".
    const frame = frameOf(
      requestFor("message.send", { body: { payload: { kind: "x" } } }),
      "req-1",
    );

    expect(keysOf(parseFrame(frame))).toEqual(["payload", "request_id", "runtime", "type"]);
    expect(parseFrame(frame)["type"]).toBe(wireIdOf("message.send"));
    expect(parseFrame(frame)["request_id"]).toBe("req-1");
  });

  it("never writes the three server-side envelope fields", () => {
    // Red when: `idempotency_key`, `event_seq` or `emitted_at` is added to the
    // outbound frame. `RuntimeEnvelope` declares them, but it is a *server* shape:
    // no recorded c2s frame carries one, so writing one would be a field the
    // engine does not read (the same defect class as trap 3, inverted).
    const frame = parseFrame(frameOf(requestFor("device.info"), "req-2"));

    expect(keysOf(frame)).toEqual(["request_id", "type"]);
    expect(frame).not.toHaveProperty("event_seq");
    expect(frame).not.toHaveProperty("emitted_at");
    expect(frame).not.toHaveProperty("idempotency_key");
  });

  it("merges the body as named fields rather than nesting it", () => {
    // Red when: the body is sent under a `body` key, or as an array. The wire
    // commands take named fields (`path`, `content`, `agent_id`), and a nested
    // wrapper is a shape none of them declares.
    const frame = parseFrame(
      frameOf(requestFor("file.write", { body: { path: "/tmp/a", content: "x" } }), "minted-1"),
    );

    expect(frame["path"]).toBe("/tmp/a");
    expect(frame["content"]).toBe("x");
    expect(frame).not.toHaveProperty("body");
  });

  it("treats undefined and null bodies as an empty body", () => {
    // Red when: an absent body throws, or `null` is spread into the frame. Both
    // are the normal spelling for the commands that are all envelope. The
    // capability is one whose wire carries no id, so the whole frame should be
    // `type` and nothing else - a body contribution would show up as an extra key.
    expect(keysOf(parseFrame(frameOf(requestFor("terminal.input"))))).toEqual(["type"]);
    expect(keysOf(parseFrame(frameOf(requestFor("terminal.input", { body: null }))))).toEqual([
      "type",
    ]);
  });

  it("refuses a body that is not a plain object", () => {
    // Red when: the body is spread regardless. Spreading a string yields numeric
    // keys (`{"0":"a"}`), which is a body the engine cannot read and which the
    // caller never wrote. The minted id matters: without it this case would pass
    // for the wrong reason, because the capability would refuse the frame for a
    // missing id before the body was ever examined.
    for (const body of ["text", 42, true, ["a", "b"]]) {
      expect(
        () => frameOf(requestFor("agent.list", { body }), "minted-1"),
        `body ${JSON.stringify(body)} must be refused`,
      ).toThrow(/body must be a plain object/);
    }
  });

  it("refuses a body that sets a field the send path owns", () => {
    // Red when: the body is allowed to override `request_id` (the diagnostic-bundle-tree defect),
    // or is merged before the envelope is written. Every field here is one the
    // send path produces, so a caller setting it is assembling the envelope.
    const cases: readonly Record<string, unknown>[] = [
      { request_id: "caller-1" },
      { type: "something-else" },
      { runtime: SCOPE },
    ];

    for (const body of cases) {
      expect(
        () => frameOf(requestFor("message.send", { body })),
        `body ${JSON.stringify(body)} must be refused`,
      ).toThrow(/body must not set/);
    }
  });

  it("refuses the three server-side envelope fields in a body as well", () => {
    // Red when: only `type` and `request_id` are guarded. The whole envelope is
    // envelope as the client's, so a caller writing one is doing our work even
    // though we do not send that field ourselves.
    for (const key of ["event_seq", "emitted_at", "idempotency_key"]) {
      expect(
        () => frameOf(requestFor("device.info", { body: { [key]: 1 } })),
        `body field ${key} must be refused`,
      ).toThrow(/body must not set/);
    }
  });

  it("lets an unscoped command use the id-shaped fields its own wire declares", () => {
    // Red when: `agent_id` / `conversation_id` are reserved globally instead of
    // per carrier. These are ordinary body fields on dozens of commands, and
    // reserving them everywhere would refuse correct callers.
    const frame = parseFrame(
      frameOf(
        requestFor("conversation.get", { body: { conversation_id: "conversation-1" } }),
        "minted-1",
      ),
    );

    expect(frame["conversation_id"]).toBe("conversation-1");
  });

  it("refuses an own __proto__ key instead of losing it into the prototype", () => {
    // Red when: the body is copied with an unchecked `frame[key] = value`. The
    // parsed body really does have an own enumerable `__proto__` key, and
    // assigning it changes the frame's prototype: the field vanishes from the
    // serialized string and the object grows an inherited shape.
    //
    // The minted id is not decoration. Without it this case would still throw
    // when the guard was removed - but for the unrelated reason that the
    // capability owes an id, so the assertion would pass on the wrong error and
    // the guard could rot unnoticed. With an id supplied, the body check is the
    // only thing left that can raise.
    const body = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;

    expect(() => frameOf(requestFor("device.info", { body }), "minted-1")).toThrow(/__proto__/);
  });

  it("proves the __proto__ key is really there to be caught", () => {
    // Positive control for the case above: if `JSON.parse` did not produce an own
    // key, the guard would be refusing something that never occurs and the test
    // above would pass vacuously. It does, and assigning it really does change an
    // object's prototype instead of adding a field.
    const body = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(body, "__proto__")).toBe(true);
    expect(Object.keys(body)).toContain("__proto__");

    const probe: Record<string, unknown> = {};
    for (const key of Object.keys(body)) {
      probe[key] = body[key];
    }
    expect(probe).not.toHaveProperty("__proto__");
    expect(JSON.stringify(probe)).toBe("{}");
    expect((probe as { polluted?: boolean }).polluted).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* Three id classes                                                          */
/* ------------------------------------------------------------------------- */

describe("the id travels or it does not", () => {
  it("drops a caller's id on the five capabilities whose wire has no id", () => {
    // Red when: the caller's id is forwarded to an untracked command. The wire
    // has no `request_id` field, so forwarding one sends a name the engine does
    // not read - and for a keystroke it would also turn two identical frames into
    // frames into one correlatable pair.
    //
    // The field's absence is asserted on the **parsed object**, not on the
    // serialized string: `JSON.stringify` drops an `undefined` value, so a string
    // check cannot tell "we never wrote the key" from "we wrote it as undefined",
    // and the two are exactly what this case exists to separate.
    for (const name of CAPABILITY_NAMES.filter(
      (candidate) => completionOf(candidate) === "untracked",
    )) {
      const frame = frameOf(requestFor(name, { requestId: "caller-1" }), "minted-1");

      expect(declares(name, "request_id"), `${name} must have no id field`).toBe(false);
      expect(frame.requestId, `${name} must not carry an id`).toBeUndefined();
      expect(parseFrame(frame)).not.toHaveProperty("request_id");
      expect(frame.tracksInFlight).toBe(false);
    }
  });

  it("would have shown a forwarded id, so the absences above are not vacuous", () => {
    // Red when: the two paths converge. A frame that legitimately carries an id
    // must expose the field, which is what proves every `not.toHaveProperty`
    // above is a real assertion rather than a name that never appears. Object
    // level for the same reason as the case above.
    expect(parseFrame(frameOf(requestFor("agent.list"), "minted-1"))).toHaveProperty(
      "request_id",
      "minted-1",
    );
  });

  it("sends two identical untracked commands as two byte-identical frames", () => {
    // This is a genuine claim about bytes: two
    // keystrokes must both leave, unchanged and indistinguishable, rather than
    // being merged into one correlatable pair by a dedupe table. It is the one
    // assertion here that belongs at the string level, because byte equality is
    // the property being claimed.
    const request = requestFor("terminal.input", { body: { terminal_id: "t-1", data: "a" } });
    const first = buildFrame(request, {}, undefined);
    const second = buildFrame(request, {}, undefined);

    expect(first.raw).toBe(second.raw);
    expect(parseFrame(first)).not.toHaveProperty("request_id");
  });

  it("relies on JSON dropping undefined, which is why the guard is a guard", () => {
    // This is documentation with an exit code. Writing `frame.request_id =
    // undefined` and not writing the key at all produce byte-identical frames,
    // so the `requestId !== undefined` test around the assignment is not
    // observable on the wire - it is a statement of intent. The mutant that
    // removes it survives, and this case is where that is recorded instead of
    // being quietly counted as a hole in the suite.
    expect(JSON.stringify({ type: "t", request_id: undefined })).toBe('{"type":"t"}');
  });

  it("drops an id on the duplex capability too", () => {
    // Red when: only `untracked` is special-cased. The duplex wire carries no id
    // either, and nothing can be correlated on a channel that runs both ways.
    const name: CapabilityName = "file.ops";
    expect(completionOf(name)).toBe("duplex");

    const frame = frameOf(requestFor(name, { requestId: "caller-1" }), "minted-1");

    expect(frame.requestId).toBeUndefined();
    expect(parseFrame(frame)).not.toHaveProperty("request_id");
  });

  it("keeps the id on the two silent capabilities but never tracks them", () => {
    // Red when: the id is dropped (the wire declares it) or the send is tracked
    // (nothing ever answers, so every send would end in a false TIMEOUT).
    const silent = CAPABILITY_NAMES.filter((name) => completionOf(name) === "silent");
    expect(silent).toHaveLength(2);

    for (const name of silent) {
      const frame = frameOf(requestFor(name, { body: { path: "/tmp/a" } }), "minted-1");

      expect(declares(name, "request_id"), `${name} must declare an id field`).toBe(true);
      expect(frame.requestId, `${name} must carry the minted id`).toBe("minted-1");
      expect(parseFrame(frame)["request_id"]).toBe("minted-1");
      expect(frame.tracksInFlight, `${name} must not be tracked`).toBe(false);
    }
  });

  it("prefers the caller's explicit id over the minted one", () => {
    // Red when: the mint always wins. The caller's explicit parameter is a
    // parameter", so the parameter is a decision and the mint is a convenience.
    const frame = frameOf(requestFor("agent.list", { requestId: "caller-1" }), "minted-1");

    expect(frame.requestId).toBe("caller-1");
  });

  it("treats an empty id as no id at all", () => {
    // Red when: `""` is sent. The engine's own reply paths are gated on
    // `if (parsed.request_id)`, so an empty id claims a correlation that cannot
    // exist. On a capability that must carry an id, that is a request nobody can
    // answer, so it is refused rather than timed out later.
    expect(() => frameOf(requestFor("agent.list", { requestId: "" }), "")).toThrow(
      /never be correlated/,
    );
  });

  it("refuses a required-id capability with no id at all", () => {
    // Red when: the frame goes out with no id. Every candidate here declares a
    // required `request_id`, so the engine could never correlate the answer and
    // the caller would wait for a promise that was never made.
    for (const name of CAPABILITY_NAMES.filter(
      (candidate) => declares(candidate, "request_id") && !hasOptionalRequestId(candidate),
    )) {
      expect(
        () => frameOf(requestFor(name)),
        `${name} must refuse to go out without an id`,
      ).toThrow(/correlated/);
    }
  });

  it("lets the five optional-id capabilities go out without an id, and untracked", () => {
    // Red when: an optional id is required (the caller loses the fire-and-forget
    // form) or the untracked id is still tracked (a guaranteed false TIMEOUT).
    const optional = CAPABILITY_NAMES.filter((name) => hasOptionalRequestId(name));
    expect(optional).toHaveLength(5);

    for (const name of optional) {
      const frame = frameOf(requestFor(name));

      expect(frame.requestId, `${name} must accept no id`).toBeUndefined();
      expect(parseFrame(frame)).not.toHaveProperty("request_id");
      expect(frame.tracksInFlight).toBe(false);
      // The class still says a reply is *possible*: this is the exact pair of
      // facts that trap 2 is about, and the one argument form cannot tell them
      // apart.
      expect(tracksInFlight(name)).toBe(true);
    }
  });

  it("tracks an optional-id capability once an id was actually sent", () => {
    // Red when: the decision ignores the id and uses the class alone, which
    // would make `message.send` untracked even though the engine acknowledges it.
    for (const name of CAPABILITY_NAMES.filter((name) => hasOptionalRequestId(name))) {
      const frame = frameOf(requestFor(name), "minted-1");

      expect(frame.requestId).toBe("minted-1");
      expect(frame.tracksInFlight, `${name} must be tracked once it carries an id`).toBe(true);
    }
  });

  it("decides tracking with two arguments on every capability", () => {
    // Red when: `tracksInFlight(name)` replaces `tracksInFlightWith(name, sent)`.
    // The one-argument answer is derived independently here, so the two forms
    // disagreeing is exactly what this compares.
    for (const name of CAPABILITY_NAMES) {
      const frame = frameOf(requestFor(name), "minted-1");
      const sent = frame.requestId !== undefined;

      expect(frame.tracksInFlight, `${name} tracking`).toBe(completionOf(name) === "response");
      expect(frame.tracksInFlight, `${name} must agree with the two-argument question`).toBe(
        tracksInFlightWith(name, sent),
      );
    }
  });
});

/* ------------------------------------------------------------------------- */
/* The reply name is registered, never derived                               */
/* ------------------------------------------------------------------------- */

describe("the acknowledgement frame name (trap 1)", () => {
  it("derives the name from the registry, never from the command wire", () => {
    // Red when: the module invents `<wire>_response`. With no registry port there
    // is nothing to invent from, so the honest answer is "unknown" for every one
    // of the 68 - and an implementation that guessed would answer with a string
    // here.
    for (const name of CAPABILITY_NAMES) {
      expect(frameOf(requestFor(name), "minted-1").replyWire, name).toBeUndefined();
    }
  });

  it("carries the registered name verbatim when the mapping table supplies one", () => {
    // Red when: the registry value is rewritten, prefixed or validated. The send
    // path has no business second-guessing the table that owns the vocabulary.
    const name: CapabilityName = "message.send";
    const expected = derivedReplyFor(wireIdOf(name));
    expect(expected).toBeDefined();

    const frame = buildFrame(requestFor(name), { replyWireOf: () => expected }, "minted-1");

    expect(frame.replyWire).toBe(expected);
  });

  it("finds exactly one capability whose acknowledgement is not <wire>_response", () => {
    // Red when: the contract gains a second exception (which would make every
    // prefix-based guess wrong twice) or loses this one (which would make the
    // registry unnecessary and this module's refusal to guess moot). The names
    // here are derived from `snapshot.json`, never written down.
    const exceptions = CAPABILITY_NAMES.filter((name) => {
      const wire = wireIdOf(name);
      const reply = derivedReplyFor(wire);
      return reply !== undefined && reply !== `${wire}_response`;
    });

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toBe("message.send");
  });

  it("keeps a message send trackable despite its non-standard reply name", () => {
    // Red when: tracking is decided by "does `<wire>_response` exist". That
    // inference marks this capability as never answering, so every message send
    // waits for a frame nobody will send and ends in a TIMEOUT - silently, one
    // per message, which is the worst possible way for the core action to fail.
    const name: CapabilityName = "message.send";
    const wire = wireIdOf(name);

    expect(MESSAGE_WIRES).not.toContain(`${wire}_response`);
    expect(derivedReplyFor(wire)).not.toBe(`${wire}_response`);

    const frame = frameOf(requestFor(name), "minted-1");

    expect(frame.tracksInFlight).toBe(true);
    expect(frame.replyWire).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- */
/* Two scope carriers                                                        */
/* ------------------------------------------------------------------------- */

describe("scope travels in the carrier its wire uses (trap 4)", () => {
  it("uses a nested runtime object for the thirteen runtime-carrier capabilities", () => {
    // Red when: the scope is written at the top level for these. Their wires
    // declare `runtime` and not `agent_id`, so the ids would arrive in fields the
    // engine does not read.
    const carriers = CAPABILITY_NAMES.filter((name) => scopeCarrierOf(name) === "runtime");
    expect(carriers).toHaveLength(13);

    for (const name of carriers) {
      const frame = parseFrame(frameOf(requestFor(name), "minted-1"));

      expect(declares(name, "runtime"), `${name} must declare runtime`).toBe(true);
      expect(frame["runtime"]).toEqual({
        agent_id: SCOPE.agent_id,
        conversation_id: SCOPE.conversation_id,
      });
      expect(frame).not.toHaveProperty("agent_id");
      expect(frame).not.toHaveProperty("conversation_id");
    }
  });

  it("uses top-level ids for the one top-level-carrier capability", () => {
    // Red when: a `runtime` container is attached here. This is the capability
    // that starts a runtime, so it cannot be addressed *by* one; its wire has
    // `agent_id` / `conversation_id` at the top level and no `runtime` field.
    const carriers = CAPABILITY_NAMES.filter((name) => scopeCarrierOf(name) === "top-level");
    expect(carriers).toHaveLength(1);

    for (const name of carriers) {
      const frame = parseFrame(frameOf(requestFor(name), "minted-1"));

      expect(declares(name, "runtime")).toBe(false);
      expect(frame).not.toHaveProperty("runtime");
      expect(frame["agent_id"]).toBe("agent-1");
      expect(frame["conversation_id"]).toBe("conversation-1");
    }
  });

  it("omits a null agent id at the top level instead of sending null", () => {
    // Red when: `agent_id: null` is written. The top-level carrier's field is a
    // bare string with no null in it, so a null would be a value the wire does
    // not define; absence says the same thing honestly.
    const name: CapabilityName = "conversation.switch";
    const frame = parseFrame(
      frameOf(
        requestFor(name, { runtime: { agent_id: null, conversation_id: "conversation-1" } }),
        "minted-1",
      ),
    );

    expect(frame).not.toHaveProperty("agent_id");
    expect(frame["conversation_id"]).toBe("conversation-1");
  });

  it("keeps a null agent id in the runtime container", () => {
    // Red when: the runtime object drops the key for a null agent. The type is
    // `string | null` there, so null is a legal value and the object's shape is
    // documented to stay constant - dropping it would make one wire field
    // sometimes-present and sometimes-not.
    const frame = parseFrame(
      frameOf(requestFor("message.send", { runtime: { agent_id: null, conversation_id: "c-1" } })),
    );

    expect(frame["runtime"]).toEqual({ agent_id: null, conversation_id: "c-1" });
  });

  it("rebuilds the runtime container instead of spreading the caller's scope", () => {
    // Red when: `frame.runtime = runtime` (or `{...runtime}`) is used. The scope
    // object belongs to the caller, so any field the engine's wire does not
    // define would ride along into the envelope - and `acting_user_id`, present
    // on the engine's own scope type, is exactly the sort of field a caller
    // might carry over from a server frame. The container holds two ids and
    // nothing else.
    const leaky = { ...SCOPE, acting_user_id: "user-1", extra: 1 } as RuntimeScope;
    const frame = parseFrame(frameOf(requestFor("message.send", { runtime: leaky }), "minted-1"));

    expect(keysOf(frame["runtime"] as Record<string, unknown>)).toEqual([
      "agent_id",
      "conversation_id",
    ]);
  });

  it("writes scope for exactly the capabilities that need it", () => {
    // Red when: a scope is attached to an unscoped command (a field its wire does
    // not declare) or omitted for a scoped one (a frame addressing no runtime).
    for (const name of CAPABILITY_NAMES) {
      const frame = parseFrame(frameOf(requestFor(name), "minted-1"));
      const carrier = scopeCarrierOf(name);

      expect(frame["runtime"] !== undefined, `${name} runtime presence`).toBe(
        carrier === "runtime",
      );
      expect("agent_id" in frame, `${name} top-level agent id`).toBe(carrier === "top-level");
    }
  });

  it("refuses a scoped capability that was given no scope", () => {
    // Red when: a scoped frame is sent with no scope. The wire declares `runtime`
    // as required, so the engine would read an address of `undefined`.
    for (const name of CAPABILITY_NAMES.filter((candidate) => scoped(candidate))) {
      const request: CommandRequest = { capability: name, body: {}, requestId: "r-1" };

      expect(() => frameOf(request), `${name} must refuse to go out unscoped`).toThrow(
        /runtime is required/,
      );
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Budget                                                                    */
/* ------------------------------------------------------------------------- */

describe("the budget comes from the family table", () => {
  it("falls back to the default when the caller states no timeout", () => {
    // Red when: a constant is used instead of the family table. The two
    // expectations are read from `timeouts.ts` itself, so the send path cannot
    // the table it is supposed to consult.
    for (const name of CAPABILITY_NAMES) {
      const frame = frameOf(requestFor(name), "minted-1");

      expect(frame.timeoutMs, name).toBe(defaultTimeoutMs(name));
      expect(frame.clamped, name).toBe(false);
    }
  });

  it("propagates the clamp as a fact rather than failing the send", () => {
    // Red when: `clamped` is hard-coded false, or an over-cap value throws.
    //  §4.4 is explicit that a defensive parameter must not cost the
    // caller their command.
    const name: CapabilityName = "compaction.prepare";
    // `maxTimeoutMs` is already the cap, so one millisecond past it is the
    // smallest input that can clamp - and the expected value is read from
    // rather than multiplied out a second time here.
    const frame = frameOf(requestFor(name, { timeoutMs: maxTimeoutMs(name) + 1 }), "minted-1");

    expect(frame.timeoutMs).toBe(maxTimeoutMs(name));
    expect(frame.clamped).toBe(true);
    expect(parseFrame(frame)["request_id"]).toBe("minted-1");
  });

  it("keeps a caller's value that is inside the cap, unclamped", () => {
    // Red when: every caller value is treated as a clamp. A shortened wait is a
    // legitimate decision (a picker that wants two seconds).
    const frame = frameOf(requestFor("device.info", { timeoutMs: 2_000 }), "minted-1");

    expect(frame.timeoutMs).toBe(2_000);
    expect(frame.clamped).toBe(false);
  });

  it("uses the injected resolver instead of the table, so the port is real", () => {
    // Red when: the port is ignored (then the injected budget never appears) or
    // the table is bypassed for real callers (the default case above pins it).
    const frame = buildFrame(
      requestFor("device.info"),
      {
        resolveTimeoutOf: () => ({ ms: 4_242, clamped: true }),
      },
      "minted-1",
    );

    expect(frame.timeoutMs).toBe(4_242);
    expect(frame.clamped).toBe(true);
  });

  it("agrees with resolveTimeout for every capability", () => {
    // Red when: the send path re-implements the family lookup. Two readings of
    // the same table would let the timer and the diagnostic disagree about why a
    // request timed out.
    for (const name of CAPABILITY_NAMES) {
      const expected = resolveTimeout(name, 1_234);

      expect(frameOf(requestFor(name, { timeoutMs: 1_234 }), "minted-1").timeoutMs).toBe(
        expected.ms,
      );
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Every capability, against the contract                                    */
/* ------------------------------------------------------------------------- */

describe("every capability produces the frame its snapshot record describes", () => {
  it("matches the wire, the id presence and the scope fields row by row", () => {
    // Red when: any one capability is misclassified. The expectations come from
    // `snapshot.json` - `request_id` presence, `runtime` presence, and the two
    // top-level scope fields - and the frame is compared with them; the module is
    // never compared with itself.
    const offenders: string[] = [];

    for (const name of CAPABILITY_NAMES) {
      const frame = frameOf(requestFor(name), "minted-1");
      const parsed = parseFrame(frame);
      const completion: CompletionMode = completionOf(name);

      if (parsed["type"] !== wireIdOf(name)) {
        offenders.push(`${name}: type`);
      }

      const idExpected = declares(name, "request_id") && completion !== "untracked";
      if ((parsed["request_id"] !== undefined) !== idExpected) {
        offenders.push(`${name}: request_id`);
      }

      const scopeCarrier = scopeCarrierOf(name);
      if ((parsed["runtime"] !== undefined) !== (scopeCarrier === "runtime")) {
        offenders.push(`${name}: runtime`);
      }

      for (const field of ["agent_id", "conversation_id"] as const) {
        const expected = scopeCarrier === "top-level" && declares(name, field);
        if ((parsed[field] !== undefined) !== expected) {
          offenders.push(`${name}: ${field}`);
        }
      }

      for (const envelopeField of ["event_seq", "emitted_at", "idempotency_key"]) {
        if (parsed[envelopeField] !== undefined) {
          offenders.push(`${name}: ${envelopeField}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never emits a field the command's snapshot record does not declare", () => {
    // Red when: a scope, an id or an envelope field is attached to a command that
    // has no slot for it. This is the "no invented fields" half of the previous
    // case, stated as its own claim: every key in the frame must be either
    // declared by the command's wire or be `type`.
    const offenders: string[] = [];

    for (const name of CAPABILITY_NAMES) {
      const declared = new Set(snapshotFor(name).fields.map((field) => field.name));

      for (const key of Object.keys(parseFrame(frameOf(requestFor(name), "minted-1")))) {
        if (key !== "type" && !declared.has(key)) {
          offenders.push(`${name}: ${key}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("serializes to a string that round-trips through JSON unchanged", () => {
    // Red when: the frame is returned as an object, or its string form is not
    // JSON (a template, a concatenation). The transport writes `raw`, so this is
    // the contract with `transport.ts`.
    const frame = frameOf(
      requestFor("conversation.switch", {
        body: { create_conversation: { title: "x" } },
      }),
      "minted-1",
    );

    expect(typeof frame.raw).toBe("string");
    expect(JSON.parse(frame.raw)).toEqual(parseFrame(frame));
    expect(JSON.parse(JSON.stringify(JSON.parse(frame.raw)))).toEqual(parseFrame(frame));
  });

  it("refuses a body that would collide with a wire id the contract does not know", () => {
    // Red when: an unknown capability silently produces a frame. `wireIdOf` of an
    // unknown name is `undefined`, `JSON.stringify` then drops the key, and the
    // result is a frame with no `type` at all - reported by the engine as a
    // protocol failure instead of as the caller's mistake.
    const unknown = "no.suchCapability" as CapabilityName;

    expect(findCapability(unknown)).toBeUndefined();
    expect(() => frameOf({ capability: unknown, body: {} })).toThrow(/unknown capability/);
  });
});
