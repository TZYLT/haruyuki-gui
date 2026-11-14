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

  /** Exported palette names to the theme key they belong to. */
  const nameToTheme = new Map([
    ["LIGHT_NORMAL", "light/normal"],
    ["LIGHT_HIGH", "light/high"],
    ["DARK_NORMAL", "dark/normal"],
    ["DARK_HIGH", "dark/high"],
  ]);

  const themes = new Map();

  for (const [exportName, themeKey] of nameToTheme) {
    const patterns = [
      new RegExp(`export const ${exportName}\\s*(?::\\s*Palette)?\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`),
      new RegExp(`export const ${exportName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`),
    ];
    const body = patterns.map((pattern) => palettesSource.match(pattern)?.[1]).find(Boolean);

    // A missing palette is a T3 violation, not a broken gate: the script itself
    // is fine, the tree is wrong. Reporting it here lets the caller collect it
    // with the other T3 findings instead of aborting with exit 2.
    if (body === undefined) continue;

    const slots = new Set(shared);

    for (const match of body.matchAll(/"(--ui-[A-Za-z0-9-]+)"\s*:/g)) {
      if (match[1] !== undefined) slots.add(match[1]);
    }

    themes.set(themeKey, slots);
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
    const values = palettes[key];
    const fg = values?.get(foreground);
    const bg = values?.get(background);

    if (fg === undefined || bg === undefined) return;

    const ratio = contrast(fg, bg);

    if (ratio < minimum) {
      violations.push({
        file: palettesFile,
        rule,
        message: `${key}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, below ${minimum}:1`,
      });
    }
  }

  for (const key of Object.keys(palettes)) {
    for (const surface of surfaces) {
      requireContrast(key, "--ui-color-neutral-1", surface, MIN_TEXT_RATIO, "T4");
      requireContrast(key, "--ui-color-neutral-2", surface, MIN_TEXT_RATIO, "T4");
      requireContrast(key, "--ui-color-neutral-3", surface, MIN_NON_TEXT_RATIO, "T4");
    }

    requireContrast(key, "--ui-color-accent-1", "--ui-color-surface-1", MIN_TEXT_RATIO, "T4");

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

  // ---- T2: no component names a colour.
  const colourLiteral = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;
  const stylePattern =
    /(?:^|[^A-Za-z])(?:color|background|backgroundColor|borderColor|fill|stroke)\s*[:=]\s*["'`]([^"'`]*)["'`]/g;

  for (const directory of CONSUMER_DIRS) {
    for (const relative of listFiles(args.root, directory, [".ts", ".tsx"])) {
      if (relative.includes(".test.")) continue;

      const source = read(path.join(args.root, relative));
      const lines = source.split(/\r?\n/);

      lines.forEach((line, index) => {
        // A comment may name a colour while explaining why we do not; only code
        // counts.
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");

        if (/^\s*\*/.test(code)) return;

        for (const match of code.matchAll(stylePattern)) {
          const value = match[1] ?? "";

          // A value that is a `var(--ui-...)` reference is exactly what we want.
          if (value.startsWith("var(--ui-")) continue;

          if (colourLiteral.test(value)) {
            violations.push({
              file: relative,
              line: index + 1,
              rule: "T2",
              message: "colour literal in a component; use var(--ui-...) so the theme can reach it",
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
      if (relative.includes(".test.")) continue;

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
  const stylesheetFile = `packages/ui/src/components/styles.ts`;
  const stylesheetPath = path.join(args.root, stylesheetFile);

  if (existsSync(stylesheetPath)) {
    const stylesheet = read(stylesheetPath);
    const classPattern = /className=(?:"([^"]+)"|\{`([^`]+)`\})/g;
    const templatePattern = /\$\{[^}]*\}/g;

    for (const directory of CONSUMER_DIRS) {
      for (const relative of listFiles(args.root, directory, [".tsx"])) {
        if (relative.includes(".test.")) continue;

        const source = read(path.join(args.root, relative));

        for (const match of source.matchAll(classPattern)) {
          const literal = match[1] ?? (match[2] ?? "").replace(templatePattern, " ");

          for (const token of literal.split(/\s+/)) {
            if (!token.startsWith("ui-")) continue;
            // A modifier assembled at runtime (`${classes}__popup`) is covered by
            // the class it is derived from; only fully literal names are checked.
            if (token.includes("$")) continue;

            // Matched with a boundary, not a bare substring: `.ui-x` is a prefix
            // of `.ui-x-extra`, and a substring test would call a renamed class
            // present. That false pass is what the first version did.
            if (!hasClassRule(stylesheet, token)) {
              violations.push({
                file: relative,
                rule: "T6",
                message: `${token} is used but has no rule in ${stylesheetFile}`,
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
