/**
 * Error state.
 *
 * Same "draws, does not decide" split as the empty state, with one difference that
 * matters: it is `role="alert"`.
 *
 * An error that appears silently after a retry is the failure mode this
 * component exists to prevent. A screen-reader user who pressed "retry" and got an
 * unchanged screen has no way to know the retry failed, so this announces.
 *
 * The retry button's label is a translated key, not a caller-supplied string,
 * because "try again" is the kind of word every screen needs and none should
 * retranslate.
 */

import type { ReactElement } from "react";

import { useT } from "../i18n/index.js";
import { Button } from "./Button.js";
import { Icon } from "../icons/index.js";
import type { IconName } from "../icons/index.js";
import { ensureStyles } from "./styles.js";
import type { BaseProps } from "./types.js";

/** Props of {@link ErrorState}. */
export interface ErrorStateProps extends BaseProps {
  /** Short heading, already translated by the caller. */
  title: string;
  /** Optional technical detail. Shown as secondary text, never as the heading. */
  detail?: string;
  /** When present, renders a retry button. */
  onRetry?: () => void;
  /** Icon above the heading. Defaults to a warning glyph. */
  icon?: IconName;
}

/**
 * An error state.
 *
 * @param props error state props
 * @returns the state block
 */
export function ErrorState({
  title,
  detail,
  onRetry,
  icon = "warning",
  className,
  style,
  "data-testid": testId,
}: ErrorStateProps): ReactElement {
  ensureStyles();

  const t = useT();
  const classes = className === undefined ? "ui-state" : `ui-state ${className}`;

  return (
    <div
      className={classes}
      style={style}
      // Unlike the empty state, this interrupts: the user acted and it failed.
      role="alert"
      data-tone="danger"
      data-testid={testId}
    >
      <span className="ui-state__icon">
        <Icon name={icon} size={32} />
      </span>
      <p className="ui-state__title">{title}</p>
      {detail === undefined ? null : <p className="ui-state__description">{detail}</p>}
      {onRetry === undefined ? null : (
        <div className="ui-state__actions">
          <Button variant="secondary" iconLeft="refresh" onClick={onRetry}>
            {t("page.error.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
