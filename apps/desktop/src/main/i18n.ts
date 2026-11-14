/**
 * The shell's own i18n binding.
 *
 * The renderer gets its translator from the React provider in `@haruyuki/ui/i18n`. The
 * main process needs some of the same strings -- the window title, dialog copy -- and it
 * has no React, so it imports the framework-free entry `@haruyuki/ui/i18n/core` instead.
 *
 * Measured (and corrected): the ordinary entry bundles to ~214 kB with React present, the
 * core entry to ~73 kB with none. The earlier "88 KB vs 19.8 KB" figure in the route
 * document was taken with the ICU parser external, which understated both sides; the
 * ratio and the direction of the claim hold, the absolute numbers did not.
 *
 * Locale resolution order, and why:
 *
 *   1. The persisted choice. It is what the user last asked for, and the one setting
 *      whose job is to outrank the environment.
 *   2. The OS locale, matched against the shipped catalogues. A first launch should speak
 *      the system's language rather than the fallback.
 *   3. The fallback. Always available, always complete.
 */

import {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  resolveLocale,
  type Locale,
} from "@haruyuki/ui/i18n/core";

/**
 * The product name.
 *
 * A constant, not a catalogue key. It is a brand name, identical in every locale, and
 * adding it to the catalogues would create a key whose two translations must be kept
 * equal by hand -- which is exactly the kind of entry a translator eventually "improves".
 */
export const APP_NAME = "Haruyuki";

/**
 * Pick the locale for this launch.
 *
 * @param persisted the value from settings: a validated locale, or `null` when
 *   the user has never chosen one
 * @param systemLocale the OS locale as Electron reports it (`app.getLocale()`)
 */
export function chooseLocale(persisted: Locale | null, systemLocale: string): Locale {
  // A stored choice wins over the environment -- that is the one job this field
  // has. `null` is not "unknown", it is "not chosen yet", and it is what lets a
  // first launch speak the system's language instead of the fallback.
  //
  // The membership check is repeated rather than trusted: a settings file edited
  // by hand is re-read on every launch, and "validated earlier" is not a property
  // this function can see.
  if (persisted !== null && (SUPPORTED_LOCALES as readonly string[]).includes(persisted)) {
    return persisted;
  }

  return resolveLocale(systemLocale) || FALLBACK_LOCALE;
}
