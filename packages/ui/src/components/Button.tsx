/**
 * Button.
 *
 * Fully controlled: no internal state for the visual variant, the size or the
 * disabled flag. `loading` is the one apparent exception, and it is not: loading
 * is a value the caller owns, and the only thing this component does with it is
 * refuse the click and say so to assistive technology.
 *
 * A disabled button is `disabled` (not clickable, not focusable) rather than a
 * clickable element with `aria-disabled`. For a *submit* control that is the
 * correct trade: a disabled submit button cannot be pressed twice, and the
 * reason it is disabled is explained by text next to it, not by the button.
 *
 * Icons are composable nodes rather than an `icon` prop taking a name: the caller
 * already knows which icon it wants and whether it is decorative, and threading a
 * name through would duplicate the icon layer's API here.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactElement } from "react";

import { Icon } from "../icons/index.js";
import type { IconName } from "../icons/index.js";
import { ensureStyles } from "./styles.js";
import type { BaseProps } from "./types.js";

/** Visual weight. Four, no more: a fifth would be indistinguishable. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Two sizes. A third would need its own token step to be meaningful. */
export type ButtonSize = "md" | "sm";

/** Props of {@link Button}. */
export interface ButtonProps
  extends
    BaseProps,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "children"> {
  /** Visual weight. Defaults to `primary`. */
  variant?: ButtonVariant;
  /** Height and padding step. Defaults to `md`. */
  size?: ButtonSize;
  /** Shows a spinner and refuses interaction without unmounting the button. */
  loading?: boolean;
  /** Icon drawn before the label. */
  iconLeft?: IconName;
  /** Icon drawn after the label. */
  iconRight?: IconName;
  /** Visible label. Required unless an icon carries the accessible name. */
  children?: React.ReactNode;
}

/**
 * A button.
 *
 * @param props button props
 * @returns the button element
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    iconLeft,
    iconRight,
    disabled = false,
    className,
    style,
    children,
    type = "button",
    ...rest
  },
  ref,
): ReactElement {
  ensureStyles();

  const classes = className === undefined ? "ui-button" : `ui-button ${className}`;

  return (
    <button
      {...rest}
      ref={ref}
      // `button` is the default on purpose: a `<button>` inside a form submits
      // it unless told otherwise, and that default has caused more accidental
      // submissions than any other HTML decision.
      type={type}
      className={classes}
      style={style}
      disabled={disabled || loading}
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading ? true : undefined}
    >
      {iconLeft === undefined ? null : <Icon name={iconLeft} />}
      {children}
      {iconRight === undefined ? null : <Icon name={iconRight} />}
    </button>
  );
});
