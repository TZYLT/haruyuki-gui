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

  // ----------------------------------------------------------------- crash
  // The full-window surface that replaces the shell after an engine or renderer
  // death. The two detail messages carry the facts the user needs to report it;
  // the generic description is what an unrecognised route shows.
  "common.crash.engineTitle": "The engine stopped unexpectedly",
  "common.crash.rendererTitle": "The interface stopped",
  "common.crash.description":
    "The application stopped because a process it depends on ended unexpectedly. Exporting a diagnostics bundle is the best way to report what happened.",
  "common.crash.engineDetails":
    "The engine exited with code {code} (signal {signal}). The diagnostics bundle contains the details.",
  "common.crash.rendererDetails":
    "The interface process stopped (reason {reason}, exit code {exitCode}). The diagnostics bundle contains the details.",
  "common.crash.export": "Export diagnostics",
  "common.crash.restart": "Restart application",
  "common.crash.quit": "Quit application",
  "common.crash.bridgeUnavailable":
    "The diagnostics bridge is unavailable, so this action cannot run.",
  "common.crash.notAvailable": "not reported",

  // ------------------------------------------------------------ diagnostics
  // The panel's own vocabulary. The two option labels carry their scope and risk
  // in the same sentence rather than in a tooltip: what a checkbox includes is
  // the one thing a user must not have to go looking for.
  "common.diagnostics.title": "Export diagnostics",
  "common.diagnostics.sessionContent":
    "Include the most recent 200 messages from this session (tool names, arguments and results; never API keys or tokens)",
  "common.diagnostics.minidump":
    "Include the crash dump (minidump); it may contain sensitive data from memory",
  "common.diagnostics.export": "Export",
  "common.diagnostics.cancel": "Cancel",
  "common.diagnostics.close": "Close",
  "common.diagnostics.noSession": "No active session",
  "common.diagnostics.emptySessionNote":
    "This build has no session source, so the bundle will contain an empty placeholder with a note saying so",
  "common.diagnostics.phaseCollect": "Collecting files",
  "common.diagnostics.phaseCompress": "Compressing the bundle",
  "common.diagnostics.phaseWrite": "Writing the archive",
  "common.diagnostics.progress": "Working: {done} of {total}",
  "common.diagnostics.exported": "Exported to {path} ({size} bytes)",
  "common.diagnostics.failed": "Export failed",
  "common.diagnostics.retry": "Retry",
  "common.diagnostics.bridgeUnavailable":
    "The diagnostics bridge is unavailable, so the bundle cannot be exported",

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
  "error.shell.resourceDenied": "The application could not load a file it is not allowed to read",
  "error.shell.resourceMissing": "The application could not find a file it needs",
  "error.shell.bridgeDenied": "The application asked for a capability it does not have",
  "error.shell.settingsCorrupt": "Your settings could not be read, so defaults are in use",
  "error.shell.engineUnavailable": "The engine did not start",
  "error.shell.engineCrashed": "The engine stopped unexpectedly",
  "error.shell.diagnosticExportFailed": "The diagnostic bundle could not be exported",
  "error.shell.staleEngineFound": "An engine process from an earlier run is still running",
  "error.shell.staleEngineCleanFailed": "The leftover engine process could not be ended",

  // ------------------------------------------------------------------ a11y
  "a11y.action.delete": "Delete",
} as const satisfies LocaleMessages;

/** The key union every `t()` call is checked against. */
export type MessageKey = keyof typeof en;
