/**
 * The runtime layout is the one place that answers "where is the engine, the
 * watchdog and the lock". These tests pin the two shapes that matter:
 *
 *   packaged  the engine and watchdog must be real files under `resources/`,
 *             while the lock must be inside `app.asar`;
 *   dev       the engine must come from `_research`, not from a packaged path.
 *
 * A wrong answer here fails as "the engine is missing" or "the watchdog never
 * printed", never as a path error. That is why the assertions name the full
 * paths rather than checking only that a string is non-empty.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import { computeRuntimeLayout, type RuntimeFacts } from "../runtime/layout.js";

/** A packaged install under Program Files, with a space in the product name. */
const PACKAGED: RuntimeFacts = {
  isPackaged: true,
  appPath: "C:\\Program Files\\Haruyuki 应用\\resources\\app.asar",
  resourcesPath: "C:\\Program Files\\Haruyuki 应用\\resources",
  here: "C:\\Program Files\\Haruyuki 应用\\resources\\app.asar\\dist\\main",
  userData: "C:\\Users\\测试 用户\\AppData\\Roaming\\Haruyuki",
  logsDir: "C:\\Users\\测试 用户\\AppData\\Roaming\\Haruyuki\\logs",
};

/** A checkout at the canonical J: drive, with dist/main as __dirname. */
const DEV: RuntimeFacts = {
  isPackaged: false,
  appPath: "J:\\Projects\\Haruyuki-desktop\\apps\\desktop",
  resourcesPath: "J:\\Projects\\Haruyuki-desktop\\apps\\desktop",
  here: "J:\\Projects\\Haruyuki-desktop\\apps\\desktop\\dist\\main",
  userData: "J:\\Users\\tester\\AppData\\Roaming\\Haruyuki",
  logsDir: "J:\\Users\\tester\\AppData\\Roaming\\Haruyuki\\logs",
};

describe("computeRuntimeLayout", () => {
  it("puts the engine and watchdog under resources, outside app.asar", () => {
    const layout = computeRuntimeLayout(PACKAGED);

    expect(layout.mode).toBe("packaged");
    expect(layout.resourcesRoot).toBe(PACKAGED.resourcesPath);
    expect(layout.engineDir).toBe(path.join(PACKAGED.resourcesPath, "engine"));
    expect(layout.bundlePath).toBe(path.join(PACKAGED.resourcesPath, "engine", "haruyuki.js"));
    expect(layout.watchdogPath).toBe(path.join(PACKAGED.resourcesPath, "runtime", "watchdog.cjs"));
    expect(layout.watchdogPath).not.toContain("app.asar");
    expect(layout.bundlePath).not.toContain("app.asar");
  });

  it("keeps the lock inside app.asar and the state under userData", () => {
    const layout = computeRuntimeLayout(PACKAGED);

    expect(layout.appRoot).toBe(PACKAGED.appPath);
    expect(layout.lockPath).toBe(path.join(PACKAGED.appPath, "runtime-lock.json"));
    expect(layout.lockPath).toContain("app.asar");
    expect(layout.statePath).toBe(path.join(PACKAGED.userData, "runtime-state.json"));
    expect(layout.logsDir).toBe(PACKAGED.logsDir);
  });

  it("preserves spaces and non-ASCII in every derived path", () => {
    const layout = computeRuntimeLayout(PACKAGED);

    expect(layout.engineDir).toContain("Haruyuki 应用");
    expect(layout.bundlePath).toContain("Haruyuki 应用");
    expect(layout.statePath).toContain("测试 用户");
  });

  it("uses _research and the source watchdog in dev", () => {
    const layout = computeRuntimeLayout(DEV);

    expect(layout.mode).toBe("dev");
    expect(layout.appRoot).toBe(path.resolve(DEV.here, "..", ".."));
    expect(layout.engineDir).toBe(
      path.resolve("J:\\Projects\\Haruyuki-desktop", "_research", "engine-0.6.0", "package"),
    );
    expect(layout.bundlePath).toBe(
      path.resolve(
        "J:\\Projects\\Haruyuki-desktop",
        "_research",
        "engine-0.6.0",
        "package",
        "haruyuki.js",
      ),
    );
    expect(layout.watchdogPath).toBe(
      path.resolve(
        "J:\\Projects\\Haruyuki-desktop",
        "packages",
        "core",
        "src",
        "runtime",
        "watchdog.cjs",
      ),
    );
    expect(layout.lockPath).toBe(
      path.resolve("J:\\Projects\\Haruyuki-desktop", "apps", "desktop", "runtime-lock.json"),
    );
  });

  it("does not use app.getAppPath() as the resources root in packaged builds", () => {
    const layout = computeRuntimeLayout(PACKAGED);

    expect(layout.resourcesRoot).not.toBe(layout.appRoot);
    expect(layout.resourcesRoot.endsWith("resources")).toBe(true);
  });

  it.each([
    ["appPath", { ...PACKAGED, appPath: "" }],
    ["resourcesPath", { ...PACKAGED, resourcesPath: "  " }],
    ["here", { ...PACKAGED, here: "" }],
    ["userData", { ...PACKAGED, userData: "" }],
    ["logsDir", { ...PACKAGED, logsDir: "" }],
  ])("rejects an empty %s instead of resolving it to cwd", (name, facts) => {
    expect(() => computeRuntimeLayout(facts)).toThrowError(
      new RegExp(`${name} must be a non-empty path`),
    );
  });
});
