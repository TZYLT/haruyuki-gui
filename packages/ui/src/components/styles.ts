/**
 * Component styles.
 *
 * One stylesheet, emitted as a string and injected once. Same mechanism as the
 * token layer, for the same reason: the package ships TypeScript source with no
 * bundler, so anything that depends on a CSS loader is unusable downstream.
 *
 * Why CSS at all rather than inline styles: `:hover`, `:focus-visible` and
 * `:disabled` cannot be expressed inline. Focus styling in particular is not
 * optional -- a keyboard user must be able to see where they are -- and a
 * solution that cannot express it is not a solution.
 *
 * Every value comes from a token. No component names a colour, a pixel size, a
 * radius or a z-index directly: that is what lets a theme change reach every
 * component, and it is what the token gate checks.
 *
 * Class names are prefixed `ui-` and are structural, not semantic: `ui-button`
 * describes the component, and modifiers live in `data-` attributes so a
 * consumer's own class cannot accidentally select a variant.
 */

import { installTokens } from "../tokens/index.js";

/** Marks the style element these rules live in, so injection stays idempotent. */
const STYLE_ELEMENT_ID = "haruyuki-ui-components";

/**
 * Focus ring.
 *
 * `:focus-visible` rather than `:focus` so a mouse click does not draw the ring
 * but a Tab does. The outline is not removed anywhere -- removing it without a
 * replacement is the single most common accessibility regression in a design
 * system.
 */
const FOCUS_RING = `
  outline: 2px solid var(--ui-color-accent-1);
  outline-offset: 2px;
`;

/** The shared control shape: both button and input size from the same tokens. */
const CONTROL_BASE = `
  font-family: var(--ui-font-family-body);
  /* A unitless line-height resolves against this element's font-size, which is
     what makes a Chinese and an English control the same height. */
  line-height: var(--ui-font-lineHeight-2);
  border-radius: var(--ui-radius-2);
  box-sizing: border-box;
`;

/** Button rules. Variants ride on a data attribute, not on a class modifier. */
const BUTTON_CSS = `
.ui-button {
  ${CONTROL_BASE}
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--ui-space-2);
  font-size: var(--ui-font-size-3);
  font-weight: var(--ui-font-weight-2);
  padding: var(--ui-space-3) var(--ui-space-6);
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background-color var(--ui-motion-duration-2) var(--ui-motion-easing-1),
    border-color var(--ui-motion-duration-2) var(--ui-motion-easing-1);
}

.ui-button[data-size="sm"] {
  font-size: var(--ui-font-size-2);
  padding: var(--ui-space-2) var(--ui-space-4);
}

.ui-button:focus-visible {
  ${FOCUS_RING}
}

.ui-button[data-variant="primary"] {
  background-color: var(--ui-color-accent-1);
  color: var(--ui-color-static-1);
  border-color: var(--ui-color-accent-1);
}

.ui-button[data-variant="primary"]:hover:not(:disabled) {
  background-color: var(--ui-color-accent-2);
  border-color: var(--ui-color-accent-2);
}

.ui-button[data-variant="secondary"] {
  background-color: var(--ui-color-surface-1);
  color: var(--ui-color-neutral-1);
  border-color: var(--ui-color-neutral-3);
}

.ui-button[data-variant="secondary"]:hover:not(:disabled) {
  background-color: var(--ui-color-surface-2);
}

.ui-button[data-variant="ghost"] {
  background-color: transparent;
  color: var(--ui-color-neutral-1);
  border-color: transparent;
}

.ui-button[data-variant="ghost"]:hover:not(:disabled) {
  background-color: var(--ui-color-surface-2);
}

.ui-button[data-variant="danger"] {
  background-color: var(--ui-color-danger-1);
  color: var(--ui-color-static-1);
  border-color: var(--ui-color-danger-1);
}

.ui-button[data-variant="danger"]:hover:not(:disabled) {
  background-color: var(--ui-color-danger-2);
  color: var(--ui-color-danger-1);
}

.ui-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ui-button[data-loading="true"] {
  cursor: progress;
}
`;

/** Input rules, including the invalid and prefixed/suffixed arrangements. */
const INPUT_CSS = `
.ui-input {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
  ${CONTROL_BASE}
  background-color: var(--ui-color-surface-1);
  border: 1px solid var(--ui-color-neutral-3);
  padding: var(--ui-space-2) var(--ui-space-4);
  transition: border-color var(--ui-motion-duration-2) var(--ui-motion-easing-1);
}

.ui-input:focus-within {
  ${FOCUS_RING}
}

.ui-input[data-invalid="true"] {
  border-color: var(--ui-color-danger-1);
}

.ui-input[data-disabled="true"] {
  background-color: var(--ui-color-surface-2);
  cursor: not-allowed;
  opacity: 0.7;
}

.ui-input__field {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ui-color-neutral-1);
  font-family: inherit;
  font-size: var(--ui-font-size-3);
  line-height: inherit;
  padding: 0;
}

.ui-input__field::placeholder {
  color: var(--ui-color-neutral-2);
}

.ui-input__affix {
  display: inline-flex;
  align-items: center;
  color: var(--ui-color-neutral-2);
  flex-shrink: 0;
}
`;

/** Switch rules. The track and thumb are spans; base-ui supplies the behaviour. */
const SWITCH_CSS = `
.ui-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--ui-space-3);
  cursor: pointer;
  border: none;
  background: none;
  padding: 0;
  font-family: var(--ui-font-family-body);
  font-size: var(--ui-font-size-3);
  line-height: var(--ui-font-lineHeight-2);
  color: var(--ui-color-neutral-1);
}

.ui-switch:focus-visible {
  ${FOCUS_RING}
  border-radius: var(--ui-radius-2);
}

.ui-switch[data-disabled] {
  cursor: not-allowed;
  opacity: 0.55;
}

.ui-switch__track {
  position: relative;
  display: inline-block;
  width: calc(var(--ui-space-8) * 1.6);
  height: var(--ui-space-7);
  border-radius: calc(var(--ui-space-7) / 2);
  background-color: var(--ui-color-neutral-3);
  transition: background-color var(--ui-motion-duration-2) var(--ui-motion-easing-1);
  flex-shrink: 0;
}

.ui-switch[data-checked] .ui-switch__track {
  background-color: var(--ui-color-accent-1);
}

.ui-switch__thumb {
  position: absolute;
  top: var(--ui-space-1);
  left: var(--ui-space-1);
  width: calc(var(--ui-space-7) - var(--ui-space-2) * 2);
  height: calc(var(--ui-space-7) - var(--ui-space-2) * 2);
  border-radius: 50%;
  background-color: var(--ui-color-static-1);
  transition: transform var(--ui-motion-duration-2) var(--ui-motion-easing-1);
}

.ui-switch[data-checked] .ui-switch__thumb {
  transform: translateX(calc(var(--ui-space-8) * 1.6 - var(--ui-space-7)));
}
`;

/** Tag rules: one chip, four tones. */
const TAG_CSS = `
.ui-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--ui-space-2);
  font-family: var(--ui-font-family-body);
  font-size: var(--ui-font-size-1);
  /* Unitless so the chip is the same height in every script. */
  line-height: var(--ui-font-lineHeight-2);
  padding: var(--ui-space-1) var(--ui-space-3);
  border-radius: var(--ui-radius-1);
  border: 1px solid transparent;
  max-width: 100%;
}

.ui-tag__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-tag[data-tone="neutral"] {
  background-color: var(--ui-color-surface-2);
  color: var(--ui-color-neutral-1);
  border-color: var(--ui-color-neutral-3);
}

.ui-tag[data-tone="accent"] {
  background-color: var(--ui-color-accent-3);
  color: var(--ui-color-accent-1);
  border-color: var(--ui-color-accent-1);
}

.ui-tag[data-tone="danger"] {
  background-color: var(--ui-color-danger-2);
  color: var(--ui-color-danger-1);
  border-color: var(--ui-color-danger-1);
}

.ui-tag[data-tone="success"] {
  background-color: var(--ui-color-success-2);
  color: var(--ui-color-success-1);
  border-color: var(--ui-color-success-1);
}

.ui-tag__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  border-radius: var(--ui-radius-1);
}

.ui-tag__remove:focus-visible {
  ${FOCUS_RING}
}
`;

/** Alert rules: an inline banner, not a floating one. */
const ALERT_CSS = `
.ui-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--ui-space-4);
  font-family: var(--ui-font-family-body);
  font-size: var(--ui-font-size-3);
  line-height: var(--ui-font-lineHeight-2);
  padding: var(--ui-space-5);
  border-radius: var(--ui-radius-3);
  border: 1px solid transparent;
}

.ui-alert__icon {
  flex-shrink: 0;
  display: inline-flex;
  padding-top: var(--ui-space-1);
}

.ui-alert__body {
  flex: 1;
  min-width: 0;
}

.ui-alert__title {
  font-weight: var(--ui-font-weight-3);
  margin-bottom: var(--ui-space-1);
}

.ui-alert__content {
  color: inherit;
}

.ui-alert__dismiss {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  padding: var(--ui-space-1);
  cursor: pointer;
  color: inherit;
  border-radius: var(--ui-radius-1);
}

.ui-alert__dismiss:focus-visible {
  ${FOCUS_RING}
}

.ui-alert[data-tone="info"] {
  background-color: var(--ui-color-info-2);
  color: var(--ui-color-info-1);
  border-color: var(--ui-color-info-1);
}

.ui-alert[data-tone="success"] {
  background-color: var(--ui-color-success-2);
  color: var(--ui-color-success-1);
  border-color: var(--ui-color-success-1);
}

.ui-alert[data-tone="warning"] {
  background-color: var(--ui-color-warning-2);
  color: var(--ui-color-warning-1);
  border-color: var(--ui-color-warning-1);
}

.ui-alert[data-tone="danger"] {
  background-color: var(--ui-color-danger-2);
  color: var(--ui-color-danger-1);
  border-color: var(--ui-color-danger-1);
}
`;

/**
 * The full component stylesheet.
 *
 * Assembled from the per-component blocks above so a reader can find one
 * component's rules without scrolling past the others, while the injector still
 * sees a single string.
 */
export const COMPONENT_CSS = [BUTTON_CSS, INPUT_CSS, SWITCH_CSS, TAG_CSS, ALERT_CSS].join("\n");

/**
 * Install the token sheet and the component sheet, once each.
 *
 * Called from every component's render. The cost is one `getElementById` after
 * the first call, which is cheaper than making every consumer remember a setup
 * call -- and a consumer who forgets it would get an unstyled, unusable screen.
 *
 * Tokens are installed first because the component rules read them; ordering does
 * not actually matter for CSS variables, but it matters for a human reading the
 * document head.
 *
 * @param doc target document, defaults to the ambient one
 * @returns the style element holding the component rules
 */
export function ensureStyles(doc?: Document): HTMLStyleElement {
  const target = doc ?? globalThis.document;

  if (target === undefined) {
    throw new Error("ensureStyles needs a Document; none was passed and none is ambient");
  }

  installTokens(target);

  const existing = target.getElementById(STYLE_ELEMENT_ID);

  if (existing !== null) {
    return existing as HTMLStyleElement;
  }

  const style = target.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = COMPONENT_CSS;
  target.head.appendChild(style);

  return style;
}
