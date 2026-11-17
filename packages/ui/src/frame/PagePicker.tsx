/**
 * The page picker used by the empty state and the side-rail entry.
 *
 * It lists definitions from the registry, grouped by zone, and asks the frame to
 * open one. It does not decide the target group; `openPage` owns that.
 */

import type { ReactElement } from "react";

import { Button } from "../components/Button.js";
import { useT } from "../i18n/index.js";

import { useFrameHost } from "./host-context.js";

/** Render the openable pages. */
export function PagePicker({ onOpen }: { readonly onOpen: () => void }): ReactElement {
  const host = useFrameHost();
  const t = useT();
  const main = host.registry.list().filter((page) => page.zone === "main");
  const side = host.registry.list().filter((page) => page.zone === "side");

  const group = (title: string, pages: typeof main): ReactElement => (
    <section className="hz-picker__group">
      <h3 className="hz-picker__heading">{title}</h3>
      <ul className="hz-picker__list">
        {pages.map((page) => (
          <li key={page.id}>
            <Button
              variant="ghost"
              onClick={() => {
                host.openPage(page.id);
                onOpen();
              }}
            >
              {t(page.titleKey)}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <div className="hz-picker" role="dialog" aria-label={t("page.frame.picker.title")}>
      <h2 className="hz-picker__title">{t("page.frame.picker.title")}</h2>
      {group(t("page.frame.picker.main"), main)}
      {group(t("page.frame.picker.side"), side)}
    </div>
  );
}
