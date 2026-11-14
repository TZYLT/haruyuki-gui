/**
 * WCAG relative luminance and contrast.
 *
 * Kept in the package (not in a gate script) because both the theme gate and
 * the theme tests need it, and because a colour decision has to be checkable at
 * the point of definition rather than only after the gate runs.
 *
 * The formula is WCAG 2.1 section 1.4.3 / 1.4.11: linearise each sRGB channel,
 * weight by 0.2126 / 0.7152 / 0.0722, then (Llight + 0.05) / (Ldark + 0.05).
 */

/** A colour in the only form tokens may use: 3-, 6- or 8-digit hex. */
const HEX_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * @param value token value
 * @returns true when the value is a hex colour this module can measure
 */
export function isHexColor(value: string): boolean {
  return HEX_PATTERN.test(value);
}

/**
 * Expand a hex colour to its three 0-255 channels.
 *
 * Only the RGB channels are used; an 8-digit value's alpha is ignored because a
 * translucent foreground has no single contrast ratio. Theme values are opaque
 * by rule, so ignoring alpha cannot hide a violation.
 *
 * @param value hex colour
 * @returns red, green, blue
 */
export function parseHex(value: string): [number, number, number] {
  if (!isHexColor(value)) {
    throw new Error(`not a hex colour: ${value}`);
  }

  const body = value.slice(1);
  const full =
    body.length === 3
      ? body
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : body.slice(0, 6);

  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * @param channel 0-255 sRGB channel
 * @returns linearised channel in 0-1
 */
function linearise(channel: number): number {
  const scaled = channel / 255;

  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/**
 * @param value hex colour
 * @returns relative luminance in 0-1
 */
export function relativeLuminance(value: string): number {
  const [red, green, blue] = parseHex(value);

  return 0.2126 * linearise(red) + 0.7152 * linearise(green) + 0.0722 * linearise(blue);
}

/**
 * Contrast ratio between two opaque colours, always >= 1.
 *
 * @param foreground hex colour
 * @param background hex colour
 * @returns ratio in 1-21
 */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);

  return (lighter + 0.05) / (darker + 0.05);
}

/** Minimum ratios the palette contract fixes. */
export const MIN_RATIO_BODY_TEXT = 4.5;

/** Large text and non-text component boundaries share one threshold. */
export const MIN_RATIO_LARGE_TEXT_OR_ICON = 3;
