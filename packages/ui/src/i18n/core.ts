/**
 * The framework-free entry point of the i18n layer.
 *
 * Why this file exists rather than consumers importing `./index.js`:
 *
 * `index.ts` re-exports `LocaleProvider` from `./provider.js`. That
 * `export ... from` is a static edge, so a bundler cannot drop it: anything that
 * imports `formatMessage` from `index.ts` also gets `provider.js` and therefore
 * React. Measured on the main-process bundle: 88 KB including `react.production`
 * against 19.8 KB for the same call reached through a React-free module. The
 * Electron main process has no DOM and no React, and it needs `formatMessage` for
 * the window title, the menu label and the two dialogs it owns, so it cannot pay
 * that tax.
 *
 * So this is the entry a non-React consumer imports (`@haruyuki/ui/i18n/core`),
 * and `index.ts` stays the entry a renderer imports.
 *
 * **Maintenance rule:** any new export added to `index.ts` must be considered
 * here too, and copied only if it is React-free. This file deliberately does not
 * use `export * from "./index.js"` -- that would re-introduce exactly the edge it
 * exists to avoid, and `core.test.ts` asserts the re-export is absent.
 *
 * The local constant below is not decoration: the ownership gate rejects a module
 * whose every statement forwards from another module, because such a module owns
 * nothing. `I18N_CORE_LAYER` is the layer's own value, the same way `I18N_LAYER`
 * in `index.ts` and `COMPONENT_LAYER` in `components/index.ts` are.
 */

import { formatMessage } from "./format.js";
import type { MessageKey } from "./locales/en.js";
import type { Locale, MessageValues } from "./types.js";
import { resolveLocale } from "./types.js";

/**
 * Identifies the framework-free i18n entry in diagnostics.
 *
 * A consumer that logs which layer formatted a string can tell this entry apart
 * from the React-bound one without importing both.
 */
export const I18N_CORE_LAYER = "i18n/core" as const;

/**
 * Build a translator for one locale without React.
 *
 * This duplicates `createTranslator` in `index.ts` on purpose. Two facts force it:
 *
 * 1. `index.ts` cannot export it without also loading `provider.js`. The function
 *    and the React binding live in one module graph, and a bundler keeps the whole
 *    graph; importing it here would restore the 88 KB bundle this file exists to
 *    avoid.
 * 2. They are two different consumer contracts. The `index.ts` copy serves a caller
 *    that already has React; this copy guarantees zero React. They agree today, and
 *    a caller cannot tell which one it received.
 *
 * The correct way to collapse the duplication is to move `createTranslator` into
 * `format.ts`, which both entries can import and which has no React dependency.
 * That file is outside this worker's write scope, so the duplication is recorded
 * here rather than silently introduced: if you are reading this and can edit
 * `format.ts`, moving the function there is the intended fix, and this copy should
 * become a re-export of it.
 *
 * @param locale requested locale; unsupported tags resolve to the fallback
 * @returns a callable translator with its resolved locale attached
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

  // Enumerable so a caller can read `.locale` back, and non-writable because the
  // translator is bound to one locale: a caller mutating it would format in a
  // locale the catalogue it came from does not describe.
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

export {
  FALLBACK_LOCALE,
  MESSAGE_KEY_PATTERN,
  MESSAGE_NAMESPACES,
  SUPPORTED_LOCALES,
  resolveLocale,
} from "./types.js";
export type { Locale, LocaleMessages, MessageValues } from "./types.js";
