/**
 * The sample navigation page.
 *
 * A placeholder that exists to prove the registry and the host work, not to be a
 * real navigation UI: the rows are plain text with no destination and no action.
 * Making them links would invent routes this build does not have, and every
 * consumer of the sample would then have to be told why they go nowhere.
 *
 * `pinned` is set because a navigation rail that a user can close leaves an empty
 * side zone with no way back to it. That is a property of the role, not of this
 * particular content.
 */

import { useT } from "../../i18n/index.js";
import type { PageDefinition, PageInstanceProps } from "../types.js";

/** Rows shown in the sample rail; fixed content, so a tuple is enough. */
const SAMPLE_ITEMS = ["Inbox", "Drafts", "Archive", "Settings"] as const;

/**
 * Render the sample rail.
 *
 * The landmark's accessible name is the page title rather than a second string:
 * a named navigation region and its tab should not be able to disagree, and the
 * title already exists in both catalogues.
 *
 * @returns the navigation element
 */
function NavPage(_props: PageInstanceProps) {
  const t = useT();

  return (
    <nav aria-label={t("page.nav.title")}>
      <ul>
        {SAMPLE_ITEMS.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </nav>
  );
}

/** Registration for the navigation rail. */
export const navPage: PageDefinition = {
  id: "nav",
  titleKey: "page.nav.title",
  icon: "link",
  zone: "side",
  defaultSide: "left",
  minWidth: 240,
  pinned: true,
  allowMultiple: false,
  component: NavPage,
};
