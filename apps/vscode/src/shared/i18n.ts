/**
 * Locale resolution for this shell, shared by the extension host and the panel.
 *
 * The editor is the only source of truth: `vscode.env.language` is the language
 * the user chose for the editor, and the panel has to render in that same one.
 * The value reaches the panel as an attribute on the document root, because a
 * document is produced once per panel while a bridge message is replayed on
 * every return to visibility; a fact that does not change is the wrong cargo
 * for the replay path.
 *
 * Normalisation is not re-implemented here. `@haruyuki/ui/i18n/core` owns
 * `SUPPORTED_LOCALES` and `resolveLocale`, and this module re-exports the table
 * and wraps the resolver, so the shell has exactly one answer to "which locale
 * is this?". A second table would let the editor's `zh-cn` resolve one way on
 * one side of the panel and another way on the other, which is the class of bug
 * that only shows up as a half-translated screen.
 *
 * The host side writes the raw tag and never normalises; normalising is this
 * module's job so that the tag on the document and the tag in the provider can
 * only ever disagree about spelling, never about the locale.
 */

import {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  resolveLocale,
  type Locale,
} from "@haruyuki/ui/i18n/core";

export { FALLBACK_LOCALE, SUPPORTED_LOCALES };
export type { Locale };

/**
 * The attribute the host writes the editor's raw language tag into.
 *
 * Authoritative: the document may also carry a `lang` for the browser and for
 * assistive technology, but the panel reads this one first.
 */
export const LOCALE_ATTRIBUTE = "data-locale";

/** The attribute the raw tag is mirrored on, and the one the panel keeps true. */
export const LANG_ATTRIBUTE = "lang";

/**
 * The part of an element this module reads and writes.
 *
 * Structural rather than `HTMLElement` so the resolution can be exercised with a
 * plain object, and so the host-side tests never need a DOM.
 */
export interface LocaleAttributes {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/**
 * Resolve a language tag the editor reports to a locale this shell ships.
 *
 * `vscode.env.language` is spelled like `zh-cn`, `en` or `ja`; the catalogues
 * are keyed by `zh-CN` and `en`. Region and case differences are absorbed by
 * the shared resolver, and an unsupported language falls back to English rather
 * than leaving the panel blank.
 *
 * The tag is trimmed here rather than in the resolver: the shared one compares
 * the whole string, so a padded value would resolve to the fallback through this
 * function and to `zh-CN` through the document read path. Both callers hand it
 * the value they found, and both get the same answer.
 *
 * @param tag the raw tag, or `null`/`undefined` when the editor reported none
 * @returns a supported locale
 */
export function resolveShellLocale(tag: string | null | undefined): Locale {
  const trimmed = tag?.trim();

  return resolveLocale(trimmed === "" ? undefined : trimmed);
}

/**
 * Read the raw language tag a document carries.
 *
 * Probes {@link LOCALE_ATTRIBUTE} first and falls back to {@link LANG_ATTRIBUTE}
 * so a document produced by an older host -- or by the browser itself, where
 * `lang` is the only attribute that exists -- still answers. A blank value is
 * treated as absent rather than as a locale, so the panel falls back instead of
 * resolving an empty string.
 *
 * @param element the document root, or anything with the same two members
 * @returns the raw tag, or `undefined` when the document names none
 */
export function readLocaleTag(element: LocaleAttributes): string | undefined {
  for (const name of [LOCALE_ATTRIBUTE, LANG_ATTRIBUTE]) {
    const raw = element.getAttribute(name)?.trim();

    if (raw !== undefined && raw !== "") {
      return raw;
    }
  }

  return undefined;
}

/**
 * Read the locale a document asks the panel to render in.
 *
 * The whole read path in one call: the document is what carries the host's
 * answer, and callers should not have to sequence two functions to get at it.
 *
 * @param element the document root
 * @returns a supported locale
 */
export function readElementLocale(element: LocaleAttributes): Locale {
  return resolveShellLocale(readLocaleTag(element));
}

/**
 * Resolve the document's locale and mirror it into `lang`.
 *
 * The attribute the host writes is the editor's raw tag (`zh-cn`), while the
 * locale the panel renders is the resolved one (`zh-CN`). Leaving the raw value
 * on `lang` would tell the browser and a screen reader a tag the content behind
 * it does not use, so the resolved value is written back once, before the first
 * paint. A value that is already correct is not rewritten.
 *
 * @param element the document root
 * @returns the locale that was mirrored
 */
export function applyElementLocale(element: LocaleAttributes): Locale {
  const locale = readElementLocale(element);

  if (element.getAttribute(LANG_ATTRIBUTE) !== locale) {
    element.setAttribute(LANG_ATTRIBUTE, locale);
  }

  return locale;
}
