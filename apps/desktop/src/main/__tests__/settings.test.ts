import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  isWindowVisible,
  parseSettings,
  serializeSettings,
  settingsPath,
  type ShellSettings,
} from "../settings.js";

describe("settingsPath", () => {
  it("puts the file in userData and nowhere else", () => {
    const userData = process.platform === "win32" ? "C:\\Users\\x\\AppData" : "/home/x/.config";

    expect(settingsPath(userData)).toBe(path.join(userData, "shell-settings.json"));
  });
});

describe("parseSettings", () => {
  it("returns the defaults for an empty file", () => {
    expect(parseSettings("")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("   \n")).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the defaults for a document that is not JSON", () => {
    // A crash mid-write leaves a truncated file. This is the common case, not an
    // exceptional one.
    expect(parseSettings('{"theme": "dark"')).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the defaults for JSON that is not an object", () => {
    expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("42")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('"dark"')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("[]")).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid values", () => {
    const settings = parseSettings(
      JSON.stringify({
        theme: "dark",
        contrast: "high",
        locale: "zh-CN",
        window: { x: 100, y: 50, width: 1280, height: 800, maximized: true },
      }),
    );

    expect(settings.theme).toBe("dark");
    expect(settings.contrast).toBe("high");
    expect(settings.locale).toBe("zh-CN");
    expect(settings.window).toEqual({ x: 100, y: 50, width: 1280, height: 800, maximized: true });
  });

  it("falls back per field rather than discarding the whole document", () => {
    // One bad theme must not lose the window position: that would move the
    // window on every launch until the theme is fixed.
    const settings = parseSettings(
      JSON.stringify({
        theme: "neon",
        contrast: "high",
        locale: "en",
        window: { x: 10, y: 20, width: 1000, height: 700, maximized: false },
      }),
    );

    expect(settings.theme).toBe("light");
    expect(settings.contrast).toBe("high");
    expect(settings.window).toEqual({ x: 10, y: 20, width: 1000, height: 700, maximized: false });
  });

  it("ignores an unsupported locale", () => {
    expect(parseSettings(JSON.stringify({ locale: "fr" })).locale).toBe("en");
  });

  it("treats a non-boolean maximized as false", () => {
    const settings = parseSettings(
      JSON.stringify({ window: { x: 0, y: 0, width: 900, height: 700, maximized: "yes" } }),
    );

    expect(settings.window?.maximized).toBe(false);
  });

  it("refuses a window whose width is below the minimum", () => {
    const settings = parseSettings(
      JSON.stringify({ window: { x: 0, y: 0, width: MIN_WINDOW_WIDTH - 1, height: 700 } }),
    );

    expect(settings.window).toBeNull();
  });

  it("refuses a window whose height is below the minimum", () => {
    const settings = parseSettings(
      JSON.stringify({ window: { x: 0, y: 0, width: 900, height: MIN_WINDOW_HEIGHT - 1 } }),
    );

    expect(settings.window).toBeNull();
  });

  it("refuses a window with a missing or non-finite coordinate", () => {
    // All or nothing: a half-specified rectangle is not a window the user had.
    for (const window of [
      { x: 0, width: 900, height: 700 },
      { x: 0, y: null, width: 900, height: 700 },
      { x: "0", y: 0, width: 900, height: 700 },
      { x: 0, y: 0, width: 900 },
    ]) {
      expect(parseSettings(JSON.stringify({ window })).window).toBeNull();
    }
  });

  it("refuses a window that is not an object", () => {
    expect(parseSettings(JSON.stringify({ window: "somewhere" })).window).toBeNull();
    expect(parseSettings(JSON.stringify({ window: 5 })).window).toBeNull();
    expect(parseSettings(JSON.stringify({ window: null })).window).toBeNull();
  });

  it("is not confused by extra keys", () => {
    const settings = parseSettings(
      JSON.stringify({ theme: "dark", devtools: true, unknown: { deep: 1 } }),
    );

    expect(settings.theme).toBe("dark");
    expect(Object.keys(settings).sort()).toEqual(["contrast", "locale", "theme", "window"]);
  });
});

describe("serializeSettings", () => {
  it("round-trips through the parser", () => {
    const original: ShellSettings = {
      theme: "dark",
      contrast: "high",
      locale: "zh-CN",
      window: { x: 12, y: 34, width: 1000, height: 700, maximized: false },
    };

    expect(parseSettings(serializeSettings(original))).toEqual(original);
  });

  it("round-trips a null window", () => {
    const original: ShellSettings = { ...DEFAULT_SETTINGS, window: null };

    expect(parseSettings(serializeSettings(original))).toEqual(original);
  });

  it("ends with a newline so the file is a text file", () => {
    expect(serializeSettings(DEFAULT_SETTINGS).endsWith("\n")).toBe(true);
  });

  it("rounds the geometry to whole DIP", () => {
    // A fractional coordinate is a scale-factor artefact, not a position the user
    // chose, and it accumulates drift on every save.
    const serialized = serializeSettings({
      ...DEFAULT_SETTINGS,
      window: { x: 10.7, y: 20.2, width: 900.5, height: 700.4, maximized: false },
    });

    expect(JSON.parse(serialized).window).toEqual({
      x: 11,
      y: 20,
      width: 901,
      height: 700,
      maximized: false,
    });
  });

  it("writes the keys in a fixed order", () => {
    expect(serializeSettings(DEFAULT_SETTINGS).indexOf('"theme"')).toBeLessThan(
      serializeSettings(DEFAULT_SETTINGS).indexOf('"window"'),
    );
  });
});

describe("isWindowVisible", () => {
  const primary = { x: 0, y: 0, width: 2048, height: 1152 };
  const secondary = { x: 2048, y: 0, width: 1920, height: 1080 };

  it("accepts a window fully on the primary display", () => {
    expect(isWindowVisible({ x: 100, y: 100, width: 1024, height: 768 }, [primary])).toBe(true);
  });

  it("accepts a window on a second display", () => {
    expect(
      isWindowVisible({ x: 2200, y: 100, width: 1024, height: 768 }, [primary, secondary]),
    ).toBe(true);
  });

  it("refuses a window whose display is gone", () => {
    // The saved coordinates outlive the layout: the monitor was unplugged between
    // launches and the window would restore off-screen.
    expect(isWindowVisible({ x: 2200, y: 100, width: 1024, height: 768 }, [primary])).toBe(false);
  });

  it("refuses a window far outside every display", () => {
    expect(isWindowVisible({ x: -5000, y: -5000, width: 1024, height: 768 }, [primary])).toBe(
      false,
    );
  });

  it("accepts a window deliberately pushed to an edge", () => {
    // Most of it off-screen but a grab handle visible: usable, and not ours to
    // overrule.
    expect(isWindowVisible({ x: 2000, y: 100, width: 1024, height: 768 }, [primary])).toBe(true);
  });

  it("refuses a window with only a sliver showing", () => {
    expect(isWindowVisible({ x: 2047, y: 100, width: 1024, height: 768 }, [primary])).toBe(false);
  });

  it("refuses when there are no displays at all", () => {
    // Defensive: `screen.getAllDisplays()` is never empty in practice, but a
    // restore path that assumes otherwise would be a crash in the one case it
    // cannot test.
    expect(isWindowVisible({ x: 0, y: 0, width: 800, height: 600 }, [])).toBe(false);
  });
});
