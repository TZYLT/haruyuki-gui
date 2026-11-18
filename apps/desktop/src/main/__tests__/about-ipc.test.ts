/**
 * The about channels at the main-process boundary.
 *
 * Two questions, and the second is the one that matters for acceptance: the
 * facts must be readable from disk with no network at all, and the three legal
 * entries must open a *file inside the package* rather than a URL. A handler
 * that reached the network would pass every test that only checked the shape,
 * so the fetch here is a triple that fails the test when called.
 *
 * No Electron: the `ipcMain` and `shell.openPath` are fakes, and the state file
 * is written to a temporary directory.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ABOUT_INFO_CHANNEL, ABOUT_OPEN_CHANNEL, CHANNEL_ALLOWLIST } from "../../shared/bridge.js";
import {
  ABOUT_DOC_FILES,
  ABOUT_ISSUE_URL,
  ABOUT_REPO_URL,
  legalDocRoots,
  registerAboutIpc,
  resolveLegalDoc,
  type AboutInfo,
  type AboutIpcMain,
  type AboutPathFacts,
} from "../about-ipc.js";

/** A recording `ipcMain`. */
class FakeIpc implements AboutIpcMain {
  readonly handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

  registerCalls = 0;

  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void {
    this.registerCalls += 1;
    this.handlers.set(channel, listener);
  }

  invoke(channel: string, payload?: unknown): unknown {
    const handler = this.handlers.get(channel);

    if (handler === undefined) throw new Error(`no handler for ${channel}`);

    return handler({}, payload);
  }
}

/** Directories each test creates, removed afterwards. */
const created: string[] = [];

/**
 * Make a temporary `userData`, optionally with a `runtime-state.json`.
 *
 * @param state the state document to write, or `null` for an absent file
 * @returns the directory
 */
async function userDataWith(state: unknown | null): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "haruyuki-about-"));

  created.push(dir);

  if (state !== null) {
    await writeFile(path.join(dir, "runtime-state.json"), JSON.stringify(state), "utf8");
  }

  return dir;
}

/** A packaged layout: the documents sit beside the executable. */
const PACKAGED: AboutPathFacts = {
  isPackaged: true,
  exeDir: "/opt/haruyuki",
  resourcesPath: "/opt/haruyuki/resources",
  appPath: "/opt/haruyuki/resources/app.asar",
  devRoot: "/repo",
};

/** The state a successful earlier launch leaves. */
const VERIFIED = {
  stateVersion: 1,
  lastAppVersion: "0.1.0",
  lastVerifiedAt: "2026-11-18T00:00:00.000Z",
  lastResult: "ok",
};

/**
 * A lock that passes `readRuntimeLock`'s shape check.
 *
 * Written out in full rather than stubbing the reader: the assertion under test
 * is "the version comes from the lock", and a stub would let a wrong field name
 * pass.
 */
const VALID_LOCK = {
  lockVersion: 1,
  engineVersion: "0.6.0",
  bundle: { name: "haruyuki", entry: "haruyuki.js", bytes: 1234 },
  sha256: "a".repeat(64),
  source: { kind: "npm", spec: "@haruyuki/engine@0.6.0" },
  builtAt: "2026-11-18T00:00:00.000Z",
  runtime: { electron: "45.3.2", node: "24.22.3", modules: "150" },
  tree: { files: 1, bytes: 1234, sha256: "b".repeat(64) },
};

/** Build the deps one handler call needs, with everything fake. */
function deps(overrides: {
  userData: string;
  lockPath?: string;
  engineDir?: string;
  exists?: (target: string) => boolean;
  liveBundlePath?: () => string | null;
  openPath?: (target: string) => Promise<string>;
  paths?: AboutPathFacts;
}): {
  ipc: FakeIpc;
  openPath: ReturnType<typeof vi.fn>;
  deps: Parameters<typeof registerAboutIpc>[0];
} {
  const ipc = new FakeIpc();
  const openPath = vi.fn(overrides.openPath ?? (() => Promise.resolve("")));

  return {
    ipc,
    openPath,
    deps: {
      ipc,
      appVersion: () => "0.1.0",
      userData: overrides.userData,
      engineDir: overrides.engineDir ?? "/opt/haruyuki/resources/engine",
      lockPath: overrides.lockPath ?? "/opt/haruyuki/resources/app.asar/runtime-lock.json",
      paths: overrides.paths ?? PACKAGED,
      versions: {
        electron: "45.3.2",
        node: "24.22.3",
        platform: "win32",
        arch: "x64",
      },
      openPath,
      exists: overrides.exists ?? (() => true),
      ...(overrides.liveBundlePath === undefined
        ? {}
        : { liveBundlePath: overrides.liveBundlePath }),
    },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();

  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("the channels are the allowlisted ones", () => {
  it("registers both names the shared module declares", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({ userData });

    registerAboutIpc(build.deps);

    expect(build.ipc.registerCalls).toBe(2);
    expect(build.ipc.handlers.has(ABOUT_INFO_CHANNEL)).toBe(true);
    expect(build.ipc.handlers.has(ABOUT_OPEN_CHANNEL)).toBe(true);
    expect(CHANNEL_ALLOWLIST).toContain(ABOUT_INFO_CHANNEL);
    expect(CHANNEL_ALLOWLIST).toContain(ABOUT_OPEN_CHANNEL);
  });

  it("treats a second registration as a no-op", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({ userData });

    registerAboutIpc(build.deps);
    registerAboutIpc(build.deps);

    // `ipcMain.handle` throws on a second handler for one channel, and a window
    // reload is a normal thing to happen.
    expect(build.ipc.registerCalls).toBe(2);
  });
});

describe("about.info", () => {
  it("answers the facts from disk without touching the network", async () => {
    const fetchDouble = vi.fn(() => {
      throw new Error("about.info must not reach the network");
    });

    vi.stubGlobal("fetch", fetchDouble);

    const userData = await userDataWith(VERIFIED);
    const build = deps({ userData });

    registerAboutIpc(build.deps);

    const info = (await build.ipc.invoke(ABOUT_INFO_CHANNEL)) as AboutInfo;

    expect(fetchDouble).not.toHaveBeenCalled();
    expect(info.appVersion).toBe("0.1.0");
    expect(info.repoUrl).toBe(ABOUT_REPO_URL);
    expect(info.issueUrl).toBe(ABOUT_ISSUE_URL);
    expect(info.runtime).toEqual({
      electron: "45.3.2",
      node: "24.22.3",
      platform: "win32",
      arch: "x64",
    });
  });

  it("reports the verification the state file recorded", async () => {
    const userData = await userDataWith({ ...VERIFIED, lastResult: "tree-mismatch" });
    const build = deps({ userData });

    registerAboutIpc(build.deps);

    const info = (await build.ipc.invoke(ABOUT_INFO_CHANNEL)) as AboutInfo;

    expect(info.engine.lastResult).toBe("tree-mismatch");
  });

  it("says unknown rather than reporting a first launch as a failed check", async () => {
    // The recovered default carries `lastResult: "missing"`, which is not a
    // verification outcome -- it is the absence of one.
    const userData = await userDataWith(null);
    const build = deps({ userData });

    registerAboutIpc(build.deps);

    const info = (await build.ipc.invoke(ABOUT_INFO_CHANNEL)) as AboutInfo;

    expect(info.engine.lastResult).toBe("unknown");
  });

  it("calls the state's missing outcome missing when it was actually recorded", async () => {
    const userData = await userDataWith({ ...VERIFIED, lastResult: "missing" });
    const build = deps({ userData });

    registerAboutIpc(build.deps);

    const info = (await build.ipc.invoke(ABOUT_INFO_CHANNEL)) as AboutInfo;

    expect(info.engine.lastResult).toBe("missing");
  });

  it("reads the bundled version out of the lock", async () => {
    const userData = await userDataWith(VERIFIED);
    const lockDir = await mkdtemp(path.join(tmpdir(), "haruyuki-lock-"));

    created.push(lockDir);

    const lockPath = path.join(lockDir, "runtime-lock.json");

    await writeFile(lockPath, JSON.stringify(VALID_LOCK), "utf8");

    const build = deps({ userData, lockPath });

    registerAboutIpc(build.deps);

    const info = (await build.ipc.invoke(ABOUT_INFO_CHANNEL)) as AboutInfo;

    expect(info.engine.version).toBe("0.6.0");
    expect(info.engine.source).toBe("bundled");
  });

  it("reports an unreadable lock as an unknown version rather than failing", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({ userData, lockPath: path.join(userData, "absent-lock.json") });

    registerAboutIpc(build.deps);

    const info = (await build.ipc.invoke(ABOUT_INFO_CHANNEL)) as AboutInfo;

    expect(info.engine.version).toBe("");
  });

  it("reports the live bundle's source when one is running", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({
      userData,
      engineDir: "/opt/haruyuki/resources/engine",
      liveBundlePath: () => "/opt/haruyuki/resources/engine/haruyuki.js",
    });

    registerAboutIpc(build.deps);

    const info = (await build.ipc.invoke(ABOUT_INFO_CHANNEL)) as AboutInfo;

    expect(info.engine.source).toBe("bundled");
  });

  it("reports a bundle found on PATH as such", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({
      userData,
      engineDir: "/opt/haruyuki/resources/engine",
      liveBundlePath: () => "/usr/local/lib/node_modules/haruyuki/haruyuki.js",
    });

    registerAboutIpc(build.deps);

    const info = (await build.ipc.invoke(ABOUT_INFO_CHANNEL)) as AboutInfo;

    expect(info.engine.source).toBe("path");
  });

  it("falls back to the recorded pick when no engine is running", async () => {
    const userData = await userDataWith({
      ...VERIFIED,
      externalEngineDir: "/home/user/engines/haruyuki",
      externalEngineVersion: "0.7.0",
    });
    const build = deps({ userData, liveBundlePath: () => null });

    registerAboutIpc(build.deps);

    const info = (await build.ipc.invoke(ABOUT_INFO_CHANNEL)) as AboutInfo;

    expect(info.engine.source).toBe("external");
    expect(info.engine.version).toBe("0.7.0");
  });

  it("survives a state file that is not JSON", async () => {
    const userData = await userDataWith(null);

    await writeFile(path.join(userData, "runtime-state.json"), "{ not json", "utf8");

    const build = deps({ userData });

    registerAboutIpc(build.deps);

    const info = (await build.ipc.invoke(ABOUT_INFO_CHANNEL)) as AboutInfo;

    expect(info.engine.lastResult).toBe("unknown");
  });
});

describe("about.open", () => {
  it("opens the file that exists in the package, never a URL", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({ userData, exists: (target) => target.endsWith("LICENSE") });

    registerAboutIpc(build.deps);

    const result = await build.ipc.invoke(ABOUT_OPEN_CHANNEL, { doc: "license" });

    expect(result).toEqual({ ok: true });
    expect(build.openPath).toHaveBeenCalledTimes(1);

    const opened = build.openPath.mock.calls[0]?.[0] as string;

    expect(path.isAbsolute(opened)).toBe(true);
    expect(path.basename(opened)).toBe(ABOUT_DOC_FILES.license);
    // The whole point of the entry: a local file, not a page.
    expect(opened.startsWith("http")).toBe(false);
  });

  it("opens each of the three documents by its own name", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({
      userData,
      exists: (target) =>
        ["LICENSE", "NOTICE", "THIRD-PARTY"].includes(path.basename(target) as string),
    });

    registerAboutIpc(build.deps);

    for (const doc of ["license", "notice", "third-party"] as const) {
      await expect(build.ipc.invoke(ABOUT_OPEN_CHANNEL, { doc })).resolves.toEqual({ ok: true });
    }

    const names = build.openPath.mock.calls.map((call) => path.basename(call[0] as string));

    expect(names).toEqual(["LICENSE", "NOTICE", "THIRD-PARTY"]);
  });

  it("answers a value, not a rejection, when the file is not in the package", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({ userData, exists: () => false });

    registerAboutIpc(build.deps);

    const result = (await build.ipc.invoke(ABOUT_OPEN_CHANNEL, { doc: "notice" })) as {
      ok: boolean;
      detail?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("NOTICE");
    // Nothing was opened, so the window can say why rather than "it did nothing".
    expect(build.openPath).not.toHaveBeenCalled();
  });

  it("answers a value when the operating system refuses the file", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({
      userData,
      openPath: () => Promise.resolve("no application can open this file"),
    });

    registerAboutIpc(build.deps);

    await expect(build.ipc.invoke(ABOUT_OPEN_CHANNEL, { doc: "license" })).resolves.toEqual({
      ok: false,
      detail: "no application can open this file",
    });
  });

  it("answers a value when the opener throws", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({
      userData,
      openPath: () => Promise.reject(new Error("the shell is gone")),
    });

    registerAboutIpc(build.deps);

    await expect(build.ipc.invoke(ABOUT_OPEN_CHANNEL, { doc: "license" })).resolves.toEqual({
      ok: false,
      detail: "the shell is gone",
    });
  });

  it("refuses a name that is not one of the three", async () => {
    const userData = await userDataWith(VERIFIED);
    const build = deps({ userData });

    registerAboutIpc(build.deps);

    for (const payload of [undefined, null, {}, { doc: "README" }, { doc: 7 }]) {
      const result = (await build.ipc.invoke(ABOUT_OPEN_CHANNEL, payload)) as { ok: boolean };

      expect(result.ok).toBe(false);
    }

    expect(build.openPath).not.toHaveBeenCalled();
  });
});

describe("legalDocRoots", () => {
  it("looks beside the executable, then under resources, when packaged", () => {
    const roots = legalDocRoots(PACKAGED);

    expect(roots[0]).toBe("/opt/haruyuki");
    expect(roots).toContain("/opt/haruyuki/resources");
  });

  it("looks in the checkout when development has no package root", () => {
    const roots = legalDocRoots({
      isPackaged: false,
      exeDir: "/repo/node_modules/electron/dist",
      resourcesPath: "/repo/node_modules/electron/dist/resources",
      appPath: "/repo/apps/desktop",
      devRoot: "/repo",
    });

    expect(roots).toEqual(["/repo"]);
  });
});

describe("resolveLegalDoc", () => {
  it("returns the first root that has the file", () => {
    // `path.join` in the expectation as well: the separator is the platform's,
    // and a test that hardcoded `/` would fail on Windows for no reason.
    const wanted = path.join("/b", "THIRD-PARTY");
    const resolved = resolveLegalDoc("third-party", ["/a", "/b"], (target) => target === wanted);

    expect(resolved).toEqual({ ok: true, path: wanted });
  });

  it("names every path it tried, so a missing document is diagnosable", () => {
    const resolved = resolveLegalDoc("notice", ["/a", "/b"], () => false);

    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false ? resolved.detail : "").toContain(path.join("/a", "NOTICE"));
  });
});
