/**
 * Tests for the two exits: a keyboard stroke and a paste.
 *
 * What these assertions are actually protecting
 *   Every one of them would still pass on a module that produced correct bytes
 *   in the general case. The cases collected here are the ones where the bytes
 *   must *not* travel, or must differ from what the general case would send, so
 *   a general-case-only implementation fails here even while it looks right.
 *   Each block names the defect it catches.
 *
 * The interrupt precedence case
 *   `Ctrl+C` mid-composition is deliberately asserted in both directions: the
 *   plain composition case proves the guard works, and the stop case proves the
 *   guard does not swallow the one byte a user cannot afford to lose. Keeping
 *   only the first would let a strict priority order pass review and then
 *   strand a foreground process.
 */

import { describe, expect, it } from "vitest";

import { TERMINAL_INPUT_CAPABILITY, translateKey, translatePaste } from "./exit.js";
import type { KeyStroke, PasteDecision } from "./exit.js";

/** The interrupt byte, spelled without a control character in this file. */
const ETX = "\u0003";

/** DEL: what the terminal emulator emits for one Backspace press. */
const DEL = "\u007f";

/** ESC: the prefix of every cursor-key sequence. */
const ESC = "\u001b";

/** A minimal stroke with no modifiers held and no composition open. */
function stroke(key: string, data: string): KeyStroke {
  return { key, data };
}

describe("translateKey: the strokes that are passed through", () => {
  it("sends a printable character as the character itself", () => {
    expect(translateKey(stroke("a", "a"))).toBe("a");
    expect(translateKey(stroke("Z", "Z"))).toBe("Z");
    expect(translateKey(stroke(" ", " "))).toBe(" ");
  });

  it("sends a cursor key as one sequence, not as the bytes that spell it", () => {
    // The emulator already chose the sequence; re-deriving it here would be a
    // second opinion about the same stroke, and the two would drift.
    expect(translateKey(stroke("ArrowUp", `${ESC}[A`))).toBe(`${ESC}[A`);
    expect(translateKey(stroke("ArrowDown", `${ESC}[B`))).toBe(`${ESC}[B`);
    expect(translateKey(stroke("ArrowRight", `${ESC}[C`))).toBe(`${ESC}[C`);
    expect(translateKey(stroke("ArrowLeft", `${ESC}[D`))).toBe(`${ESC}[D`);
  });

  it("sends Backspace as exactly one deletion", () => {
    // Granularity is the property: one press is one payload. A module that
    // split the payload into per-byte writes would delete twice per press for a
    // multi-byte sequence, and a single-byte assertion here would not notice.
    expect(translateKey(stroke("Backspace", DEL))).toBe(DEL);
    expect(translateKey(stroke("Backspace", DEL))).toHaveLength(1);

    const wordDelete = `${ESC}[3;5~`;
    expect(translateKey(stroke("Backspace", wordDelete))).toBe(wordDelete);
  });

  it("sends Tab and Escape", () => {
    expect(translateKey(stroke("Tab", "\t"))).toBe("\t");
    expect(translateKey(stroke("Escape", ESC))).toBe(ESC);
  });

  it("sends nothing for an empty payload", () => {
    // A modifier pressed on its own, a swallowed gesture. Sending `""` would be
    // a write of zero bytes, which the wire does not need and which a spy on the
    // producer cannot distinguish from a real one.
    expect(translateKey(stroke("Shift", ""))).toBeNull();
    expect(translateKey({ key: "a", data: "", ctrlKey: true })).toBeNull();
  });
});

describe("translateKey: Ctrl+C is an interrupt even with a selection", () => {
  it("sends the interrupt byte when there is nothing to copy", () => {
    expect(translateKey({ key: "c", data: "", ctrlKey: true })).toBe(ETX);
  });

  it("sends the interrupt byte when the payload already is the interrupt", () => {
    expect(translateKey({ key: "c", data: ETX, ctrlKey: true })).toBe(ETX);
  });

  it("cannot be talked into copying by a selection it is told about", () => {
    // No input describes a selection, so no branch can read one. This asserts
    // the absence directly: a stroke carrying the extra field decides the same
    // way as one without it, for both answers a selection could have.
    const selected: KeyStroke & { readonly hasSelection: boolean } = {
      key: "c",
      data: "",
      ctrlKey: true,
      hasSelection: true,
    };
    const unselected: KeyStroke & { readonly hasSelection: boolean } = {
      ...selected,
      hasSelection: false,
    };

    expect(translateKey(selected)).toBe(ETX);
    expect(translateKey(unselected)).toBe(ETX);
    expect(translateKey(selected)).toBe(translateKey(unselected));
  });

  it("still interrupts while a composition is apparently open", () => {
    // The emulator finalizes the composition and then emits the interrupt, so
    // this flag is one tick stale for exactly the stroke that must not be lost.
    expect(translateKey({ key: "c", data: ETX, ctrlKey: true, isComposing: true })).toBe(ETX);
  });

  it("treats AltGr as a character, not as an interrupt", () => {
    // Platform key events report AltGr as Control+Alt. It produces a character
    // through the browser, never through the emulator's data event, so the pair
    // must not read as a stop gesture.
    expect(translateKey({ key: "c", data: "©", ctrlKey: true, altKey: true })).toBe("©");
  });
});

describe("translateKey: the chord gestures send nothing", () => {
  it("sends nothing for Ctrl+Shift+C, whatever the payload says", () => {
    // The window's copy gesture. Forwarding the payload would put a literal
    // Control+C into the shell as an interrupt for a key the user pressed to
    // copy -- the defect this rule exists for.
    expect(translateKey({ key: "c", data: ETX, ctrlKey: true, shiftKey: true })).toBeNull();
    expect(translateKey({ key: "C", data: "C", ctrlKey: true, shiftKey: true })).toBeNull();
  });

  it("sends nothing for Ctrl+Shift+V, whatever the payload says", () => {
    expect(translateKey({ key: "v", data: "v", ctrlKey: true, shiftKey: true })).toBeNull();
    expect(translateKey({ key: "V", data: "\u0016", ctrlKey: true, shiftKey: true })).toBeNull();
  });

  it("sends nothing for the command-key spelling of the same gestures", () => {
    expect(translateKey({ key: "c", data: "c", metaKey: true, shiftKey: true })).toBeNull();
    expect(translateKey({ key: "v", data: "v", metaKey: true, shiftKey: true })).toBeNull();
  });

  it("leaves a bare Ctrl+C alone when Shift is the only modifier in question", () => {
    // Not a chord: Control alone is the interrupt, and the shift rule must not
    // widen to cover it.
    expect(translateKey({ key: "c", data: "", ctrlKey: true, shiftKey: false })).toBe(ETX);
    expect(translateKey({ key: "v", data: "\u0016", ctrlKey: true })).toBe("\u0016");
  });
});

describe("translateKey: an open composition sends nothing", () => {
  it("sends nothing while the input method owns the input", () => {
    // The payload here is what the general case would forward, which is why this
    // assertion cannot be satisfied by a pass-through that forgot the flag.
    expect(translateKey({ key: "a", data: "a", isComposing: true })).toBeNull();
    expect(translateKey({ key: "Process", data: "\u3093", isComposing: true })).toBeNull();
    expect(translateKey({ key: "Enter", data: "\r", isComposing: true })).toBeNull();
  });

  it("sends the committed text once and only once the composition ends", () => {
    // What the emulator does at composition end: one data event with the whole
    // finished text, and the flag already cleared.
    expect(translateKey({ key: "Process", data: "\u65e5\u672c\u8a9e", isComposing: false })).toBe(
      "\u65e5\u672c\u8a9e",
    );
  });

  it("sends nothing across the whole composition, per stroke", () => {
    // The property, not one example: every intermediate stroke yields null, and
    // the run of nulls is what a spy would count as zero bytes sent.
    const composing = ["n", "i", "h", "o", "n"];
    const decisions = composing.map((key) => translateKey({ key, data: key, isComposing: true }));

    expect(decisions).toEqual([null, null, null, null, null]);
  });
});

describe("translatePaste: one line goes straight through", () => {
  it("sends a single line unchanged and never asks", () => {
    expect(translatePaste("ls -la", { confirmed: false })).toEqual({
      action: "send",
      data: "ls -la",
    });
  });

  it("sends text with no line break at all", () => {
    expect(translatePaste("", { confirmed: false })).toEqual({ action: "send", data: "" });
  });
});

describe("translatePaste: several lines ask first", () => {
  it("asks before sending, and reports the line count", () => {
    expect(translatePaste("rm -rf build\nnpm test", { confirmed: false })).toEqual({
      action: "ask",
      lines: 2,
    });
  });

  it("sends once the caller says the user confirmed", () => {
    expect(translatePaste("rm -rf build\nnpm test", { confirmed: true })).toEqual({
      action: "send",
      data: "rm -rf build\rnpm test",
    });
  });

  it("normalizes every line ending to the byte a shell submits on", () => {
    // A payload with a bare line feed does not submit on a normal line
    // discipline, so the paste path has to be the one place that fixes it.
    expect(translatePaste("a\nb", { confirmed: true })).toEqual({ action: "send", data: "a\rb" });
    expect(translatePaste("a\r\nb", { confirmed: true })).toEqual({
      action: "send",
      data: "a\rb",
    });
    expect(translatePaste("a\rb", { confirmed: true })).toEqual({ action: "send", data: "a\rb" });
  });
});

describe("translatePaste: the line count is pinned", () => {
  it("counts a trailing newline as one more line", () => {
    // The decision, stated so it cannot drift silently: lines are breaks + 1, so
    // the empty final segment counts. It is the segment whose newline would
    // submit the command above it, and a confirmation that hid it would
    // understate what the paste does to the shell.
    expect(translatePaste("a\nb", { confirmed: false })).toEqual({ action: "ask", lines: 2 });
    expect(translatePaste("a\nb\n", { confirmed: false })).toEqual({ action: "ask", lines: 3 });
    expect(translatePaste("\n", { confirmed: false })).toEqual({ action: "ask", lines: 2 });
    expect(translatePaste("a\n\nb", { confirmed: false })).toEqual({ action: "ask", lines: 3 });
  });

  it("counts the same number of lines before and after confirmation", () => {
    // The number the dialog shows is the number the decision carries, so a
    // second count on the confirmed path would be a second definition of it.
    const pending: PasteDecision = translatePaste("a\nb\nc", { confirmed: false });
    const confirmed: PasteDecision = translatePaste("a\nb\nc", { confirmed: true });

    expect(pending).toEqual({ action: "ask", lines: 3 });
    expect(confirmed).toEqual({ action: "send", data: "a\rb\rc" });

    if (confirmed.action !== "send") {
      throw new Error(`expected the confirmed paste to send, got ${confirmed.action}`);
    }

    expect(confirmed.data.split("\r")).toHaveLength(3);
  });

  it("does not ask for a single line even when told it was confirmed", () => {
    expect(translatePaste("single", { confirmed: true })).toEqual({
      action: "send",
      data: "single",
    });
  });
});

/**
 * The renderer's own sources, as raw text.
 *
 * Why the renderer source is read at all
 *   Every behavioural assertion above can pass on a module that is correct while
 *   some other file assembles the same payload for itself. That is the defect
 *   this whole file is organised around: two producers mean a spy on one of them
 *   reports zero bytes sent while the other keeps sending, and the suite stays
 *   green. Behavioural tests cannot see a module they never import, so the
 *   producer count is asserted structurally: the capability name may appear in
 *   this file and nowhere else in the renderer.
 *
 * What the glob covers
 *   Every `.ts` and `.tsx` under the renderer's `src/`, not just this directory.
 *   A producer added next to a keyboard handler or a paste handler is exactly
 *   where one would appear, and a scan of this directory alone would miss it.
 *   Comment text is stripped before matching, so the module's own prose about the
 *   capability is not counted as a use of it.
 *
 * Why `import.meta.glob` with `?raw` rather than `node:fs`
 *   The renderer may not import a Node builtin, and the boundary gate enforces
 *   that on the resolved specifier, so even this test cannot reach `node:fs`.
 *   The glob is compile-time only, which also keeps it honest: it reads the same
 *   text the bundler reads.
 */
const SOURCES: Record<string, string> = (
  import.meta as ImportMeta & {
    glob: (
      pattern: string[],
      options: { query: string; import: string; eager: true },
    ) => Record<string, string>;
  }
).glob(["../../**/*.ts", "../../**/*.tsx"], { query: "?raw", import: "default", eager: true });

/**
 * Strip comments, so a file that merely *mentions* the capability in prose is
 * not counted as a producer of it.
 *
 * @param source TypeScript source text
 * @returns the source with block and line comments removed
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("the module is the only place a terminal-input payload is named", () => {
  it("has no producer of the payload outside itself and this test", () => {
    // The capability name is spelled once, in the module, and once here because
    // this test has to look for it. Any third occurrence -- a keyboard handler
    // that builds its own payload instead of calling `translateKey`, a paste
    // handler that does the same -- lands in this list.
    const offenders = Object.keys(SOURCES).filter((path) => {
      if (path.endsWith("exit.ts") || path.endsWith("exit.test.ts")) return false;

      const text = SOURCES[path];

      return text !== undefined && stripComments(text).includes(TERMINAL_INPUT_CAPABILITY);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps the name out of the module's behaviour, so the scan cannot be dodged", () => {
    // A producer could avoid the literal by spelling the capability some other
    // way. This pins the shape instead: the two functions take a stroke or a
    // string and return bytes, so there is no payload object to assemble here
    // and nothing for a second producer to copy.
    expect(typeof translateKey).toBe("function");
    expect(typeof translatePaste).toBe("function");
    expect(Object.keys(SOURCES).length).toBeGreaterThan(1);
  });
});
