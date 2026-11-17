/**
 * Tests for the message assembler.
 *
 * The assertions are about the two things a merger can get wrong: which deltas
 * belong to the same message, and what to do with the ones that do not fit.
 * Every case therefore goes through `push` (the only way state changes) and
 * checks the delta it returns together with what `complete` reports afterwards,
 * so a bug that appends twice or loses text cannot hide behind a passing
 * intermediate step.
 *
 * The identity cases are taken from a recorded session: the same message id
 * appears on the main line and inside a subagent, with the same sequence
 * numbers. A key that ignored the subagent would merge the two answers, which is
 * why that case exists here rather than a synthetic "same id, different author"
 * alone.
 */

import { describe, expect, it } from "vitest";

import { createAssembler, type AssemblyInput } from "./assemble.js";
import type { AssistantPart } from "./types.js";

/** One text part, the shape the engine sends for streamed text. */
const textPart = (text: string): AssistantPart => ({ type: "text", text });

/** A valid input, overridable field by field. */
function input(overrides: Partial<AssemblyInput> = {}): AssemblyInput {
  return {
    authorAgentId: "agent-local-54b313a7",
    subagentId: null,
    messageId: "ui-msg-2",
    runId: "local-run-2",
    runSeq: 1,
    parts: [textPart("a")],
    at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("createAssembler", () => {
  it("concatenates text in arrival order and marks only the first delta", () => {
    const assembler = createAssembler();

    const first = assembler.push(input());
    const second = assembler.push(input({ runSeq: 2, parts: [textPart("b c")] }));

    expect(first?.first).toBe(true);
    expect(first?.reset).toBe(false);
    expect(first?.text).toBe("a");
    expect(second?.first).toBe(false);
    expect(second?.reset).toBe(false);
    expect(second?.text).toBe("b c");
    expect(second?.parts).toEqual([textPart("a"), textPart("b c")]);

    expect(assembler.complete("agent-local-54b313a7", null, "ui-msg-2")).toEqual({
      messageId: "ui-msg-2",
      runId: "local-run-2",
      textLength: 4,
      incomplete: false,
    });
  });

  it("keeps non-text parts in order but out of the text", () => {
    const assembler = createAssembler();
    const toolCall: AssistantPart = { type: "tool_call", tool_call_id: "call-1" };

    const first = assembler.push(input({ parts: [textPart("Hi"), toolCall] }));
    const second = assembler.push(input({ runSeq: 2, parts: [textPart(" there")] }));

    expect(first?.text).toBe("Hi");
    expect(first?.parts).toEqual([textPart("Hi"), toolCall]);
    // The delta handed out earlier is a copy: it must not grow when the next
    // delta is accepted, or a consumer holding it renders the message twice.
    expect(first?.parts).toHaveLength(2);
    expect(second?.text).toBe(" there");
    expect(second?.parts).toHaveLength(3);
    expect(second?.parts?.[2]).toEqual(textPart(" there"));
  });

  it("marks the message incomplete when a sequence number is missing", () => {
    const assembler = createAssembler();

    expect(assembler.push(input({ runSeq: 1 }))?.incomplete).toBe(false);

    // 2 is missing.
    const afterHole = assembler.push(input({ runSeq: 3, parts: [textPart("c")] }));

    expect(afterHole?.incomplete).toBe(true);
    expect(afterHole?.text).toBe("c");
    expect(afterHole?.first).toBe(false);

    // The hole stays visible for the rest of the message: a later contiguous
    // delta cannot prove what was in the missing one.
    const later = assembler.push(input({ runSeq: 4, parts: [textPart("d")] }));

    expect(later?.incomplete).toBe(true);
    expect(assembler.complete("agent-local-54b313a7", null, "ui-msg-2")).toEqual({
      messageId: "ui-msg-2",
      runId: "local-run-2",
      textLength: 3,
      incomplete: true,
    });
  });

  it("treats a message that starts at a later sequence number as incomplete", () => {
    const assembler = createAssembler();

    const first = assembler.push(input({ runSeq: 2, parts: [textPart("b")] }));

    // The very first delta is not the message's first piece, so text before it
    // is missing and the message cannot claim to be whole.
    expect(first?.first).toBe(true);
    expect(first?.incomplete).toBe(true);
  });

  it("refuses a repeated sequence number", () => {
    const assembler = createAssembler();

    assembler.push(input({ runSeq: 1, parts: [textPart("a")] }));
    assembler.push(input({ runSeq: 2, parts: [textPart("b")] }));
    assembler.push(input({ runSeq: 3, parts: [textPart("c")] }));

    expect(assembler.push(input({ runSeq: 3, parts: [textPart("C")] }))).toBeNull();
    // A sequence below the highest one is already reflected in the text too,
    // and a resend of a middle piece is not a restart.
    expect(assembler.push(input({ runSeq: 2, parts: [textPart("B")] }))).toBeNull();

    expect(assembler.complete("agent-local-54b313a7", null, "ui-msg-2")).toEqual({
      messageId: "ui-msg-2",
      runId: "local-run-2",
      textLength: 3,
      incomplete: false,
    });
  });

  it("restarts the message when sequence one arrives again with text present", () => {
    const assembler = createAssembler();

    assembler.push(input({ runSeq: 1, parts: [textPart("Hello")] }));
    assembler.push(input({ runSeq: 2, parts: [textPart(" world")] }));

    const restarted = assembler.push(input({ runSeq: 1, parts: [textPart("Goodbye")] }));

    expect(restarted?.reset).toBe(true);
    expect(restarted?.first).toBe(true);
    expect(restarted?.text).toBe("Goodbye");
    expect(restarted?.parts).toEqual([textPart("Goodbye")]);
    expect(restarted?.incomplete).toBe(false);

    // The earlier text is gone rather than kept in front of the new run.
    expect(assembler.complete("agent-local-54b313a7", null, "ui-msg-2")).toEqual({
      messageId: "ui-msg-2",
      runId: "local-run-2",
      textLength: 7,
      incomplete: false,
    });
  });

  it("clears the incomplete mark when the message restarts", () => {
    const assembler = createAssembler();

    assembler.push(input({ runSeq: 1, parts: [textPart("a")] }));
    assembler.push(input({ runSeq: 3, parts: [textPart("c")] }));

    expect(assembler.push(input({ runSeq: 4 }))?.incomplete).toBe(true);

    const restarted = assembler.push(input({ runSeq: 1, parts: [textPart("again")] }));

    expect(restarted?.reset).toBe(true);
    expect(restarted?.incomplete).toBe(false);
  });

  it("reports the text length and drops the message on complete", () => {
    const assembler = createAssembler();

    assembler.push(input({ runSeq: 1, parts: [textPart("ab")] }));
    assembler.push(input({ runSeq: 2, parts: [textPart("cd")] }));

    expect(assembler.complete("agent-local-54b313a7", null, "ui-msg-2")).toEqual({
      messageId: "ui-msg-2",
      runId: "local-run-2",
      textLength: 4,
      incomplete: false,
    });
    expect(assembler.size()).toBe(0);
    expect(assembler.complete("agent-local-54b313a7", null, "ui-msg-2")).toBeNull();

    // Without state, the next delta for that id is a new message again.
    const next = assembler.push(input({ runSeq: 2, parts: [textPart("late")] }));

    expect(next?.first).toBe(true);
    expect(next?.text).toBe("late");
  });

  it("evicts the least recently used message when the bound is reached", () => {
    const assembler = createAssembler({ limit: 2 });

    assembler.push(input({ messageId: "m1" }));
    assembler.push(input({ messageId: "m2" }));
    // Refreshing m1 makes m2 the least recently used one.
    assembler.push(input({ messageId: "m1", runSeq: 2, parts: [textPart("b")] }));
    assembler.push(input({ messageId: "m3" }));

    expect(assembler.size()).toBe(2);
    expect(assembler.complete("agent-local-54b313a7", null, "m2")).toBeNull();
    expect(assembler.complete("agent-local-54b313a7", null, "m1")).toEqual({
      messageId: "m1",
      runId: "local-run-2",
      textLength: 2,
      incomplete: false,
    });
  });

  it("keeps the main line and a subagent apart when they reuse a message id", () => {
    const assembler = createAssembler();
    const subagentId = "subagent-1794661146742-1";

    const main = assembler.push(input({ messageId: "ui-msg-2", parts: [textPart("main")] }));
    const sub = assembler.push(
      input({ messageId: "ui-msg-2", subagentId, parts: [textPart("sub")] }),
    );

    expect(main?.text).toBe("main");
    expect(sub?.text).toBe("sub");
    expect(sub?.first).toBe(true);
    expect(assembler.size()).toBe(2);

    // Each context continues on its own sequence.
    const mainSecond = assembler.push(
      input({ messageId: "ui-msg-2", runSeq: 2, parts: [textPart(" line")] }),
    );

    expect(mainSecond?.first).toBe(false);
    expect(mainSecond?.parts).toEqual([textPart("main"), textPart(" line")]);

    expect(assembler.complete("agent-local-54b313a7", null, "ui-msg-2")?.textLength).toBe(9);
    expect(assembler.complete("agent-local-54b313a7", subagentId, "ui-msg-2")?.textLength).toBe(3);
  });

  it("keeps two authors apart when they reuse a message id", () => {
    const assembler = createAssembler();

    const first = assembler.push(input({ authorAgentId: "agent-a", parts: [textPart("a")] }));
    const second = assembler.push(input({ authorAgentId: "agent-b", parts: [textPart("b")] }));

    expect(first?.text).toBe("a");
    expect(second?.text).toBe("b");
    expect(second?.first).toBe(true);
    expect(assembler.size()).toBe(2);
  });

  it("forgets a message without reporting it", () => {
    const assembler = createAssembler();

    assembler.push(input({ messageId: "m1" }));
    assembler.push(input({ messageId: "m2" }));

    assembler.forget("agent-local-54b313a7", null, "m1");

    expect(assembler.size()).toBe(1);
    expect(assembler.complete("agent-local-54b313a7", null, "m1")).toBeNull();

    assembler.clear();

    expect(assembler.size()).toBe(0);
    expect(assembler.complete("agent-local-54b313a7", null, "m2")).toBeNull();
  });

  it("refuses a sequence number that is not a count", () => {
    const assembler = createAssembler();

    expect(assembler.push(input({ runSeq: Number.NaN }))).toBeNull();
    expect(assembler.push(input({ runSeq: -1 }))).toBeNull();
    expect(assembler.push(input({ runSeq: 1.5 }))).toBeNull();
    expect(assembler.size()).toBe(0);
  });
});
