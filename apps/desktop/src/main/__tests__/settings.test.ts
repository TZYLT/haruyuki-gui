import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOG_RETENTION,
  DEFAULT_SETTINGS,
  MAX_LOG_RETENTION_DAYS,
  MAX_LOG_TOTAL_MB,
  MIN_LOG_RETENTION_DAYS,
  MIN_LOG_TOTAL_MB,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  SETTINGS_VERSION,
  isWindowVisible,
  parseSettings,
  readSettings,
  serializeSettings,
  settingsPath,
  type LogsProblem,
  type ShellSettings,
} from "../settings.js";

describe("settingsPath", () => {
  it("puts the file in userData and nowhere else", () => {
    const userData = process.platform === "win32" ? "C:\\Users\\x\\AppData" : "/home/x/.config";

    expect(settingsPath(userData)).toBe(path.join(userData, "shell-settings.json"));
  });
});

describe("the window minimum", () => {
  it("matches the requirement's numbers, not a value of our own", () => {
    // The regression this exists for: the constants said 480×360 while
    // `D1-Q27` said 1024×700, and every test compared against the constants --
    // so the suite agreed with the code and neither agreed with the document.
    // Asserting the literals is what lets a document and a constant disagree and
    // fail. Changing these numbers is a requirement change, not a refactor.
    expect(MIN_WINDOW_WIDTH).toBe(1024);
    expect(MIN_WINDOW_HEIGHT).toBe(700);
  });

  it("accepts a saved window exactly at the minimum", () => {
    const parsed = parseSettings(
      JSON.stringify({
        window: { x: 0, y: 0, width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT },
      }),
    );

    expect(parsed.window).not.toBeNull();
  });

  it("refuses a saved window one pixel below the minimum on either axis", () => {
    for (const [width, height] of [
      [MIN_WINDOW_WIDTH - 1, MIN_WINDOW_HEIGHT],
      [MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT - 1],
    ]) {
      const parsed = parseSettings(JSON.stringify({ window: { x: 0, y: 0, width, height } }));

      expect(parsed.window, `${String(width)}x${String(height)}`).toBeNull();
    }
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
        window: { x: 10, y: 20, width: 1100, height: 700, maximized: false },
      }),
    );

    expect(settings.theme).toBe("light");
    expect(settings.contrast).toBe("high");
    expect(settings.window).toEqual({ x: 10, y: 20, width: 1100, height: 700, maximized: false });
  });

  it("ignores an unsupported locale", () => {
    expect(parseSettings(JSON.stringify({ locale: "fr" })).locale).toBe("en");
  });

  it("distinguishes 'never chose a locale' from 'chose English'", () => {
    // Regression: both used to parse to `"en"`, so the launch-locale resolver
    // could not tell a first launch from a deliberate choice and always kept
    // English. A first launch on a Chinese machine therefore opened in English.
    expect(parseSettings("").locale).toBeNull();
    expect(parseSettings("{}").locale).toBeNull();
    expect(parseSettings(JSON.stringify({ locale: null })).locale).toBeNull();
    expect(parseSettings(JSON.stringify({ locale: "en" })).locale).toBe("en");
  });

  it("round-trips a settings document whose locale was never chosen", () => {
    const parsed = parseSettings(serializeSettings(DEFAULT_SETTINGS));

    expect(parsed.locale).toBeNull();
  });

  it("treats a non-boolean maximized as false", () => {
    const settings = parseSettings(
      JSON.stringify({ window: { x: 0, y: 0, width: 1280, height: 800, maximized: "yes" } }),
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
      { x: 0, width: 1280, height: 800 },
      { x: 0, y: null, width: 1280, height: 800 },
      { x: "0", y: 0, width: 1280, height: 800 },
      { x: 0, y: 0, width: 1280 },
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

    // The five fields D1 wrote, plus the optional `logs` section D4 added. An
    // exact key set would need editing for every future field; this states what
    // the parser must produce instead.
    const keys = Object.keys(settings).sort();
    const known = ["contrast", "locale", "theme", "version", "window"];

    expect(keys).toEqual(expect.arrayContaining(known));
    expect(keys.filter((key) => key !== "logs")).toEqual(known);
  });
});

describe("the log retention section", () => {
  it("matches the requirement's defaults and ranges", () => {
    // Literals from `32` section 6.5, asserted rather than compared against the
    // constants: that is the only way a document and the code can disagree and
    // fail. Changing them is a requirement change.
    expect(DEFAULT_LOG_RETENTION).toEqual({ retentionDays: 7, maxTotalMb: 50 });
    expect([MIN_LOG_RETENTION_DAYS, MAX_LOG_RETENTION_DAYS]).toEqual([1, 90]);
    expect([MIN_LOG_TOTAL_MB, MAX_LOG_TOTAL_MB]).toEqual([10, 1000]);

    const low = parseSettings(JSON.stringify({ logs: { retentionDays: 1, maxTotalMb: 10 } }));
    const high = parseSettings(JSON.stringify({ logs: { retentionDays: 90, maxTotalMb: 1000 } }));

    expect(low.logs).toEqual({ retentionDays: 1, maxTotalMb: 10 });
    expect(high.logs).toEqual({ retentionDays: 90, maxTotalMb: 1000 });
  });

  it("stays absent when the file never set it", () => {
    // Absent means "use the defaults", and a write must not turn that into a
    // choice the user never made (`32` section 6.5: 缺失 → 用默认值，不写回).
    expect(parseSettings(JSON.stringify({ theme: "dark" })).logs).toBeUndefined();
    expect(parseSettings("").logs).toBeUndefined();
  });

  it("falls back per field, so one bad number does not discard the other", () => {
    const cases: readonly [unknown, number, number][] = [
      [{ retentionDays: 0, maxTotalMb: 200 }, 7, 200],
      [{ retentionDays: 91, maxTotalMb: 200 }, 7, 200],
      [{ retentionDays: 30, maxTotalMb: 9 }, 30, 50],
      [{ retentionDays: 30, maxTotalMb: 1001 }, 30, 50],
      [{ retentionDays: 7.5, maxTotalMb: 50 }, 7, 50],
      [{ retentionDays: "30", maxTotalMb: null }, 7, 50],
      [{}, 7, 50],
    ];

    for (const [logs, days, totalMb] of cases) {
      expect(parseSettings(JSON.stringify({ logs })).logs, JSON.stringify(logs)).toEqual({
        retentionDays: days,
        maxTotalMb: totalMb,
      });
    }
  });

  it("falls back to the default pair when the section is not an object", () => {
    for (const logs of [null, "7", 7, true, [], [{ retentionDays: 30, maxTotalMb: 50 }]]) {
      expect(parseSettings(JSON.stringify({ logs })).logs, JSON.stringify(logs)).toEqual(
        DEFAULT_LOG_RETENTION,
      );
    }
  });

  it("reports what was wrong so the caller can log settings.logs.invalid", () => {
    const problems: LogsProblem[] = [];
    const read = readSettings(JSON.stringify({ logs: { retentionDays: -1, maxTotalMb: 50 } }), {
      onLogsInvalid: (found) => problems.push(...found),
    });

    expect(problems).toEqual(["retentionDays"]);
    expect(read.settings.logs).toEqual({ retentionDays: 7, maxTotalMb: 50 });

    // A valid pair and an absent section are not problems; reporting them would
    // put a warning in the log of every healthy launch.
    problems.length = 0;
    readSettings(JSON.stringify({ logs: { retentionDays: 30, maxTotalMb: 200 } }), {
      onLogsInvalid: (found) => problems.push(...found),
    });
    readSettings(JSON.stringify({ theme: "dark" }), {
      onLogsInvalid: (found) => problems.push(...found),
    });

    expect(problems).toEqual([]);
  });

  it("uses the defaults, not a newer document's section, when it may not write", () => {
    // The section's meaning in a newer format is not this build's to guess.
    const problems: LogsProblem[] = [];
    const read = readSettings(
      JSON.stringify({
        version: SETTINGS_VERSION + 1,
        logs: { retentionDays: 30, maxTotalMb: 200 },
      }),
      { onLogsInvalid: (found) => problems.push(...found) },
    );

    expect(read.writable).toBe(false);
    expect(read.settings.logs).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it("round-trips through the serialiser without bumping the version", () => {
    const original: ShellSettings = {
      ...DEFAULT_SETTINGS,
      theme: "dark",
      logs: { retentionDays: 30, maxTotalMb: 200 },
    };
    const document = JSON.parse(serializeSettings(original)) as Record<string, unknown>;

    expect(document.version).toBe(1);
    expect(SETTINGS_VERSION).toBe(1);
    expect(document.logs).toEqual({ retentionDays: 30, maxTotalMb: 200 });
    expect(parseSettings(serializeSettings(original))).toEqual(original);

    // A document that never set the section must not gain one: writing the
    // defaults back would turn "unset" into "chose 7/50".
    const plain = JSON.parse(serializeSettings(DEFAULT_SETTINGS)) as Record<string, unknown>;

    expect(plain).not.toHaveProperty("logs");
    expect(Object.keys(plain).sort()).toEqual(["contrast", "locale", "theme", "version", "window"]);
  });
});

describe("the format version", () => {
  it("writes the version this build understands", () => {
    const document = JSON.parse(serializeSettings(DEFAULT_SETTINGS)) as Record<string, unknown>;

    expect(document.version).toBe(SETTINGS_VERSION);
  });

  it("puts the version first, because a reader needs it before anything else", () => {
    const keys = Object.keys(JSON.parse(serializeSettings(DEFAULT_SETTINGS)) as object);

    expect(keys[0]).toBe("version");
  });

  it("treats a missing version as this build's own", () => {
    // Every file written before the field existed was written by this build, so
    // refusing to write those would strand every existing install.
    const read = readSettings(JSON.stringify({ theme: "dark" }));

    expect(read.foundVersion).toBeNull();
    expect(read.writable).toBe(true);
    expect(read.settings.theme).toBe("dark");
  });

  it("accepts a file at the current version", () => {
    const read = readSettings(JSON.stringify({ version: SETTINGS_VERSION, theme: "dark" }));

    expect(read.foundVersion).toBe(SETTINGS_VERSION);
    expect(read.writable).toBe(true);
  });

  it("reads a newer version but refuses to write it back", () => {
    // The case this rule exists for: a newer build wrote the file, then the user
    // opened an older one. Writing would drop the fields this build cannot
    // represent, and the newer build would find them gone.
    const read = readSettings(
      JSON.stringify({ version: SETTINGS_VERSION + 1, theme: "dark", futureField: { a: 1 } }),
    );

    expect(read.foundVersion).toBe(SETTINGS_VERSION + 1);
    expect(read.writable).toBe(false);
    // Reading still works: the values this build knows are returned, so the
    // window still opens where it should. Only the write is refused.
    expect(read.settings.theme).toBe("dark");
  });

  it("is not talked into a newer version by a string or a fraction", () => {
    // Only a positive integer is a version. `"2"` and `2.5` are not documents this
    // build wrote, and honouring them would mean guessing at a format.
    for (const bogus of ["2", 2.5, null, -1, 0]) {
      const read = readSettings(JSON.stringify({ version: bogus }));

      expect(read.foundVersion, JSON.stringify(bogus)).toBeNull();
      expect(read.writable, JSON.stringify(bogus)).toBe(true);
    }
  });

  it("keeps the write verdict next to the values, so they cannot drift apart", () => {
    // A caller that took the values but not the verdict would write a downgraded
    // file the moment the window moved.
    const read = readSettings(JSON.stringify({ version: SETTINGS_VERSION + 1 }));

    expect(Object.keys(read).sort()).toEqual(["corrupt", "foundVersion", "settings", "writable"]);
  });
});

describe("a settings document that exists but cannot be understood", () => {
  it("is reported as corrupt, not as a first launch", () => {
    // The two are different events to a user: a first launch is normal, a corrupt
    // file means preferences were silently lost and something is writing it badly.
    // Collapsing them is why a half-written file goes unnoticed until someone asks
    // why settings never stick.
    for (const raw of ["{", "null", "42", '"dark"', "[]", '{"theme":']) {
      const read = readSettings(raw);

      expect(read.corrupt, raw).toBe(true);
    }
  });

  it("does not call an empty file corrupt", () => {
    // An empty file is one that was created and not yet written. Reporting it would
    // put a warning in the log of every first launch that happens to touch the file.
    expect(readSettings("").corrupt).toBe(false);
    expect(readSettings("   \n").corrupt).toBe(false);
  });

  it("does not call a valid document corrupt", () => {
    expect(readSettings(JSON.stringify({ theme: "dark" })).corrupt).toBe(false);
  });

  it("still returns usable values when the document is corrupt", () => {
    // Corrupt is a verdict about the file, not a reason to stop. The window still
    // opens with defaults, which is the whole point of not treating this as fatal.
    const read = readSettings("{");

    expect(read.settings).toEqual(DEFAULT_SETTINGS);
    expect(read.writable).toBe(true);
  });
});

describe("serializeSettings", () => {
  it("round-trips through the parser", () => {
    const original: ShellSettings = {
      version: SETTINGS_VERSION,
      theme: "dark",
      contrast: "high",
      locale: "zh-CN",
      window: { x: 12, y: 34, width: 1280, height: 800, maximized: false },
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
      window: { x: 10.7, y: 20.2, width: 1024.5, height: 700.4, maximized: false },
    });

    expect(JSON.parse(serialized).window).toEqual({
      x: 11,
      y: 20,
      width: 1025,
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
