/**
 * The application menu.
 *
 * A desktop app with no menu has no `Ctrl+Q` on Linux, no `Cmd+,` for settings, and
 * no way to reach reload without a mouse. It also cannot be given one later without
 * the shortcuts changing under the user, so it exists from the first build.
 *
 * Four decisions worth stating:
 *
 *   The Help menu is the shell's one application-specific menu (P10). It offers the
 *   three things a user needs when something went wrong -- export a diagnostics
 *   bundle, open the log folder, restart -- plus the manual path for a leftover
 *   engine that boot supervision refused to kill on its own. Those items exist
 *   because the code behind them exists; nothing here is a placeholder.
 *
 *   Everything else stays role-based. Electron resolves `role` to the platform's own
 *   accelerator and localised label. Hand-written `CmdOrCtrl+R` strings would be
 *   right on two platforms and subtly wrong on the third, and re-labelling the
 *   existing Edit/View/Window items is a menu rewrite D4 explicitly does not do
 *   (`RD-10`).
 *
 *   Help labels come from the catalogue, not from this file. `menuLabels` is the
 *   single place that turns a key into text, so the menu and the two dialogs it
 *   opens cannot disagree about a word and a translator has one file to edit. The
 *   labels are built here rather than in the wiring because the i18n gate reads
 *   `t()` literals from this file (`scripts/i18n/check.mjs`), and the menu is the
 *   only main-process module that renders catalogue text.
 *
 *   The menu describes state it is given, not state it reads. `staleCount` decides
 *   the cleanup item's label and enabled flag; the candidate objects themselves
 *   never reach this module, so building a template cannot accidentally kill or
 *   inspect a process.
 *
 * The template is split from `Menu.buildFromTemplate` so its shape is testable
 * without an Electron process: "is the devtools item present" and "is the cleanup
 * item enabled" are the decisions that can be wrong, and they are decided here.
 */

import { createTranslator, type Locale } from "@haruyuki/ui/i18n/core";
import type { MenuItemConstructorOptions } from "electron";

/** What the menu needs to know about the process it is describing. */
export interface MenuContext {
  /** True when the app is unpackaged, i.e. `app.isPackaged === false`. */
  readonly isDevelopment: boolean;
  /** True when the developer-tools escape hatch is on. */
  readonly devtoolsAllowed: boolean;
  /** Localised label for the application menu. */
  readonly appName: string;
  /** The locale every Help label is resolved in. */
  readonly locale: Locale;
  /**
   * How many stale-engine candidates the last scan kept.
   *
   * Only a count: the menu cannot act on a candidate without the dialog, and
   * handing it process objects would make a template a place where a kill could
   * happen.
   */
  readonly staleCount: number;
  /** Opens the diagnostics panel; absent disables the item. */
  readonly onExportDiagnostics?: () => void;
  /** Opens the log folder; absent disables the item. */
  readonly onOpenLogs?: () => void;
  /** Relaunches the shell; absent disables the item. */
  readonly onRestart?: () => void;
  /** Opens the stale-engine confirmation dialog; absent disables the item. */
  readonly onCleanupStale?: () => void;
}

/**
 * Every user-visible string the Help menu and its dialogs need, resolved once.
 *
 * Returning functions rather than pre-formatted strings keeps the count-aware
 * messages in the catalogue where a translator can reorder the number.
 */
export interface MenuLabels {
  readonly helpTitle: string;
  readonly exportDiagnostics: string;
  readonly openLogs: string;
  readonly restart: string;
  readonly cleanupStale: string;
  readonly cleanupStaleCount: (count: number) => string;
  readonly cleanupTitle: string;
  readonly cleanupMessage: (count: number, details: string) => string;
  readonly cleanupConfirm: string;
  readonly cleanupCancel: string;
  readonly cleanupDone: (count: number) => string;
  readonly cleanupFailed: string;
  readonly openLogsFailed: string;
  readonly close: string;
}

/**
 * Resolve the Help menu's copy for one locale.
 *
 * The only `t()` call sites in the main process live in this function, so the
 * i18n gate can see every key the menu uses by reading one file.
 *
 * @param locale the resolved shell locale
 * @returns the labels, with count-aware messages still callable
 */
export function menuLabels(locale: Locale): MenuLabels {
  const t = createTranslator(locale);

  return {
    helpTitle: t("common.menu.title"),
    exportDiagnostics: t("common.menu.exportDiagnostics"),
    openLogs: t("common.menu.openLogs"),
    restart: t("common.menu.restart"),
    cleanupStale: t("common.menu.cleanupStale"),
    cleanupStaleCount: (count) => t("common.menu.cleanupStaleCount", { count }),
    cleanupTitle: t("common.menu.cleanupTitle"),
    cleanupMessage: (count, details) => t("common.menu.cleanupMessage", { count, details }),
    cleanupConfirm: t("common.menu.cleanupConfirm"),
    cleanupCancel: t("common.menu.cleanupCancel"),
    cleanupDone: (count) => t("common.menu.cleanupDone", { count }),
    cleanupFailed: t("common.menu.cleanupFailed"),
    openLogsFailed: t("common.menu.openLogsFailed"),
    close: t("common.diagnostics.close"),
  };
}

/** One label-only action: enabled exactly when somebody is listening. */
function action(label: string, handler: (() => void) | undefined): MenuItemConstructorOptions {
  return {
    label,
    enabled: handler !== undefined,
    click: () => {
      handler?.();
    },
  };
}

/** The Help submenu, whose enabled states follow the callbacks and the count. */
function helpSubmenu(context: MenuContext, labels: MenuLabels): MenuItemConstructorOptions[] {
  const cleanupEnabled = context.staleCount > 0 && context.onCleanupStale !== undefined;

  return [
    action(labels.exportDiagnostics, context.onExportDiagnostics),
    action(labels.openLogs, context.onOpenLogs),
    action(labels.restart, context.onRestart),
    { type: "separator" },
    {
      // The count belongs in the label: a greyed item that does not say how many
      // candidates it knows about reads as "nothing happened" rather than "there
      // is nothing to do".
      label:
        context.staleCount > 0 ? labels.cleanupStaleCount(context.staleCount) : labels.cleanupStale,
      enabled: cleanupEnabled,
      click: () => {
        context.onCleanupStale?.();
      },
    },
  ];
}

/**
 * Build the menu template.
 *
 * @param context the process facts and callbacks the template depends on
 */
export function buildMenuTemplate(context: MenuContext): MenuItemConstructorOptions[] {
  // Development, or the explicit escape hatch. Anything else gets no item.
  const inspectorVisible = context.isDevelopment || context.devtoolsAllowed;
  const labels = menuLabels(context.locale);

  return [
    {
      label: context.appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        ...(inspectorVisible
          ? ([{ role: "toggleDevTools" }] satisfies MenuItemConstructorOptions[])
          : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
    {
      label: labels.helpTitle,
      submenu: helpSubmenu(context, labels),
    },
  ];
}
