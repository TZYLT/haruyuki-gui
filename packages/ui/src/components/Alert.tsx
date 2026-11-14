/**
 * Alert.
 *
 * An inline banner, not a floating one. The distinction matters: a floating
 * alert steals focus or covers content, and this component is for a message that
 * belongs in the flow of the page.
 *
 * The role depends on the tone, and that is the point of this component rather
 * than a styled div:
 *
 * - `danger` and `warning` render `role="alert"`, which interrupts the screen
 *   reader because the user needs to know now.
 * - `info` and `success` render `role="status"`, which waits for a pause because
 *   interrupting for a confirmation is rude.
 *
 * Dismissal is a real button with a translated accessible name, not a clickable
 * glyph.
 */

import type { ReactElement, ReactNode } from "react";

import { useT } from "../i18n/index.js";
import { Icon } from "../icons/index.js";
import type { IconName } from "../icons/index.js";
import { ensureStyles } from "./styles.js";
import type { BaseProps } from "./types.js";

/** Severity, and the only prop that changes the ARIA role. */
export type AlertTone = "info" | "success" | "warning" | "danger";

/** The icon each tone shows. Chosen by tone so a caller cannot pair them wrongly. */
const TONE_ICONS: Record<AlertTone, IconName> = {
  info: "info",
  success: "check",
  warning: "warning",
  danger: "warning",
};

/** Props of {@link Alert}. */
export interface AlertProps extends BaseProps {
  /** Severity. Decides both the colour and the ARIA role. */
  tone: AlertTone;
  /** Optional heading, rendered above the content. */
  title?: string;
  /** Body content. */
  children?: ReactNode;
  /** When present, renders a dismiss button. */
  onDismiss?: () => void;
}

/**
 * An inline alert.
 *
 * @param props alert props
 * @returns the alert element
 */
export function Alert({
  tone,
  title,
  children,
  onDismiss,
  className,
  style,
  "data-testid": testId,
}: AlertProps): ReactElement {
  ensureStyles();

  const t = useT();
  const classes = className === undefined ? "ui-alert" : `ui-alert ${className}`;
  const interrupts = tone === "danger" || tone === "warning";

  return (
    <div
      className={classes}
      style={style}
      data-tone={tone}
      data-testid={testId}
      role={interrupts ? "alert" : "status"}
    >
      <span className="ui-alert__icon">
        {/* The tone already conveys the meaning in text; an announced icon would
            repeat it. */}
        <Icon name={TONE_ICONS[tone]} size={16} />
      </span>
      <div className="ui-alert__body">
        {title === undefined ? null : <div className="ui-alert__title">{title}</div>}
        {children === undefined ? null : <div className="ui-alert__content">{children}</div>}
      </div>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          className="ui-alert__dismiss"
          aria-label={t("component.alert.dismiss")}
          title={t("component.alert.dismiss")}
          onClick={onDismiss}
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}
