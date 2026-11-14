/**
 * Shapes shared by the catalogues and the runtime.
 *
 * Kept separate from either locale file so the Chinese catalogue can be typed
 * against the English one without importing it circularly, and so the runtime
 * does not have to import a specific locale just to name a type.
 */

/**
 * Keys are `namespace.seg[.seg]`, two to four segments, each lowerCamelCase.
 *
 * Digits are allowed after the first character, which is what makes the frozen
 * namespace `a11y` legal: it is `a` followed by three digits. A pattern that
 * only allowed letters would reject the requirement's own namespace list.
 *
 * The pattern is documentation and a gate input, not a runtime check: a key is
 * validated once, in `i18n:check`, rather than on every `t()` call.
 */
export const MESSAGE_KEY_PATTERN =
  /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){0,2}$/;

/** The closed namespace set. Adding one is a frozen-surface change. */
export const MESSAGE_NAMESPACES = ["common", "component", "page", "error", "a11y"] as const;

/** A locale's catalogue. Values are ICU MessageFormat strings. */
export type LocaleMessages = Record<string, string>;

/**
 * Values that may be interpolated into a message.
 *
 * Deliberately not `unknown`: an object or a function would either throw inside
 * the formatter or render as `[object Object]`, and both are worse than a type
 * error at the call site.
 */
export type MessageValues = Record<string, string | number>;

/** Supported locales. `en` is the fallback and must always exist. */
export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

/** A supported locale identifier. */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** The locale used when resolution fails. */
export const FALLBACK_LOCALE: Locale = "en";

/**
 * Resolve a requested locale tag to a supported one.
 *
 * Order: exact match, then the same language with its default region, then the
 * fallback. Never throws -- an unknown tag is a host mistake, and taking the
 * whole renderer down over it would be worse than rendering English.
 *
 * @param tag BCP 47 tag such as `zh-CN` or `zh-Hans-CN`
 * @returns a supported locale
 */
export function resolveLocale(tag: string | undefined): Locale {
  if (tag === undefined || tag === "") {
    return FALLBACK_LOCALE;
  }

  const normalised = tag.replace(/_/g, "-");
  const exact = SUPPORTED_LOCALES.find(
    (locale) => locale.toLowerCase() === normalised.toLowerCase(),
  );

  if (exact !== undefined) {
    return exact;
  }

  const language = normalised.split("-")[0]?.toLowerCase();

  if (language === "zh") {
    return "zh-CN";
  }

  return FALLBACK_LOCALE;
}
