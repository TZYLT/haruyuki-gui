/**
 * The sample file-tree page.
 *
 * The hierarchy is written as nested lists rather than flattened with depth
 * numbers: the nesting is what a tree looks like to a screen reader, and a depth
 * attribute on a plain list would announce structure the markup does not carry.
 *
 * The entries are invented. They exist to give the right-hand rail something with
 * more than one level in it, so the layout proof includes a real indentation and
 * not just a column of equal rows.
 */

import { useT } from "../../i18n/index.js";
import type { PageDefinition, PageInstanceProps } from "../types.js";

/**
 * Render the sample tree.
 *
 * @returns the file tree element
 */
function TreePage(_props: PageInstanceProps) {
  const t = useT();

  return (
    <section aria-label={t("page.tree.title")}>
      <ul>
        <li>
          docs/
          <ul>
            <li>architecture.md</li>
            <li>notes.md</li>
          </ul>
        </li>
        <li>
          src/
          <ul>
            <li>main.ts</li>
          </ul>
        </li>
        <li>README.md</li>
      </ul>
    </section>
  );
}

/** Registration for the right-hand file rail. */
export const treePage: PageDefinition = {
  id: "tree",
  titleKey: "page.tree.title",
  icon: "file",
  zone: "side",
  defaultSide: "right",
  minWidth: 240,
  component: TreePage,
};
