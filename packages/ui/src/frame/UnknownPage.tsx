/**
 * The placeholder for a page id this build does not know.
 *
 * Closing it does not delete the tab: `onClose` is the frame's hide path, so the
 * layout document keeps the tab and a later build can show it again.
 */

import type { ReactElement } from "react";

import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { useT } from "../i18n/index.js";

/** Render an unknown page with its id and a hide action. */
export function UnknownPage({
  pageId,
  onClose,
}: {
  readonly pageId: string;
  readonly onClose: () => void;
}): ReactElement {
  const t = useT();

  return (
    <EmptyState
      title={t("page.frame.unknown.title", { id: pageId })}
      description={t("page.frame.unknown.description")}
      action={
        <Button variant="secondary" onClick={onClose}>
          {t("page.frame.tab.close")}
        </Button>
      }
    />
  );
}
