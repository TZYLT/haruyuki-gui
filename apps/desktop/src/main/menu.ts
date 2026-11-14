/**
 * The application menu.
 *
 * A desktop app with no menu has no `Ctrl+Q` on Linux, no `Cmd+,` for settings, and
 * no way to reach reload without a mouse. It also cannot be given one later without
 * the shortcuts changing under the user, so it exists from the first build.
 *
 * Three decisions worth stating:
 *
 *   No application-specific entries yet. The shell has no settings window, no
 *   document and no export to offer. A menu item that opens nothing is worse than a
 *   missing item, so this is the platform's default menu with the roles Electron
 *   already implements. Adding items is a later item's job, not a guess made here.
 *
 *   Roles, not accelerators. Electron resolves `role` to the platform's own
 *   accelerator and localised label. Hand-written `CmdOrCtrl+R` strings would be
 *   right on two platforms and subtly wrong on the third.
 *
 *   No devtools outside development. The menu is one of the ways a user can reach
 *   the inspector, so it follows the same gate as the keyboard shortcut rather than
 *   keeping its own copy of the condition.
 */

import type { MenuItemConstructorOptions } from "electron";

/** What the menu needs to know about the process it is describing. */
export interface MenuContext {
  /** True when the app is unpackaged, i.e. `app.isPackaged === false`. */
  readonly isDevelopment: boolean;
  /** True when the developer-tools escape hatch is on. */
  readonly devtoolsAllowed: boolean;
  /** Localised label for the application menu. */
  readonly appName: string;
}

/**
 * Build the menu template.
 *
 * Split from `Menu.buildFromTemplate` so the shape is testable without an Electron
 * process: the decision "is the devtools item present" is the part that can be
 * wrong, and it is decided here.
 *
 * @param context the process facts the template depends on
 */
export function buildMenuTemplate(context: MenuContext): MenuItemConstructorOptions[] {
  // Development, or the explicit escape hatch. Anything else gets no item.
  const inspectorVisible = context.isDevelopment || context.devtoolsAllowed;

  const template: MenuItemConstructorOptions[] = [
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
  ];

  return template;
}
