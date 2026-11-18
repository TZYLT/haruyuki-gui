/**
 * The about window: what it creates, what it loads, and what it refuses.
 *
 * Every assertion here is about a decision this module makes on its own, and
 * each one is a decision that can be wrong while the rest of the suite stays
 * green -- which is exactly why this file exists. The three `webPreferences`
 * flags are a security boundary, not a preference: flipping any of them
 * opens the renderer to the host, and no other test would notice.
 *
 * The window itself is a double. `openAboutWindow` takes a `createWindow` seam
 * for precisely this: the facts worth asserting are the options handed to
 * Electron, the URL handed to `loadURL`, and the two navigation guards -- none of
 * which needs a browser process. What a double cannot prove (that the document
 * renders) is proven elsewhere, against a running shell.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";

import {
  ABOUT_DOCUMENT,
  ABOUT_HEIGHT,
  ABOUT_WIDTH,
  aboutUrl,
  closeAboutWindow,
  openAboutWindow,
  type AboutWindowDeps,
} from "../about-window.js";

/** The repository root, from this test file's location. */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

/** The Electron options one `createWindow` call received. */
type WindowOptions = ConstructorParameters<typeof BrowserWindow>[0];

/** One recorded window: the options it was built with and the URL it loaded. */
interface FakeWindow {
  readonly options: WindowOptions;
  readonly webContents: {
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  loadURLCalls: string[];
  /**
   * Optional because the recording literal is built first and `Object.assign`
   * fills the behaviours in; the "refused load" case replaces this one.
   */
  loadURL?: (url: string) => Promise<void>;
  destroyed: boolean;
  shown: boolean;
  focused: number;
  restored: number;
  readonly handlers: Map<string, (...args: unknown[]) => void>;
}

/**
 * Build one double that records everything the module does to a window.
 *
 * @param options the options Electron would have received
 * @returns the double, cast to what the module asks for
 */
function fakeWindow(options: WindowOptions): FakeWindow {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const window: FakeWindow = {
    options,
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(`contents:${event}`, handler);
      }),
    },
    loadURLCalls: [],
    destroyed: false,
    shown: false,
    focused: 0,
    restored: 0,
    handlers,
  };

  // `once` and `on` are the two registration points the module uses. Both record,
  // so a test can fire the event Electron would have fired.
  const asWindow = {
    ...window,
    webContents: window.webContents,
    isDestroyed: () => window.destroyed,
    isMinimized: () => false,
    restore: () => {
      window.restored += 1;
    },
    focus: () => {
      window.focused += 1;
    },
    show: () => {
      window.shown = true;
    },
    close: () => {
      window.destroyed = true;
      window.handlers.get("closed")?.();
    },
    once: (event: string, handler: (...args: unknown[]) => void) => {
      window.handlers.set(event, handler);
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      window.handlers.set(event, handler);
    },
    loadURL: (url: string) => {
      window.loadURLCalls.push(url);

      return Promise.resolve();
    },
  };

  return Object.assign(window, asWindow) as unknown as FakeWindow;
}

/** Deps for one call, with the window factory recording its options. */
function deps(overrides: Partial<AboutWindowDeps> = {}): {
  deps: AboutWindowDeps;
  windows: FakeWindow[];
} {
  const windows: FakeWindow[] = [];

  return {
    windows,
    deps: {
      here: path.join(REPO_ROOT, "apps", "desktop", "dist", "main"),
      locale: "en",
      theme: "dark",
      contrast: "high",
      devtoolsAllowed: false,
      openExternal: () => undefined,
      createWindow: (options) => {
        const window = fakeWindow(options);

        windows.push(window);

        return window as unknown as BrowserWindow;
      },
      ...overrides,
    },
  };
}

afterEach(() => {
  closeAboutWindow();
});

describe("the window it creates", () => {
  it("keeps the renderer sandboxed: sandbox, contextIsolation, nodeIntegration", async () => {
    // The three flags, one assertion each, so a failure names the flag that
    // moved. Any of them flipped is a security regression, not a layout change.
    const build = deps();
    await openAboutWindow(build.deps);

    const prefs = (build.windows[0]?.options?.webPreferences ?? {}) as Record<string, unknown>;

    expect(prefs["sandbox"]).toBe(true);
    expect(prefs["contextIsolation"]).toBe(true);
    expect(prefs["nodeIntegration"]).toBe(false);
  });

  it("loads the preload that sits beside the main bundle", async () => {
    // A wrong preload path fails silently: `window.haruyuki` is undefined, the
    // window looks fine, and every button on the page does nothing.
    const build = deps();
    await openAboutWindow(build.deps);

    const prefs = (build.windows[0]?.options?.webPreferences ?? {}) as Record<string, unknown>;

    expect(prefs["preload"]).toBe(
      path.join(REPO_ROOT, "apps", "desktop", "dist", "main", "preload.cjs"),
    );
  });

  it("does not let the page open a webview or the inspector unless allowed", async () => {
    const build = deps();
    await openAboutWindow(build.deps);

    const prefs = (build.windows[0]?.options?.webPreferences ?? {}) as Record<string, unknown>;

    expect(prefs["webviewTag"]).toBe(false);
    expect(prefs["devTools"]).toBe(false);
  });

  it("passes the inspector gate through rather than deciding its own answer", async () => {
    // `devTools` must be the composition root's gate, not a second opinion.
    const build = deps({ devtoolsAllowed: true });
    await openAboutWindow(build.deps);

    const prefs = (build.windows[0]?.options?.webPreferences ?? {}) as Record<string, unknown>;

    expect(prefs["devTools"]).toBe(true);
  });

  it("opens hidden and shows itself only when it is ready to paint", async () => {
    // `show: true` would paint a blank white rectangle first: the document has a
    // React root to mount, and the frame arrives after it.
    const build = deps();
    await openAboutWindow(build.deps);

    expect(build.windows[0]?.options?.show).toBe(false);

    build.windows[0]?.handlers.get("ready-to-show")?.();

    expect(build.windows[0]?.shown).toBe(true);
  });

  it("is a fixed small window, not one the user can collapse to nothing", async () => {
    const build = deps();
    await openAboutWindow(build.deps);

    expect(build.windows[0]?.options?.width).toBe(ABOUT_WIDTH);
    expect(build.windows[0]?.options?.height).toBe(ABOUT_HEIGHT);
    expect(build.windows[0]?.options?.minWidth).toBeGreaterThan(0);
    expect(build.windows[0]?.options?.minHeight).toBeGreaterThan(0);
  });
});

describe("the document it loads", () => {
  it("loads the about document over app://, not a file path", async () => {
    const build = deps();
    await openAboutWindow(build.deps);

    const url = build.windows[0]?.loadURLCalls[0] ?? "";

    expect(url.startsWith("app://haruyuki/")).toBe(true);
    expect(url.startsWith("file:")).toBe(false);
    expect(url).toContain(`/${ABOUT_DOCUMENT}`);
  });

  it("names a document that the renderer build actually produces", () => {
    // Two independent halves, because either can be wrong alone: the constant is
    // what this module loads, and the Vite input is what the build emits. A
    // renamed entry would leave `aboutUrl()` correct and the window blank.
    const rendered = path.join(REPO_ROOT, "apps", "desktop", "vite.renderer.mts");
    const source = readFileSync(rendered, "utf8");
    const match = /about:\s*path\.resolve\([^)]*"([^"]+)"\)/.exec(source);

    expect(match, "the renderer config has no about entry").not.toBeNull();
    expect(path.basename(match![1]!)).toBe(ABOUT_DOCUMENT);
  });

  it("has a built copy of the document on disk when a build exists", () => {
    // Skips only when nothing was built: the gate that runs on a clean checkout
    // must not require a build (the same rule the build-paths test follows).
    const built = path.join(REPO_ROOT, "apps", "desktop", "dist", "renderer", ABOUT_DOCUMENT);

    if (!existsSync(path.dirname(built))) return;

    expect(existsSync(built), `the build did not emit ${ABOUT_DOCUMENT}`).toBe(true);
  });

  it("carries the theme and the locale in the URL", () => {
    // A round trip after load would paint the default theme and then correct it,
    // which is a visible flash on every open.
    const url = aboutUrl("zh-CN", "dark", "high");

    expect(url).toBe("app://haruyuki/about.html?theme=dark&contrast=high&locale=zh-CN");
  });

  it("puts the boot parameters where the page reads them", async () => {
    const build = deps({ locale: "zh-CN", theme: "dark", contrast: "normal" });
    await openAboutWindow(build.deps);

    const url = new URL(build.windows[0]?.loadURLCalls[0] ?? "app://haruyuki/");

    expect(url.searchParams.get("theme")).toBe("dark");
    expect(url.searchParams.get("contrast")).toBe("normal");
    expect(url.searchParams.get("locale")).toBe("zh-CN");
  });

  it("reports a refused load instead of leaving a blank window silently", async () => {
    const onFailure = vi.fn();
    const build = deps({
      onFailure,
      createWindow: (options) => {
        const window = fakeWindow(options);

        window.loadURL = (url: string) => {
          window.loadURLCalls.push(url);

          return Promise.reject(new Error("ERR_FILE_NOT_FOUND"));
        };

        build.windows.push(window);

        return window as unknown as BrowserWindow;
      },
    });

    await openAboutWindow(build.deps);

    expect(onFailure).toHaveBeenCalledWith("ERR_FILE_NOT_FOUND");
  });
});

describe("the navigation guards", () => {
  it("denies a window.open and hands https links to the browser", async () => {
    const opened: string[] = [];
    const onFailure = vi.fn();
    const build = deps({
      openExternal: (url) => opened.push(url),
      onFailure,
    });

    await openAboutWindow(build.deps);

    const handler = build.windows[0]?.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
      ((details: { url: string }) => { action: string }) | undefined;

    expect(handler).toBeDefined();

    // An https link reaches the browser and the window stays put.
    expect(handler!({ url: "https://github.com/TZYLT/haruyuki-gui" })).toEqual({ action: "deny" });
    expect(opened).toEqual(["https://github.com/TZYLT/haruyuki-gui"]);

    // Anything else is refused *and* reported: a silent refusal looks like a
    // broken link.
    expect(handler!({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
    expect(opened).toHaveLength(1);
    expect(onFailure).toHaveBeenCalledWith(
      expect.stringContaining("refused to open a non-https link"),
    );
  });

  it("lets the page navigate inside app:// and stops it anywhere else", async () => {
    const opened: string[] = [];
    const build = deps({ openExternal: (url) => opened.push(url) });

    await openAboutWindow(build.deps);

    const navigate = build.windows[0]?.webContents.on.mock.calls.find(
      (call) => call[0] === "will-navigate",
    )?.[1] as ((event: { preventDefault: () => void }, url: string) => void) | undefined;

    expect(navigate).toBeDefined();

    const prevented = vi.fn();

    // A reload of the same document is the window's own business.
    navigate!({ preventDefault: prevented }, "app://haruyuki/about.html?theme=light");
    expect(prevented).not.toHaveBeenCalled();

    // A navigation away is blocked, and an https one still reaches the browser.
    navigate!({ preventDefault: prevented }, "https://example.com/");
    expect(prevented).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(["https://example.com/"]);
  });
});

describe("one window, not one per click", () => {
  it("focuses the open window on a second click instead of building a second one", async () => {
    // The menu item stays clickable; a second window per click would leave the
    // first one orphaned and would eventually stack them.
    const build = deps();

    const first = await openAboutWindow(build.deps);
    const second = await openAboutWindow(build.deps);

    expect(build.windows).toHaveLength(1);
    expect(second).toBe(first);
    expect(build.windows[0]?.focused).toBe(1);
    expect(build.windows[0]?.loadURLCalls).toHaveLength(1);
  });

  it("restores a minimized window before focusing it", async () => {
    const build = deps();
    await openAboutWindow(build.deps);

    const window = build.windows[0]!;
    const asWindow = window as unknown as { isMinimized: () => boolean };

    asWindow.isMinimized = () => true;

    await openAboutWindow(build.deps);

    expect(window.restored).toBe(1);
  });

  it("builds a new window after the previous one was closed", async () => {
    // The `closed` handler clears the module's reference; without it every later
    // click would focus a destroyed window, which throws inside Electron.
    const build = deps();

    await openAboutWindow(build.deps);
    build.windows[0]?.handlers.get("closed")?.();
    await openAboutWindow(build.deps);

    expect(build.windows).toHaveLength(2);
  });

  it("does not focus a window that is already destroyed", async () => {
    const build = deps();
    await openAboutWindow(build.deps);

    (build.windows[0] as unknown as { destroyed: boolean }).destroyed = true;

    await openAboutWindow(build.deps);

    expect(build.windows).toHaveLength(2);
  });
});

describe("closeAboutWindow", () => {
  it("closes the open window and forgets it", async () => {
    // Called from the quit path: the window must not outlive the process's
    // channels, so this is the teardown the composition root relies on.
    const build = deps();
    await openAboutWindow(build.deps);

    closeAboutWindow();

    expect(build.windows[0]?.destroyed).toBe(true);

    // And the next open is a fresh window, not a reference to the closed one.
    await openAboutWindow(build.deps);

    expect(build.windows).toHaveLength(2);
  });

  it("is a no-op when nothing is open", () => {
    // The quit path runs whether or not the user ever opened it.
    expect(() => closeAboutWindow()).not.toThrow();
  });

  it("is idempotent", async () => {
    const build = deps();
    await openAboutWindow(build.deps);

    closeAboutWindow();
    closeAboutWindow();

    expect(build.windows).toHaveLength(1);
  });
});
