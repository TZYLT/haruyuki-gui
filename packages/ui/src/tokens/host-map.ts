/**
 * Adapter: map a host's theme variables onto this package's tokens.
 *
 * The two shells style differently. The desktop shell owns its own palette; the
 * VSCode extension is embedded in an editor that publishes `--vscode-*` variables
 * and expects its webviews to follow the user's editor theme. Without an adapter
 * the extension would render in this package's colours and look like a foreign
 * panel inside its own editor.
 *
 * The adapter is a **mapping**, not a second theme system: it reads host variables
 * and writes our slots, so components keep referencing `--ui-*` and never learn
 * which shell they are in. That is the property the requirement cares about
 * the values change, the component code does not.
 *
 * A slot whose host variable is absent keeps its own value. Falling back to an
 * empty string would blank the colour and is worse than a slightly off-theme
 * panel, so absence is treated as "the host has no opinion".
 */

import { THEME_MODE_ATTRIBUTE, THEME_CONTRAST_ATTRIBUTE } from "./slots.js";
import type { TokenName } from "./slots.js";

/**
 * Host variable name to token slot.
 *
 * Only the slots the editor actually has a meaningful equivalent for. Mapping all
 * seventy-odd slots would invent correspondences that do not exist -- the editor
 * has no opinion about diff backgrounds, and pretending it does is worse than
 * leaving ours in place.
 */
export const VSCODE_TOKEN_MAP = {
  "--ui-color-surface-1": "--vscode-editor-background",
  "--ui-color-surface-2": "--vscode-sideBar-background",
  "--ui-color-surface-3": "--vscode-editorWidget-background",
  "--ui-color-neutral-1": "--vscode-editor-foreground",
  "--ui-color-neutral-2": "--vscode-descriptionForeground",
  "--ui-color-neutral-3": "--vscode-panel-border",
  "--ui-color-accent-1": "--vscode-textLink-foreground",
  "--ui-color-danger-1": "--vscode-errorForeground",
  "--ui-color-success-1": "--vscode-testing-iconPassed",
  "--ui-color-warning-1": "--vscode-editorWarning-foreground",
  "--ui-color-info-1": "--vscode-editorInfo-foreground",
  "--ui-font-family-body": "--vscode-font-family",
  "--ui-font-size-3": "--vscode-font-size",
} as const satisfies Partial<Record<TokenName, string>>;

/** A slot the adapter can map. */
export type MappedSlot = keyof typeof VSCODE_TOKEN_MAP;

/**
 * Read a custom property from an element.
 *
 * @param host element carrying the host variables
 * @param name variable name including the leading `--`
 * @returns the trimmed value, or an empty string when unset
 */
function readVariable(host: Element, name: string): string {
  return getComputedStyle(host).getPropertyValue(name).trim();
}

/**
 * Map host variables onto token slots.
 *
 * Writes each mapped slot onto the given element as an inline custom property, so
 * the value wins over the stylesheet's own rule without rewriting it. Returns the
 * slots that were actually mapped, which is what a test asserts on: a mapping that
 * silently produced nothing would otherwise look like success.
 *
 * @param host element that carries the host variables
 * @param target element to write the tokens onto, defaults to `host`
 * @returns the slots that received a value
 */
export function applyHostTokens(host: Element, target?: Element): MappedSlot[] {
  const destination = target ?? host;
  const applied: MappedSlot[] = [];

  for (const [slot, hostVariable] of Object.entries(VSCODE_TOKEN_MAP)) {
    const value = readVariable(host, hostVariable);

    if (value === "") continue;

    (destination as HTMLElement).style.setProperty(slot, value);
    applied.push(slot as MappedSlot);
  }

  return applied;
}

/**
 * Decide the theme combination a host implies.
 *
 * The editor publishes its kind as a class on `body`. High contrast is a separate
 * kind, and normal is the fallback -- which is the same default the token layer
 * uses, so an unrecognised host gets a defined theme rather than none.
 *
 * @param host element carrying the host's kind class
 * @returns the combination to apply
 */
export function hostThemeCombination(host: Element): {
  mode: "light" | "dark";
  contrast: "normal" | "high";
} {
  const classes = host.classList;
  const dark = classes.contains("vscode-dark") || classes.contains("vscode-high-contrast");
  const high =
    classes.contains("vscode-high-contrast") || classes.contains("vscode-high-contrast-light");

  return { mode: dark ? "dark" : "light", contrast: high ? "high" : "normal" };
}

/**
 * The attributes a host theme maps to.
 *
 * Exported so a host does not have to reach into the token layer's constants to
 * know which two attributes to set.
 */
export const HOST_THEME_ATTRIBUTES = {
  mode: THEME_MODE_ATTRIBUTE,
  contrast: THEME_CONTRAST_ATTRIBUTE,
} as const;
