/**
 * Tag.
 *
 * A chip with optional removal. When `onClose` is present the tag renders a
 * *button* for removal, not a clickable span: a span with an `onClick` is
 * unreachable by keyboard and invisible to a screen reader as an action.
 *
 * The remove button's accessible name comes from a message key, composed with the
 * tag's own text via ICU interpolation rather than by concatenating strings --
 * concatenation is wrong because word order differs between languages.
 */

import type { ReactElement } from "react";

import { useT } from "../i18n/index.js";
import { Icon } from "../icons/index.js";
import { ensureStyles } from "./styles.js";
import type { BaseProps } from "./types.js";

/** Colour intent. Four tones, matching the status families that have tokens. */
export type TagTone = "neutral" | "accent" | "danger" | "success";

/** Props of {@link Tag}. */
export interface TagProps extends BaseProps {
  /** Visible text. */
  text: string;
  /** Colour intent. Defaults to `neutral`. */
  tone?: TagTone;
  /** When present, renders a remove button. */
  onClose?: () => void;
  /** Disables the remove button without hiding it. */
  closeDisabled?: boolean;
}

/**
 * A tag chip.
 *
 * @param props tag props
 * @returns the tag element
 */
export function Tag({
  text,
  tone = "neutral",
  onClose,
  closeDisabled = false,
  className,
  style,
  "data-testid": testId,
}: TagProps): ReactElement {
  ensureStyles();

  const t = useT();
  const classes = className === undefined ? "ui-tag" : `ui-tag ${className}`;

  return (
    <span className={classes} style={style} data-tone={tone} data-testid={testId}>
      <span className="ui-tag__text">{text}</span>
      {onClose === undefined ? null : (
        <button
          type="button"
          className="ui-tag__remove"
          // The accessible name is the translated verb, and the tag text is
          // passed as an argument so a language that puts the object first can
          // order it correctly. `component.tag.remove` carries no argument today;
          // the title attribute carries the specific label instead.
          aria-label={t("component.tag.remove")}
          title={t("component.tag.remove")}
          disabled={closeDisabled}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      )}
    </span>
  );
}
