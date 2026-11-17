/**
 * The placeholder for a page id this build does not know.
 *
 * Hiding it does not delete the tab: `onHide` is the frame's hide path, so the
 * layout document keeps the tab (`hidden: true`) and a later build that
 * registers the page shows it again. The button says "hide" rather than "close"
 * for exactly that reason -- a user who feared losing data would otherwise avoid
 * the only action here.
 */

import type { ReactElement } from "react";

import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { useT } from "../i18n/index.js";

/** Render an unknown page with its id and a hide action. */
export function UnknownPage({
  pageId,
  onHide,
}: {
  readonly pageId: string;
  readonly onHide: () => void;
}): ReactElement {
  const t = useT();

  return (
    <EmptyState
      title={t("page.frame.unknown.title", { id: pageId })}
      description={t("page.frame.unknown.description")}
      action={
        <Button variant="secondary" onClick={onHide}>
          {t("page.frame.unknown.hide")}
        </Button>
      }
    />
  );
}
