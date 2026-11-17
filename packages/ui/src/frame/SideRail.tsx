/**
 * The side rails: one strip per edge, listing the side-zone pages.
 *
 * The rail is an *entry point*, not the page area. The page area is the dock's
 * side panel (the default layout's `nav` and `tree` groups); the rail is how the
 * user reaches those pages, how the rail is collapsed to its icon strip, and --
 * in compact mode -- how a side page is opened into the main area.
 *
 * Pure rendering on purpose: the side comes from the caller, the page list comes
 * from the registry through the caller, and `onOpen`/`onToggle` are the only two
 * verbs. That keeps the collapse state with the frame (which is the only place
 * that can also apply a keyboard shortcut to it) and lets the whole strip be
 * tested without a dock.
 *
 * When collapsed only the icons stay. Collapsing is a width change on the rail,
 * not a dockview layout operation, so it cannot unload a page or write a layout.
 */

import type { ReactElement } from "react";

import { useT } from "../i18n/index.js";
import { Icon } from "../icons/index.js";

import type { PageDefinition } from "./types.js";

/** Which edge a rail sits on. */
export type SideRailSide = "left" | "right";

/** Props of {@link SideRail}. */
export interface SideRailProps {
  readonly side: SideRailSide;
  /** Registered side pages whose `defaultSide` is this edge. */
  readonly pages: readonly PageDefinition[];
  /** Icon strip only; the page labels are hidden. */
  readonly collapsed: boolean;
  /** Page id of the active tab, when it belongs to this side. */
  readonly activePageId?: string;
  /** Collapse/expand request. The caller owns the state. */
  onToggle(side: SideRailSide): void;
  onOpen(pageId: string): void;
}

/**
 * Render one side rail.
 *
 * @param props rail props
 * @returns the rail element
 */
export function SideRail({
  side,
  pages,
  collapsed,
  activePageId,
  onToggle,
  onOpen,
}: SideRailProps): ReactElement {
  const t = useT();
  const label = side === "left" ? t("page.frame.sideRail.left") : t("page.frame.sideRail.right");

  return (
    <nav
      className={collapsed ? "hz-rail hz-rail--collapsed" : "hz-rail"}
      data-side={side}
      aria-label={label}
    >
      <button
        type="button"
        className="hz-rail__toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("page.frame.sideRail.expand") : t("page.frame.sideRail.collapse")}
        onClick={() => onToggle(side)}
      >
        <Icon name="chevronDown" size={16} />
      </button>
      {pages.length === 0 ? (
        collapsed ? null : (
          <p className="hz-rail__empty">{t("page.frame.sideRail.empty")}</p>
        )
      ) : (
        <ul className="hz-rail__list">
          {pages.map((page) => (
            <li key={page.id}>
              <button
                type="button"
                className="hz-rail__entry"
                aria-current={activePageId === page.id ? "page" : undefined}
                title={t(page.titleKey)}
                onClick={() => onOpen(page.id)}
              >
                <Icon name={page.icon} size={16} />
                {collapsed ? null : <span className="hz-rail__label">{t(page.titleKey)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** Props of {@link CompactSideRail}. */
export interface CompactSideRailProps {
  readonly left: readonly PageDefinition[];
  readonly right: readonly PageDefinition[];
  /** Open a page into the main area; compact mode never creates a side panel. */
  onOpen(pageId: string): void;
}

/**
 * The compact-mode substitute for both rails: one labelled list of side pages.
 *
 * At less than 1200px there is no room for a side panel, so the pages behind the
 * rails have to be reachable from the single main area. Clicking an entry opens
 * that page in the main area (`59` section 4.8); it does not move it.
 *
 * @param props compact rail props
 * @returns the grouped list
 */
export function CompactSideRail({ left, right, onOpen }: CompactSideRailProps): ReactElement {
  const t = useT();
  const groups = [
    { side: "left" as const, label: t("page.frame.sideRail.left"), pages: left },
    { side: "right" as const, label: t("page.frame.sideRail.right"), pages: right },
  ];

  return (
    <div className="hz-compact-pages" role="group" aria-label={t("page.frame.sideRail.title")}>
      {groups.map((group) => (
        <section className="hz-compact-pages__group" key={group.side}>
          <h3 className="hz-compact-pages__heading">{group.label}</h3>
          {group.pages.length === 0 ? (
            <p className="hz-rail__empty">{t("page.frame.sideRail.empty")}</p>
          ) : (
            <ul className="hz-rail__list">
              {group.pages.map((page) => (
                <li key={page.id}>
                  <button
                    type="button"
                    className="hz-rail__entry"
                    title={t(page.titleKey)}
                    onClick={() => onOpen(page.id)}
                  >
                    <Icon name={page.icon} size={16} />
                    <span className="hz-rail__label">{t(page.titleKey)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
