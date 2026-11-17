#!/usr/bin/env node
/**
 * verify-terminal.mjs - the terminal assertions that a unit test cannot reach.
 *
 * Usage:
 *   node apps/desktop/scripts/verify-terminal.mjs
 *
 * Why this script exists
 *   Most of the terminal layer is already unit-tested. What is left is the small
 *   set of claims about a *live* emulator: does the grid recompute when the
 *   window resizes, and do several terminals coexist without drinking from each
 *   other's buffer. Both need a real `Terminal` walked through open / write /
 *   resize in order, which is exactly the shape a unit test replaces with a
 *   double.
 *
 * What it can answer, and what it cannot
 *   The DOM here is jsdom. It has no layout engine, so there is no compositor,
 *   no scroll performance, no real font metrics and no clipboard. This script
 *   therefore answers only the three claims that survive without those:
 *
 *     manual-cleanup-dialog  after a container resize, the column/row count is recomputed, and
 *           the bytes already written are still in the buffer
 *     crash-record-retention  what each of the three clears actually clears: the product's `\f`
 *           (which delegates), `ESC[2J` (display only) and `ESC[3J` (scrollback
 *           included)
 *       N terminals coexist: every one echoes its own line and none shows
 *           another's
 *
 *   Three claims no headless run can make -- smooth scrolling, selection and
 *   copy, and a font change that does not reflow -- are reported as MANUAL, not
 *   as PASS. None of them is among the document's judgements: the first two are
 *   ergonomics, and the third is a follows from how clearing is defined. A script that reported
 *   "smooth" would be claiming to know something jsdom cannot observe, because
 *   it has no compositor to stutter.
 *
 * What "clear" can and cannot mean here
 *   Three different things are called "clear", and only one of them is what the
 *   product does. They are measured separately because a reader who conflated
 *   them would grade the wrong one:
 *
 *   1. The product sends a form feed (`\f`, Control-L) to the shell. That byte is
 *      a line break to the terminal, not a clear, so the scrollback decision
 *      belongs to the shell and no headless run can observe the answer. What this
 *      script does assert is the part on our side of the wire: `\f` erases
 *      nothing, so the panel is delegating rather than clearing.
 *   2. `ESC[2J` erases the display and leaves every scrolled-off row in place.
 *      A program that clears this way is repainting the viewport only.
 *   3. `ESC[3J` erases the saved lines as well, and `Terminal.clear()` reaches the
 *      scrollback too -- measured, and recorded as notes rather than graded,
 *      because the product calls neither.
 *
 *   What is *not* asserted anywhere is that the repaint reached the screen: a
 *   buffer with no rows and a screen still showing the old ones are
 *   indistinguishable to any headless run, and that gap is what the manual entry
 *   covers.
 *
 * The size stub, and why it is load-bearing
 *   jsdom performs no layout, so xterm's own cell metrics resolve to 0x0 and
 *   `FitAddon.fit()` silently does nothing: it reads a cell width of 0, decides
 *   it cannot propose dimensions, and returns. No error, no warning -- the same
 *   failure family as installing no stylesheet. So the cell metrics are stubbed
 *   to a known 10x20 and the container's size is set as an inline style, which
 *   `getComputedStyle` *does* report in jsdom. That makes the arithmetic real
 *   and the layout fake: this verifies that the panel recomputes and that the
 *   formula is wired to the container, not that a browser laid anything out.
 *
 *   The stub has to be re-applied after every `fit()`, because a successful fit
 *   calls `resize`, which rebuilds the render service and puts the real 0x0 cell
 *   metrics back. A version of this script that stubbed once passed the first
 *   assertion and silently skipped every later one.
 *
 * Two environment details, both learned from the sibling probe scripts:
 *   The packages are resolved from `packages/ui/package.json`, because that is
 *   the package that declares them; resolving from here would look in the wrong
 *   tree. And jsdom has no `matchMedia`, which xterm queries while opening --
 *   without the stub `open` throws instead of mounting, so the stub is what
 *   makes the rest of the file possible rather than a nicety.
 *
 * Exit codes: 0 every automated claim held, 1 one failed, 2 the setup is broken.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

/** Anchor resolution at the package that declares the dependencies. */
const HERE = dirname(fileURLToPath(import.meta.url));
const UI_PACKAGE = resolve(HERE, "../../../packages/ui/package.json");
const require = createRequire(UI_PACKAGE);

/**
 * How many terminals the concurrency claim asserts at once.
 *
 * Measured, not assumed: construction and echoing held up to 1024 terminals on
 * this machine (see the ceiling probe below, which reports it), so the assertion
 * is set at a count a user can plausibly reach -- sixteen panes, twice what a
 * window full of tabs tends to be -- and the ceiling is reported separately
 * rather than being used as the pass bar. Asserting at the ceiling would make a
 * red result mean "this box is small", which is not what the claim is about.
 */
const CONCURRENT_TERMINALS = 16;

/** The stubbed cell metrics. Real values come from a browser's font shaping. */
const CELL_WIDTH = 10;
const CELL_HEIGHT = 20;

/** xterm subtracts its scrollbar allowance from the container width before dividing. */
const SCROLLBAR_ALLOWANCE = 14;

/** Container sizes the resize claim is exercised across. */
const SIZES = [
  { width: 800, height: 480 },
  { width: 400, height: 240 },
  { width: 1200, height: 720 },
  { width: 240, height: 200 },
];

/** Counts the ceiling probe walks up, stopping at the first one that fails. */
const CEILING = [64, 128, 256, 512, 1024];

/** Automatically graded results, in report order. */
const graded = [];

/** Reported as MANUAL: no headless run can observe what these ask. */
const manual = [];

let failures = 0;

/**
 * Record and print one automatically graded claim.
 *
 * @param {string} label what was claimed
 * @param {boolean} ok whether it held
 * @param {string} [detail] the measurement behind the answer
 * @returns {boolean} `ok`, so a caller can branch on it
 */
/**
 * Record an observation that is not a pass/fail claim.
 *
 * Some measurements describe a library rather than this product, and grading them
 * makes a green run lie in the other direction: it would report that a behaviour
 * nobody calls has been verified.
 *
 * @param {string} label what was observed
 * @param {string} detail the measurement
 */
function note(label, detail) {
  process.stdout.write(`NOTE  ${label}  -- ${detail}\n`);
}

function check(label, ok, detail) {
  graded.push({ label, ok, detail });
  process.stdout.write(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${detail}`}\n`,
  );

  if (!ok) failures += 1;

  return ok;
}

/**
 * Record one claim that only a human at a real window can settle.
 *
 * Printed as MANUAL rather than omitted, because a reader who only sees the
 * PASS lines would reasonably conclude the whole item is verified.
 *
 * @param {string} label the claim
 * @param {string} because why no headless run can answer it
 */
function manualOnly(label, because) {
  manual.push({ label, because });
  process.stdout.write(`MANUAL  ${label}  -- ${because}\n`);
}

/**
 * A DOM for xterm, with the gaps jsdom leaves filled in.
 *
 * @returns {JSDOM} the document xterm renders into
 */
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);

  // xterm asks for the device pixel ratio while opening; jsdom has no such query
  // and `open` throws without it, so this is what lets a terminal exist here.
  dom.window.matchMedia ??= (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });

  return dom;
}

/**
 * Resolve a named export from a CommonJS package loaded through ESM.
 *
 * These packages are CJS with named exports, so the ESM namespace also carries
 * them under `default`. The product code must use the named import form; this
 * tolerance exists because a probe that reported a loader difference as a
 * version problem would be worse than useless.
 *
 * @param {object} namespace the module namespace
 * @param {string} name the export to take
 * @returns {unknown} the export, or undefined
 */
function named(namespace, name) {
  return namespace[name] ?? namespace.default?.[name] ?? namespace["module.exports"]?.[name];
}

/**
 * @param {HTMLElement} container the element the terminal paints into
 * @returns {HTMLElement[]} its mounted terminal roots, one per live instance
 */
function terminalRoots(container) {
  return [...container.querySelectorAll(".terminal")];
}

/**
 * @param {object} terminal an xterm instance
 * @returns {string[]} every non-empty row, in order
 */
function rows(terminal) {
  const out = [];

  for (let index = 0; index < terminal.buffer.active.length; index += 1) {
    const text = terminal.buffer.active.getLine(index)?.translateToString(true) ?? "";

    if (text !== "") out.push(text);
  }

  return out;
}

/**
 * Settle a write, so the buffer is readable on the next line.
 *
 * `Terminal.write` parses asynchronously; reading the buffer without the
 * callback returns the state before the text landed, which reads as an empty
 * buffer rather than as a race.
 *
 * @param {object} terminal an xterm instance
 * @param {string} text what to write
 * @returns {Promise<void>} resolves once the text is in the buffer
 */
function settle(terminal, text) {
  return new Promise((done) => terminal.write(text, done));
}

/**
 * Make the cell metrics non-zero for one fit.
 *
 * xterm computes these from font shaping, which jsdom cannot do, so they are
 * 0x0 and `fit()` declines to propose any dimensions. Stubbing them is what
 * turns "fit does nothing" into "fit computes from the container".
 *
 * @param {object} terminal an xterm instance
 */
function stubCellMetrics(terminal) {
  const metrics = terminal._core._renderService.dimensions.css.cell;

  metrics.width = CELL_WIDTH;
  metrics.height = CELL_HEIGHT;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const dom = installDom();

/**
 * Load one dependency, or report the setup as broken.
 *
 * Wrapped rather than left to throw, because `createRequire` raising
 * `MODULE_NOT_FOUND` would print a stack trace and exit 1 -- the code that
 * means "an assertion failed", which is the one answer this is not. Exit 2 is
 * reserved for "the tree cannot run this script at all", and that distinction is
 * the difference between "the panel is broken" and "run pnpm install".
 *
 * @param {string} specifier the package to load
 * @returns {object | null} the module namespace, or null when it is absent
 */
function loadPackage(specifier) {
  try {
    return require(specifier);
  } catch (error) {
    process.stderr.write(
      `FAIL  cannot load ${specifier} from ${UI_PACKAGE}\n` +
        `      ${String(error?.message ?? error).split("\n")[0]}\n` +
        "      run: pnpm install\n",
    );
    process.exit(2);
  }
}

const xterm = loadPackage("@xterm/xterm");
const fitPackage = loadPackage("@xterm/addon-fit");

const Terminal = named(xterm, "Terminal");
const FitAddon = named(fitPackage, "FitAddon");

if (Terminal === undefined || FitAddon === undefined) {
  process.stderr.write(
    `FAIL  the xterm packages loaded but did not export what this script needs\n` +
      `      Terminal=${String(Terminal)} FitAddon=${String(FitAddon)}\n` +
      "      the named form is required; a default import yields undefined at runtime\n",
  );
  process.exit(2);
}

const CSS_PATH = join(dirname(require.resolve("@xterm/xterm/package.json")), "css/xterm.css");
const CSS = readFileSync(CSS_PATH, "utf8");

{
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
}

process.stdout.write("verify-terminal\n");
process.stdout.write(`xterm:  ${require.resolve("@xterm/xterm")}\n`);
process.stdout.write(`jsdom:  no layout engine (cell metrics stubbed at 10x20)\n\n`);

// ---------------------------------------------------------------------------
// A resize recomputes the grid, and keeps the bytes it already had
// ---------------------------------------------------------------------------

process.stdout.write("--- resize recomputes the grid\n");

{
  const container = document.createElement("div");
  container.style.width = `${SIZES[0].width}px`;
  container.style.height = `${SIZES[0].height}px`;
  document.body.append(container);

  const terminal = new Terminal({ cols: 80, rows: 24, fontSize: 13 });
  terminal.open(container);

  const fit = new FitAddon();
  terminal.loadAddon(fit);

  const proposals = [];

  for (const { width, height } of SIZES) {
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;

    // Re-stubbed every round: a successful fit calls `resize`, which rebuilds the
    // render service and restores the real (zero) metrics.
    stubCellMetrics(terminal);

    const proposed = fit.proposeDimensions();
    fit.fit();

    const expectedCols = Math.max(2, Math.floor((width - SCROLLBAR_ALLOWANCE) / CELL_WIDTH));
    const expectedRows = Math.max(1, Math.floor(height / CELL_HEIGHT));

    proposals.push({
      width,
      height,
      proposed,
      cols: terminal.cols,
      rows: terminal.rows,
      expectedCols,
      expectedRows,
    });
  }

  const allComputed = proposals.every((entry) => entry.proposed !== undefined);
  check(
    "fit proposes dimensions once cell metrics exist",
    allComputed,
    allComputed ? `${proposals.length} container sizes` : "proposeDimensions returned undefined",
  );

  const allMatch = proposals.every(
    (entry) => entry.cols === entry.expectedCols && entry.rows === entry.expectedRows,
  );
  check(
    "the grid follows the container, not the constructor",
    allMatch,
    proposals.map((e) => `${e.width}x${e.height}->${e.cols}x${e.rows}`).join(" "),
  );

  const distinct = new Set(proposals.map((entry) => `${entry.cols}x${entry.rows}`)).size;
  check(
    "each container size yields a distinct grid",
    distinct === proposals.length,
    `${distinct} distinct of ${proposals.length}`,
  );

  terminal.dispose();
  container.remove();
}

{
  // The second half of the claim, and the one a user notices: resizing a window
  // must not lose what a command already printed.
  const container = document.createElement("div");
  document.body.append(container);

  const terminal = new Terminal({ cols: 80, rows: 24, fontSize: 13 });
  terminal.open(container);

  const sentence = "the quick brown fox jumps over the lazy dog 0123456789";
  await settle(terminal, `${sentence}\r\nsecond line\r\n`);

  const originalBytes = `${sentence}second line`;

  for (const cols of [40, 30, 100, 20]) {
    terminal.resize(cols, 12);

    const text = rows(terminal).join("");

    check(
      `bytes survive a resize to ${cols} columns`,
      text === originalBytes,
      text === originalBytes
        ? `${text.length} chars`
        : `lost or reordered: got ${text.length} of ${originalBytes.length}`,
    );
  }

  terminal.dispose();
  container.remove();
}

{
  // Narrowing rewraps, which is unavoidable: a 54-character line cannot occupy
  // one 40-column row. What is worth asserting is the part a user would call a
  // bug -- that the rewrap is *reversible*. Widening back re-joins the physical
  // rows here, so the buffer is byte-identical to before the shrink and only the
  // intermediate display differed.
  const container = document.createElement("div");
  document.body.append(container);

  const terminal = new Terminal({ cols: 80, rows: 24, fontSize: 13 });
  terminal.open(container);

  const sentence = "the quick brown fox jumps over the lazy dog 0123456789";
  await settle(terminal, `${sentence}\r\nsecond line\r\n`);

  const before = rows(terminal);
  terminal.resize(40, 12);
  const narrowed = rows(terminal);

  terminal.resize(80, 24);
  const restored = rows(terminal);

  check(
    "narrowing rewraps one row into several",
    narrowed.length > before.length && before[0].startsWith((narrowed[0] ?? "").trimEnd()),
    `${before.length} rows became ${narrowed.length} at 40 columns`,
  );

  check(
    "widening back restores the original rows, so the rewrap is reversible",
    restored.join("\u0000") === before.join("\u0000"),
    restored.length === before.length
      ? `row 0 is ${(restored[0] ?? "").length} chars again`
      : `row count ${restored.length} of ${before.length}`,
  );

  terminal.dispose();
  container.remove();
}

// ---------------------------------------------------------------------------
// Clearing the screen also clears what a user can scroll back to
// ---------------------------------------------------------------------------

process.stdout.write("\n--- clear reaches the scrollback\n");

{
  // Both halves are asserted against a buffer that has actually overflowed the
  // viewport, because a clear that only touches the visible rows passes
  // trivially on a screen that never scrolled. Forty rows into a ten-row viewport
  // leaves thirty-one saved lines, which is the state the claim is about.
  const container = document.createElement("div");
  document.body.append(container);

  const terminal = new Terminal({ cols: 40, rows: 10, scrollback: 500, fontSize: 13 });
  terminal.open(container);

  const before = [];
  for (let index = 0; index < 40; index += 1) {
    const line = `scrolled-${index}`;
    before.push(line);
    await settle(terminal, `${line}\r\n`);
  }

  const savedLines = terminal.buffer.active.baseY;

  check(
    "the fixture really did overflow the viewport",
    savedLines > 0,
    `${savedLines} saved lines behind a ${terminal.rows}-row viewport`,
  );

  // The product's clear button does not call this method. It transmits a form
  // feed (`\f`, Control-L) to the shell, which is the byte a user's Control-L
  // produces. Asserted here as an **xterm API fact** rather than as a description
  // of the panel, because a reader who assumed otherwise would go looking for a
  // call site that does not exist.
  terminal.clear();

  const survivors = [];
  for (let index = 0; index < terminal.buffer.active.length; index += 1) {
    const text = terminal.buffer.active.getLine(index)?.translateToString(true) ?? "";

    if (text !== "") survivors.push(text);
  }

  const leftovers = survivors.filter((text) => /scrolled-\d/.test(text));

  check(
    "the buffer holds no row from before the clear",
    leftovers.length === 0,
    leftovers.length === 0
      ? "0 rows survive"
      : `${leftovers.length} rows survive, first ${JSON.stringify(leftovers[0])}`,
  );

  check(
    "xterm API fact: Terminal.clear() does clear the scrollback",
    terminal.buffer.active.baseY === 0,
    `baseY after clear is ${terminal.buffer.active.baseY}`,
  );

  // Scrolling up is what a user does to check this, and it is also the assertion
  // that cannot be satisfied by a viewport-only repaint.
  terminal.scrollToTop();
  const afterScroll = [];
  for (let index = 0; index < terminal.buffer.active.length; index += 1) {
    const text = terminal.buffer.active.getLine(index)?.translateToString(true) ?? "";

    if (/scrolled-\d/.test(text)) afterScroll.push(text);
  }

  check(
    "xterm API fact: scrolling to the top after Terminal.clear() finds nothing",
    afterScroll.length === 0,
    afterScroll.length === 0
      ? `${savedLines} saved lines were dropped`
      : `found ${afterScroll.length}`,
  );

  terminal.dispose();
  container.remove();
}

{
  // The product path, which is the one that matters. The panel sends `\f` and the
  // shell answers; this script has no PTY, so it cannot observe the shell. What it
  // *can* observe is this side of the wire, and that half is decisive: a form feed
  // arriving in a terminal is not a clear at all. xterm renders it as an ordinary
  // line break -- the saved lines stay readable, the viewport stays, only the
  // cursor moves down. So the scrollback decision is delegated to the shell, and
  // whether it is honoured depends on the shell's terminfo rather than on us.
  const container = document.createElement("div");
  document.body.append(container);

  const terminal = new Terminal({ cols: 40, rows: 10, scrollback: 500, fontSize: 13 });
  terminal.open(container);

  for (let index = 0; index < 40; index += 1) {
    await settle(terminal, `scrolled-${index}\r\n`);
  }

  const savedBefore = terminal.buffer.active.baseY;

  /** Every row the user could scroll to right now, counted the same way before and after. */
  const readableRows = () => {
    const found = [];
    for (let index = 0; index < terminal.buffer.active.length; index += 1) {
      const text = terminal.buffer.active.getLine(index)?.translateToString(true) ?? "";

      if (/scrolled-\d/.test(text)) found.push(text);
    }
    return found.length;
  };

  const readableBefore = readableRows();

  await settle(terminal, "\f");

  const readableAfter = readableRows();

  check(
    "a form feed is not a clear to the terminal; it is a line break",
    readableAfter === readableBefore && terminal.buffer.active.baseY > 0,
    `form feed: ${readableBefore} readable rows before, ${readableAfter} after; baseY ${savedBefore}->${terminal.buffer.active.baseY}`,
  );

  check(
    "the product's clear delegates the scrollback decision to the shell",
    terminal.buffer.active.baseY > 0,
    "nothing on this side of the wire erases a row",
  );

  terminal.dispose();
  container.remove();
}

{
  // The half that makes the clear worth measuring. `ESC[2J` is what a program reaches
  // for and it repaints the viewport while leaving every saved line in place, so a
  // user clears the screen and can still scroll back through the whole session.
  // Only `ESC[3J` erases the saved lines. Asserting the difference is what turns
  // "clear works" into "clear works the way a user means".
  const scenario = async (payload) => {
    const container = document.createElement("div");
    document.body.append(container);

    const terminal = new Terminal({ cols: 40, rows: 10, scrollback: 500, fontSize: 13 });
    terminal.open(container);

    for (let index = 0; index < 40; index += 1) {
      await settle(terminal, `scrolled-${index}\r\n`);
    }

    const savedBefore = terminal.buffer.active.baseY;
    await settle(terminal, payload);

    const remaining = [];
    for (let index = 0; index < terminal.buffer.active.length; index += 1) {
      const text = terminal.buffer.active.getLine(index)?.translateToString(true) ?? "";

      if (/scrolled-\d/.test(text)) remaining.push(text);
    }

    const savedAfter = terminal.buffer.active.baseY;
    terminal.dispose();
    container.remove();

    return { savedBefore, savedAfter, remaining: remaining.length };
  };

  const displayOnly = await scenario("\u001b[H\u001b[2J");
  const withSavedLines = await scenario("\u001b[H\u001b[2J\u001b[3J");

  check(
    "erase-display alone leaves the saved lines behind",
    displayOnly.savedAfter > 0 && displayOnly.remaining === displayOnly.savedBefore,
    `ESC[2J: ${displayOnly.savedBefore} saved lines became ${displayOnly.savedAfter}, ${displayOnly.remaining} rows still readable`,
  );

  check(
    "erase-saved-lines is what actually clears the scrollback",
    withSavedLines.savedAfter === 0 && withSavedLines.remaining === 0,
    `ESC[2J ESC[3J: ${withSavedLines.savedBefore} saved lines became 0`,
  );
}

{
  // The API path, which is what a host calls and what `clear` in the panel's own
  // sense must agree with. Asserted separately from the byte path because the two
  // could drift: an escape sequence that clears and a method that does not is
  // exactly the sort of half-fix this file exists to catch.
  const container = document.createElement("div");
  document.body.append(container);

  const terminal = new Terminal({ cols: 40, rows: 10, scrollback: 500, fontSize: 13 });
  terminal.open(container);

  for (let index = 0; index < 40; index += 1) {
    await settle(terminal, `scrolled-${index}\r\n`);
  }

  // An unfinished prompt line, which is the row `clear()` documents it keeps:
  // "making the prompt line the new first line". Measured rather than assumed,
  // because a reader of the assertion below needs to know what is allowed to
  // survive and what is a leak.
  await settle(terminal, "$ partia");

  terminal.clear();

  const survivors = [];
  for (let index = 0; index < terminal.buffer.active.length; index += 1) {
    const text = terminal.buffer.active.getLine(index)?.translateToString(true) ?? "";

    if (text !== "") survivors.push(text);
  }

  const committed = survivors.filter((text) => /scrolled-\d/.test(text));
  const keptPromptLine = survivors.filter((text) => text.includes("$ partia"));

  // Recorded, not graded, because the product does not call this method. The
  // wording follows the measurement and not the expectation: clear() *does* reach
  // the scrollback (baseY 0, no row from before survives), and it *keeps* the
  // uncommitted prompt line. A note that said the opposite would be the same
  // failure as a wrong PASS -- a reader takes it to the document and cannot tell
  // that nobody checked.
  note(
    "xterm: clear() clears the scrollback too",
    `${committed.length} rows from before a clear survive, baseY ${terminal.buffer.active.baseY}`,
  );
  note(
    "xterm: clear() keeps the uncommitted prompt line",
    `${keptPromptLine.length} prompt rows survive a clear`,
  );

  terminal.dispose();
  container.remove();
}

// ---------------------------------------------------------------------------
// N terminals coexist, each with its own buffer
// ---------------------------------------------------------------------------

process.stdout.write("\n--- concurrent terminals\n");

{
  const terminals = [];

  for (let index = 0; index < CONCURRENT_TERMINALS; index += 1) {
    const container = document.createElement("div");
    document.body.append(container);

    const terminal = new Terminal({ cols: 40, rows: 8, fontSize: 13 });
    terminal.open(container);

    terminals.push({ index, terminal, container });
  }

  const mounted = terminals.reduce((sum, entry) => sum + terminalRoots(entry.container).length, 0);
  check(
    `${CONCURRENT_TERMINALS} terminals mount one root each`,
    mounted === CONCURRENT_TERMINALS,
    `${mounted} roots`,
  );

  await Promise.all(
    terminals.map((entry) => settle(entry.terminal, `terminal-${entry.index}\r\n`)),
  );

  const echoed = terminals.filter((entry) => {
    const line = entry.terminal.buffer.active.getLine(0)?.translateToString(true) ?? "";

    return line.includes(`terminal-${entry.index}`);
  });
  check(
    "every terminal echoes its own line",
    echoed.length === CONCURRENT_TERMINALS,
    `${echoed.length} of ${CONCURRENT_TERMINALS}`,
  );

  // The claim that matters when several terminals share a page: one reading the
  // other's bytes would still echo its own line, so "echoed" alone cannot see it.
  //
  // Matched with a digit boundary rather than a substring, because the indices are
  // a prefix chain: `terminal-1` is a substring of `terminal-10`, so the substring
  // form reported six cross-reads between terminals that had never touched each
  // other. The same trap as a class name that is a prefix of a longer one.
  const crossed = terminals.filter((entry) => {
    const text = rows(entry.terminal).join("|");

    for (let other = 0; other < CONCURRENT_TERMINALS; other += 1) {
      if (other === entry.index) continue;
      if (new RegExp(`terminal-${other}(?!\\d)`).test(text)) return true;
    }

    return false;
  });
  check(
    "no terminal's buffer contains another's line",
    crossed.length === 0,
    crossed.length === 0 ? "0 cross-reads" : `crossed: ${crossed.map((e) => e.index).join(",")}`,
  );

  // A second terminal opened into the *same* container is the arrangement most
  // likely to interleave, because both render into one box.
  {
    const shared = document.createElement("div");
    document.body.append(shared);

    const first = new Terminal({ cols: 40, rows: 8 });
    const second = new Terminal({ cols: 40, rows: 8 });
    first.open(shared);
    second.open(shared);

    await settle(first, "alpha\r\n");
    await settle(second, "beta\r\n");

    const firstLine = first.buffer.active.getLine(0)?.translateToString(true) ?? "";
    const secondLine = second.buffer.active.getLine(0)?.translateToString(true) ?? "";
    const roots = terminalRoots(shared).length;

    check(
      "two terminals in one container keep separate buffers",
      firstLine.includes("alpha") && secondLine.includes("beta") && roots === 2,
      `roots=${roots} a=${JSON.stringify(firstLine)} b=${JSON.stringify(secondLine)}`,
    );

    first.dispose();
    second.dispose();
    shared.remove();
  }

  for (const entry of terminals) {
    entry.terminal.dispose();
    entry.container.remove();
  }
}

// ---------------------------------------------------------------------------
// The concurrency ceiling: how far the claim is measured, not assumed
// ---------------------------------------------------------------------------

process.stdout.write("\n--- measured ceiling\n");

/** The count the document's own concurrency probe assumes. */
const DOCUMENT_ASSUMED_CONCURRENCY = 10;

{
  let ceiling = 0;
  let perTerminalKb = 0;

  for (const count of CEILING) {
    globalThis.gc?.();
    const baseline = process.memoryUsage().heapUsed;
    const created = [];
    const startedAt = Date.now();
    let failure = null;

    try {
      for (let index = 0; index < count; index += 1) {
        const container = document.createElement("div");
        document.body.append(container);

        const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 1000, fontSize: 13 });
        terminal.open(container);
        created.push({ terminal, container });
      }

      await Promise.all(created.map((entry, index) => settle(entry.terminal, `t${index}\r\n`)));
    } catch (error) {
      failure = error.message;
    }

    const elapsed = Date.now() - startedAt;
    const peak = process.memoryUsage().heapUsed;

    if (failure !== null) {
      check(
        `ceiling: ${count} terminals did not all come up`,
        false,
        `stopped at ${created.length} of ${count}: ${failure}`,
      );
      break;
    }

    ceiling = count;
    perTerminalKb = Math.round((peak - baseline) / 1024 / count);

    process.stdout.write(
      `INFO  ${count} terminals  ${elapsed}ms  ${perTerminalKb}KB each (jsdom renderer)\n`,
    );

    for (const entry of created) {
      entry.terminal.dispose();
      entry.container.remove();
    }

    await new Promise((resume) => setTimeout(resume, 50));
  }

  check(
    "the concurrency ceiling is at least the asserted count",
    ceiling >= CONCURRENT_TERMINALS,
    `measured ${ceiling} as the highest fully-live count`,
  );

  // Reported rather than asserted: a low ceiling is a fact about the machine, not
  // a defect in the panel, and turning it into a red result would hide which.
  process.stdout.write(
    `NOTE  ceiling probe walks ${CEILING.join("/")}; highest fully live here was ` +
      `${ceiling}, about ${perTerminalKb}KB of renderer heap per terminal, ` +
      `so the first limit a user meets is memory rather than the DOM\n`,
  );

  // Three numbers on one line on purpose. A reader will compare one of them
  // against the document, and a run that printed only the one it asserted would
  // leave the other two indistinguishable from "never measured": the assertion is
  // 16, the document's own probe assumed 10, and this machine held 1024.
  process.stdout.write(
    `NOTE   asserts ${CONCURRENT_TERMINALS}; measured ceiling ${ceiling}; ` +
      `the document's P-8 assumed ${DOCUMENT_ASSUMED_CONCURRENCY}\n`,
  );
}

// ---------------------------------------------------------------------------
// Claims only a human at a real window can settle
// ---------------------------------------------------------------------------

process.stdout.write("\n--- manual, no headless observation exists\n");

manualOnly(
  "scroll is smooth (no document judgement; ergonomics)",
  "jsdom has no compositor, so nothing can stutter",
);
manualOnly(
  "selection and copy (the renderer depends on it; not a judgement of its own)",
  "jsdom has no clipboard and no text selection",
);
manualOnly(
  "a font-size change does not reflow existing output (follows from how clearing is defined)",
  "jsdom shapes no glyphs, so no reflow happens",
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = graded.filter((entry) => entry.ok).length;

process.stdout.write(
  `\n${failures === 0 ? "PASS" : "FAIL"}  ${passed} of ${graded.length} automated claims\n`,
);
process.stdout.write(
  `MANUAL  ${manual.length} claims need a real window: ${manual.map((entry) => entry.label).join(", ")}\n`,
);
process.stdout.write(
  "jsdom: no layout, no compositor — smoothness and font reflow remain manual\n",
);

// The limitation is repeated last on purpose: a reader who scans only the tail of
// a green run must not conclude the whole item is verified.
process.stdout.write(
  "the resize layout is stubbed (10x20 cells), so it verifies the recompute, not a browser's placement\n",
);

process.exitCode = failures === 0 ? 0 : 1;
void dom;
