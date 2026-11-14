/**
 * React binding for the message runtime.
 *
 * The provider carries the locale, not a mutable global: two subtrees may render
 * in different locales (a preview pane next to an editing surface), and a global
 * setter would make that impossible and untestable. Switching locale means the
 * host re-renders the provider with a new value, which is also why there is no
 * `setLocale` in the public surface.
 *
 * `useLocale` and `useT` are separate hooks on purpose: a component that only
 * forwards the locale string should not subscribe to the formatter, and a
 * component that only formats should not have to know the locale is a concept.
 */

import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from "react";

import { formatMessage } from "./format.js";
import type { MessageKey } from "./locales/en.js";
import type { Locale, MessageValues } from "./types.js";
import { FALLBACK_LOCALE, resolveLocale } from "./types.js";

/** What the context carries. */
interface LocaleContextValue {
  locale: Locale;
}

/**
 * `null` is the "no provider above me" sentinel, deliberately distinct from a
 * context that defaults to English: defaulting would let a component tree render
 * in the wrong language without anyone noticing that the provider is missing.
 */
const LocaleContext = createContext<LocaleContextValue | null>(null);

/** Props of {@link LocaleProvider}. */
export interface LocaleProviderProps {
  /** Requested locale; unsupported tags fall back according to `resolveLocale`. */
  locale: string;
  children: ReactNode;
}

/**
 * Supply a locale to a subtree.
 *
 * @param props provider props
 * @returns the provider element
 */
export function LocaleProvider({ locale, children }: LocaleProviderProps): ReactElement {
  const value = useMemo<LocaleContextValue>(() => ({ locale: resolveLocale(locale) }), [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * Read the active locale.
 *
 * Falls back to English outside a provider rather than throwing: a component
 * rendered in isolation (a unit test, a story) should still produce text, and
 * the fallback is the same one an unsupported tag gets.
 *
 * @returns the active locale
 */
export function useLocale(): Locale {
  return useContext(LocaleContext)?.locale ?? FALLBACK_LOCALE;
}

/** The translate function shape handed to components. */
export interface Translator {
  (key: MessageKey): string;
  (key: MessageKey, values: MessageValues): string;
  /** The locale this translator formats in. */
  readonly locale: Locale;
}

/**
 * Get a translator bound to the active locale.
 *
 * The returned function is stable per locale, so passing it into a dependency
 * array does not re-run effects on every render.
 *
 * @returns a `t` function
 */
export function useT(): Translator {
  const locale = useLocale();

  return useMemo(() => {
    const translate = ((key: MessageKey, values?: MessageValues): string =>
      formatMessage(locale, key, values)) as Translator;

    Object.defineProperty(translate, "locale", { value: locale, enumerable: true });

    return translate;
  }, [locale]);
}
