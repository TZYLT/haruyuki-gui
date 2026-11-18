/**
 * Tests for the line-oriented fence scanner.
 *
 * The scanner is the only place a message is cut, so the cases here are the
 * ones a surface would notice: a closed fence, a fence that never closes, the
 * tilde variant, a closer that is too short, an info string that must survive
 * untouched, and every shape that must NOT be cut (inline backticks, a
 * four-space indent, a closer with trailing text). The last test pins the
 * streaming contract: one character at a time must produce exactly what one
 * whole string produces.
 */

import { describe, expect, it } from "vitest";

import { createFenceState, feedFence, finishFence, scanFence } from "./fence.js";
import type { FenceSegment } from "./fence.js";
import type { FenceState } from "./types.js";

/** Feed every chunk in order, then finish, collecting all segments. */
function feedChunks(chunks: readonly string[]): {
  readonly state: FenceState;
  readonly segments: FenceSegment[];
} {
  const state = createFenceState();
  const segments: FenceSegment[] = [];
  for (const chunk of chunks) {
    segments.push(...feedFence(state, chunk));
  }
  segments.push(...finishFence(state));
  return { state, segments };
}

describe("closed fences", () => {
  it("splits prose, an open fence, code and prose in source order", () => {
    const { state, segments } = feedChunks(["one\ntwo\n```ts\nlet a = 1;\n```\nthree\n"]);

    expect(segments).toEqual([
      { kind: "text", text: "one\n" },
      { kind: "text", text: "two\n" },
      { kind: "code-open", info: "ts" },
      { kind: "code-text", text: "let a = 1;\n" },
      { kind: "code-close" },
      { kind: "text", text: "three\n" },
    ]);
    expect(state.mode).toBe("text");
    expect(state.closed).toBe(true);
    expect(state.pendingLine).toBe("");
  });

  it("keeps the newline before the closer inside the code text", () => {
    const { segments } = feedChunks(["```\nbody\n\n```\n"]);

    expect(segments).toEqual([
      { kind: "code-open", info: "" },
      { kind: "code-text", text: "body\n" },
      { kind: "code-text", text: "\n" },
      { kind: "code-close" },
    ]);
  });

  it("does not treat a fence inside a fenced block as an opener", () => {
    const { segments } = feedChunks(["```\n```ts\n```\n"]);

    expect(segments).toEqual([
      { kind: "code-open", info: "" },
      { kind: "code-text", text: "```ts\n" },
      { kind: "code-close" },
    ]);
  });

  it("closes a tilde fence with tildes", () => {
    const { state, segments } = feedChunks(["~~~js\nx\n~~~\n"]);

    expect(segments).toEqual([
      { kind: "code-open", info: "js" },
      { kind: "code-text", text: "x\n" },
      { kind: "code-close" },
    ]);
    expect(state.closed).toBe(true);
  });

  it("does not let a tilde line close a backtick fence", () => {
    const { state, segments } = feedChunks(["```\n~~~\n"]);

    expect(segments).toEqual([
      { kind: "code-open", info: "" },
      { kind: "code-text", text: "~~~\n" },
    ]);
    expect(state.mode).toBe("code");
    expect(state.closed).toBe(false);
  });

  it("allows a closer with trailing whitespace only", () => {
    const { state, segments } = feedChunks(["```\nx\n```   \n"]);

    expect(segments.at(-1)).toEqual({ kind: "code-close" });
    expect(state.closed).toBe(true);
  });

  it("treats a closer with trailing text as code", () => {
    const { state, segments } = feedChunks(["```\nx\n```x\n"]);

    expect(segments).toEqual([
      { kind: "code-open", info: "" },
      { kind: "code-text", text: "x\n" },
      { kind: "code-text", text: "```x\n" },
    ]);
    expect(state.closed).toBe(false);
  });

  it("starts a new block, still open, after a closed one", () => {
    const { state, segments } = feedChunks(["```\na\n```\n```\nb"]);

    expect(segments).toEqual([
      { kind: "code-open", info: "" },
      { kind: "code-text", text: "a\n" },
      { kind: "code-close" },
      { kind: "code-open", info: "" },
      { kind: "code-text", text: "b" },
    ]);
    expect(state.mode).toBe("code");
    expect(state.closed).toBe(false);
  });
});

describe("unterminated fences", () => {
  it("stays in code mode through finish and keeps closed false", () => {
    const { state, segments } = feedChunks(["```\nopen\n"]);

    expect(segments).toEqual([
      { kind: "code-open", info: "" },
      { kind: "code-text", text: "open\n" },
    ]);
    expect(state.mode).toBe("code");
    expect(state.closed).toBe(false);
  });

  it("turns the tail without a newline into code, not prose", () => {
    const { segments } = feedChunks(["```\nabc"]);

    expect(segments).toEqual([
      { kind: "code-open", info: "" },
      { kind: "code-text", text: "abc" },
    ]);
  });

  it("does not close on a shorter fence", () => {
    const { state, segments } = feedChunks(["````ts\nx\n```\n"]);

    expect(segments).toEqual([
      { kind: "code-open", info: "ts" },
      { kind: "code-text", text: "x\n" },
      { kind: "code-text", text: "```\n" },
    ]);
    expect(state.closed).toBe(false);
  });

  it("closes on an equal-or-longer fence", () => {
    const { state } = feedChunks(["````ts\nx\n`````\n"]);

    expect(state.closed).toBe(true);
  });
});

describe("lines that must stay prose", () => {
  it("does not split inline backticks", () => {
    const { segments } = feedChunks(["use `code` here\n"]);

    expect(segments).toEqual([{ kind: "text", text: "use `code` here\n" }]);
  });

  it("does not split a four-space indented block", () => {
    const { segments } = feedChunks(["    ```ts\ncode\n    ```\n"]);

    expect(segments).toEqual([
      { kind: "text", text: "    ```ts\n" },
      { kind: "text", text: "code\n" },
      { kind: "text", text: "    ```\n" },
    ]);
  });

  it("does not split a fence with only two fence characters", () => {
    const { segments } = feedChunks(["``\n``\n"]);

    expect(segments).toEqual([
      { kind: "text", text: "``\n" },
      { kind: "text", text: "``\n" },
    ]);
  });

  it("keeps a tail line as prose when it never became a fence", () => {
    const { segments } = feedChunks(["plain tail"]);

    expect(segments).toEqual([{ kind: "text", text: "plain tail" }]);
  });
});

describe("fence shape", () => {
  it("keeps the info string as written apart from its trailing whitespace", () => {
    const { segments } = feedChunks(["```ts  title=a.ts  \n"]);

    expect(segments[0]).toEqual({ kind: "code-open", info: "ts  title=a.ts" });
  });

  it("keeps the leading spaces between the fence and the info", () => {
    const { segments } = feedChunks(["```  ts title=x  \n"]);

    expect(segments[0]).toEqual({ kind: "code-open", info: "  ts title=x" });
  });

  it("keeps the leading spaces on a tilde fence too", () => {
    const { segments } = feedChunks(["~~~  json  \n"]);

    expect(segments[0]).toEqual({ kind: "code-open", info: "  json" });
  });

  it("accepts an empty info string", () => {
    const { segments } = feedChunks(["``` \nx\n"]);

    expect(segments[0]).toEqual({ kind: "code-open", info: "" });
  });

  it("accepts up to three leading spaces on the opener and the closer", () => {
    const { state, segments } = feedChunks(["   ```ts\nx\n  ```\n"]);

    expect(segments).toEqual([
      { kind: "code-open", info: "ts" },
      { kind: "code-text", text: "x\n" },
      { kind: "code-close" },
    ]);
    expect(state.closed).toBe(true);
  });
});

describe("streaming", () => {
  it("holds a partial opener until its newline arrives", () => {
    const state = createFenceState();

    expect(feedFence(state, "```ts")).toEqual([]);
    expect(state.pendingLine).toBe("```ts");
    expect(feedFence(state, "\n")).toEqual([{ kind: "code-open", info: "ts" }]);
  });

  it("holds partial prose until its line ends", () => {
    const state = createFenceState();

    expect(feedFence(state, "hel")).toEqual([]);
    expect(feedFence(state, "lo\n")).toEqual([{ kind: "text", text: "hello\n" }]);
  });

  it("ignores an empty feed", () => {
    const { state, segments } = feedChunks([]);
    const before = state.pendingLine;

    expect(segments).toEqual([]);
    expect(feedFence(state, "")).toEqual([]);
    expect(state.pendingLine).toBe(before);
  });

  it("produces the same segments one character at a time", () => {
    const input = "intro\n   ```ts\nconst a = `x`;\n\n```   \nafter\n~~~\nbody\n~~~\ntail";

    const whole = scanFence(input);
    const chars = input.split("");
    const { segments: streamed } = feedChunks(chars);

    expect(streamed).toEqual(whole);
    expect(streamed.length).toBeGreaterThan(5);
  });
});
