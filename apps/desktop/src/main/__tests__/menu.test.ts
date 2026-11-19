import { describe, expect, it } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

import { buildMenuTemplate, menuLabels, type MenuContext } from "../menu.js";

/** The context a packaged production build has, in English. */
const PRODUCTION: MenuContext = {
  isDevelopment: false,
  devtoolsAllowed: false,
  appName: "Haruyuki",
  locale: "en",
  staleCount: 0,
};

/** The context an unpackaged development run has. */
const DEVELOPMENT: MenuContext = { ...PRODUCTION, isDevelopment: true };

/** Find the View submenu's items. */
function viewSubmenu(context: MenuContext): MenuItemConstructorOptions[] {
  const template = buildMenuTemplate(context);
  const view = template.find((item) => item.label === "View");

  if (view === undefined || !Array.isArray(view.submenu)) {
    throw new Error("the template has no View submenu");
  }

  return view.submenu;
}

/** Find the Help submenu's items. */
function helpSubmenu(context: MenuContext): MenuItemConstructorOptions[] {
  const template = buildMenuTemplate(context);
  const help = template.find((item) => item.label === menuLabels(context.locale).helpTitle);

  if (help === undefined || !Array.isArray(help.submenu)) {
    throw new Error("the template has no Help submenu");
  }

  return help.submenu;
}

/** The items under the application menu (the first top-level menu). */
function applicationSubmenu(context: MenuContext): MenuItemConstructorOptions[] {
  const template = buildMenuTemplate(context);
  const application = template[0];

  if (application === undefined || !Array.isArray(application.submenu)) {
    throw new Error("the template has no application submenu");
  }

  return application.submenu;
}

/** Whether the inspector item is present. */
function hasInspectorItem(context: MenuContext): boolean {
  return viewSubmenu(context).some((item) => item.role === "toggleDevTools");
}

/** Invoke an item's click handler the way Electron would. */
function clickItem(item: MenuItemConstructorOptions): void {
  if (typeof item.click !== "function") {
    throw new Error(`menu item ${String(item.label)} has no click handler`);
  }

  (item.click as unknown as () => void)();
}

describe("buildMenuTemplate", () => {
  it("has the five top-level menus", () => {
    const labels = buildMenuTemplate(PRODUCTION).map((item) => item.label);

    expect(labels).toEqual(["Haruyuki", "Edit", "View", "Window", "Help"]);
  });

  it("uses the supplied application name", () => {
    const labels = buildMenuTemplate({ ...PRODUCTION, appName: "Other" }).map((item) => item.label);

    expect(labels[0]).toBe("Other");
  });

  it("offers no built-in about panel beside the Help entry", () => {
    // The user-visible failure this pins: the application menu carried Electron's
    // `role: "about"`, whose panel shows a name and a version, while the Help
    // menu carried the entry the requirement actually describes. Whichever one a
    // person found first became "the about window", and the built-in one made
    // the build look broken. One entry, and it is the complete one.
    const aboutPanels = applicationSubmenu(PRODUCTION).filter((item) => item.role === "about");

    expect(aboutPanels).toHaveLength(0);
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

describe("the Help menu", () => {
  it("offers exactly the three signed actions, in order", () => {
    // Whole `toEqual`, not a length and not a `toContain`: an array that grew a
    // fourth item passes a length check written as `toHaveLength(3)` only if
    // somebody remembers to update it, and a `for` loop over a longer array
    // silently runs past a missing expectation. Comparing the full list makes a
    // new, removed or reordered item a failure here.
    const labels = helpSubmenu(PRODUCTION)
      .filter((item) => item.type !== "separator")
      .map((item) => item.label);

    expect(labels).toEqual(["Export Diagnostics…", "Clean Up Leftover Engines…", "About Haruyuki"]);
  });

  it("has no second entry point to the about window", () => {
    // "Check for updates" lives inside the window this item opens. A menu entry
    // for it would change a surface a user signed, so it is asserted absent by
    // name rather than by counting.
    const labels = helpSubmenu(PRODUCTION).map((item) => item.label);

    expect(labels).not.toContain("Check for Updates…");
  });

  it("puts the cleanup action behind a separator", () => {
    // Export answers "something is wrong"; cleanup is the rarer, destructive one.
    const items = helpSubmenu(PRODUCTION);
    const separator = items.findIndex((item) => item.type === "separator");

    expect(separator).toBe(1);
  });

  it("puts the about item behind a separator of its own", () => {
    // Everything above the second separator is about a problem with this run;
    // the item below describes the build. Mixing them would put "clean up a
    // leftover process" and "what version am I running" in one list.
    const items = helpSubmenu(PRODUCTION);
    const separators = items.reduce<number[]>(
      (found, item, index) => (item.type === "separator" ? [...found, index] : found),
      [],
    );

    expect(separators).toEqual([1, 3]);
    // Three actions and the two separators that group them.
    expect(items).toHaveLength(5);
  });

  it("disables every action whose callback is absent", () => {
    const actions = helpSubmenu(PRODUCTION).filter((item) => item.type !== "separator");

    expect(actions.map((item) => item.label)).toEqual([
      "Export Diagnostics…",
      "Clean Up Leftover Engines…",
      "About Haruyuki",
    ]);
    expect(actions.every((item) => item.enabled === false)).toBe(true);
  });

  it("enables the actions whose callbacks are present", () => {
    const actions = helpSubmenu({
      ...PRODUCTION,
      staleCount: 1,
      onExportDiagnostics: () => undefined,
      onCleanupStale: () => undefined,
      onAbout: () => undefined,
    }).filter((item) => item.type !== "separator");

    expect(actions).toHaveLength(3);
    expect(actions.every((item) => item.enabled === true)).toBe(true);
  });

  it("runs the callback each action names", () => {
    const calls: string[] = [];
    const items = helpSubmenu({
      ...PRODUCTION,
      staleCount: 1,
      onExportDiagnostics: () => calls.push("export"),
      onCleanupStale: () => calls.push("cleanup"),
      onAbout: () => calls.push("about"),
    });

    for (const item of items) {
      if (item.type === "separator") continue;
      clickItem(item);
    }

    expect(calls).toEqual(["export", "cleanup", "about"]);
  });

  it("calls the about callback from the about item, and only it", () => {
    // Named rather than positional: the assertion is "this labelled item opens
    // the window", so reordering the submenu must not move the check onto a
    // different item and still pass.
    const calls: string[] = [];
    const items = helpSubmenu({
      ...PRODUCTION,
      onExportDiagnostics: () => calls.push("export"),
      onCleanupStale: () => calls.push("cleanup"),
      onAbout: () => calls.push("about"),
    });
    const about = items.find((item) => item.label === "About Haruyuki");

    expect(about).toBeDefined();
    expect(about?.enabled).toBe(true);

    if (about !== undefined) clickItem(about);

    expect(calls).toEqual(["about"]);
  });

  it("disables cleanup when there are no candidates", () => {
    const items = helpSubmenu({ ...PRODUCTION, onCleanupStale: () => undefined });
    const cleanup = items.find((item) => item.label === "Clean Up Leftover Engines…");

    expect(cleanup?.enabled).toBe(false);
  });

  it("shows the candidate count in the cleanup label", () => {
    const items = helpSubmenu({
      ...PRODUCTION,
      staleCount: 3,
      onCleanupStale: () => undefined,
    });
    const cleanup = items.find((item) => item.label === "Clean Up Leftover Engines (3)…");

    expect(cleanup?.enabled).toBe(true);
  });

  it("keeps cleanup disabled at a count with no listener", () => {
    // The count alone is not consent: without the dialog callback there is no
    // safe path from a click to a kill, so the item must stay greyed.
    const items = helpSubmenu({ ...PRODUCTION, staleCount: 2 });
    const cleanup = items.find((item) => item.label === "Clean Up Leftover Engines (2)…");

    expect(cleanup?.enabled).toBe(false);
  });

  it("labels the menu and its actions in the requested locale", () => {
    const chinese = helpSubmenu({ ...PRODUCTION, locale: "zh-CN" });
    const titles = buildMenuTemplate({ ...PRODUCTION, locale: "zh-CN" }).map((item) => item.label);

    expect(titles).toContain("帮助");
    expect(chinese[0]?.label).toBe("导出诊断…");
    expect(chinese[2]?.label).toBe("清理遗留引擎…");
    expect(chinese[4]?.label).toBe("关于 Haruyuki");
    // The whole Chinese action list too, so a translation that slipped into the
    // wrong item is a failure rather than a passing spot check.
    expect(chinese.filter((item) => item.type !== "separator").map((item) => item.label)).toEqual([
      "导出诊断…",
      "清理遗留引擎…",
      "关于 Haruyuki",
    ]);
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

  it("adds no application-specific item outside Help", () => {
    // Help is the one menu that names app actions, and every one of them has an
    // implementation behind it. The other menus stay pure role menus (RD-10).
    const template = buildMenuTemplate(DEVELOPMENT);
    const nonRole = template
      .filter((item) => item.label !== menuLabels("en").helpTitle)
      .flatMap((item) => (Array.isArray(item.submenu) ? item.submenu : []))
      .filter((item) => item.role === undefined && item.type !== "separator");

    expect(nonRole).toEqual([]);
  });
});
