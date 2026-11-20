/**
 * Empty state.
 *
 * **Draws, does not decide.** The requirement is explicit: whether an empty
 * result is worth an empty state -- as opposed to
 * nothing, or a different message -- is a decision the page makes. This component
 * therefore has no `isEmpty`, no `items.length` check and no timing logic; it
 * renders what it is given, when it is given.
 *
 * The title is a plain string rather than a message key because the caller already
 * has the wording, usually from its own `page.*` namespace. Forcing a key here
 * would make a page define a key for every empty variant it has.
 *
 * `role="status"` is deliberate: an empty state often appears after a search, and
 * a screen-reader user who gets no feedback would reasonably think the search
 * failed. It is a status, not an alert -- it is information, not an emergency.
 */

import type { ReactElement, ReactNode } from "react";

import { Icon } from "../icons/index.js";
import type { IconName } from "../icons/index.js";
import { ensureStyles } from "./styles.js";
import type { BaseProps } from "./types.js";

/** Props of {@link EmptyState}. */
export interface EmptyStateProps extends BaseProps {
  /** Short heading, for example "No results". */
  title: string;
  /** Optional explanation under the heading. */
  description?: string;
  /** Optional action, typically a button that changes the situation. */
  action?: ReactNode;
  /** Icon above the heading. Defaults to a generic document. */
  icon?: IconName;
}

/**
 * An empty state.
 *
 * @param props empty state props
 * @returns the state block
 */
export function EmptyState({
  title,
  description,
  action,
  icon = "file",
  className,
  style,
  "data-testid": testId,
}: EmptyStateProps): ReactElement {
  ensureStyles();

  const classes = className === undefined ? "ui-state" : `ui-state ${className}`;

  return (
    <div className={classes} style={style} role="status" data-tone="neutral" data-testid={testId}>
      <span className="ui-state__icon">
        <Icon name={icon} size={32} />
      </span>
      <p className="ui-state__title">{title}</p>
      {description === undefined ? null : <p className="ui-state__description">{description}</p>}
      {action === undefined ? null : <div className="ui-state__actions">{action}</div>}
    </div>
  );
}
