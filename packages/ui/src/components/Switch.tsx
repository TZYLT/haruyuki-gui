/**
 * Switch.
 *
 * Base UI supplies the behaviour that is genuinely hard: the hidden native input
 * that makes the control submit with a form, keyboard activation, and the ARIA
 * wiring between the root and the thumb. This file supplies the appearance and
 * the label.
 *
 * A label is required, not optional. Base UI will render a switch with no
 * accessible name, and a switch with no name is unusable with a screen reader --
 * so the prop is required rather than merely documented.
 *
 * Controlled: `checked` and `onChange` both come from the caller.
 *
 * The callback is named `onChange`, matching FZ §6.4, rather than base-ui's
 * `onCheckedChange`. Base UI's name is more precise -- a switch has a state, not a
 * value -- but the frozen surface is the public contract and every other control
 * in this package calls its callback `onChange`, so a divergent name here would be
 * the one exception a consumer has to remember.
 */

import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ReactElement } from "react";

import { ensureStyles } from "./styles.js";
import type { BaseProps } from "./types.js";

/** Props of {@link Switch}. */
export interface SwitchProps extends BaseProps {
  /** Current state. Controlled. */
  checked: boolean;
  /** Called with the requested state. */
  onChange: (checked: boolean) => void;
  /** Visible and accessible label. Required. */
  label: string;
  /** Disables interaction and marks the control disabled. */
  disabled?: boolean;
  /** Id for the underlying control, when a caller needs to address it. */
  id?: string;
}

/**
 * An on/off switch.
 *
 * @param props switch props
 * @returns the switch element
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  id,
  className,
  style,
  "data-testid": testId,
}: SwitchProps): ReactElement {
  ensureStyles();

  const classes = className === undefined ? "ui-switch" : `ui-switch ${className}`;

  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={(next) => {
        onChange(next);
      }}
      disabled={disabled}
      id={id}
      className={classes}
      style={style}
      data-testid={testId}
    >
      <BaseSwitch.Thumb className="ui-switch__track">
        <span className="ui-switch__thumb" />
      </BaseSwitch.Thumb>
      {/* The text is inside the root so it is part of the control's accessible
          name, and clicking it toggles the switch -- which is what a user
          expects from a label beside a control. */}
      <span>{label}</span>
    </BaseSwitch.Root>
  );
}
