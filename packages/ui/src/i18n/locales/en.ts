/**
 * The English message catalogue.
 *
 * This file is the **type source** for the whole i18n layer: `MessageKey` is
 * `keyof typeof en`, so a key that does not exist here is a compile error at the
 * call site. That is why the catalogue is a TypeScript module and not JSON -- a
 * JSON file would need a separate type generation step, and until that step ran
 * a typo in `t()` would be a runtime string.
 *
 * Key rules: a namespace from a closed set, then two to four
 * `lowerCamelCase` segments. The four-segment ceiling is deliberate: a deeper
 * path means the sentence should be composed from smaller pieces, not addressed
 * by a longer id.
 *
 * Values are ICU MessageFormat. Named arguments only -- positional arguments are
 * banned because they make a translation reorder silently wrong.
 */

import type { LocaleMessages } from "../types.js";

/** The English catalogue. Also the shape all other catalogues must match. */
export const en = {
  // ---------------------------------------------------------------- common
  "common.action.cancel": "Cancel",
  "common.action.confirm": "Confirm",
  "common.action.delete": "Delete",
  "common.action.save": "Save",
  "common.state.loading": "Loading",
  "common.state.empty": "Nothing here yet",
  "common.state.error": "Something went wrong",

  // ------------------------------------------------------------- component
  "component.input.placeholder": "Enter a value",
  "component.select.placeholder": "Select an option",
  "component.select.empty": "No matching options",
  "component.dialog.title": "Confirm",
  "component.dialog.close": "Close dialog",
  "component.tag.remove": "Remove",
  "component.alert.dismiss": "Dismiss alert",
  "component.form.required": "This field is required",

  // ------------------------------------------------------------------ page
  "page.conversation.empty.title": "No conversation yet",
  "page.conversation.empty.description": "Start typing to begin",
  "page.conversation.retryLater": "Try again in a moment",
  "page.error.retry": "Try again",

  // ----------------------------------------------------------------- error
  "error.network.unreachable": "The service is unreachable",
  "error.unexpected": "An unexpected error occurred",
  "error.withCode": "An error occurred ({code})",

  // ------------------------------------------------------------------ a11y
  "a11y.action.delete": "Delete",
} as const satisfies LocaleMessages;

/** The key union every `t()` call is checked against. */
export type MessageKey = keyof typeof en;
