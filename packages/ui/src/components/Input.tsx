/**
 * Text input.
 *
 * Controlled only. The requirement is explicit that no component carries business
 * state, and an input that also holds a draft value would make "what is the
 * current value" have two answers.
 *
 * IME safety is not something this component can enforce -- it is a
 * property of not re-rendering on composition -- but what it must not do is
 * normalise or trim the value while the user is still composing. So the value is
 * passed through verbatim and `onChange` fires with exactly what the DOM had.
 *
 * The border sits on the wrapping element, not on the `<input>`, so a prefix icon
 * is inside the field's boundary and the focus ring wraps the whole thing. The
 * actual `<input>` is borderless and transparent, which is why `:focus-within`
 * drives the ring rather than `:focus`.
 */

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { ensureStyles } from "./styles.js";
import type { BaseProps } from "./types.js";

/** Props of {@link Input}. */
export interface InputProps
  extends
    BaseProps,
    Omit<
      InputHTMLAttributes<HTMLInputElement>,
      "className" | "style" | "value" | "onChange" | "prefix"
    > {
  /** Current value. Controlled. */
  value: string;
  /** Called with the raw value from the DOM, never normalised. */
  onChange: (value: string) => void;
  /** Renders the error border and marks the field invalid to assistive tech. */
  invalid?: boolean;
  /** Content before the field, typically an icon. */
  prefix?: ReactNode;
  /** Content after the field, typically a unit or a clear button. */
  suffix?: ReactNode;
}

/**
 * A text input.
 *
 * @param props input props
 * @returns the wrapping field element
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    value,
    onChange,
    invalid = false,
    disabled = false,
    prefix,
    suffix,
    className,
    style,
    "data-testid": testId,
    ...rest
  },
  ref,
): ReactElement {
  ensureStyles();

  const generatedId = useId();
  const fieldId = rest.id ?? generatedId;
  const classes = className === undefined ? "ui-input" : `ui-input ${className}`;

  return (
    <div
      className={classes}
      style={style}
      data-invalid={invalid ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      // On the wrapper, not the input: a caller addressing the field wants the
      // element that also carries the affixes and the invalid state.
      data-testid={testId}
    >
      {prefix === undefined ? null : <span className="ui-input__affix">{prefix}</span>}
      <input
        {...rest}
        ref={ref}
        id={fieldId}
        className="ui-input__field"
        value={value}
        disabled={disabled}
        aria-invalid={invalid ? true : undefined}
        onChange={(event) => {
          // The raw DOM value, untouched: trimming here would eat a trailing
          // space the user typed on purpose and break IME composition.
          onChange(event.target.value);
        }}
      />
      {suffix === undefined ? null : <span className="ui-input__affix">{suffix}</span>}
    </div>
  );
});
