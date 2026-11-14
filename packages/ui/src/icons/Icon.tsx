/**
 * The icon component.
 *
 * Two accessibility modes, decided by whether a label key was supplied:
 *
 * - **decorative** (no `labelKey`): `aria-hidden="true"`. The icon repeats
 *   information already in text next to it -- a trash glyph beside the word
 *   "Delete" -- so announcing it would make a screen reader say it twice.
 * - **semantic** (`labelKey` given): `role="img"` plus `aria-label` from the key.
 *   The icon *is* the control's only content, so it needs a name.
 *
 * The label is a **message key**, not a string, because every accessible name is
 * translated text, and those names have to come from `a11y.*`. Taking a string
 * would let a caller hard-code English and no gate could tell.
 *
 * Size and colour come from tokens: the icon never names a pixel value or a
 * colour, which is what lets it follow the theme.
 */

import type { CSSProperties, ReactElement } from "react";

import { useT } from "../i18n/index.js";
import type { MessageKey } from "../i18n/index.js";
import type { TokenName } from "../tokens/index.js";
import { ICONS, type IconName } from "./registry.js";

/** Props of {@link Icon}. */
export interface IconProps {
  /** Which icon to draw. */
  name: IconName;
  /**
   * Pixel size override.
   *
   * Absent means the icon inherits the current font size, which is what makes an
   * icon sit optically level with the text it accompanies. An explicit number is
   * for the rare standalone case.
   */
  size?: number;
  /** Accessible name. Present means semantic, absent means decorative. */
  labelKey?: MessageKey;
  /** Extra class names, merged onto the svg. */
  className?: string;
}

/**
 * The token an icon takes its colour from.
 *
 * `neutral-2` is the secondary tier: it clears the 4.5:1 text threshold, which
 * covers the 3:1 a non-text glyph needs, and it is the tier a bare glyph belongs
 * in rather than the primary text colour.
 */
const ICON_COLOR_TOKEN: TokenName = "--ui-color-neutral-2";

/**
 * Render an icon.
 *
 * @param props icon props
 * @returns the svg element
 */
export function Icon({ name, size, labelKey, className }: IconProps): ReactElement {
  const t = useT();
  const definition = ICONS[name];
  const Glyph = definition.component;

  const style: CSSProperties = {
    // `currentColor` rather than a direct token read: it lets a parent set the
    // colour once (a danger button's icon turns red with the button) while the
    // default still comes from the token layer.
    color: `var(${ICON_COLOR_TOKEN})`,
    flexShrink: 0,
  };

  const accessibility =
    labelKey === undefined
      ? ({ "aria-hidden": true } as const)
      : ({ role: "img", "aria-label": t(labelKey) } as const);

  return (
    <Glyph
      size={size ?? "1em"}
      strokeWidth={2}
      className={className}
      style={style}
      focusable="false"
      {...accessibility}
    />
  );
}
