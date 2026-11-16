import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectDiagnostics,
  type DiagnosticsBundle,
  type DiagnosticsCollectOptions,
  type DiagnosticsEngineFacts,
} from "../diagnostics/collect.js";
import type { CrashRecord } from "../crash/records.js";
import {
  readActiveSession,
  resetSessionDiagnosticsSource,
  setSessionDiagnosticsSource,
} from "../diagnostics/session.js";
import type { ShellSettings } from "../settings.js";

/** Directories this file made, removed pointwise after each test. */
const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-collect-"));
  created.push(dir);

  return dir;
}

afterEach(async () => {
  resetSessionDiagnosticsSource();

  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

/** The fixed instant every bundle in this file is built at. */
const NOW = new Date("2026-11-16T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

/** The three managed directories, all below one fake home. */
interface Fixture {
  readonly home: string;
  readonly userData: string;
  readonly logsDir: string;
  readonly crashDumpsDir: string;
}

async function fixture(): Promise<Fixture> {
  const home = await tempDir();
  const userData = path.join(home, "userData");
  const logsDir = path.join(home, "logs");
  const crashDumpsDir = path.join(home, "crash-dumps");
  await Promise.all(
    [userData, logsDir, crashDumpsDir].map((dir) => mkdir(dir, { recursive: true })),
  );
  return { home, userData, logsDir, crashDumpsDir };
}

const SETTINGS: ShellSettings = {
  version: 1,
  theme: "light",
  contrast: "normal",
  locale: null,
  window: null,
};

const ENGINE: DiagnosticsEngineFacts = {
  version: "0.6.0",
  protocolVersion: 1,
  backend: "local",
  watchdog: "active",
  degradations: [{ kind: "watchdog", detail: "no WATCHDOG_OK" }],
  expectedVersion: "0.6.0",
  stderrTail: [],
};

function collectOptions(
  dirs: Fixture,
  overrides: Partial<DiagnosticsCollectOptions> = {},
): DiagnosticsCollectOptions {
  return {
    userData: dirs.userData,
    logsDir: dirs.logsDir,
    crashDumpsDir: dirs.crashDumpsDir,
    appVersion: "0.1.0",
    commit: "abc1234",
    electron: "45.3.2",
    chrome: "146.0.0.0",
    node: "24.22.3",
    platform: "win32",
    arch: "x64",
    release: "10.0.26100",
    locale: "zh-CN",
    theme: "light",
    packaged: false,
    workspace: path.join(dirs.home, "workspace"),
    homeDir: dirs.home,
    settings: SETTINGS,
    engine: ENGINE,
    crashes: [],
    options: { includeSessionContent: false, includeMinidump: false },
    now: NOW,
    totalMemoryMb: 16_384,
    ...overrides,
  };
}

function entryOf(bundle: DiagnosticsBundle, entryPath: string) {
  const found = bundle.entries.find((entry) => entry.path === entryPath);
  if (found === undefined) throw new Error(`bundle has no entry ${entryPath}`);

  return found;
}

function textOf(bundle: DiagnosticsBundle, entryPath: string): string {
  return entryOf(bundle, entryPath).data.toString("utf8");
}

function hasEntry(bundle: DiagnosticsBundle, entryPath: string): boolean {
  return bundle.entries.some((entry) => entry.path === entryPath);
}

function logName(offsetDays: number): string {
  return `shell-${new Date(NOW.getTime() - offsetDays * DAY_MS).toISOString().slice(0, 10)}.jsonl`;
}

function crashRecord(at: string, overrides: Partial<CrashRecord> = {}): CrashRecord {
  return {
    schemaVersion: 1,
    at,
    kind: "main",
    code: "MAIN_CRASHED",
    app: {
      version: "0.1.0",
      electron: "45.3.2",
      node: "24.22.3",
      platform: "win32",
      arch: "x64",
    },
    main: { name: "Error", message: "boom" },
    ...overrides,
  };
}

describe("collectDiagnostics: default bundle", () => {
  it("writes the required tree, lists every hash, and leaves session content out", async () => {
    const dirs = await fixture();
    const logFile = path.join(dirs.logsDir, logName(0));

    await writeFile(logFile, `{"path":"${path.join(dirs.home, "proj", "a.ts")}"}\n`, "utf8");
    await mkdir(path.join(dirs.crashDumpsDir, "reports"), { recursive: true });
    await writeFile(path.join(dirs.crashDumpsDir, "reports", "x.dmp"), Buffer.from([0, 1, 2, 3]));

    const bundle = await collectDiagnostics(
      collectOptions(dirs, { crashes: [crashRecord("2026-11-16T10:00:00.000Z")] }),
    );
    const paths = bundle.entries.map((entry) => entry.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        "README.txt",
        "summary.txt",
        "env.json",
        "config/shell-settings.json",
        `logs/${logName(0)}`,
        "engine/stderr-tail.txt",
        "manifest.json",
        "crash/crash-2026-11-16T10-00-00-000Z.json",
      ]),
    );
    expect(hasEntry(bundle, "content/conversation.json")).toBe(false);
    expect(paths.some((entryPath) => entryPath.startsWith("crash/minidump-"))).toBe(false);
    expect(bundle.manifest.options).toEqual({
      includeSessionContent: false,
      includeMinidump: false,
    });

    // The manifest lists everything except itself, and every hash names the
    // bytes that actually ship.
    const listed = bundle.entries.filter((entry) => entry.path !== "manifest.json");

    expect(bundle.manifest.files.map((file) => file.path)).toEqual(
      listed.map((entry) => entry.path),
    );

    for (const file of bundle.manifest.files) {
      const entry = entryOf(bundle, file.path);

      expect(file.bytes).toBe(entry.data.length);
      expect(file.sha256).toBe(createHash("sha256").update(entry.data).digest("hex"));
    }

    const manifestEntry = entryOf(bundle, "manifest.json");
    expect(manifestEntry.bytes).toBe(manifestEntry.data.length);

    for (const entryPath of paths) {
      expect(entryPath.includes("\\")).toBe(false);
      expect(entryPath.startsWith("/")).toBe(false);
      expect(entryPath.split("/")).not.toContain("..");
    }

    expect(bundle.manifest.schemaVersion).toBe(1);
    expect(bundle.manifest.createdAt).toBe(NOW.toISOString());
    expect(bundle.manifest.app).toEqual({
      version: "0.1.0",
      commit: "abc1234",
      electron: "45.3.2",
      chrome: "146.0.0.0",
      node: "24.22.3",
      packaged: false,
    });
    expect(bundle.manifest.system.totalMemoryMb).toBe(16_384);
    expect(bundle.manifest.engine).toEqual({
      version: "0.6.0",
      protocolVersion: 1,
      backend: "local",
      watchdog: "active",
      expectedVersion: "0.6.0",
    });
    expect(bundle.manifest.redaction).toEqual({ homePathReplaced: true, secretsStripped: true });

    for (const prose of [textOf(bundle, "README.txt"), textOf(bundle, "summary.txt")]) {
      expect(prose).toMatch(/[\u4e00-\u9fff]/);
      expect(prose).toMatch(/do not run/i);
      expect(prose).toContain("manifest.json");
    }
  });

  it("redacts home paths and secrets, and never ships markers, token files or dumps", async () => {
    const dirs = await fixture();
    const secret = "tok-live-4242424242";

    await writeFile(
      path.join(dirs.logsDir, logName(0)),
      `${JSON.stringify({ path: path.join(dirs.home, "proj", "a.ts"), token: secret })}\n`,
      "utf8",
    );
    await writeFile(path.join(dirs.userData, "runtime.json"), "{}", "utf8");
    await writeFile(path.join(dirs.userData, "runtime-stale-1.json"), "{}", "utf8");
    await mkdir(path.join(dirs.userData, "engine-token"), { recursive: true });
    await writeFile(path.join(dirs.userData, "engine-token", "engine-token"), secret, "utf8");

    const bundle = await collectDiagnostics(collectOptions(dirs, { secrets: [secret] }));
    const env = JSON.parse(textOf(bundle, "env.json")) as {
      paths: { userData: string; logs: string; crashDumps: string; workspace: string };
      versions: { app: string };
      engine: { degradations: unknown[] };
    };
    const log = textOf(bundle, `logs/${logName(0)}`);

    expect(log).not.toContain(dirs.home);
    expect(log).not.toContain(secret);
    expect(log).toContain("~");
    expect(log).toContain("[redacted]");

    for (const value of Object.values(env.paths)) {
      expect(value.startsWith("~")).toBe(true);
      expect(value.includes(dirs.home)).toBe(false);
    }

    expect(env.versions.app).toBe("0.1.0");
    expect(env.engine.degradations).toEqual([{ kind: "watchdog", detail: "no WATCHDOG_OK" }]);
    expect(textOf(bundle, "config/shell-settings.json")).not.toContain(secret);

    for (const entry of bundle.entries) {
      expect(entry.path).not.toMatch(/runtime\.json|runtime-stale|engine-token/);

      if (!entry.path.endsWith(".dmp")) {
        expect(entry.data.toString("utf8")).not.toContain(dirs.home);
      }
    }
  });
});

describe("collectDiagnostics: files and budgets", () => {
  it("keeps seven UTC days of logs newest first and omits the rest by retention", async () => {
    const dirs = await fixture();

    for (const offset of [0, 1, 2, 3, 4, 5, 6, 7, 40]) {
      await writeFile(path.join(dirs.logsDir, logName(offset)), `${offset}\n`, "utf8");
    }

    const bundle = await collectDiagnostics(collectOptions(dirs));
    const shipped = bundle.entries
      .filter((entry) => entry.path.startsWith("logs/"))
      .map((entry) => entry.path);
    expect(shipped).toEqual([0, 1, 2, 3, 4, 5, 6].map((offset) => `logs/${logName(offset)}`));
    expect(bundle.omitted).toEqual([
      { path: `logs/${logName(7)}`, bytes: Buffer.byteLength("7\n"), reason: "retention" },
      { path: `logs/${logName(40)}`, bytes: Buffer.byteLength("40\n"), reason: "retention" },
    ]);
    expect(bundle.manifest.omissions).toEqual(bundle.omitted);
  });

  it("stops at the first log that would exceed the 50 MB byte budget", async () => {
    const dirs = await fixture();
    const huge = Buffer.alloc(51 * MB, 0x61);

    await writeFile(path.join(dirs.logsDir, logName(0)), huge);
    await writeFile(path.join(dirs.logsDir, logName(1)), "small\n", "utf8");

    const bundle = await collectDiagnostics(collectOptions(dirs));

    expect(hasEntry(bundle, `logs/${logName(0)}`)).toBe(false);
    expect(hasEntry(bundle, `logs/${logName(1)}`)).toBe(false);
    expect(bundle.omitted).toEqual([
      { path: `logs/${logName(0)}`, bytes: huge.length, reason: "cap" },
      // The stop is sticky: a later, smaller file does not reopen the budget.
      { path: `logs/${logName(1)}`, bytes: Buffer.byteLength("small\n"), reason: "cap" },
    ]);
  });

  it("selects recent crash records, omits old and oversized ones, and does not mutate them", async () => {
    const dirs = await fixture();
    const secret = "tok-crash-11223344";
    const recent = crashRecord("2026-11-16T11:00:00.000Z", {
      main: {
        name: "Error",
        message: "boom",
        stack: `at ${path.join(dirs.home, "proj", "a.ts")}:1 (token=${secret})`,
      },
    });
    const big = crashRecord("2026-11-16T10:30:00.000Z", {
      main: { name: "Error", message: "big", stack: "x".repeat(11 * MB) },
    });
    const records = [
      recent,
      big,
      crashRecord("2026-10-01T10:00:00.000Z"),
      crashRecord("not-a-date"),
    ];
    const before = JSON.stringify(records);
    const bundle = await collectDiagnostics(
      collectOptions(dirs, { crashes: records, secrets: [secret] }),
    );
    const shipped = bundle.entries.filter((entry) => entry.path.startsWith("crash/crash-"));
    const recentPath = "crash/crash-2026-11-16T11-00-00-000Z.json";

    expect(shipped.map((entry) => entry.path)).toEqual([recentPath]);
    expect(textOf(bundle, recentPath)).toContain("~");
    expect(textOf(bundle, recentPath)).not.toContain(secret);
    expect(bundle.omitted).toEqual([
      {
        path: "crash/crash-2026-11-16T10-30-00-000Z.json",
        bytes: expect.any(Number),
        reason: "cap",
      },
      {
        path: "crash/crash-2026-10-01T10-00-00-000Z.json",
        bytes: expect.any(Number),
        reason: "retention",
      },
      { path: "crash/crash-unparsed-3.json", bytes: expect.any(Number), reason: "unreadable" },
    ]);
    expect(JSON.stringify(records)).toBe(before);
  });

  it("adds minidumps only when requested and keeps the recent ones", async () => {
    const dirs = await fixture();
    const reports = path.join(dirs.crashDumpsDir, "reports");
    const recentDump = Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0, 1, 2, 3]);
    const old = new Date(NOW.getTime() - 8 * DAY_MS);

    await mkdir(reports, { recursive: true });
    await writeFile(path.join(reports, "recent.dmp"), recentDump);
    await writeFile(path.join(reports, "old.dmp"), Buffer.from("old"));
    await utimes(path.join(reports, "old.dmp"), old, old);

    const defaults = await collectDiagnostics(collectOptions(dirs));
    expect(defaults.entries.some((entry) => entry.path.startsWith("crash/minidump-"))).toBe(false);

    const bundle = await collectDiagnostics(
      collectOptions(dirs, {
        options: { includeSessionContent: false, includeMinidump: true },
      }),
    );

    expect(entryOf(bundle, "crash/minidump-recent.dmp").data.equals(recentDump)).toBe(true);
    expect(bundle.omitted).toEqual([
      { path: "crash/minidump-old.dmp", bytes: 3, reason: "retention" },
    ]);
  });

  it("limits the engine stderr tail to 200 lines and redacts it", async () => {
    const dirs = await fixture();
    const lines = Array.from({ length: 250 }, (_, index) =>
      index === 249 ? `line ${index} ${path.join(dirs.home, "x")}` : `line ${index}`,
    );
    const bundle = await collectDiagnostics(
      collectOptions(dirs, { engine: { ...ENGINE, stderrTail: lines } }),
    );
    const body = textOf(bundle, "engine/stderr-tail.txt")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));

    expect(body).toHaveLength(200);
    expect(body[0]).toBe("line 50");
    expect(body.at(-1)?.startsWith("line 249 ~")).toBe(true);

    const empty = await collectDiagnostics(collectOptions(dirs));
    expect(textOf(empty, "engine/stderr-tail.txt")).toContain("no engine stderr captured");
  });
});

describe("collectDiagnostics: session content", () => {
  it("writes the explicit empty placeholder when no source is registered", async () => {
    const bundle = await collectDiagnostics(
      collectOptions(await fixture(), {
        options: { includeSessionContent: true, includeMinidump: false },
      }),
    );
    const payload = JSON.parse(textOf(bundle, "content/conversation.json")) as {
      schemaVersion: number;
      session: unknown;
      messages: unknown[];
      note: string;
    };

    expect(payload).toMatchObject({
      schemaVersion: 1,
      session: null,
      messages: [],
    });
    expect(payload.note).toContain("no active session");
    expect(textOf(bundle, "summary.txt")).toContain("no active session");
  });

  it("keeps the newest 200 messages, redacted and without mutating the source", async () => {
    const dirs = await fixture();
    const source = {
      messages: Array.from({ length: 250 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content:
          index === 249
            ? { text: `file ${path.join(dirs.home, "a.ts")}`, token: "tok-session-4242" }
            : `message ${index}`,
      })),
      calls: 0,
      getActiveSession() {
        this.calls += 1;

        return { conversationId: "conv-1", messages: this.messages };
      },
    };

    setSessionDiagnosticsSource(source);

    const bundle = await collectDiagnostics(
      collectOptions(dirs, {
        options: { includeSessionContent: true, includeMinidump: false },
      }),
    );
    const payload = JSON.parse(textOf(bundle, "content/conversation.json")) as {
      conversationId: string;
      messages: { content: unknown }[];
    };
    const last = payload.messages[199]?.content as { text: string; token: string };

    expect(payload.conversationId).toBe("conv-1");
    expect(payload.messages).toHaveLength(200);
    expect(payload.messages[0]?.content).toBe("message 50");
    expect(last.text.startsWith("file ~")).toBe(true);
    expect(last.text).not.toContain(dirs.home);
    expect(last.token).toBe("[redacted]");

    // The source is read, not consumed or rewritten.
    expect(source.calls).toBe(1);
    expect(source.messages).toHaveLength(250);
  });
});

describe("readActiveSession", () => {
  it("truncates to the limit and treats a broken source as no session", () => {
    const messages = [{ id: 1 }, { id: 2 }, { id: 3 }];
    setSessionDiagnosticsSource({
      getActiveSession: () => ({ conversationId: "c", messages }),
    });

    expect(readActiveSession(2)?.messages).toEqual([{ id: 2 }, { id: 3 }]);
    expect(readActiveSession(0)?.messages).toEqual([]);
    resetSessionDiagnosticsSource();
    expect(readActiveSession()).toBeNull();

    setSessionDiagnosticsSource({
      getActiveSession: () => {
        throw new Error("store is gone");
      },
    });

    expect(readActiveSession()).toBeNull();
  });
});
