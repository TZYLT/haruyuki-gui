import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSpawnSpec,
  DESKTOP_CAPABILITIES,
  desktopPaths,
  ENGINE_HOME_ENV,
  engineEnvironment,
  ensurePaths,
  watchdogFor,
} from "../host-port.js";

/** A `getPath` that answers the names Electron actually accepts. */
function fakeGetPath(name: string): string {
  const answers: Record<string, string> = {
    userData: "C:/Users/x/AppData/Roaming/Haruyuki",
    logs: "C:/Users/x/AppData/Roaming/Haruyuki/logs",
    temp: "C:/Users/x/AppData/Local/Temp",
  };

  const answer = answers[name];
  if (answer === undefined) throw new Error(`getPath has no name ${name}`);

  return answer;
}

/** A bundle path that passes the absolute check on every platform under test. */
const BUNDLE = process.platform === "win32" ? "C:/engine/bundle.mjs" : "/engine/bundle.mjs";

/** Paths resolved once for the assertions below. */
const PATHS = desktopPaths(fakeGetPath);

/** Where the app lives, as `app.getAppPath()` would report it. */
const APP_PATH = process.platform === "win32" ? "C:/app" : "/app";

describe("capabilities", () => {
  it("claims exactly the three the desktop can honour", () => {
    expect(DESKTOP_CAPABILITIES).toEqual({
      canNotify: true,
      canReadDroppedFiles: true,
      canPopout: true,
      // Not a capability this item can claim: the difference from `canPopout` is
      // undefined (requirement T-4), and `true` would be a promise about a
      // behaviour nobody has specified.
      canFloatingWindow: false,
    });
  });

  it("is frozen, so a consumer cannot flip a capability at runtime", () => {
    expect(Object.isFrozen(DESKTOP_CAPABILITIES)).toBe(true);
  });
});

describe("paths", () => {
  it("composes cache under userData instead of asking Electron for it", () => {
    // `app.getPath` has no `cache` name; calling it throws at runtime rather than
    // returning a default. The fake above throws for that reason, so this
    // assertion fails if the implementation ever starts asking.
    //
    // Compared through `path.resolve` on both sides: `path.join` normalises
    // separators, so a literal "…/cache" string would fail on Windows for a
    // reason that has nothing to do with the behaviour under test.
    expect(path.resolve(PATHS.cache)).toBe(
      path.resolve("C:/Users/x/AppData/Roaming/Haruyuki", "cache"),
    );
  });

  it("takes logs from Electron rather than deriving it", () => {
    // `D1` decided logs resolve through `getPath("logs")`; deriving it would be a
    // second answer that drifts on macOS, where logs are not under userData.
    expect(PATHS.logs).toBe("C:/Users/x/AppData/Roaming/Haruyuki/logs");
  });

  it("keeps the engine home and the cache in the same tree", () => {
    // The real question is containment, not a text prefix: separators differ by
    // platform and a prefix test would pass on POSIX while failing on Windows.
    expect(path.relative(PATHS.userData, PATHS.cache)).toBe("cache");
  });
});

describe("engineEnvironment", () => {
  it("runs the child as Node rather than as a second shell", () => {
    const env = engineEnvironment({ PATH: "/usr/bin" }, "/w/watchdog.cjs", "/home/u");

    // Without this the child is another Electron app: no window, no server, and
    // the failure reads as "the engine produced no output".
    expect(env["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });

  it("points the engine at userData, which is also its cwd", () => {
    const env = engineEnvironment({}, "/w/watchdog.cjs", "/home/u");

    expect(env[ENGINE_HOME_ENV]).toBe("/home/u");
  });

  it("replaces NODE_OPTIONS rather than appending to it", () => {
    const env = engineEnvironment(
      { NODE_OPTIONS: "--max-old-space-size=4096" },
      "/w/watchdog.cjs",
      "/home/u",
    );

    // Appending would preload the watchdog twice or carry flags the engine child
    // must not inherit. The only preload it gets is ours.
    expect(env["NODE_OPTIONS"]).toBe('--require "/w/watchdog.cjs"');
    expect(env["NODE_OPTIONS"]).not.toContain("max-old-space-size");
  });

  it("copies the rest of the environment, which the caller will not merge again", () => {
    const env = engineEnvironment({ PATH: "/usr/bin", LANG: "C" }, "/w/watchdog.cjs", "/home/u");

    // The contract says `spec.env` is complete. A missing PATH makes the engine
    // unfindable on POSIX, and the failure looks like a spawn bug.
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["LANG"]).toBe("C");
  });

  it("drops entries Node cannot represent as strings", () => {
    const env = engineEnvironment(
      { PRESENT: "x", ABSENT: undefined },
      "/w/watchdog.cjs",
      "/home/u",
    );

    expect(env["PRESENT"]).toBe("x");
    expect("ABSENT" in env).toBe(false);
  });
});

describe("watchdogFor", () => {
  it("resolves against the app path, not this module's directory", () => {
    // The main bundle is built into `dist/main/`, while the watchdog ships beside
    // the engine bundle. Anchoring at the module would point inside `dist`.
    const resolved = watchdogFor("/app");

    expect(resolved).toContain("runtime/watchdog.cjs");
    expect(resolved).not.toContain("dist/main");
  });

  it("uses forward slashes on Windows, where NODE_OPTIONS is a command line", () => {
    const resolved = watchdogFor(process.platform === "win32" ? "C:\\app" : "/app");

    if (process.platform === "win32") {
      expect(resolved).not.toContain("\\");
    }
  });

  it("answers an absolute path on both platforms", () => {
    expect(
      watchdogFor(process.cwd()).startsWith("/") || /^[A-Za-z]:/.test(watchdogFor(process.cwd())),
    ).toBe(true);
  });
});

describe("buildSpawnSpec", () => {
  it("refuses a relative bundle path, because the child resolves it elsewhere", async () => {
    const result = await buildSpawnSpec(
      { bundlePath: "engine/bundle.mjs" },
      PATHS,
      () => true,
      APP_PATH,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("must be absolute");
  });

  it("refuses a missing bundle, and names the path so the reason is actionable", async () => {
    const result = await buildSpawnSpec({ bundlePath: BUNDLE }, PATHS, () => false, APP_PATH);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(BUNDLE);
  });

  it("reports a missing watchdog separately from a missing bundle", async () => {
    // Both are "a file is missing", but they are different failures to a user and
    // a single message would hide which artifact packaging left out.
    const result = await buildSpawnSpec(
      { bundlePath: BUNDLE },
      PATHS,
      (candidate) => candidate === BUNDLE,
      APP_PATH,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("watchdog");
  });

  it("builds a spec whose cwd is userData, so the engine writes one tree", async () => {
    const result = await buildSpawnSpec({ bundlePath: BUNDLE }, PATHS, () => true, APP_PATH);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.cwd).toBe(PATHS.userData);
    expect(result.spec.env[ENGINE_HOME_ENV]).toBe(PATHS.userData);
  });

  it("pipes both streams, because stdout carries the port line and stdin the signal", async () => {
    const result = await buildSpawnSpec({ bundlePath: BUNDLE }, PATHS, () => true, APP_PATH);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.stdio).toBe("pipe");
  });

  it("hides the console window on Windows, where a flash is a reported defect", async () => {
    const result = await buildSpawnSpec({ bundlePath: BUNDLE }, PATHS, () => true, APP_PATH);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.windowsHide).toBe(true);
  });

  it("detaches only on POSIX, where a process group exists", async () => {
    const result = await buildSpawnSpec({ bundlePath: BUNDLE }, PATHS, () => true, APP_PATH);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.detached).toBe(process.platform !== "win32");
  });

  it("passes the token FILE option and never a token value", async () => {
    const result = await buildSpawnSpec({ bundlePath: BUNDLE }, PATHS, () => true, APP_PATH);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The path is appended by `Engine.start`, which owns the token directory. A
    // value in argv would be a secret in the process list.
    expect(result.spec.argvPrefix).toContain("--ws-token-file");
    expect(result.spec.argvPrefix.some((arg) => arg.startsWith("--ws-token="))).toBe(false);
  });
});

describe("ensurePaths", () => {
  it("creates every root, tolerating ones that already exist", async () => {
    // A real temporary tree, not the fake `PATHS`. The earlier version asserted only
    // "does not throw" and then ran against a fabricated `C:/Users/x/...` answer, which
    // meant two problems: `ensurePaths` could have been emptied without failing the
    // test, and the test created a directory tree inside another user's profile.
    //
    // `mkdtemp` gives a path nobody else owns, so the assertion is about the code rather
    // than about a leftover on this machine.
    const root = await mkdtemp(path.join(tmpdir(), "haruyuki-ensure-"));
    const paths = {
      userData: path.join(root, "userData"),
      logs: path.join(root, "logs"),
      cache: path.join(root, "cache"),
      temp: path.join(root, "temp"),
    };

    await ensurePaths(paths);

    // The point of the function: they exist now.
    for (const dir of Object.values(paths)) {
      expect(statSync(dir).isDirectory(), dir).toBe(true);
    }

    // Called twice on purpose: the second call must not fail on EEXIST, because the
    // engine may already have written into a directory from a previous run.
    await expect(ensurePaths(paths)).resolves.toBeUndefined();

    // And the second call did not remove or replace anything.
    for (const dir of Object.values(paths)) {
      expect(statSync(dir).isDirectory(), dir).toBe(true);
    }
  });

  it("creates the cache root, which nothing else did", async () => {
    // The specific gap review found in the shell: `ensurePaths` existed and was called by
    // this file and the probe, but never by `main.ts`, so `paths.cache` pointed at a
    // directory that did not exist and no startup step missed it.
    const root = await mkdtemp(path.join(tmpdir(), "haruyuki-ensure2-"));
    const paths = {
      userData: path.join(root, "userData"),
      logs: path.join(root, "logs"),
      cache: path.join(root, "cache"),
      temp: path.join(root, "temp"),
    };

    await ensurePaths(paths);

    expect(statSync(paths.cache).isDirectory()).toBe(true);
  });
});
