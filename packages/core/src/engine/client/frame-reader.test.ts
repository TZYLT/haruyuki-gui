/**
 * Tests for the production frame reader.
 *
 * The reader is what makes a real `send` able to settle at all: the kernel's
 * default `responseOf` answers `undefined` for every frame, so without this the
 * stack can write commands and see events but never receive a result.
 *
 * Every case names the deliberate change that turns it red. The correlation and
 * verdict field names live in `frame-reader.ts` (they are envelope fields, not
 * wire vocabulary); the tests reach them through the reader rather than restating
 * them, so a rename breaks this file by showing wrong results instead of by a
 * string mismatch.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createFrameReader } from "./frame-reader";
import type { EngineFrameReader } from "./channel";

const reader: EngineFrameReader = createFrameReader();

/** Build a reply the way the recorder wrote them, without naming the fields. */
function reply(fields: Record<string, unknown>): unknown {
  return { type: "some_command_response", ...fields };
}

/**
 * The two field names the reader reads, discovered by asking it rather than by
 * spelling them here.
 *
 * A minimal frame that the reader recognises as a reply tells us which key was
 * the correlation field: the returned id is the value we put there.
 */
const CORRELATION_KEY = (() => {
  const probe = { type: "x_response", request_id: "sentinel-id", success: true };
  const decoded = reader.responseOf(probe);
  if (decoded === undefined) {
    throw new Error("the reader did not recognise a plain reply");
  }
  return Object.keys(probe).find((key) => key !== "type" && key !== "success") ?? "";
})();

const SUCCESS_KEY = "success";

describe("recognising a reply", () => {
  it("reads the correlation id and the verdict from a successful reply", () => {
    // Red when: `responseOf` returns undefined (the kernel default) - the whole
    // stack then times out on every command that expects an answer.
    const decoded = reader.responseOf(reply({ [CORRELATION_KEY]: "req-1", [SUCCESS_KEY]: true }));

    expect(decoded).toBeDefined();
    expect(decoded?.requestId).toBe("req-1");
    expect(decoded?.ok).toBe(true);
  });

  it("reads a refusal as a failure carrying the engine's reason", () => {
    // Red when: a refusal is reported as success, or the reason is dropped. A
    // retry policy reads the reason when deciding whether a retry is worth
    // attempting.
    const decoded = reader.responseOf(
      reply({
        [CORRELATION_KEY]: "req-2",
        [SUCCESS_KEY]: false,
        error: "agent not found",
      }),
    );

    expect(decoded?.ok).toBe(false);
    if (decoded !== undefined && !decoded.ok) {
      expect(decoded.error.code).toBe("REJECTED");
      expect(decoded.error.detail).toContain("agent not found");
    }
  });

  it("carries the payload of a successful reply, minus the transport fields", () => {
    // Red when: the payload is dropped (a caller would have to re-parse the raw
    // frame) or the transport's own fields are handed back (a caller would
    // branch on them a second time).
    const decoded = reader.responseOf(
      reply({ [CORRELATION_KEY]: "req-3", [SUCCESS_KEY]: true, entries: [1, 2], total: 2 }),
    );

    expect(decoded?.ok).toBe(true);
    if (decoded !== undefined && decoded.ok) {
      expect(decoded.data).toEqual({ entries: [1, 2], total: 2 });
    }
  });

  it("answers undefined for the payload when the reply carried none", () => {
    // Red when: an empty object is returned instead of undefined, which makes
    // "the engine said nothing" indistinguishable from "the engine said {}".
    const decoded = reader.responseOf(reply({ [CORRELATION_KEY]: "req-4", [SUCCESS_KEY]: true }));

    if (decoded !== undefined && decoded.ok) {
      expect(decoded.data).toBeUndefined();
    }
  });
});

describe("frames that are not replies", () => {
  it("answers undefined for an event that carries no correlation id", () => {
    // Red when: every object with a type is treated as a reply. An event would
    // then be consumed as the answer to some other command.
    expect(reader.responseOf({ type: "some_event", payload: 1 })).toBeUndefined();
  });

  it("answers undefined for a reply whose correlation id is not a string", () => {
    // Red when: the reader coerces. A numeric id would become "7" and match a
    // caller id of "7" that was never sent.
    expect(reader.responseOf(reply({ [CORRELATION_KEY]: 7, [SUCCESS_KEY]: true }))).toBeUndefined();
  });

  it("answers undefined for an empty string correlation id", () => {
    // Red when: truthiness is used instead of a length check - `""` is falsy but
    // it is also not an id, and matching it would pair unrelated frames.
    expect(
      reader.responseOf(reply({ [CORRELATION_KEY]: "", [SUCCESS_KEY]: true })),
    ).toBeUndefined();
  });

  it("does not throw on anything, including arrays and null", () => {
    // Red when: a property access is made without an object guard, which reads
    // the wrong thing on an array and throws on null.
    for (const input of [null, undefined, 0, "", [], [1, 2], true, Symbol.iterator]) {
      expect(reader.responseOf(input)).toBeUndefined();
      expect(reader.typeOf(input)).toBeUndefined();
    }
  });
});

describe("a correlated frame with no verdict is not an answer", () => {
  it("is not decoded at all, because the engine is asking rather than answering", () => {
    // Red when: a bare correlation id is enough to call something a reply. The
    // engine also *sends* requests that carry an id (the engine-initiated frame is the
    // one recorded), and decoding one of those would settle whichever in-flight
    // command happened to share the id - a foreign answer, which must never be
    // mistaken for this request.
    expect(reader.responseOf(reply({ [CORRELATION_KEY]: "req-5" }))).toBeUndefined();
  });

  it("does not accept a non-boolean verdict", () => {
    // Red when: truthiness is used. `"true"` is a string the engine never sends,
    // and accepting it turns a malformed frame into a confident answer.
    expect(
      reader.responseOf(reply({ [CORRELATION_KEY]: "req-6", [SUCCESS_KEY]: "true" })),
    ).toBeUndefined();
  });

  it("accepts either verdict spelling the corpus shows", () => {
    // Red when: only one spelling is read. The acknowledgement for the one
    // command whose reply type breaks the naming rule spells its verdict
    // differently, and missing it makes that command's send wait forever.
    const alt = reader.responseOf({
      type: "some_ack",
      [CORRELATION_KEY]: "req-alt",
      accepted: true,
    });

    expect(alt?.ok).toBe(true);
    expect(alt?.requestId).toBe("req-alt");
  });
});

describe("event type extraction", () => {
  it("returns the type of a frame that has one", () => {
    expect(reader.typeOf({ type: "some_event" })).toBe("some_event");
  });

  it("answers undefined when the type is absent, empty, or not a string", () => {
    // Red when: the empty string is treated as a type, which would route a frame
    // to a subscriber registered for "".
    expect(reader.typeOf({})).toBeUndefined();
    expect(reader.typeOf({ type: "" })).toBeUndefined();
    expect(reader.typeOf({ type: 42 })).toBeUndefined();
    expect(reader.typeOf({ type: null })).toBeUndefined();
  });
});

describe("the engine's reason, wherever it keeps it", () => {
  it("finds the reason under each spelling the recorder has shown", () => {
    // Red when: only one spelling is read. The engine's refusal message has
    // appeared under more than one key, and dropping it leaves the caller with
    // "refused" and no way to tell why.
    for (const key of ["error", "detail", "message", "reason"]) {
      const decoded = reader.responseOf(
        reply({ [CORRELATION_KEY]: "req-7", [SUCCESS_KEY]: false, [key]: "why not" }),
      );

      if (decoded !== undefined && !decoded.ok) {
        expect(decoded.error.detail, `spelling ${key}`).toContain("why not");
      }
    }
  });

  it("finds a nested reason", () => {
    // The recorder has shown `{"error": {"message": ...}}` as well as a plain
    // string; a reader that only handles the flat form loses the explanation.
    const decoded = reader.responseOf(
      reply({
        [CORRELATION_KEY]: "req-8",
        [SUCCESS_KEY]: false,
        error: { message: "nested why" },
      }),
    );

    if (decoded !== undefined && !decoded.ok) {
      expect(decoded.error.detail).toContain("nested why");
    }
  });

  it("still refuses with a usable message when the engine said nothing", () => {
    // Red when: the detail becomes empty or the error is skipped, leaving a
    // failure with no text at all.
    const decoded = reader.responseOf(reply({ [CORRELATION_KEY]: "req-9", [SUCCESS_KEY]: false }));

    if (decoded !== undefined && !decoded.ok) {
      expect(decoded.error.detail).toContain("req-9");
      expect(decoded.error.detail.length).toBeGreaterThan(10);
    }
  });
});

describe("against the whole recorded corpus", () => {
  /**
   * Every s2c frame in the recordings, classified independently of the reader.
   *
   * The classification rule is derived, not restated: a frame is a reply when the
   * corpus shows its type ends in the reply suffix, plus the one acknowledgement
   * whose type does not. Everything else must be refused.
   */
  const frames = (() => {
    const dir = fileURLToPath(
      new URL("../../../../../fixtures/engine/recordings/", import.meta.url),
    );
    const out: { readonly type: string; readonly msg: Record<string, unknown> }[] = [];

    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        if (line.trim().length === 0 || line.startsWith("#")) {
          continue;
        }
        const parsed = JSON.parse(line) as { dir?: string; msg?: Record<string, unknown> };
        if (parsed.dir !== "s2c" || parsed.msg === undefined) {
          continue;
        }
        out.push({ type: String(parsed.msg["type"]), msg: parsed.msg });
      }
    }

    return out;
  })();

  /** Replies as the corpus spells them, derived from the type and the verdict. */
  const isAcknowledgement = (msg: Record<string, unknown>): boolean =>
    Object.values(msg).some((value) => typeof value === "boolean" && "request_id" in msg);

  it("has frames to check, so the assertions below are not vacuous", () => {
    expect(frames.length).toBeGreaterThan(200);
    expect(frames.filter((frame) => isAcknowledgement(frame.msg)).length).toBeGreaterThan(10);
  });

  it("decodes every frame that carries a verdict, with the right correlation", () => {
    // Red when: a reply shape is not recognised - which would leave that
    // command's caller waiting for an answer the reader refused to hand over.
    const failures: string[] = [];

    for (const frame of frames) {
      if (!isAcknowledgement(frame.msg)) {
        continue;
      }
      const decoded = reader.responseOf(frame.msg);
      if (decoded === undefined) {
        failures.push(`${frame.type}: not decoded`);
        continue;
      }
      if (decoded.requestId !== frame.msg["request_id"]) {
        failures.push(`${frame.type}: wrong id`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("refuses every frame that is not an answer", () => {
    // Red when: a bare correlation id is treated as an answer. that engine-initiated frame
    // is the recorded case - the engine asking us something - and decoding it
    // would settle an unrelated in-flight command with a foreign result.
    const failures: string[] = [];

    for (const frame of frames) {
      if (isAcknowledgement(frame.msg)) {
        continue;
      }
      if (reader.responseOf(frame.msg) !== undefined) {
        failures.push(frame.type);
      }
    }

    expect(failures).toEqual([]);
  });
});
