/**
 * The software-level top bar.
 *
 * Only actions that exist for the whole app live here; agent information belongs
 * to the navigation page. An entry whose target is missing is omitted rather
 * than shown disabled: a settings item that does nothing is worse than no item.
 *
 * The edit menu is a small popover rather than a Dialog because it must act on
 * the focused page without stealing focus first; `document.execCommand` is the
 * only API that reaches the current selection across the Electron renderer.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";

import { Button } from "../components/Button.js";
import { Dialog } from "../components/Dialog.js";
import { useT } from "../i18n/index.js";

/** One edit command exposed by the menu. */
export type EditAction = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

/** What the shell supplies. */
export interface TopBarProps {
  readonly hasSettings: boolean;
  readonly hasUpdates: boolean;
  readonly onOpenSettings?: () => void;
  readonly onCheckUpdates?: () => void;
  readonly onExportDiagnostics?: () => void;
  readonly onResetLayout?: () => void;
  readonly onEditAction?: (action: EditAction) => void;
}

/** Render the top bar and its two menus. */
export function TopBar(props: TopBarProps): ReactElement {
  const t = useT();
  const [menu, setMenu] = useState<"edit" | "help" | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const root = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (menu === null) return;

    const close = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target) === true) return;
      setMenu(null);
    };

    document.addEventListener("mousedown", close);

    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const edit = (action: EditAction): void => {
    setMenu(null);
    if (props.onEditAction !== undefined) {
      props.onEditAction(action);
      return;
    }

    // The page owns the focus; the command applies to the current selection.
    document.execCommand(action === "selectAll" ? "selectAll" : action);
  };

  const editItems: ReadonlyArray<{ action: EditAction; label: string }> = [
    { action: "undo", label: t("page.topbar.undo") },
    { action: "redo", label: t("page.topbar.redo") },
    { action: "cut", label: t("page.topbar.cut") },
    { action: "copy", label: t("page.topbar.copy") },
    { action: "paste", label: t("page.topbar.paste") },
    { action: "selectAll", label: t("page.topbar.selectAll") },
  ];

  return (
    <header className="hz-topbar" ref={root}>
      <div className="hz-topbar__menus">
        <button
          type="button"
          className="hz-topbar__button"
          aria-expanded={menu === "edit"}
          onClick={() => setMenu(menu === "edit" ? null : "edit")}
        >
          {t("page.topbar.edit")}
        </button>
        <button
          type="button"
          className="hz-topbar__button"
          aria-expanded={menu === "help"}
          onClick={() => setMenu(menu === "help" ? null : "help")}
        >
          {t("page.topbar.help")}
        </button>
        {menu === "edit" && (
          <div className="hz-topbar__menu" role="menu">
            {editItems.map((item) => (
              <button
                key={item.action}
                type="button"
                role="menuitem"
                onClick={() => edit(item.action)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        {menu === "help" && (
          <div className="hz-topbar__menu" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setResetOpen(true);
              }}
            >
              {t("page.topbar.resetLayout")}
            </button>
          </div>
        )}
      </div>

      <div className="hz-topbar__actions">
        {props.onExportDiagnostics !== undefined && (
          <button type="button" className="hz-topbar__button" onClick={props.onExportDiagnostics}>
            {t("page.topbar.diagnostics")}
          </button>
        )}
        {props.hasSettings && props.onOpenSettings !== undefined && (
          <button type="button" className="hz-topbar__button" onClick={props.onOpenSettings}>
            {t("page.topbar.settings")}
          </button>
        )}
        {props.hasUpdates && props.onCheckUpdates !== undefined && (
          <button type="button" className="hz-topbar__button" onClick={props.onCheckUpdates}>
            {t("page.topbar.updates")}
          </button>
        )}
      </div>

      <Dialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t("page.topbar.resetTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetOpen(false)}>
              {t("page.topbar.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setResetOpen(false);
                props.onResetLayout?.();
              }}
            >
              {t("page.topbar.resetConfirm")}
            </Button>
          </>
        }
      >
        <p>{t("page.topbar.resetBody")}</p>
      </Dialog>
    </header>
  );
}
