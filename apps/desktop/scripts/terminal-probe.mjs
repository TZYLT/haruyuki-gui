/**
 * Does the terminal stack hold together?
 *
 * Run with `pnpm terminal:probe` from the repository root.
 *
 * This is a **regression** probe, not a record of one afternoon's findings. The
 * four xterm packages declare no dependency on each other, so nothing enforces
 * that they stay compatible: `pnpm update` can break the terminal panel while
 * every other test still passes, because the failure mode is a missing export or
 * a stale base class -- visible only when an addon is activated against a real
 * terminal.
 *
 * Four questions, each expensive to discover later:
 *
 *   1. Are the packages present at the pinned versions, and does each entry point
 *      load? A missing export surfaces here rather than at first paint.
 *   2. Does each addon activate, and does the one method it exists for work? An
 *      addon with a stale base class activates just fine.
 *   3. Without the stylesheet injected by hand, is the composition overlay
 *      positioned? This shell has no CSS loader, so the stylesheet travels as a
 *      string; if that string is empty the terminal still constructs, opens,
 *      loads every addon and fits -- and the IME preedit renders in the document
 *      flow. The computed position is the only value that differs.
 *   4. Does a full scrollback serialise inside the reload budget?
 *
 * Node only, with jsdom supplying the DOM. That is deliberate: the panel runs in
 * Electron, but every failure above is a version or wiring problem, and a version
 * problem does not need a browser to reproduce.
 *
 * Why this lives in the shell and not beside the component: it reads the
 * filesystem (`xterm.css`) and a pinned `package.json`, and the renderer package
 * forbids Node builtins so that no I/O can creep into the render path. The
 * dependencies themselves stay in that package, so resolution is anchored there.
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

const PINNED = {
  "@xterm/xterm": "6.0.0",
  "@xterm/addon-fit": "0.11.0",
  "@xterm/addon-serialize": "0.14.0",
  "@xterm/addon-search": "0.16.0",
};

/** Reload restore is only worth having if taking the snapshot is cheap. */
const SERIALIZE_BUDGET_MS = 300;
const SERIALIZE_BUDGET_BYTES = 4 * 1024 * 1024;

/** What the panel configures, and what the viewport takes out of it. */
const SCROLLBACK_LINES = 3000;
const VIEWPORT_ROWS = 24;
const PROBE_COLS = 80;

let failures = 0;

function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${detail}`}`);

  if (!ok) failures += 1;

  return ok;
}

/**
 * A DOM for xterm, with the gaps jsdom leaves filled in.
 *
 * jsdom has no layout engine, so `matchMedia` is absent and xterm queries it for
 * the device pixel ratio. Stubbing it keeps this probe about versions rather than
 * about jsdom's completeness -- the same reason jsdom's canvas warning below is
 * not treated as a failure.
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
 * These packages are CJS with named exports, so the ESM namespace carries them
 * under `default` as well. Accepting both shapes matters here: a probe that knows
 * only one reports a version problem that is really a loader difference.
 *
 * The panel itself must use the named form. `import Terminal from "@xterm/xterm"`
 * yields `undefined` at runtime with no type error, which is one of the bugs this
 * file is meant to catch, not a convenience to normalise away.
 */
function named(namespace, name) {
  return namespace[name] ?? namespace.default?.[name] ?? namespace["module.exports"]?.[name];
}

/** One row of plausible output, padded so the column count actually matters. */
function outputRow(index, cols) {
  const head = `[${String(index).padStart(5, "0")}] acked ${index * 37} bytes `;
  return `${head}${"x".repeat(Math.max(0, cols - head.length - 2))}\r\n`;
}

const dom = installDom();

// ---------------------------------------------------------------------------
// 1. Presence and pinned versions.
// ---------------------------------------------------------------------------

for (const [name, wanted] of Object.entries(PINNED)) {
  try {
    const meta = require(`${name}/package.json`);
    check(`${name} pinned`, meta.version === wanted, `version=${meta.version} (want ${wanted})`);
  } catch (error) {
    check(`${name} pinned`, false, error.code ?? String(error));
  }
}

// ---------------------------------------------------------------------------
// 2. Every entry point loads, and every addon activates.
// ---------------------------------------------------------------------------

// Loaded through `require` rather than `import`: the packages live in the renderer
// package's dependency tree, and a static import here would resolve against this
// package's own tree, where they are deliberately absent.
const Terminal = named(require("@xterm/xterm"), "Terminal");
const FitAddon = named(require("@xterm/addon-fit"), "FitAddon");
const SerializeAddon = named(require("@xterm/addon-serialize"), "SerializeAddon");
const SearchAddon = named(require("@xterm/addon-search"), "SearchAddon");

check("Terminal export present", Terminal !== undefined);

if (Terminal !== undefined) {
  const host = document.createElement("div");
  document.body.append(host);

  const term = new Terminal({
    cols: PROBE_COLS,
    rows: VIEWPORT_ROWS,
    scrollback: 5000,
    fontSize: 13,
  });

  let opened = false;
  try {
    term.open(host);
    opened = check("Terminal.open", true, `element=${term.element?.className ?? "none"}`);
  } catch (error) {
    check("Terminal.open", false, error.message);
  }

  if (opened) {
    // Each addon activates against the same terminal, and each failure is
    // reported on its own: one bad addon must not hide the state of the others.
    const addons = {};
    for (const [label, instance] of [
      ["FitAddon", FitAddon === undefined ? undefined : new FitAddon()],
      ["SerializeAddon", SerializeAddon === undefined ? undefined : new SerializeAddon()],
      ["SearchAddon", SearchAddon === undefined ? undefined : new SearchAddon()],
    ]) {
      if (instance === undefined) {
        check(`${label} activate`, false, "export missing");
        continue;
      }
      try {
        await Promise.resolve(term.loadAddon(instance));
        addons[label] = instance;
        check(`${label} activate`, true);
      } catch (error) {
        check(`${label} activate`, false, error.message);
      }
    }

    // Activation is not enough. An addon of the wrong version activates and then
    // fails on the one method it exists for, so call each of them once.
    term.write("hello\r\nneedle\r\n");
    await new Promise((done) => term.write("", done));

    const line = term.buffer.active.getLine(0)?.translateToString(true) ?? "";
    check("buffer round trip", line.includes("hello"), `line0="${line}"`);

    if (addons.FitAddon !== undefined) {
      try {
        addons.FitAddon.fit();
        check("FitAddon.fit", true, `cols=${term.cols} rows=${term.rows}`);
      } catch (error) {
        check("FitAddon.fit", false, error.message);
      }
    }

    if (addons.SearchAddon !== undefined) {
      try {
        check("SearchAddon.findNext", addons.SearchAddon.findNext("needle") === true);
      } catch (error) {
        check("SearchAddon.findNext", false, error.message);
      }
    }

    // -------------------------------------------------------------------------
    // 3. The stylesheet is required, and it is required by hand.
    //
    // Checked as a before/after pair on purpose. Asserting only the after state
    // would pass on a machine where the sheet came from somewhere else; asserting
    // only the before state would pass while the panel was still broken.
    // -------------------------------------------------------------------------

    const cssPath = join(dirname(require.resolve("@xterm/xterm/package.json")), "css/xterm.css");
    const css = readFileSync(cssPath, "utf8");

    check(
      "xterm.css content",
      css.includes(".xterm-screen") && css.includes(".xterm-viewport") && css.length > 4000,
      `bytes=${css.length}`,
    );

    const overlay = host.querySelector(".composition-view");
    const before = overlay === null ? "missing" : dom.window.getComputedStyle(overlay).position;
    check("stylesheet is load-bearing", before === "static", `overlay position without: ${before}`);

    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);

    const after = overlay === null ? "missing" : dom.window.getComputedStyle(overlay).position;
    check("overlay positioned with sheet", after === "absolute", `${after}`);

    // -------------------------------------------------------------------------
    // 4. A full scrollback serialises inside the reload budget.
    // -------------------------------------------------------------------------

    if (addons.SerializeAddon !== undefined) {
      for (let start = 0; start < SCROLLBACK_LINES; start += 100) {
        const chunk = Array.from({ length: Math.min(100, SCROLLBACK_LINES - start) }, (_, k) =>
          outputRow(start + k, PROBE_COLS),
        ).join("");
        await new Promise((done) => term.write(chunk, done));
      }

      const started = performance.now();
      const snapshot = addons.SerializeAddon.serialize();
      const elapsed = performance.now() - started;

      check(
        `serialize ${SCROLLBACK_LINES} lines`,
        elapsed < SERIALIZE_BUDGET_MS && snapshot.length < SERIALIZE_BUDGET_BYTES,
        `chars=${snapshot.length} ms=${Math.round(elapsed)}`,
      );

      // The viewport is not scrollback, so the configured figure is an upper
      // bound on what a user can scroll back through.
      const reachable = term.buffer.active.baseY;
      check(
        "scrollback reachable",
        reachable > 0 && reachable <= SCROLLBACK_LINES,
        `baseY=${reachable} of ${SCROLLBACK_LINES} configured (viewport takes ${VIEWPORT_ROWS})`,
      );
    }

    try {
      term.dispose();
      check("Terminal.dispose", true);
    } catch (error) {
      check("Terminal.dispose", false, error.message);
    }
  }

  host.remove();
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
