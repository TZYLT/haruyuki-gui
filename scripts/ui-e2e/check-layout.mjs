/**
 * check-layout.mjs - layout checks in a real browser.
 *
 * Usage:
 *   node scripts/ui-e2e/check-layout.mjs
 *   node scripts/ui-e2e/check-layout.mjs --headful     # watch it run
 *
 * This gate is **not** part of `pnpm verify` (A4-Q32). It needs a browser, and a
 * gate that cannot run on every machine is a gate that gets excluded from the run
 * that matters. It is available, opt-in, and uses the Edge that ships with Windows
 * rather than downloading a bundled Chromium.
 *
 * What it checks, and why it cannot be checked in jsdom:
 *
 *   L1 height-parity  the same component in `en` and `zh-CN` renders to the same
 *                     height. jsdom performs no layout, so every height there is
 *                     zero and any assertion passes regardless of the CSS.
 *   L2 no-overflow    nothing overflows its container horizontally in either
 *                     locale. This is the failure a shared component causes when a
 *                     translated string is longer than the English it replaced.
 *
 * Width parity is deliberately **not** checked: R-11 established that the width
 * difference cannot be eliminated (measured 53 px), so requiring it would make the
 * gate permanently red. Height can be equal because line heights are unitless
 * multipliers against each element's own font size.
 *
 * Exit codes: 0 clean, 1 violation, 2 broken (no browser, bad argument).
 */

import { existsSync } from "node:fs";

import { parseArgs, finish, fail } from "../lib/gate-cli.mjs";

/** Where the built sample page will be served from. */
const PAGE_URL = process.env.UI_E2E_URL ?? "http://127.0.0.1:5173/";

/** Edge's install locations on Windows, in the order they are tried. */
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

/** Tolerance in pixels. Sub-pixel rounding differs between font renderers. */
const TOLERANCE = 1;

/**
 * Find a usable Edge binary.
 *
 * @returns the path, or null when none exists
 */
function findEdge() {
  return EDGE_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Measure the rendered size of a set of elements.
 *
 * @param page playwright page
 * @param selector selector to measure
 * @returns heights keyed by an index
 */
async function measure(page, selector) {
  return page.$$eval(selector, (nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();

      return { height: rect.height, width: rect.width, scrollWidth: node.scrollWidth };
    }),
  );
}

/**
 * Collect violations for one locale pair.
 *
 * @param browser launched browser
 * @param selector element selector to compare
 * @returns violations
 */
async function compareAcross(page, selector) {
  const violations = [];
  const results = {};

  for (const locale of ["en", "zh-CN"]) {
    await page.goto(`${PAGE_URL}?locale=${encodeURIComponent(locale)}`, {
      waitUntil: "networkidle",
    });

    results[locale] = await measure(page, selector);

    // L2: horizontal overflow inside the measured elements.
    for (const [index, box] of results[locale].entries()) {
      if (box.scrollWidth > box.width + TOLERANCE) {
        violations.push({
          file: "scripts/ui-e2e/check-layout.mjs",
          rule: "L2",
          message: `${selector}[${index}] overflows in ${locale}: scrollWidth ${box.scrollWidth} > width ${Math.round(box.width)}`,
        });
      }
    }
  }

  const english = results.en ?? [];
  const chinese = results["zh-CN"] ?? [];

  if (english.length !== chinese.length) {
    violations.push({
      file: "scripts/ui-e2e/check-layout.mjs",
      rule: "L1",
      message: `${selector} count differs between locales: en ${english.length}, zh-CN ${chinese.length}`,
    });

    return violations;
  }

  // L1: equal heights.
  for (const [index, box] of english.entries()) {
    const other = chinese[index];

    if (other === undefined) continue;

    if (Math.abs(box.height - other.height) > TOLERANCE) {
      violations.push({
        file: "scripts/ui-e2e/check-layout.mjs",
        rule: "L1",
        message: `${selector}[${index}] height differs: en ${box.height.toFixed(2)}px, zh-CN ${other.height.toFixed(2)}px`,
      });
    }
  }

  return violations;
}

/**
 * Run the check.
 *
 * @param {{ root: string, flags: Record<string, boolean> }} args parsed arguments
 * @returns violations
 */
async function collect(args) {
  // Imported lazily so a missing dependency is a clear exit 2 rather than a crash
  // at module load. `playwright-core` is added on `main` per the route doc 7.2:
  // this branch references it but does not install it, so its absence here is
  // expected rather than a mistake.
  let chromium;

  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error(
      "playwright-core is not installed; this check runs once the dependency lands on main",
    );
  }

  const executablePath = findEdge();

  if (executablePath === null) {
    // Exit 2, not 1: no browser means the check could not judge, which is a
    // different thing from a layout that failed.
    throw new Error(
      "no Edge binary found; install Edge or set UI_E2E_URL to a machine that has one",
    );
  }

  const browser = await chromium.launch({ executablePath, headless: !args.flags.headful });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    const violations = [];

    for (const selector of [".ui-button", ".ui-tag", ".ui-input", ".ui-alert"]) {
      violations.push(...(await compareAcross(page, selector)));
    }

    return violations;
  } finally {
    await browser.close();
  }
}

try {
  const args = parseArgs(process.argv.slice(2), { flags: ["headful"] });

  finish(await collect(args));
} catch (error) {
  fail(error);
}
