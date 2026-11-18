/**
 * Fence scanner: turns a message's running prose into an ordered stream of text
 * and code segments.
 *
 * Only fenced code blocks are split out. Markdown structure -- headings, lists,
 * tables, emphasis, formulas -- stays in the text segment verbatim, because a
 * later layer renders it and a scanner that guessed at structure would be a
 * second parser that disagrees with the first. Nothing is escaped, trimmed,
 * re-wrapped or language-tagged here.
 *
 * The scanner is line-oriented on purpose. A fence opener is only real once its
 * newline has arrived: until then the tail sits in `pendingLine`, so a partial
 * "```" never reaches the surface as prose and then has to be taken back. The
 * cost is one line of latency, the only delay this layer introduces. Text that
 * is already complete is emitted immediately, so the delay never accumulates.
 *
 * The accepted fence subset:
 *
 * - an opener is 0-3 leading spaces, a run of three or more backticks or three
 *   or more tildes, then the info string, kept as written minus trailing
 *   whitespace (any spaces between the fence run and the info stay);
 * - a closer uses the opener's character, is at least as long as the opener,
 *   and has nothing but whitespace after it (0-3 leading spaces are allowed);
 * - a fence inside a fenced block is never an opener, and the fence lines
 *   themselves belong to no segment;
 * - the newline before the closer stays in the code text;
 * - a four-space indent, an inline backtick, and a fence inside a list or a
 *   blockquote are all ordinary text. That is a deliberate limitation: the
 *   syntax needed to tell those apart is Markdown structure, which is out of
 *   scope for this layer.
 *
 * Everything here is deterministic: no clock, no randomness, no I/O. The only
 * state is the `FenceState` the caller passes in, and the return value is the
 * only thing a caller has to act on. Feeding one long string and feeding the
 * same string one character at a time produce the same segments, which is what
 * makes the streaming and the whole-message paths agree.
 */

import type { FenceState } from "./types.js";

/** One step the scanner reports, in source order. */
export type FenceSegment =
  /** Prose, exactly as written, including its trailing newline when it had one. */
  | { readonly kind: "text"; readonly text: string }
  /** A fence opener; `info` is the raw info string minus its trailing whitespace. */
  | { readonly kind: "code-open"; readonly info: string }
  /** One code line, exactly as written, including its trailing newline when it had one. */
  | { readonly kind: "code-text"; readonly text: string }
  /** The closing fence; the line itself is not part of any segment. */
  | { readonly kind: "code-close" };

/** A leading run of fence characters, with whatever followed it. */
type FenceRun = {
  readonly char: "`" | "~";
  readonly length: number;
  readonly rest: string;
};

/** A scanner that has seen nothing yet: prose mode, empty tail. */
export function createFenceState(): FenceState {
  return {
    mode: "text",
    fenceChar: null,
    fenceLength: 0,
    info: "",
    closed: false,
    pendingLine: "",
  };
}

/**
 * Feed one piece of text to the scanner and collect what it produced.
 *
 * The state is mutated in place. A trailing line without a newline is kept in
 * `pendingLine` and produces nothing yet; call `finishFence` to flush it once
 * the message is over. An empty input produces nothing and leaves the state
 * untouched.
 */
export function feedFence(state: FenceState, text: string): readonly FenceSegment[] {
  const segments: FenceSegment[] = [];

  if (text.length === 0) {
    return segments;
  }

  state.pendingLine += text;
  let start = 0;
  let newline = state.pendingLine.indexOf("\n", start);
  while (newline !== -1) {
    consumeLine(state, state.pendingLine.slice(start, newline), segments);
    start = newline + 1;
    newline = state.pendingLine.indexOf("\n", start);
  }
  state.pendingLine = state.pendingLine.slice(start);

  return segments;
}

/**
 * Flush the tail that never got a newline.
 *
 * In prose mode the tail is text and leaves without a newline of its own; in
 * code mode it is the last code line and equally leaves as written. The tail is
 * not re-examined for a fence: an opener needs its newline to exist at all, so
 * the tail of a finished message can never turn into one. `closed` is untouched,
 * which is what keeps an unterminated block's `closed:false` truthful.
 */
export function finishFence(state: FenceState): readonly FenceSegment[] {
  if (state.pendingLine.length === 0) {
    return [];
  }

  const tail = state.pendingLine;
  state.pendingLine = "";
  return [state.mode === "code" ? { kind: "code-text", text: tail } : { kind: "text", text: tail }];
}

/**
 * Scan a whole string in one call.
 *
 * A convenience for the non-streaming path and for tests; the incremental form
 * is `feedFence` plus `finishFence`.
 */
export function scanFence(text: string): readonly FenceSegment[] {
  const state = createFenceState();
  return [...feedFence(state, text), ...finishFence(state)];
}

/** Decide one complete line (without its newline) and move the state on. */
function consumeLine(state: FenceState, line: string, segments: FenceSegment[]): void {
  if (state.mode === "code") {
    const run = readFenceRun(line);
    if (
      run !== null &&
      state.fenceChar !== null &&
      run.char === state.fenceChar &&
      run.length >= state.fenceLength &&
      run.rest.trim() === ""
    ) {
      // The closer ends the block; it is not a line of code and never will be.
      state.mode = "text";
      state.closed = true;
      state.fenceChar = null;
      state.fenceLength = 0;
      state.info = "";
      segments.push({ kind: "code-close" });
      return;
    }

    segments.push({ kind: "code-text", text: `${line}\n` });
    return;
  }

  const opener = readFenceRun(line);
  if (opener !== null) {
    state.mode = "code";
    state.fenceChar = opener.char;
    state.fenceLength = opener.length;
    state.info = opener.rest.trimEnd();
    state.closed = false;
    segments.push({ kind: "code-open", info: state.info });
    return;
  }

  segments.push({ kind: "text", text: `${line}\n` });
}

/**
 * Read a fence run from the start of a line.
 *
 * Returns `null` when the line does not start with one: more than three leading
 * spaces, a character other than a backtick or a tilde, or fewer than three of
 * them. `rest` is everything after the run, still untouched.
 */
function readFenceRun(line: string): FenceRun | null {
  let index = 0;
  while (index < 3 && line.charAt(index) === " ") {
    index += 1;
  }

  const char = line.charAt(index);
  if (char !== "`" && char !== "~") {
    return null;
  }

  const start = index;
  while (line.charAt(index) === char) {
    index += 1;
  }
  const length = index - start;
  if (length < 3) {
    return null;
  }

  return { char, length, rest: line.slice(index) };
}
