import { describe, expect, it } from "vitest";

import { buildMenuTemplate, type MenuContext } from "../menu.js";

/** The context a packaged production build has. */
const PRODUCTION: MenuContext = {
  isDevelopment: false,
  devtoolsAllowed: false,
  appName: "Haruyuki",
};

/** The context an unpackaged development run has. */
const DEVELOPMENT: MenuContext = { ...PRODUCTION, isDevelopment: true };

/** Find the View submenu's items. */
function viewSubmenu(context: MenuContext) {
  const template = buildMenuTemplate(context);
  const view = template.find((item) => item.label === "View");

  if (view === undefined || !Array.isArray(view.submenu)) {
    throw new Error("the template has no View submenu");
  }

  return view.submenu;
}

/** Whether the inspector item is present. */
function hasInspectorItem(context: MenuContext): boolean {
  return viewSubmenu(context).some((item) => item.role === "toggleDevTools");
}

describe("buildMenuTemplate", () => {
  it("has the four top-level menus", () => {
    const labels = buildMenuTemplate(PRODUCTION).map((item) => item.label);

    expect(labels).toEqual(["Haruyuki", "Edit", "View", "Window"]);
  });

  it("uses the supplied application name", () => {
    const labels = buildMenuTemplate({ ...PRODUCTION, appName: "Other" }).map((item) => item.label);

    expect(labels[0]).toBe("Other");
  });

  it("uses roles rather than hand-written accelerators", () => {
    // Electron resolves a role to the platform's own accelerator and localised label.
    // A hand-written `CmdOrCtrl+R` would be right on two platforms and wrong on the third.
    const view = viewSubmenu(PRODUCTION);
    const accelerators = view.filter((item) => item.accelerator !== undefined);

    expect(accelerators).toHaveLength(0);
  });
});

describe("the devtools gate", () => {
  it("omits the inspector in a packaged build without the escape hatch", () => {
    expect(hasInspectorItem(PRODUCTION)).toBe(false);
  });

  it("includes it in development", () => {
    expect(hasInspectorItem(DEVELOPMENT)).toBe(true);
  });

  it("includes it in a packaged build when the escape hatch is on", () => {
    // The one documented way to inspect a release build. Same condition as
    // `webPreferences.devTools`, so there is a single answer to "can the user inspect
    // this build".
    expect(hasInspectorItem({ ...PRODUCTION, devtoolsAllowed: true })).toBe(true);
  });

  it("keeps the rest of the View menu in both cases", () => {
    // The gate must remove one item, not the whole submenu.
    const without = viewSubmenu(PRODUCTION).map((item) => item.role ?? item.type);
    const withMore = viewSubmenu(DEVELOPMENT).map((item) => item.role ?? item.type);

    expect(without).toContain("reload");
    expect(withMore).toContain("reload");
    expect(withMore.length).toBe(without.length + 1);
  });
});

describe("the menu's contents", () => {
  it("offers quit, so the app can be closed without a mouse", () => {
    const appMenu = buildMenuTemplate(PRODUCTION)[0]?.submenu;

    expect(Array.isArray(appMenu)).toBe(true);
    expect((appMenu as { role?: string }[]).some((item) => item.role === "quit")).toBe(true);
  });

  it("offers the clipboard roles", () => {
    const edit = buildMenuTemplate(PRODUCTION).find((item) => item.label === "Edit");
    const roles = (edit?.submenu as { role?: string }[]).map((item) => item.role);

    expect(roles).toEqual(
      expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "selectAll"]),
    );
  });

  it("offers zoom and fullscreen", () => {
    const roles = viewSubmenu(PRODUCTION).map((item) => item.role);

    expect(roles).toEqual(
      expect.arrayContaining(["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]),
    );
  });

  it("offers window controls", () => {
    const windowMenu = buildMenuTemplate(PRODUCTION).find((item) => item.label === "Window");
    const roles = (windowMenu?.submenu as { role?: string }[]).map((item) => item.role);

    expect(roles).toEqual(expect.arrayContaining(["minimize", "close"]));
  });

  it("adds no application-specific item the shell cannot open", () => {
    // There is no settings window and no document yet. A menu item that opens nothing
    // is worse than a missing item.
    const template = buildMenuTemplate(DEVELOPMENT);
    const labels = template.flatMap((item) =>
      Array.isArray(item.submenu)
        ? (item.submenu as { label?: string }[]).map((sub) => sub.label ?? "")
        : [],
    );

    for (const invented of ["Settings", "Preferences", "Export", "New", "Open"]) {
      expect(labels).not.toContain(invented);
    }
  });
});
