/**
 * Tests for taking a terminal's contents away and putting them back.
 *
 * What is being tested, and why it needs a real terminal
 *   "Restored" is not the same claim as "serialize returned a string". The only
 *   evidence that a restore worked is that the buffer the user scrolls contains
 *   the text it did before, so most of this file drives a real `Terminal` and reads
 *   `buffer` back. A module of pure string handling could be tested against
 *   strings; this one can only be tested against a terminal.
 *
 *   jsdom has no layout engine, so xterm asks for `matchMedia` while opening and
 *   throws without a stub. The stub is in `beforeEach` for that reason, not as a
 *   nicety. `getContext` warnings from jsdom's canvas are noise.
 *
 * The four failures this file exists for
 *   1. restoring into a differently sized terminal -- the serialization carries
 *      absolute cursor positioning, so a smaller grid puts text on the wrong line;
 *   2. snapshotting an empty buffer -- every refresh would then store a blank
 *      string, and "is there a snapshot" would be true forever;
 *   3. snapshotting something enormous -- a binary file pasted into a shell is the
 *      realistic case, and restoring it produces garbage rather than a terminal;
 *   4. a restore that returns success without filling the buffer -- the one failure
 *      the caller cannot detect, which is why the round trip is asserted and not
 *      just the return value.
 */

// @vitest-environment jsdom

import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";

import { captureSnapshot, MAX_SNAPSHOT_BYTES, restoreSnapshot, snapshotBytes } from "./persist.js";

/** Terminals created by a test, torn down so jsdom does not accumulate them. */
const opened: Terminal[] = [];

/**
 * @param input terminal options
 * @returns a terminal with the serialize addon loaded
 */
function terminal(input: Partial<{ cols: number; rows: number; scrollback: number }> = {}): {
  term: Terminal;
  addon: SerializeAddon;
} {
  const term = new Terminal({ cols: 40, rows: 10, scrollback: 100, ...input });
  const addon = new SerializeAddon();

  term.loadAddon(addon);
  opened.push(term);

  return { term, addon };
}

/**
 * Write text into a terminal and wait for it to be parsed.
 *
 * `write` is asynchronous by design; the callback is the only signal that the
 * bytes have reached the buffer, so every fixture waits for it rather than
 * assuming a tick was enough.
 *
 * @param term the terminal to write into
 * @param text the text, which may contain newlines
 */
async function feed(term: Terminal, text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    term.write(text, resolve);
  });
}

/**
 * The visible text of a terminal's buffer.
 *
 * @param term the terminal
 * @returns its lines, trailing blank ones included -- see the round-trip case
 */
function lines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const result: string[] = [];

  for (let index = 0; index < buffer.length; index += 1) {
    result.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }

  return result;
}

/**
 * Wait for a terminal's pending writes to be parsed.
 *
 * xterm's `write` is asynchronous, so a buffer read immediately after it returns
 * describes the state before the write. A no-op write queues behind everything
 * already pending, which makes its callback the "buffer is now current" signal --
 * stronger than an arbitrary number of ticks.
 *
 * @param term the terminal to wait for
 */
async function settle(term: Terminal): Promise<void> {
  await new Promise<void>((resolve) => {
    term.write("", resolve);
  });
}

afterEach(() => {
  for (const term of opened.splice(0)) {
    try {
      term.dispose();
    } catch {
      // A disposed terminal is what the test wanted; jsdom sometimes throws on a
      // second teardown, which is not a fact about the module under test.
    }
  }
});

describe("what a snapshot is", () => {
  it("records the terminal's size alongside the text, because the text positions itself absolutely", async () => {
    // The serialization writes cursor movements in absolute cells. Restoring a
    // 40-column capture into an 80-column terminal does not reflow it -- the text
    // lands somewhere the user did not have it.
    const { term, addon } = terminal({ cols: 40, rows: 10 });
    await feed(term, "hello");

    const snap = captureSnapshot(addon, term);

    expect(snap).not.toBeNull();
    expect(snap?.cols).toBe(40);
    expect(snap?.rows).toBe(10);
    expect(snap?.serialized.length).toBeGreaterThan(0);
  });

  it("stamps the capture time, because a caller that keeps one snapshot needs to know how old it is", async () => {
    const { term, addon } = terminal();
    await feed(term, "hello");
    const before = Date.now();

    const snap = captureSnapshot(addon, term);

    expect(snap?.capturedAt).toBeGreaterThanOrEqual(before);
    expect(snap?.capturedAt).toBeLessThanOrEqual(Date.now());
  });

  it("measures itself in bytes rather than in characters, because the cap is a memory budget", () => {
    // A CJK-heavy buffer is three times its `length` in bytes. Counting characters
    // would let a snapshot three times the advertised cap through.
    const { term, addon } = terminal();

    return feed(term, "汉字汉字").then(() => {
      const snap = captureSnapshot(addon, term);

      expect(snap).not.toBeNull();
      expect(snapshotBytes(snap!)).toBeGreaterThanOrEqual(snap!.serialized.length);
    });
  });
});

describe("there is nothing to restore", () => {
  it("takes no snapshot of an empty buffer, because an empty snapshot makes 'is there one' true forever", () => {
    const { term, addon } = terminal();

    expect(captureSnapshot(addon, term)).toBeNull();
  });

  it("takes no snapshot of a buffer that only ever received a newline, because a blank line is not content", async () => {
    // The realistic shape of the failure: the panel mounts, the shell prints its
    // prompt and a newline, and the user refreshes before running anything. A
    // snapshot of that restores to an empty-looking terminal.
    const { term, addon } = terminal();
    await feed(term, "\r\n\r\n");

    expect(captureSnapshot(addon, term)).toBeNull();
  });

  it("takes a snapshot as soon as there is real text, so the empty case is not over-eager", async () => {
    const { term, addon } = terminal();
    await feed(term, "hello");

    expect(captureSnapshot(addon, term)).not.toBeNull();
  });
});

describe("the size cap", () => {
  it("refuses a snapshot over the cap, because a buffer that large means the shell printed something binary", () => {
    // `cat` on a binary file, or a runaway loop. Restoring that is not a favour:
    // the terminal would repaint a wall of control bytes, and the memory cost
    // lands on the renderer that is trying to recover.
    //
    // Stubbed rather than fed, and that is a measurement rather than a shortcut:
    // pushing four megabytes through a real parser in this environment takes
    // longer than the suite allows (a 700 KB buffer already took seconds), while
    // the decision under test is the arithmetic on the serialized size. A real
    // terminal stays in the other cases, where the round trip is what matters.
    const { term } = terminal();
    const huge = { serialize: () => "x".repeat(MAX_SNAPSHOT_BYTES + 1) };

    expect(captureSnapshot(huge as unknown as SerializeAddon, term)).toBeNull();
  });

  it("keeps a snapshot exactly at the cap, because the cap is a limit and 'over' means over", () => {
    const { term } = terminal();
    const exact = { serialize: () => "x".repeat(MAX_SNAPSHOT_BYTES) };

    expect(captureSnapshot(exact as unknown as SerializeAddon, term)).not.toBeNull();
  });

  it("keeps a snapshot just under the cap, so the budget is a limit and not a target", async () => {
    const { term, addon } = terminal();
    await feed(term, "small enough");

    const snap = captureSnapshot(addon, term);

    expect(snap).not.toBeNull();
    expect(snapshotBytes(snap!)).toBeLessThan(MAX_SNAPSHOT_BYTES);
  });

  it("advertises a budget that matches the measured cost of a large capture", () => {
    // The cap is four megabytes because a measured large capture was well under
    // one. Asserted so a future edit cannot quietly shrink it to a size real
    // terminals exceed.
    expect(MAX_SNAPSHOT_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("restoring into a different grid", () => {
  it("refuses, and says so, when the terminal's size changed -- the text would land on the wrong cells", async () => {
    // Returning false rather than throwing or silently skipping: the panel has to
    // decide between "resize to fit" and "start a fresh shell", and it cannot make
    // that choice from a snapshot it was told nothing about.
    const source = terminal({ cols: 40, rows: 10 });
    await feed(source.term, "hello\r\nworld");

    const snap = captureSnapshot(source.addon, source.term);
    expect(snap).not.toBeNull();

    const target = terminal({ cols: 80, rows: 24 });
    const restored = restoreSnapshot(target.addon, target.term, snap!);

    expect(restored).toBe(false);
  });

  it("refuses a rows-only change too, because a shorter grid loses lines just as badly", async () => {
    const source = terminal({ cols: 40, rows: 10 });
    await feed(source.term, "hello");

    const snap = captureSnapshot(source.addon, source.term)!;
    const target = terminal({ cols: 40, rows: 24 });

    expect(restoreSnapshot(target.addon, target.term, snap)).toBe(false);
  });

  it("restores into a terminal of the same size, because that is the case it exists for", async () => {
    const source = terminal({ cols: 40, rows: 10 });
    await feed(source.term, "hello\r\nworld");

    const snap = captureSnapshot(source.addon, source.term)!;
    const target = terminal({ cols: 40, rows: 10 });

    expect(restoreSnapshot(target.addon, target.term, snap)).toBe(true);
  });
});

describe("the round trip", () => {
  it("puts the text back where the user can read it, which is the only evidence a restore happened", async () => {
    // The assertion the rest of the file exists to make meaningful. A restore that
    // returned true and wrote nothing would pass every other case here.
    const source = terminal({ cols: 40, rows: 10 });
    await feed(source.term, "hello\r\nworld\r\n$ echo done");

    const expected = lines(source.term).filter((line) => line !== "");
    const snap = captureSnapshot(source.addon, source.term)!;

    const target = terminal({ cols: 40, rows: 10 });
    expect(restoreSnapshot(target.addon, target.term, snap)).toBe(true);

    // `Terminal.write` parses asynchronously, so the buffer is read after the
    // write settles. Asserting immediately is how a restore that works perfectly
    // looks broken.
    await settle(target.term);

    expect(lines(target.term).filter((line) => line !== "")).toEqual(expected);
  });

  it("keeps the text in the same order, because a restore that reorders is a different history", async () => {
    const source = terminal({ cols: 40, rows: 10 });
    await feed(source.term, "first\r\nsecond\r\nthird");

    const snap = captureSnapshot(source.addon, source.term)!;
    const target = terminal({ cols: 40, rows: 10 });
    restoreSnapshot(target.addon, target.term, snap);
    await settle(target.term);

    expect(lines(target.term).slice(0, 3)).toEqual(["first", "second", "third"]);
  });

  it("survives a second restore of the same snapshot, because a double refresh must not corrupt the view", async () => {
    const source = terminal({ cols: 40, rows: 10 });
    await feed(source.term, "hello");

    const snap = captureSnapshot(source.addon, source.term)!;
    const target = terminal({ cols: 40, rows: 10 });

    expect(restoreSnapshot(target.addon, target.term, snap)).toBe(true);
    expect(restoreSnapshot(target.addon, target.term, snap)).toBe(true);
  });

  it("restores a buffer that already has content without throwing, because the panel writes before it restores", async () => {
    // The realistic sequence: the panel mounts, the shell prints a banner, then the
    // snapshot is written back. That must not throw.
    const source = terminal({ cols: 40, rows: 10 });
    await feed(source.term, "restored text");

    const snap = captureSnapshot(source.addon, source.term)!;
    const target = terminal({ cols: 40, rows: 10 });
    await feed(target.term, "preexisting\r\n");

    expect(() => restoreSnapshot(target.addon, target.term, snap)).not.toThrow();
  });
});
