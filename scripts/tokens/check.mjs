/**
 * check-tokens.mjs - gate: the token layer is complete, themed and legible.
 *
 * Usage:
 *   node scripts/tokens/check.mjs                   # scan packages/ui
 *   node scripts/tokens/check.mjs --root <dir>      # scan another tree (self-tests)
 *   node scripts/tokens/check.mjs --verbose         # diagnostics on stderr only
 *
 * Four checks, each with its own rule id so a violation names which contract
 * broke:
 *
 *   T1 slot-coverage   every slot declared in `tokens/slots.ts` has a value in
 *                      every one of the four theme combinations
 *   T2 no-raw-color    a component may not name a colour; colours live in the
 *                      palette, referenced through `var(--ui-...)`
 *   T3 four-themes     the four `mode x contrast` combinations exist and are
 *                      enumerable, not merely documented
 *   T4 contrast        every pair a component actually renders clears WCAG AA:
 *                      text 4.5:1, borders and icon strokes 3:1
 *   T5 known-slot      every `var(--ui-...)` a component references actually
 *                      exists; a typo'd slot renders as an empty value, which is
 *                      invisible in review and silently drops the declaration
 *   T6 known-class     every `ui-` class a component names has a rule in the
 *                      stylesheet. A class in the markup with no rule is an
 *                      element that renders unstyled -- which is how a
 *                      visually-hidden live region became a visible word
 *
 * T1 and T4 read the TypeScript sources rather than importing them. Importing
 * would work today, but it would tie the gate to a build step and make a red gate
 * depend on the package compiling; a gate that cannot run when the code is broken
 * is not a gate. The trade is that the parser below only understands the literal
 * shapes this layer uses -- which is fine, because those shapes are the layer's
 * own convention and T1 fails loudly rather than silently reading nothing.
 *
 * Scope
 *   Tokens:     packages/ui/src/tokens/**
 *   Components: packages/ui/src/components/** and packages/ui/src/icons/**
 *
 * Exit codes follow scripts/lib/gate-cli.mjs: 0 clean, 1 violations, 2 broken.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { fail, runGate, toPosix } from "../lib/gate-cli.mjs";

/** Where the token layer lives, repo-relative. */
const TOKENS_DIR = "packages/ui/src/tokens";

/** Where the code that must not name colours lives. */
const CONSUMER_DIRS = ["packages/ui/src/components", "packages/ui/src/icons"];

/** The four theme combinations, in the order the requirement lists them. */
const THEME_COMBINATIONS = [
  ["light", "normal"],
  ["light", "high"],
  ["dark", "normal"],
  ["dark", "high"],
];

/** Minimum ratios, matching tokens/contrast.ts. Duplicated on purpose: a gate
 * that imports the value it checks would agree with a changed value. */
const MIN_TEXT_RATIO = 4.5;
const MIN_NON_TEXT_RATIO = 3;

/**
 * What counts as a colour the gate can measure.
 *
 * Checked before the luminance maths rather than inside it: `Number.parseInt`
 * returns `NaN` for an unparseable channel, and every comparison against `NaN`
 * is false, so an unparseable colour used to pass every contrast rule silently.
 */
const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * The repository's test-file convention, anchored at the end of the path.
 *
 * `relative.includes(".test.")` -- the previous test -- also skipped a file named
 * `states.test.helper.ts`, which is production code with an unlucky name. A
 * skipped file is invisible to T2 and T5, so the test has to be about the
 * suffix, not about a substring somewhere in the path.
 */
const TEST_FILE_PATTERN = /\.test\.tsx?$/;

/**
 * Read a file as UTF-8.
 *
 * @param {string} absolute absolute path
 * @returns {string}
 */
function read(absolute) {
  return readFileSync(absolute, "utf8");
}

/**
 * List files below a directory, recursively, by extension.
 *
 * @param {string} root absolute posix repo root
 * @param {string} relative repo-relative directory
 * @param {string[]} extensions extensions to accept
 * @returns {string[]} repo-relative posix paths
 */
function listFiles(root, relative, extensions) {
  const absolute = path.join(root, relative);

  if (!existsSync(absolute)) return [];

  const found = [];

  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;

    if (entry.isDirectory()) {
      found.push(...listFiles(root, child, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(child);
    }
  }

  return found;
}

/**
 * Extract the slot names declared in `slots.ts`.
 *
 * The file declares slots as `as const` arrays of quoted strings. Reading them
 * rather than importing keeps the gate usable when the package does not compile.
 *
 * @param {string} source slots.ts source
 * @returns {string[]} slot names, in declaration order, deduplicated
 */
function declaredSlots(source) {
  const names = [];
  const seen = new Set();

  for (const match of source.matchAll(/"(--ui-[A-Za-z0-9-]+)"/g)) {
    const name = match[1];

    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}

/**
 * Extract the theme keys and their slot assignments from `palettes.ts` plus the
 * shared scales.
 *
 * A theme's value set is the union of the palette object and the scale object,
 * because the runtime spreads one into the other. The gate has to do the same
 * union or it would report every non-colour slot as missing in every theme.
 *
 * @param {string} palettesSource palettes.ts source
 * @param {string} scalesSource scales.ts source
 * @returns {Map<string, Set<string>>} theme key to the slots it defines
 */
function themeSlots(palettesSource, scalesSource) {
  const shared = new Set();

  for (const match of scalesSource.matchAll(/"(--ui-[A-Za-z0-9-]+)"\s*:/g)) {
    if (match[1] !== undefined) shared.add(match[1]);
  }

  /**
   * Exported palette names to the theme key they belong to.
   *
   * The four names are the contract, but the scan below also looks for *other*
   * exported palettes so a fifth one is reported instead of ignored.
   */
  const nameToTheme = new Map([
    ["LIGHT_NORMAL", "light/normal"],
    ["LIGHT_HIGH", "light/high"],
    ["DARK_NORMAL", "dark/normal"],
    ["DARK_HIGH", "dark/high"],
  ]);

  const themes = new Map();

  /**
   * @param {string} exportName exported palette constant
   * @param {string} themeKey theme key it maps to
   */
  const readPalette = (exportName, themeKey) => {
    const patterns = [
      new RegExp(`export const ${exportName}\\s*(?::\\s*Palette)?\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`),
      new RegExp(`export const ${exportName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`),
    ];
    const body = patterns.map((pattern) => palettesSource.match(pattern)?.[1]).find(Boolean);

    // A missing palette is a T3 violation, not a broken gate: the script itself
    // is fine, the tree is wrong. Reporting it here lets the caller collect it
    // with the other T3 findings instead of aborting with exit 2.
    if (body === undefined) return;

    const found = new Set(shared);

    for (const match of body.matchAll(/"(--ui-[A-Za-z0-9-]+)"\s*:/g)) {
      if (match[1] !== undefined) found.add(match[1]);
    }

    themes.set(themeKey, found);
  };

  for (const [exportName, themeKey] of nameToTheme) readPalette(exportName, themeKey);

  // Everything else that is exported as a Palette.
  //
  // Without this pass the "theme is not one of the four combinations" branch
  // below was unreachable: `themes` could only ever hold the four keys the map
  // above produces, so a fifth palette (`SEPIA_NORMAL`) was silently ignored
  // while the check that exists to catch it looked like it was doing its job.
  for (const match of palettesSource.matchAll(/export const ([A-Z][A-Z0-9_]*)\s*:\s*Palette\s*=/g)) {
    const exportName = match[1];

    if (exportName === undefined || nameToTheme.has(exportName)) continue;

    readPalette(exportName, exportName.toLowerCase().replaceAll("_", "/"));
  }

  return themes;
}

/**
 * Read the colour values of one palette.
 *
 * @param {string} palettesSource palettes.ts source
 * @param {string} exportName palette constant name
 * @returns {Map<string, string>} slot to hex value, empty when the palette is absent
 */
function paletteValues(palettesSource, exportName) {
  const patterns = [
    new RegExp(`export const ${exportName}\\s*(?::\\s*Palette)?\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`),
    new RegExp(`export const ${exportName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`),
  ];
  const body = patterns.map((pattern) => palettesSource.match(pattern)?.[1]).find(Boolean);
  const values = new Map();

  // A missing palette yields no values rather than throwing: T3 already reports
  // the absence, and duplicating it as a script error would hide the real idi.
  if (body === undefined) return values;

  for (const match of body.matchAll(/"(--ui-[A-Za-z0-9-]+)"\s*:\s*"([^"]+)"/g)) {
    const [, slot, value] = match;

    if (slot !== undefined && value !== undefined) values.set(slot, value);
  }

  return values;
}

/**
 * @param {string} value hex colour
 * @returns {number} relative luminance
 */
function luminance(value) {
  const body = value.slice(1);
  const full =
    body.length === 3
      ? body
          .split("")
          .map((char) => char + char)
          .join("")
      : body.slice(0, 6);

  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;

    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * @param {string} first hex colour
 * @param {string} second hex colour
 * @returns {number} contrast ratio
 */
function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);

  return (lighter + 0.05) / (darker + 0.05);
}

/** The status families that pair a foreground with a subtle background. */
const STATUS_FAMILIES = ["danger", "warning", "success", "info"];

/**
 * Whether the stylesheet defines a rule for a class.
 *
 * Uses a regex with a trailing boundary rather than `includes`, because a class
 * name is a prefix of longer ones and a substring test reports a renamed class as
 * present -- which is a false pass, the failure mode this whole gate exists to
 * prevent.
 *
 * @param stylesheet the assembled CSS text
 * @param className the class to look for, without the leading dot
 * @returns whether a rule exists
 */
function hasClassRule(stylesheet, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(`\\.${escaped}(?![\\w-])`).test(stylesheet);
}

/**
 * Collect every violation.
 *
 * @param {{ root: string }} args parsed arguments
 * @returns {object[]} violations
 */
function collectViolations(args) {
  const violations = [];
  const slotsFile = `${TOKENS_DIR}/slots.ts`;
  const palettesFile = `${TOKENS_DIR}/palettes.ts`;
  const scalesFile = `${TOKENS_DIR}/scales.ts`;

  for (const relative of [slotsFile, palettesFile, scalesFile]) {
    if (!existsSync(path.join(args.root, relative))) {
      throw new Error(`cannot find ${relative}; is --root a haruyuki-gui checkout?`);
    }
  }

  const slotsSource = read(path.join(args.root, slotsFile));
  const palettesSource = read(path.join(args.root, palettesFile));
  const scalesSource = read(path.join(args.root, scalesFile));

  const slots = declaredSlots(slotsSource);

  if (slots.length === 0) {
    throw new Error(`no slots found in ${slotsFile}; the parser and the file disagree`);
  }

  // ---- T3: the four combinations exist.
  const themes = themeSlots(palettesSource, scalesSource);

  for (const [mode, contrastName] of THEME_COMBINATIONS) {
    const key = `${mode}/${contrastName}`;

    if (!themes.has(key)) {
      violations.push({
        file: palettesFile,
        rule: "T3",
        message: `theme combination ${key} does not exist; all four of mode x contrast must be enumerable`,
      });
    }
  }

  for (const key of themes.keys()) {
    const known = THEME_COMBINATIONS.some(
      ([mode, contrastName]) => `${mode}/${contrastName}` === key,
    );

    if (!known) {
      violations.push({
        file: palettesFile,
        rule: "T3",
        message: `theme ${key} is not one of the four combinations`,
      });
    }
  }

  // ---- T1: every slot has a value in every theme.
  for (const [key, defined] of themes) {
    for (const slot of slots) {
      if (!defined.has(slot)) {
        violations.push({
          file: palettesFile,
          rule: "T1",
          message: `theme ${key} does not give a value for ${slot}`,
        });
      }
    }
  }

  // ---- T4: contrast on the pairs a component actually renders.
  const palettes = {
    "light/normal": paletteValues(palettesSource, "LIGHT_NORMAL"),
    "light/high": paletteValues(palettesSource, "LIGHT_HIGH"),
    "dark/normal": paletteValues(palettesSource, "DARK_NORMAL"),
    "dark/high": paletteValues(palettesSource, "DARK_HIGH"),
  };
  const surfaces = ["--ui-color-surface-1", "--ui-color-surface-2", "--ui-color-surface-3"];

  /**
   * @param {string} key theme key
   * @param {string} foreground slot
   * @param {string} background slot
   * @param {number} minimum required ratio
   * @param {string} rule rule id
   */
  function requireContrast(key, foreground, background, minimum, rule) {
    pairsUsed.add(foreground);
    pairsUsed.add(background);

    const values = palettes[key];
    const fg = values?.get(foreground);
    const bg = values?.get(background);

    // A pair whose *slots* are absent is T1's finding, not T4's: T1 already says
    // "this theme does not define this slot", and reporting it here too would
    // make one missing value produce four violations in every theme.
    //
    // But a colour that is present and cannot be *parsed* is a different thing
    // and is now a violation. The first version returned in both cases, and
    // `NaN < 4.5` is false, so `neutral-1: "#zzzzzz"` produced a silent pass on
    // every contrast pair it appeared in.
    if (fg === undefined || bg === undefined) return;

    if (!HEX_PATTERN.test(fg) || !HEX_PATTERN.test(bg)) {
      violations.push({
        file: palettesFile,
        rule,
        message: `${key}: cannot measure ${foreground} (${fg}) on ${background} (${bg}) -- not a hex colour`,
      });

      return;
    }

    const ratio = contrast(fg, bg);

    if (ratio < minimum) {
      violations.push({
        file: palettesFile,
        rule,
        message: `${key}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, below ${minimum}:1`,
      });
    }
  }

  /**
   * Every slot the contrast pairs below name, so a typo in the gate's own table
   * is caught rather than silently skipped.
   *
   * This is the failure mode the pair list invites: a pair written against
   * `--ui-color-acent-1` would never match a palette key, would hit the
   * "absent slot" return above, and would therefore check nothing while looking
   * like a check. Asserting the names against the declared slot inventory turns
   * that into a gate bug that announces itself.
   */
  const pairsUsed = new Set();

  for (const key of Object.keys(palettes)) {
    for (const surface of surfaces) {
      requireContrast(key, "--ui-color-neutral-1", surface, MIN_TEXT_RATIO, "T4");
      requireContrast(key, "--ui-color-neutral-2", surface, MIN_TEXT_RATIO, "T4");
      requireContrast(key, "--ui-color-neutral-3", surface, MIN_NON_TEXT_RATIO, "T4");
    }

    requireContrast(key, "--ui-color-accent-1", "--ui-color-surface-1", MIN_TEXT_RATIO, "T4");

    // The pairs a *filled* control renders. These were missing, and they are the
    // ones that were actually broken: static-1 is the label on the primary,
    // primary-hover and danger buttons, and in the dark themes it was white on a
    // light accent (2.33:1) and a light danger (1.70:1). Nothing here could see
    // it, because the only static-pair check lived in the unit test and took
    // `Math.max(static-1, static-2)`.
    for (const fill of ["--ui-color-accent-1", "--ui-color-accent-2", "--ui-color-danger-1"]) {
      requireContrast(key, "--ui-color-static-1", fill, MIN_TEXT_RATIO, "T4");
    }

    // The switch thumb against both of its tracks.
    requireContrast(key, "--ui-color-static-1", "--ui-color-neutral-3", MIN_NON_TEXT_RATIO, "T4");

    // The danger button's hover inverts: danger-1 text on the danger-2 fill.
    requireContrast(key, "--ui-color-danger-1", "--ui-color-danger-2", MIN_TEXT_RATIO, "T4");

    // The accent chip and the selected option in a popup.
    requireContrast(key, "--ui-color-accent-1", "--ui-color-accent-3", MIN_TEXT_RATIO, "T4");
    requireContrast(key, "--ui-color-accent-1", "--ui-color-surface-2", MIN_TEXT_RATIO, "T4");

    for (const family of STATUS_FAMILIES) {
      requireContrast(
        key,
        `--ui-color-${family}-1`,
        `--ui-color-${family}-2`,
        MIN_TEXT_RATIO,
        "T4",
      );
      requireContrast(key, `--ui-color-${family}-1`, "--ui-color-surface-1", MIN_TEXT_RATIO, "T4");
    }
  }

  // A pair naming a slot that does not exist checks nothing. T1 would not catch
  // it either: T1 compares declared slots against palettes, and this is the
  // gate's own table being wrong. Checked against the union of all four palettes
  // rather than one, so a slot that is missing from a single theme stays T1's
  // finding instead of being reported twice.
  const knownPaletteSlots = new Set();

  for (const values of Object.values(palettes)) {
    for (const slot of values.keys()) knownPaletteSlots.add(slot);
  }

  for (const slot of pairsUsed) {
    if (!knownPaletteSlots.has(slot)) {
      violations.push({
        file: palettesFile,
        rule: "T4",
        message: `the contrast table names ${slot}, which no palette defines -- that pair checks nothing`,
      });
    }
  }

  // ---- T2: no component names a colour.
  //
  // A whole-file scan of executable text, not a "keyword followed by a quoted
  // string" pattern. The narrow version could only see JSX style objects like
  // `style={{ color: "#f00" }}`; every one of this package's component colours
  // lives inside a **CSS template literal**, so the rule was blind to the file
  // that it existed to police. It also missed a named colour, a literal buried
  // mid-line after a `//` in a URL, and a `var(--ui-x, #fallback)` fallback.
  //
  // Comments are still allowed to name a colour while explaining why we do not
  // write one, so they are stripped first -- line comments, block comments and
  // JSDoc continuation lines.
  // Every colour that can actually reach a stylesheet: hex in any of its three
  // lengths, and the three functional forms. Named colours are deliberately
  // **not** matched -- `nowrap`, `darken`, `unset` and a dozen other identifiers
  // contain a colour word, and a rule that fires on `white-space: nowrap` is a
  // rule people learn to ignore. The requirement names hex and the functional
  // forms, which is also what a palette is written in.
  const colourLiteral = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;
  const VAR_FALLBACK = /var\(\s*--ui-[A-Za-z0-9-]+\s*,\s*([^)]*)\)/g;

  /**
   * Strip comments while leaving string and template literals intact.
   *
   * A line-wise `replace(/\/\/.*$/)` would also eat the rest of a CSS line that
   * contains `//` inside a string, and a regex over the whole file would eat a
   * `/*` that appears inside a template literal. This walks the text and tracks
   * which construct it is in, which is the only way to keep the two apart.
   *
   * CSS comments inside a template literal are stripped too. That case is not
   * hypothetical: every component's rules live in a template literal, and a CSS
   * comment that explains "the old value was #ff0000" is a comment, not a colour.
   *
   * @param {string} source file text
   * @returns {string[]} lines with comments blanked out
   */
  function codeLines(source) {
    let out = "";
    let state = "code"; // code | line | block | single | double | template | cssBlock
    let escaped = false;

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      const next = source[i + 1];

      if (state === "line") {
        if (char === "\n") {
          state = "code";
          out += char;
        }
        continue;
      }

      if (state === "block" || state === "cssBlock") {
        if (char === "*" && next === "/") {
          state = state === "cssBlock" ? "template" : "code";
          i += 1;
        } else if (char === "\n") {
          out += char;
        }
        continue;
      }

      if (state === "single" || state === "double") {
        out += char;
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (
          (state === "single" && char === "'") ||
          (state === "double" && char === '"')
        ) {
          state = "code";
        }
        continue;
      }

      if (state === "template") {
        // `\${` opens real code inside the literal; everything else is text that
        // the stylesheet will see. CSS comments are dropped, interpolation is
        // kept so a colour smuggled into an expression is still found.
        if (char === "\\") {
          out += char;
          if (next !== undefined) {
            out += next;
            i += 1;
          }
          continue;
        }

        if (char === "/" && next === "*") {
          state = "cssBlock";
          i += 1;
          continue;
        }

        out += char;

        if (char === "`") {
          state = "code";
        }

        continue;
      }

      if (char === "/" && next === "/") {
        state = "line";
        i += 1;
        continue;
      }

      if (char === "/" && next === "*") {
        state = "block";
        i += 1;
        continue;
      }

      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";

      out += char;
    }

    return out.split(/\r?\n/);
  }

  for (const directory of CONSUMER_DIRS) {
    for (const relative of listFiles(args.root, directory, [".ts", ".tsx"])) {
      if (TEST_FILE_PATTERN.test(relative)) continue;

      const source = read(path.join(args.root, relative));
      const lines = codeLines(source);

      lines.forEach((line, index) => {
        if (colourLiteral.test(line)) {
          violations.push({
            file: relative,
            line: index + 1,
            rule: "T2",
            message: "colour literal in a component; use var(--ui-...) so the theme can reach it",
          });

          return;
        }

        // A fallback inside a token reference is still a hard-coded colour, and
        // it is the more dangerous kind: it only shows up when the token is
        // absent, which is exactly the case nobody looks at.
        for (const match of line.matchAll(VAR_FALLBACK)) {
          const fallback = match[1] ?? "";

          if (colourLiteral.test(fallback)) {
            violations.push({
              file: relative,
              line: index + 1,
              rule: "T2",
              message: "colour literal as a var() fallback; it hides exactly the case it should surface",
            });
          }
        }
      });
    }
  }

  // ---- T5: every referenced token slot exists.
  //
  // A misspelled slot name is not a colour literal, so T2 lets it through, and
  // `var(--ui-typo)` is not a CSS error -- it resolves to nothing, the
  // declaration is dropped, and the element renders with whatever was inherited.
  // That is the quietest possible failure, so it gets its own rule.
  const knownSlots = new Set(slots);
  const referencePattern = /var\(\s*(--ui-[A-Za-z0-9-]+)/g;

  for (const directory of CONSUMER_DIRS) {
    for (const relative of listFiles(args.root, directory, [".ts", ".tsx"])) {
      if (TEST_FILE_PATTERN.test(relative)) continue;

      const source = read(path.join(args.root, relative));
      const lines = source.split(/\r?\n/);

      lines.forEach((line, index) => {
        for (const match of line.matchAll(referencePattern)) {
          const slot = match[1];

          if (slot !== undefined && !knownSlots.has(slot)) {
            violations.push({
              file: relative,
              line: index + 1,
              rule: "T5",
              message: `${slot} is not a declared token slot; a var() reference to it resolves to nothing`,
            });
          }
        }
      });
    }
  }

  // ---- T6: every ui- class in the markup has a rule.
  //
  // `ui-skeleton__announcement` was referenced by the skeleton and had no rule, so
  // the live region rendered as visible text above the placeholder bars. No test
  // caught it because the live region itself was correct -- only its styling was
  // missing, and there is no assertion for "this element is styled at all".
  //
  // Two holes in the first version, both closed here:
  //
  // 1. It only read `className="literal"` and ``className={`literal`}``. Every
  //    component in this package actually writes `className={classes}` or
  //    ``className={`${classes}__body`}``, and the second form was skipped whole
  //    by the `includes("$")` guard -- so the eleven derived sub-classes
  //    (`__trigger`, `__popup`, `__backdrop`, `__body`, ...) were never checked.
  // 2. It silently did nothing when `styles.ts` was absent. A missing stylesheet
  //    is not "nothing to check", it is "every class is unstyled", so it now
  //    fails loudly instead of reporting a clean tree.
  const stylesheetFile = `packages/ui/src/components/styles.ts`;
  const stylesheetPath = path.join(args.root, stylesheetFile);

  if (!existsSync(stylesheetPath)) {
    violations.push({
      file: stylesheetFile,
      rule: "T6",
      message: `cannot judge class coverage: ${stylesheetFile} does not exist, so no ui- class has a rule`,
    });
  } else {
    const stylesheet = read(stylesheetPath);

    /**
     * Every `className=` value, in any of the three shapes this package uses.
     *
     * `className={clsx("a", "b")}` and a bare identifier are matched by the
     * third alternative: the values are picked up when the string literals are
     * scanned separately, so only the literal list needs to be complete.
     */
    const classPattern = /className=(?:"([^"]+)"|\{`([^`]+)`\}|\{([^}]*)\})/g;

    /**
     * The base class of a component.
     *
     * Derived names are written `${BASE}__part`, and the root is `classes`.
     * Components declare `const BASE = "ui-foo"` (the prefix for parts) next to
     * `const classes = ...` (the root, which may carry a caller class). Reading
     * `BASE` is what makes the derived names checkable at all.
     *
     * @param {string} source component source
     * @returns {string | null} the base class, or null when it is not literal
     */
    function baseClassOf(source) {
      const direct = source.match(/const BASE = "([^"]+)"/);

      if (direct?.[1] !== undefined) return direct[1];

      // Older components still derive from `classes` with no caller class in the
      // string, so that shape has to keep working.
      const legacy = source.match(/const classes = className === undefined \? "([^"]+)"/);

      return legacy?.[1] ?? null;
    }

    for (const directory of CONSUMER_DIRS) {
      for (const relative of listFiles(args.root, directory, [".tsx"])) {
        if (TEST_FILE_PATTERN.test(relative)) continue;

        const source = read(path.join(args.root, relative));
        const base = baseClassOf(source);

        for (const match of source.matchAll(classPattern)) {
          const raw = match[1] ?? match[2] ?? match[3] ?? "";

          for (const piece of raw.split(/\s+/)) {
            if (piece === "") continue;

            // The three shapes that reach the DOM:
            //   "ui-tag"                 a literal
            //   `${classes}__trigger`    a derived name
            //   classes                  the base itself, which is the *root*
            //                            class every component actually uses
            const resolved =
              piece === "classes" || piece === "BASE"
                ? base
                : piece.includes("${classes}") || piece.includes("${BASE}")
                  ? base === null
                    ? null
                    : piece.replace(/\$\{classes\}/g, base).replace(/\$\{BASE\}/g, base)
                  : piece;

            if (resolved === null) continue;
            if (!resolved.startsWith("ui-")) continue;
            if (resolved.includes("$")) continue;

            // Matched with a boundary, not a bare substring: `.ui-x` is a prefix
            // of `.ui-x-extra`, and a substring test would call a renamed class
            // present. That false pass is what the first version did.
            if (!hasClassRule(stylesheet, resolved)) {
              violations.push({
                file: relative,
                rule: "T6",
                message: `${resolved} is used but has no rule in ${stylesheetFile}`,
              });
            }
          }
        }
      }
    }
  }

  return violations;
}

await runGate(collectViolations, {});
