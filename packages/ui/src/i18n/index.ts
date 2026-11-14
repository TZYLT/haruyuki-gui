/**
 * Public surface of the i18n layer.
 *
 * `createTranslator` is a local declaration, so this module is not a pure
 * forwarding barrel -- the ownership gate rejects those because a module with no
 * behaviour of its own has no owner. It is also genuinely useful: a non-React
 * consumer (a gate, a CLI, a test) needs `t` without a component tree.
 */

import { formatMessage } from "./format.js";
import type { MessageKey } from "./locales/en.js";
import type { Locale, MessageValues } from "./types.js";
import { resolveLocale } from "./types.js";

/** Identifies the i18n layer in diagnostics. */
export const I18N_LAYER = "i18n" as const;

/**
 * Build a translator for one locale without React.
 *
 * @param locale requested locale; unsupported tags resolve to the fallback
 * @returns a callable translator
 */
export function createTranslator(locale: string): {
  (key: MessageKey): string;
  (key: MessageKey, values: MessageValues): string;
  readonly locale: Locale;
} {
  const resolved = resolveLocale(locale);
  const translate = ((key: MessageKey, values?: MessageValues): string =>
    formatMessage(resolved, key, values)) as {
    (key: MessageKey): string;
    (key: MessageKey, values: MessageValues): string;
    readonly locale: Locale;
  };

  Object.defineProperty(translate, "locale", { value: resolved, enumerable: true });

  return translate;
}

export {
  CATALOGUES,
  diagnostics,
  formatMessage,
  resetDiagnostics,
  setDevelopmentBuildForTesting,
} from "./format.js";
export type { DiagnosticCounters } from "./format.js";

export { en } from "./locales/en.js";
export type { MessageKey } from "./locales/en.js";
export { zhCN } from "./locales/zh-CN.js";

export { LocaleProvider, useLocale, useT } from "./provider.js";
export type { LocaleProviderProps, Translator } from "./provider.js";

export {
  FALLBACK_LOCALE,
  MESSAGE_KEY_PATTERN,
  MESSAGE_NAMESPACES,
  SUPPORTED_LOCALES,
  resolveLocale,
} from "./types.js";
export type { Locale, LocaleMessages, MessageValues } from "./types.js";
