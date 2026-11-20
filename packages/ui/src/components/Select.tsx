/**
 * Select.
 *
 * Single-select only. Base UI owns the floating positioning,
 * the roving focus, the typeahead and the ARIA wiring -- all of which are easy to
 * get 90% right by hand and impossible to get fully right, because the last 10%
 * is screen-reader behaviour on a moving popup.
 *
 * The value is controlled and may be `null`, which is what "nothing selected"
 * means. Using `""` for that would collide with an option whose value is the
 * empty string, and that collision shows up only when a caller actually has one.
 *
 * The popup is portalled to the body. That is not an implementation detail: a
 * select inside an `overflow: hidden` container would otherwise be clipped, which
 * is the single most common way a hand-rolled select breaks.
 */

import { Select as BaseSelect } from "@base-ui/react/select";
import type { ReactElement, ReactNode } from "react";

import { useT } from "../i18n/index.js";
import { Icon } from "../icons/index.js";
import { ensureStyles } from "./styles.js";
import type { BaseProps } from "./types.js";

/** One selectable option. */
export interface SelectOption {
  /** The value reported to the caller. */
  value: string;
  /** Visible text. */
  label: string;
  /** Disables this option only. */
  disabled?: boolean;
}

/** Props of {@link Select}. */
export interface SelectProps extends BaseProps {
  /** Selected value, or `null` when nothing is selected. Controlled. */
  value: string | null;
  /** Called with the newly selected value. */
  onChange: (value: string) => void;
  /** The options to offer. */
  options: readonly SelectOption[];
  /** Shown when nothing is selected. */
  placeholder?: string;
  /** Disables the whole control. */
  disabled?: boolean;
  /** Renders the error border and marks the control invalid. */
  invalid?: boolean;
  /** Accessible name. Required: a select with no name is unusable. */
  labelKey: Parameters<ReturnType<typeof useT>>[0];
  /** Extra content rendered after the options, for example a footer. */
  footer?: ReactNode;
}

/**
 * A single-select dropdown.
 *
 * @param props select props
 * @returns the select trigger and its popup
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  invalid = false,
  labelKey,
  footer,
  className,
  style,
  "data-testid": testId,
}: SelectProps): ReactElement {
  ensureStyles();

  const t = useT();
  // The base class is the prefix for every derived name.
  //
  // It used to be a single `classes` string that was *also* the prefix, so a
  // caller passing `className="wide"` produced `ui-select wide__trigger`: the
  // real `ui-select__trigger` class vanished and the trigger rendered with no
  // styling at all. The caller's class is appended to the trigger -- the element
  // that is the visible control -- and plays no part in any derived name.
  const BASE = "ui-select";
  const triggerClass = className === undefined ? `${BASE}__trigger` : `${BASE}__trigger ${className}`;
  const resolvedPlaceholder = placeholder ?? t("component.select.placeholder");

  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => {
        // base-ui reports `null` when the selection is cleared; the public
        // contract here is a string, so a clear is simply ignored rather than
        // forwarded as a value no caller expects.
        if (typeof next === "string") {
          onChange(next);
        }
      }}
      disabled={disabled}
      items={options.map((option) => ({ value: option.value, label: option.label }))}
    >
      <BaseSelect.Trigger
        className={triggerClass}
        style={style}
        aria-label={t(labelKey)}
        aria-invalid={invalid ? true : undefined}
        data-invalid={invalid ? "true" : undefined}
        data-testid={testId}
      >
        <BaseSelect.Value className={`${BASE}__value`} placeholder={resolvedPlaceholder} />
        <Icon name="chevronDown" />
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4}>
          <BaseSelect.Popup className={`${BASE}__popup`}>
            <BaseSelect.List>
              {options.length === 0 ? (
                // An empty popup is a dead end: nothing to pick, no explanation.
                // The message is a key because "no matching options" is exactly
                // the kind of short phrase every screen needs.
                <div className={`${BASE}__empty`}>{t("component.select.empty")}</div>
              ) : null}
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled === true}
                  className={`${BASE}__item`}
                >
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
            {footer === undefined ? null : footer}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
