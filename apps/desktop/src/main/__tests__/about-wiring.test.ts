/**
 * The about glue: does the menu entry actually reach the window, and does the
 * teardown actually tear anything down?
 *
 * Both halves were the shape of a bug this file exists to prevent. A menu item
 * wired to a callback that returns without doing anything is invisible to every
 * other test -- the template is correct, the channels are registered, and the
 * click produces nothing. Likewise a `dispose` that removes the handlers but
 * leaves the window open shows a page whose buttons all fail.
 *
 * `installAbout` reads `app`, `shell` and the runtime layout from Electron, so
 * this test replaces the `electron` module for the two modules under test and
 * passes everything else through its own seams. No browser process is launched.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Electron stand-in.
 *
 * Only the members `about-wiring.ts` (and the layout it derives) actually read.
 * `getPath` returns absolute, distinct paths because `computeRuntimeLayout`
 * rejects an empty one -- that rejection is a real guard, not a formality.
 */
const electronDouble = {
  app: {
    isPackaged: false,
    getVersion: () => "0.1.0",
    getAppPath: () => "/repo/apps/desktop",
    getPath: (name: string) =>
      ({
        userData: "/home/user/.config/Haruyuki",
        logs: "/home/user/.config/Haruyuki/logs",
        exe: "/repo/node_modules/electron/dist/electron",
      })[name] ?? "/home/user",
  },
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve("")),
  },
};

vi.mock("electron", () => electronDouble);

/**
 * The two process facts Electron provides and plain Node does not.
 *
 * `computeRuntimeLayout` refuses an empty path rather than resolving it to the
 * working directory, so a missing `resourcesPath` is a loud failure here instead
 * of a layout that quietly points at `/`.
 */
Object.defineProperty(process, "resourcesPath", {
  value: "/repo/node_modules/electron/dist/resources",
  configurable: true,
});

/** What the fake IPC surface recorded. */
interface FakeIpc {
  readonly handled: string[];
  readonly removed: string[];
  readonly ipcMain: {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => void;
    removeHandler: (channel: string) => void;
  };
}

/**
 * Build a fake `ipcMain` that records what was registered.
 *
 * @returns the registration surface plus the two recorders
 */
function fakeIpc(): FakeIpc {
  const handled: string[] = [];
  const removed: string[] = [];

  return {
    handled,
    removed,
    ipcMain: {
      handle: (channel) => {
        handled.push(channel);
      },
      removeHandler: (channel) => {
        removed.push(channel);
      },
    },
  };
}

/** Deps one `installAbout` call needs, with the opener injected. */
function installDeps(overrides: Record<string, unknown> = {}): {
  deps: Parameters<typeof import("../about-wiring.js").installAbout>[0];
  ipc: FakeIpc;
  opened: unknown[];
} {
  const ipc = fakeIpc();
  const opened: unknown[] = [];

  return {
    ipc,
    opened,
    deps: {
      onQuit: () => undefined,
      here: "/repo/apps/desktop/dist/main",
      ipcMain: ipc.ipcMain,
      locale: () => "zh-CN",
      theme: () => ({ mode: "dark", contrast: "high" }),
      devtoolsAllowed: () => true,
      liveBundlePath: () => "/repo/_research/engine-0.6.0/package/haruyuki.js",
      openWindow: (windowDeps: unknown) => {
        opened.push(windowDeps);

        return Promise.resolve(null);
      },
      ...overrides,
    } as unknown as Parameters<typeof import("../about-wiring.js").installAbout>[0],
  };
}

/**
 * A window double that survives being held at module scope.
 *
 * Every member `about-window.ts` calls while opening, focusing or closing has to
 * exist: the module keeps the object after the call returns, and the teardown
 * closes it. A partial double fails two tests later, in a different test, which
 * is the worst way to learn about it.
 */
function windowDouble(): {
  window: import("electron").BrowserWindow;
  closes: () => number;
  focused: () => number;
} {
  let closed = 0;
  let focused = 0;
  const handlers = new Map<string, () => void>();

  const window = {
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
    once: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
    webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() },
    isDestroyed: () => closed > 0,
    isMinimized: () => false,
    restore: vi.fn(),
    loadURL: () => Promise.resolve(),
    show: vi.fn(),
    focus: () => {
      focused += 1;
    },
    close: () => {
      closed += 1;
      handlers.get("closed")?.();
    },
  } as unknown as import("electron").BrowserWindow;

  return { window, closes: () => closed, focused: () => focused };
}

/** Open the window module's window with a double, so `dispose` has something. */
async function primeWindow(): Promise<{ closes: () => number }> {
  const windowModule = await import("../about-window.js");
  const double = windowDouble();

  await windowModule.openAboutWindow({
    here: "/repo/apps/desktop/dist/main",
    locale: "en",
    theme: "light",
    contrast: "normal",
    devtoolsAllowed: false,
    openExternal: () => undefined,
    createWindow: () => double.window,
  });

  return { closes: double.closes };
}

afterEach(async () => {
  // The window reference is a module-level singleton, so a window one test
  // created would be focused (or closed) by the next one. Tearing down through
  // the module's own function keeps this file honest about that state.
  const windowModule = await import("../about-window.js");

  windowModule.closeAboutWindow();
  vi.clearAllMocks();
});

describe("installAbout", () => {
  it("registers the two about channels and the update check the window calls", async () => {
    // Three, not two: the window's update button is answered by a handler that
    // belongs to this surface, so it is installed and torn down with it rather
    // than by the composition root. The list is exact so that a fourth entry
    // appearing here - or one of these going missing - fails once.
    const { installAbout } = await import("../about-wiring.js");
    const { deps, ipc } = installDeps();

    installAbout(deps);

    expect(ipc.handled).toEqual([
      "bridge:control.about.info",
      "bridge:control.about.open",
      "bridge:control.update.check",
    ]);
  });

  it("hands the menu entry an opener that opens the window", async () => {
    // The bug this catches: `open()` returns early, or calls something else.
    // Nothing else in the suite would notice, because the menu template and the
    // channels are both still correct.
    const { installAbout } = await import("../about-wiring.js");
    const { deps, opened } = installDeps();

    const about = installAbout(deps);

    about.open();

    expect(opened).toHaveLength(1);
  });

  it("passes the live theme, locale and inspector gate at click time", async () => {
    // Read per click, not captured at install time: the user can change the
    // theme or the locale while the shell runs, and a window opened afterwards
    // must paint in the one they chose.
    const { installAbout } = await import("../about-wiring.js");
    let locale = "en";
    let mode = "light";
    let allowed = false;
    const { deps, opened } = installDeps({
      locale: () => locale,
      theme: () => ({ mode, contrast: "normal" }),
      devtoolsAllowed: () => allowed,
    });

    const about = installAbout(deps);

    about.open();
    locale = "zh-CN";
    mode = "dark";
    allowed = true;
    about.open();

    expect(opened).toEqual([
      expect.objectContaining({ locale: "en", theme: "light", devtoolsAllowed: false }),
      expect.objectContaining({ locale: "zh-CN", theme: "dark", devtoolsAllowed: true }),
    ]);
  });

  it("gives the window the preload directory and the two link handlers", async () => {
    const { installAbout } = await import("../about-wiring.js");
    const { deps, opened } = installDeps();

    installAbout(deps).open();

    const passed = opened[0] as Record<string, unknown>;

    expect(passed["here"]).toBe("/repo/apps/desktop/dist/main");
    expect(typeof passed["openExternal"]).toBe("function");
    expect(typeof passed["onFailure"]).toBe("function");
  });

  it("routes a window failure to the log instead of swallowing it", async () => {
    const { installAbout } = await import("../about-wiring.js");
    const warn = vi.fn();
    const { deps, opened } = installDeps({ logger: { warn } });

    installAbout(deps).open();

    const passed = opened[0] as { onFailure: (detail: string) => void };

    passed.onFailure("ERR_FILE_NOT_FOUND");

    expect(warn).toHaveBeenCalledWith("about.window.failed", { detail: "ERR_FILE_NOT_FOUND" });
  });

  it("hands an external URL to the operating system", async () => {
    const { installAbout } = await import("../about-wiring.js");
    const { deps, opened } = installDeps();

    installAbout(deps).open();

    const passed = opened[0] as { openExternal: (url: string) => void };

    passed.openExternal("https://github.com/TZYLT/haruyuki-gui");

    expect(electronDouble.shell.openExternal).toHaveBeenCalledWith(
      "https://github.com/TZYLT/haruyuki-gui",
    );
  });
});

describe("dispose", () => {
  it("removes every channel it registered", async () => {
    const { installAbout } = await import("../about-wiring.js");
    const { deps, ipc } = installDeps();

    installAbout(deps).dispose();

    expect(ipc.removed).toEqual([
      "bridge:control.about.info",
      "bridge:control.about.open",
      "bridge:control.update.check",
    ]);
  });

  it("closes the window as well as removing the channels", async () => {
    // Leaving the window open after its handlers are gone shows a page whose
    // every button fails; that is the state this half prevents.
    const { installAbout } = await import("../about-wiring.js");
    const { deps } = installDeps();
    const primed = await primeWindow();

    installAbout(deps).dispose();

    expect(primed.closes()).toBe(1);
  });

  it("runs the whole teardown from the quit hook", async () => {
    // The composition root does not call `dispose` itself -- it hands this module
    // a hook and forgets about it. So the hook is the production teardown path,
    // and it must reach both halves: the handlers and the window.
    const { installAboutOnQuit } = await import("../about-wiring.js");
    const { deps, ipc } = installDeps();
    const registered: (() => void)[] = [];
    const primed = await primeWindow();

    installAboutOnQuit({
      ...deps,
      onQuit: (callback) => {
        registered.push(callback);
      },
    });

    expect(registered).toHaveLength(1);

    registered[0]!();

    expect(ipc.removed).toEqual([
      "bridge:control.about.info",
      "bridge:control.about.open",
      "bridge:control.update.check",
    ]);
    expect(primed.closes()).toBe(1);
  });

  it("is a no-op the second time", async () => {
    const { installAbout } = await import("../about-wiring.js");
    const { deps, ipc } = installDeps();

    const about = installAbout(deps);

    about.dispose();
    about.dispose();

    expect(ipc.removed).toHaveLength(3);
  });
});
