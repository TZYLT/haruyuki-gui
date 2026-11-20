/**
 * Dialog shell.
 *
 * A shell, not a feature: it owns the surface, the title, the close affordance and
 * the footer slot, and nothing else. Business behaviour -- what opening means,
 * what confirming does -- belongs to whoever renders it, and the same
 * "draws, does not decide" split the empty and error states follow).
 *
 * Base UI supplies what is genuinely hard: focus trapping, restoring focus on
 * close, Escape handling, and making the rest of the page inert. A hand-rolled
 * dialog gets focus restoration wrong almost every time, and the bug is invisible
 * to anyone using a mouse.
 *
 * It does **not** set `aria-modal`, which was measured rather than assumed: the
 * rendered popup carries `role="dialog"` and `aria-labelledby` but no
 * `aria-modal`. Without it, a screen reader keeps the content behind the dialog in
 * its virtual buffer, so the "modal" claim is only visual. The attribute is added
 * here, on the popup, because that is the one element that knows it is the
 * top-level dialog.
 *
 * The close button's accessible name is a translated key. The title is a plain
 * string because the caller owns the wording and it is already translated.
 */

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactElement, ReactNode } from "react";

import { useT } from "../i18n/index.js";
import { Icon } from "../icons/index.js";
import { ensureStyles } from "./styles.js";
import type { BaseProps } from "./types.js";

/** Props of {@link Dialog}. */
export interface DialogProps extends BaseProps {
  /** Whether the dialog is showing. Controlled. */
  open: boolean;
  /** Called with the requested state. */
  onOpenChange: (open: boolean) => void;
  /** Visible heading. Also the dialog's accessible name. */
  title: string;
  /** Body content. */
  children?: ReactNode;
  /** Action row. Rendered as given; this component does not invent buttons. */
  footer?: ReactNode;
}

/**
 * A modal dialog shell.
 *
 * @param props dialog props
 * @returns the dialog root
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
  className,
  style,
  "data-testid": testId,
}: DialogProps): ReactElement {
  ensureStyles();

  const t = useT();
  // Kept apart on purpose -- see `Select` for the full explanation. One string
  // used as both the root class and the prefix for every derived name meant a
  // caller passing `className="wide"` produced `ui-dialog wide__backdrop`, so the
  // backdrop lost its real class and rendered unstyled.
  const BASE = "ui-dialog";
  const popupClass = className === undefined ? `${BASE}__popup` : `${BASE}__popup ${className}`;
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={`${BASE}__backdrop`} />
        <BaseDialog.Popup
          className={popupClass}
          style={style}
          data-testid={testId}
          // base-ui does not set this; see the note above. It is a boolean ARIA
          // attribute, so the string is correct.
          aria-modal="true"
        >
          <div className={`${BASE}__header`}>
            {/* Dialog.Title wires aria-labelledby on the popup, which is what
                gives the dialog its accessible name. Rendering a plain <h2>
                would look identical and leave the dialog unnamed. */}
            <BaseDialog.Title className={`${BASE}__title`}>{title}</BaseDialog.Title>
            <BaseDialog.Close
              className={`${BASE}__close`}
              aria-label={t("component.dialog.close")}
              title={t("component.dialog.close")}
            >
              <Icon name="close" />
            </BaseDialog.Close>
          </div>
          <div className={`${BASE}__body`}>{children}</div>
          {footer === undefined ? null : <div className={`${BASE}__footer`}>{footer}</div>}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
