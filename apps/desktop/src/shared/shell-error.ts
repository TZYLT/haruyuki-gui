/**
 * The shell's error codes, shared by the process that raises them and the page
 * that shows them.
 *
 * Why this lives in `shared/` rather than in `main/`: the mapping from a code to
 * the message a user reads is the one part of the taxonomy both sides need. The
 * main process raises the code; the renderer turns it into a sentence. Splitting
 * them -- a list here, a lookup table there -- is how a code gets a second
 * spelling or a second message, and the requirement is explicit that this table
 * is the *only* source for that mapping.
 *
 * Like `bridge.ts` this module imports nothing. `main/` reaches it for the codes,
 * `renderer/` reaches it for the keys, and a bundled renderer that pulled in a
 * module importing `electron` would fail at runtime rather than type-check -- the
 * same reason the bridge is shaped this way.
 *
 * What is deliberately *not* here: the translated strings. Those belong in the
 * catalogue. This module names the key; `@haruyuki/ui` owns the text.
 */

/**
 * What can go wrong in the shell itself.
 *
 * Frozen, and closed: every code is expected to acquire a message, and a code
 * with no message is a string that reaches a user untranslated. Adding one is a
 * contract change, not a refactor.
 */
export const SHELL_ERROR_CODES = [
  "APP_PROTOCOL_DENIED",
  "APP_PROTOCOL_NOT_FOUND",
  "BRIDGE_CHANNEL_DENIED",
  "SHELL_SETTINGS_CORRUPT",
  "ENGINE_PROBE_FAILED",
] as const;

/** One shell error code. */
export type ShellErrorCode = (typeof SHELL_ERROR_CODES)[number];

/**
 * The message key for each code.
 *
 * `satisfies Record<ShellErrorCode, string>` rather than a bare object, so a code
 * added to the list without a key here is a compile error at this line rather
 * than a missing translation discovered by a user.
 *
 * The keys live in the `error.shell.*` namespace the requirement names. They are
 * plain strings here, not typed as the catalogue's `MessageKey`, because this
 * module is imported by a sandboxed preload and a bundled main process as well as
 * the renderer -- pulling the catalogue's type in would pull the catalogue in.
 * `shell-error.test.ts` closes that gap by checking every key exists.
 */
export const SHELL_ERROR_MESSAGE_KEYS = {
  APP_PROTOCOL_DENIED: "error.shell.resourceDenied",
  APP_PROTOCOL_NOT_FOUND: "error.shell.resourceMissing",
  BRIDGE_CHANNEL_DENIED: "error.shell.bridgeDenied",
  SHELL_SETTINGS_CORRUPT: "error.shell.settingsCorrupt",
  ENGINE_PROBE_FAILED: "error.shell.engineUnavailable",
} as const satisfies Record<ShellErrorCode, string>;

/**
 * One classified failure.
 *
 * `detail` is for humans, `messageKey` is for the UI, and the two never merge:
 * the requirement is explicit that `detail` does not become a message key. A
 * failure reported with a code and a detail renders the code's message with the
 * detail as secondary text.
 */
export interface ShellError {
  readonly code: ShellErrorCode;
  /** English ASCII technical detail. Not translated, and nothing branches on it. */
  readonly detail: string;
  /** The i18n key the UI should render for this code. Always derived, never supplied. */
  readonly messageKey: string;
}

/**
 * The message key for one code.
 *
 * @param code the shell error code
 * @returns the i18n key the UI should render
 */
export function messageKeyOf(code: ShellErrorCode): string {
  return SHELL_ERROR_MESSAGE_KEYS[code];
}

/**
 * Build a classified shell error.
 *
 * Two parameters, not three: two callers reporting the same code must not pick
 * two different messages, and the way to guarantee that is to give them no
 * choice.
 *
 * @param code which failure this is
 * @param detail English ASCII detail for a human
 */
export function shellError(code: ShellErrorCode, detail: string): ShellError {
  return { code, detail, messageKey: messageKeyOf(code) };
}

/**
 * Whether a string is one of the shell error codes.
 *
 * For the boundary where a code arrives as data -- an IPC payload or a URL
 * parameter -- and has to be validated rather than trusted. A cast would let an
 * unknown code reach the catalogue lookup and render as a hole.
 *
 * @param value anything that claims to be a code
 */
export function isShellErrorCode(value: unknown): value is ShellErrorCode {
  return typeof value === "string" && (SHELL_ERROR_CODES as readonly string[]).includes(value);
}
