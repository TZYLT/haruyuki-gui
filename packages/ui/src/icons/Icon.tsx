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
 * Render an icon.
 *
 * The colour is deliberately **not** set here. Lucide's icons draw with
 * `currentColor`, so an icon inside a button inherits the button's text colour and
 * a danger button's icon turns with it. Setting a token directly -- which this
 * component used to do -- overrode that: a delete icon rendered in
 * `--ui-color-neutral-2` grey on a red danger button, which is both ugly and a
 * contrast regression no token check could see, because the token itself is fine.
 * Found by looking at a screenshot, not by a test.
 *
 * A caller that wants a standalone colour sets it on its own wrapper; a bare icon
 * outside any coloured context still lands in the surrounding text colour, which
 * is the right default.
 *
 * @param props icon props
 * @returns the svg element
 */
export function Icon({ name, size, labelKey, className }: IconProps): ReactElement {
  const t = useT();
  const definition = ICONS[name];
  const Glyph = definition.component;

  const style: CSSProperties = {
    // Only layout. Colour comes from `currentColor` via the parent.
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
