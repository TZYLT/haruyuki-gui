/**
 * The shell's own settings: theme, locale, window geometry.
 *
 * `userData/shell-settings.json` holds four things and nothing else. It is *not*
 * the engine's `settings.json` and not C4's `LayoutDoc`; conflating them is how
 * a window position ends up in a document the renderer owns.
 *
 * Two rules shape this module:
 *
 *   Read leniently, write strictly. The file is user-editable and survives
 *   version changes, so every field is validated on read and a bad field falls
 *   back to its default instead of failing the launch. A settings file that
 *   makes the app unopenable is worse than one that forgets where the window was.
 *
 *   No schema library. Four fields with three enums between them do not justify
 *   a dependency, and a hand-written parser is testable without one.
 */

import path from "node:path";

/** Theme mode, matching the token layer's attribute values. */
export const THEME_MODES = ["light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Contrast level, matching the token layer. */
export const CONTRAST_LEVELS = ["normal", "high"] as const;
export type ContrastLevel = (typeof CONTRAST_LEVELS)[number];

/** The locales the catalogue ships. An unsupported tag resolves to the fallback. */
export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** The fallback locale, matching `@haruyuki/ui/i18n/core`. */
export const FALLBACK_LOCALE: Locale = "en";

/** Window geometry in DIP, plus whether it was maximised. */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

/**
 * The settings file format this build understands.
 *
 * A number rather than a string: the only question ever asked of it is "is the
 * file newer than me", and a number answers that without a comparison table.
 */
export const SETTINGS_VERSION = 1 as const;

/**
 * Everything the shell persists.
 *
 * `locale` is `null` when the user has never chosen one. That null is load
 * bearing, not a missing value: it is what tells the next launch to follow the
 * operating system. The first version stored `"en"` as the default, which made
 * `chooseLocale`'s system-locale branch unreachable -- every first launch on a
 * Chinese machine opened in English, and the requirement that a first launch
 * speak the system's language was quietly false.
 */
export interface ShellSettings {
  /** The format version this document was written as. */
  version: typeof SETTINGS_VERSION;
  theme: ThemeMode;
  contrast: ContrastLevel;
  /** The user's choice, or `null` to follow the OS locale. */
  locale: Locale | null;
  window: WindowState | null;
}

/**
 * A settings document together with the answer for what may be done with it.
 *
 * Reading and deciding are one step because they cannot be separated usefully: a
 * caller that took the values but not the verdict would write a downgraded file
 * the moment the window moved. The verdict is the point.
 */
export interface SettingsRead {
  /** The parsed values, safe to use whatever the verdict. */
  readonly settings: ShellSettings;
  /**
   * Whether this build may write the file back.
   *
   * False when the file declares a version this build does not know. Writing then
   * would silently downgrade a newer document: fields added by a later version
   * are not in this build's `ShellSettings`, so `serializeSettings` would drop
   * them, and the user's next launch would find them gone. Reading is still fine
   * -- unknown fields are ignored, known ones are validated -- so the values are
   * returned and only the write is refused.
   */
  readonly writable: boolean;
  /** The version found on disk, or `null` when the document was unusable. */
  readonly foundVersion: number | null;
  /**
   * Whether the document existed but could not be understood.
   *
   * Distinguished from "there was no document" because they are different events
   * to a user: a first launch is normal, a corrupt file means preferences were
   * silently lost and something is writing it badly. Collapsing the two is why a
   * half-written file can go unnoticed until someone asks why settings never
   * stick.
   */
  readonly corrupt: boolean;
}

/**
 * Minimum size a restored window may have. Below this the user cannot reach the chrome.
 *
 * These are the requirement's numbers (`D1-Q27`: 最小 1024×700), not a value
 * invented here. The first version had 480×360, which nothing reconciled with
 * the requirement and nothing tested -- the tests compared against the constant,
 * so they pinned the mistake rather than catching it. `settings.test.ts` now
 * asserts these literals, which is the only way a constant can disagree with a
 * document and fail.
 */
export const MIN_WINDOW_WIDTH = 1024;
export const MIN_WINDOW_HEIGHT = 700;

/** The defaults: no window state, so the first launch centers the window. */
export const DEFAULT_SETTINGS: ShellSettings = {
  version: SETTINGS_VERSION,
  theme: "light",
  contrast: "normal",
  // `null`, not the fallback locale: see {@link ShellSettings.locale}.
  locale: null,
  window: null,
};

/**
 * The settings file path inside `userData`.
 *
 * Exported so the log module and the tests agree on the file name, and so D2 can
 * point at the same directory without inventing a second one.
 *
 * @param userData the directory Electron reports for this app
 */
export function settingsPath(userData: string): string {
  return path.join(userData, "shell-settings.json");
}

/** Pick the first member of `allowed` that equals `value`, else the fallback. */
function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Parse a locale, keeping "never chosen" distinct from "chose English".
 *
 * A string that is not a shipped locale is a *choice that is no longer
 * available* -- a locale dropped between versions, or a hand-edited file -- so it
 * falls back to the fallback locale rather than reverting to the OS. Only a truly
 * absent value means "ask the system".
 */
function parseLocale(value: unknown): Locale | null {
  if (value === undefined || value === null) return null;

  return oneOf(SUPPORTED_LOCALES, value, FALLBACK_LOCALE);
}

/** A finite number, or the fallback. `JSON.parse` can yield `null` and `NaN` cannot appear. */
function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Parse a window state, or refuse it entirely.
 *
 * Refusal is all-or-nothing on purpose: a rectangle with one bad field is not a
 * window the user had, and completing it with a default would put the window
 * somewhere they never chose. A refused state falls back to centering, which is
 * the same thing a first launch does.
 */
function parseWindow(value: unknown): WindowState | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const width = finite(record["width"], Number.NaN);
  const height = finite(record["height"], Number.NaN);
  const x = finite(record["x"], Number.NaN);
  const y = finite(record["y"], Number.NaN);

  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT) return null;

  return { x, y, width, height, maximized: record["maximized"] === true };
}

/**
 * Parse the settings document.
 *
 * Never throws and never returns a partial object: a missing, empty, truncated or
 * hostile file yields the defaults. `JSON.parse` throwing is the common case (a
 * crash mid-write leaves half a document), so it is not an error path that
 * deserves a log line of its own.
 *
 * @param raw the file contents, or an empty string
 */
export function parseSettings(raw: string): ShellSettings {
  return readSettings(raw).settings;
}

/**
 * Parse the settings document and decide whether it may be written back.
 *
 * The version rule (`D1-Q09`): a document whose `version` this build does not
 * know is read but never written. That covers the only case that matters in
 * practice -- a newer build wrote the file, then the user opened an older one.
 * Writing would drop the fields this build cannot represent, and the newer build
 * would find them gone. Refusing the write costs the user one window position;
 * allowing it costs them whatever the newer build had stored.
 *
 * A *missing* version is treated as current, not as unknown. Every file written
 * before this field existed is by definition version 1 -- it was written by this
 * build -- and refusing to write those would strand every existing install.
 * A version *below* current would need a migration to be meaningful; there is
 * nothing to migrate from yet, so the only existing value is 1 and the branch
 * is left as a plain equality test rather than an invented ladder.
 *
 * @param raw the file contents, or an empty string
 */
export function readSettings(raw: string): SettingsRead {
  const fallback: SettingsRead = {
    settings: { ...DEFAULT_SETTINGS },
    writable: true,
    foundVersion: null,
    // An empty file is not corrupt: it is a file that was created and not yet
    // written, or a first launch that touched it.
    corrupt: false,
  };

  if (raw.trim() === "") return fallback;

  const corrupt = (): SettingsRead => ({ ...fallback, corrupt: true });

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return corrupt();
  }

  if (typeof parsed !== "object" || parsed === null) return corrupt();

  // An array is an object to `typeof`, and would otherwise fall through to the
  // field reads below, where every `record[...]` is `undefined` and the result is
  // silently the defaults. That is a corrupt document reported as a clean one.
  if (Array.isArray(parsed)) return corrupt();

  const record = parsed as Record<string, unknown>;

  // Only a positive integer is a version. `"1"`, `1.5` and `null` are not
  // versions this build wrote, and guessing at them is how a parser accepts a
  // document it does not understand.
  const rawVersion = record["version"];
  const foundVersion =
    typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion > 0
      ? rawVersion
      : null;

  return {
    settings: {
      version: SETTINGS_VERSION,
      theme: oneOf(THEME_MODES, record["theme"], DEFAULT_SETTINGS.theme),
      contrast: oneOf(CONTRAST_LEVELS, record["contrast"], DEFAULT_SETTINGS.contrast),
      locale: parseLocale(record["locale"]),
      window: parseWindow(record["window"]),
    },
    // Missing means "written before the field existed", i.e. by this build.
    writable: foundVersion === null || foundVersion <= SETTINGS_VERSION,
    foundVersion,
    corrupt: false,
  };
}

/**
 * Serialise the settings document.
 *
 * Key order is fixed so a diff of two settings files is readable, and the output
 * ends with a newline so the file is a text file. `version` comes first: it is
 * the field a reader has to interpret before any other.
 */
export function serializeSettings(settings: ShellSettings): string {
  const document = {
    version: SETTINGS_VERSION,
    theme: settings.theme,
    contrast: settings.contrast,
    locale: settings.locale,
    window:
      settings.window === null
        ? null
        : {
            x: Math.round(settings.window.x),
            y: Math.round(settings.window.y),
            width: Math.round(settings.window.width),
            height: Math.round(settings.window.height),
            maximized: settings.window.maximized,
          },
  };

  return JSON.stringify(document, null, 2) + "\n";
}

/** A display rectangle, in DIP. */
export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Whether enough of a window rectangle is on some display to be usable.
 *
 * This exists because the persisted coordinates are display-relative facts that
 * outlive the display layout: unplug a monitor, change the scale factor, and the
 * saved rectangle can point at a place that no longer exists. Restoring it
 * verbatim produces a window the user cannot find and cannot move.
 *
 * The test is deliberately loose -- a window with a grab handle visible is
 * usable, even if most of it is off-screen. Requiring the whole rectangle would
 * reject the legitimate case of a window deliberately pushed to one edge.
 *
 * @param window the persisted rectangle
 * @param displays every display's work area, in DIP
 */
export function isWindowVisible(
  window: { x: number; y: number; width: number; height: number },
  displays: readonly DisplayBounds[],
): boolean {
  // Enough of the title bar to grab, and enough of the window to see.
  const REQUIRED_VISIBLE = 48;

  for (const display of displays) {
    const overlapX =
      Math.min(window.x + window.width, display.x + display.width) - Math.max(window.x, display.x);
    const overlapY =
      Math.min(window.y + window.height, display.y + display.height) -
      Math.max(window.y, display.y);

    if (overlapX >= REQUIRED_VISIBLE && overlapY >= REQUIRED_VISIBLE) return true;
  }

  return false;
}
