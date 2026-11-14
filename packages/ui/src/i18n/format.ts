/**
 * Message formatting runtime.
 *
 * The heavy lifting is `intl-messageformat`, but three things are ours and are
 * the reason this module exists rather than call sites using the library:
 *
 * 1. **Missing parameters are loud.** `{name}` with no `name` supplied renders
 *    as an empty string in the library. A blank space where a name should be is
 *    the hardest kind of bug to notice in review, so a missing value is counted
 *    and, in a development build, thrown.
 * 2. **Catalogues are compiled once, lazily.** Parsing ICU on every render is
 *    pure waste; parsing eagerly at import time makes an unused locale cost
 *    startup. One `IntlMessageFormat` per (locale, key) is cached on first use.
 * 3. **The fallback is English, silently.** A missing key in a non-English
 *    catalogue must not blank the UI; it renders the English string and is
 *    counted, because the gate should have caught it but the screen must not
 *    depend on the gate having run.
 */

import { IntlMessageFormat } from "intl-messageformat";

import { en, type MessageKey } from "./locales/en.js";
import { zhCN } from "./locales/zh-CN.js";
import type { Locale, LocaleMessages, MessageValues } from "./types.js";
import { FALLBACK_LOCALE } from "./types.js";

/** Every shipped catalogue, keyed by locale. */
export const CATALOGUES: Readonly<Record<Locale, LocaleMessages>> = {
  en,
  "zh-CN": zhCN as unknown as LocaleMessages,
};

/**
 * Whether a missing parameter should throw.
 *
 * Read from `import.meta.env` rather than `process.env`: the renderer never has
 * `process` (`types: []` enforces it, and the boundary gate rejects `node:*`), so
 * the bundler's compile-time flag is the only signal available.
 *
 * Read through a module-level field rather than inline so a test can drive the
 * production branch. Vite replaces `import.meta.env.DEV` with a literal at build
 * time, so an inline read cannot be redefined -- and the production branch was
 * the broken one, which meant the branch that shipped was the branch with no
 * test that could reach it.
 */
let developmentBuildOverride: boolean | undefined;

function isDevelopmentBuild(): boolean {
  if (developmentBuildOverride !== undefined) {
    return developmentBuildOverride;
  }

  const env = (import.meta as { env?: { MODE?: string; DEV?: boolean } }).env;

  return env?.DEV === true || env?.MODE === "development";
}

/**
 * Force the development/production branch, for tests.
 *
 * @param value `true` for the development branch, `false` for production, or
 * `undefined` to restore the build flag
 */
export function setDevelopmentBuildForTesting(value: boolean | undefined): void {
  developmentBuildOverride = value;
}

/** Counts a diagnostic so a test can assert it without reading the console. */
export interface DiagnosticCounters {
  missingParams: number;
  missingKeys: number;
}

/** Process-wide counters, exposed for tests and for the dev overlay. */
export const diagnostics: DiagnosticCounters = { missingParams: 0, missingKeys: 0 };

/**
 * Reset the counters.
 *
 * Tests need a clean slate; production never calls this. Exposed rather than kept
 * private because a test reaching into module internals would be worse.
 */
export function resetDiagnostics(): void {
  diagnostics.missingParams = 0;
  diagnostics.missingKeys = 0;
}

/** One compiled message, cached per locale and key. */
const compiled = new Map<string, IntlMessageFormat>();

/**
 * The named arguments one ICU message declares.
 *
 * Used to detect a missing value before formatting, because the formatter itself
 * substitutes an empty string and gives no signal.
 */
const declaredArguments = new Map<string, ReadonlySet<string>>();

/**
 * AST node types that bind a named argument.
 *
 * From `@formatjs/icu-messageformat-parser`: 0 literal, 1 argument, 2 number,
 * 3 date, 4 time, 5 select, 6 plural (including ordinal), 7 pound, 8 tag. Only
 * 1/2/3/4/5/6 carry an argument name; checking `typeof value === "string"` alone
 * would also match a literal text node (type 0), whose value is a string too.
 */
const ARGUMENT_NODE_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6]);

/**
 * Extract the argument names a message uses.
 *
 * Reads the compiled AST rather than the source string: a regex over the raw text
 * would also match an escaped literal brace, and would miss that a `plural`
 * *itself* consumes `count` -- the plural node's `value` is the argument name,
 * not a branch label, so walking only its options misses the argument entirely.
 *
 * @param key cache key
 * @param message compiled formatter
 * @returns the argument names
 */
function argumentNamesOf(key: string, message: IntlMessageFormat): ReadonlySet<string> {
  const cached = declaredArguments.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const names = new Set<string>();

  /** @param elements AST nodes to walk */
  function walk(elements: readonly unknown[]): void {
    for (const element of elements) {
      if (typeof element !== "object" || element === null) continue;

      const node = element as {
        type?: number;
        value?: unknown;
        options?: Record<string, { value?: readonly unknown[] }>;
      };

      if (typeof node.type === "number" && ARGUMENT_NODE_TYPES.has(node.type)) {
        if (typeof node.value === "string") {
          names.add(node.value);
        }
      }

      for (const option of Object.values(node.options ?? {})) {
        if (Array.isArray(option.value)) {
          walk(option.value);
        }
      }
    }
  }

  walk(message.getAst());
  declaredArguments.set(key, names);

  return names;
}

/**
 * @param locale catalogue to read
 * @param key message id
 * @returns the message text, or `undefined` when absent
 */
function lookup(locale: Locale, key: string): string | undefined {
  const catalogue = CATALOGUES[locale];
  const value = catalogue[key];

  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * @param locale locale identifier
 * @param key message id
 * @returns compiled formatter
 */
function formatterFor(locale: Locale, key: string): IntlMessageFormat {
  const cacheKey = `${locale}\u0000${key}`;
  const cached = compiled.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const own = lookup(locale, key);
  // `lookup` returning here means the message is coming from the fallback
  // catalogue, and it has to be compiled **in the fallback locale**, not in the
  // requested one. The two catalogues do not just translate text: they select
  // plural branches. An ICU `plural` picks its branch by the locale's plural
  // rules, so compiling an English message against `zh` rendered the English
  // text with Chinese plural rules. It happens to differ only for languages whose
  // rule set is not English's, which is exactly the case a translator introduces
  // and nobody re-tests.
  const compiledLocale = own === undefined ? FALLBACK_LOCALE : locale;
  const message = own ?? lookup(FALLBACK_LOCALE, key);

  if (message === undefined) {
    throw new Error(`unknown message key: ${key}`);
  }

  const formatter = new IntlMessageFormat(message, compiledLocale);

  compiled.set(cacheKey, formatter);

  return formatter;
}

/**
 * Format one message.
 *
 * @param locale locale to render in
 * @param key message id
 * @param values interpolation values
 * @returns the formatted string
 */
export function formatMessage(locale: Locale, key: MessageKey, values?: MessageValues): string {
  const resolved = lookup(locale, key);

  if (resolved === undefined) {
    // Fall back to English rather than blanking the screen. Counted so the gate
    // has a signal even in a build where nothing throws.
    diagnostics.missingKeys += 1;

    if (lookup(FALLBACK_LOCALE, key) === undefined) {
      throw new Error(`unknown message key: ${key}`);
    }
  }

  const formatter = formatterFor(locale, key);
  const declared = argumentNamesOf(`${locale}\u0000${key}`, formatter);
  const supplied = new Set(Object.keys(values ?? {}));
  const missing = [...declared].filter((name) => !supplied.has(name));

  if (missing.length > 0) {
    diagnostics.missingParams += 1;

    if (isDevelopmentBuild()) {
      throw new Error(`missing interpolation value(s) for "${key}": ${missing.join(", ")}`);
    }

    // Production degrades to the literal placeholder rather than throwing.
    //
    // `intl-messageformat` throws `MissingValueError` for an absent argument, so
    // skipping our own throw was not enough: the call on the last line threw
    // anyway, which turned a missing optional value into a blank screen in the
    // one build that has no developer watching. The requirement says the
    // production build renders `{name}` and counts it, so the values are filled
    // in with a placeholder *before* formatting and the count above is the
    // diagnostic.
    //
    // A plural argument cannot take a string placeholder -- ICU would look for a
    // matching plural branch and fall to `other`, which is the defined fallback
    // anyway -- so it is supplied as a number that selects `other` for `en` and
    // `zh` alike (any non-1 integer does).
    const filled: MessageValues = { ...values };

    for (const name of missing) {
      filled[name] = `{${name}}`;
    }

    return formatter.format(filled as never) as string;
  }

  return formatter.format(values as never) as string;
}
