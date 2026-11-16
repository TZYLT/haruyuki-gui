/**
 * The export flow's user-visible decisions: options default off, save cancel,
 * the 50 MB three-way choice, the second trim after a real archive size is
 * known, and no partial file on failure.
 *
 * Entries carry real byte counts but tiny buffers: the writer is a fake, so
 * allocating 50 MB dumps would only slow the suite. Zip byte handling is covered
 * by `diagnostics-zip`.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  DiagnosticsEvent,
  DiagnosticsManifest,
  DiagnosticsOptions,
} from "../../shared/diagnostics.js";
import type { DiagnosticsBundle, DiagnosticsBundleEntry } from "../diagnostics/collect.js";
import {
  DIAGNOSTICS_MAX_BYTES,
  diagnosticsFileName,
  runDiagnosticsExport,
  type DiagnosticsCollectInput,
  type DiagnosticsExportContext,
  type DiagnosticsExportDeps,
  type DiagnosticsExportLabels,
  type DiagnosticsMessageBoxOptions,
  type DiagnosticsSaveDialogOptions,
  type DiagnosticsSaveDialogResult,
} from "../diagnostics/export.js";
import type { ZipEntry, ZipWriteOptions } from "../diagnostics/zip.js";
import type { ShellSettings } from "../settings.js";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-export-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const NOW = new Date("2026-11-16T12:00:00.000Z");
const MB = 1024 * 1024;
const SETTINGS: ShellSettings = {
  version: 1,
  theme: "light",
  contrast: "normal",
  locale: null,
  window: null,
};
const DEFAULT_OPTIONS: DiagnosticsOptions = {
  includeSessionContent: false,
  includeMinidump: false,
};
const LABELS: DiagnosticsExportLabels = {
  saveTitle: "save",
  zipFilterName: "zip",
  capTitle: "cap",
  capMessage: (bytes, max) => `${String(bytes)}/${String(max)}`,
  capFull: "full",
  capReduce: "reduce",
  capCancel: "cancel",
  successTitle: "success",
  successMessage: (file, bytes) => `${file} ${String(bytes)}`,
  openFolder: "open",
  close: "close",
  failureTitle: "failed",
  failureMessage: (detail) => detail,
};

interface FileSpec {
  readonly path: string;
  readonly bytes: number;
}

function manifestFor(options: DiagnosticsOptions): DiagnosticsManifest {
  return {
    schemaVersion: 1,
    createdAt: NOW.toISOString(),
    app: {
      version: "0.1.0",
      commit: null,
      electron: "45.3.2",
      chrome: "156.0.0.0",
      node: "24.22.3",
      packaged: false,
    },
    system: {
      platform: "win32",
      arch: "x64",
      release: "10.0",
      locale: "en",
      totalMemoryMb: null,
    },
    engine: {
      version: null,
      protocolVersion: null,
      backend: null,
      watchdog: "unknown",
      expectedVersion: null,
    },
    retentions: {
      logsDays: 7,
      logsMb: 50,
      crashesDays: 30,
      crashesMb: 10,
      minidumpsDays: 7,
      minidumpsMb: 200,
    },
    options,
    files: [],
    omissions: [],
    redaction: { homePathReplaced: false, secretsStripped: true },
  };
}

function bundleOf(files: readonly FileSpec[]): DiagnosticsBundle {
  const entry = (file: FileSpec): DiagnosticsBundleEntry => ({
    path: file.path,
    bytes: file.bytes,
    sha256: "0".repeat(64),
    data: Buffer.alloc(Math.min(file.bytes, 64)),
  });

  return {
    entries: [
      entry({ path: "README.txt", bytes: 512 }),
      entry({ path: "summary.txt", bytes: 512 }),
      ...files.map(entry),
      entry({ path: "manifest.json", bytes: 256 }),
    ],
    manifest: manifestFor(DEFAULT_OPTIONS),
    summary: "summary",
    omitted: [],
  };
}

type WriteFake = (
  entries: readonly ZipEntry[],
  outputPath: string,
  options: ZipWriteOptions,
) => Promise<{ bytes: number; entries: number }>;

interface HarnessOptions {
  readonly save?: (options: DiagnosticsSaveDialogOptions) => Promise<DiagnosticsSaveDialogResult>;
  readonly boxes?: readonly number[];
  readonly collect?: (input: DiagnosticsCollectInput) => Promise<DiagnosticsBundle>;
  readonly write?: WriteFake;
  readonly openPath?: (target: string) => Promise<void>;
}

interface Harness {
  readonly deps: DiagnosticsExportDeps;
  readonly events: DiagnosticsEvent[];
  readonly saves: DiagnosticsSaveDialogOptions[];
  readonly boxes: DiagnosticsMessageBoxOptions[];
  readonly writes: Array<{
    entries: readonly ZipEntry[];
    outputPath: string;
    options: ZipWriteOptions;
  }>;
  readonly collected: DiagnosticsCollectInput[];
  readonly outputPath: string;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await tempDir();
  const outputPath = path.join(dir, "diagnostics.zip");
  const events: DiagnosticsEvent[] = [];
  const saves: DiagnosticsSaveDialogOptions[] = [];
  const boxes: DiagnosticsMessageBoxOptions[] = [];
  const writes: Harness["writes"] = [];
  const collected: DiagnosticsCollectInput[] = [];
  const responses = [...(options.boxes ?? [])];
  let writeCount = 0;

  const write: WriteFake =
    options.write ??
    ((entries) => {
      writeCount += 1;
      return Promise.resolve({ bytes: 2048 + writeCount, entries: entries.length });
    });

  const deps: DiagnosticsExportDeps = {
    now: () => NOW,
    onEvent: (event) => events.push(event),
    labels: LABELS,
    showSaveDialog: async (saveOptions) => {
      saves.push(saveOptions);
      return options.save === undefined
        ? { canceled: false, filePath: outputPath }
        : options.save(saveOptions);
    },
    showMessageBox: async (boxOptions) => {
      boxes.push(boxOptions);
      return { response: responses.shift() ?? 1 };
    },
    openPath: options.openPath ?? (() => Promise.resolve()),
    collect: async (input) => {
      collected.push(input);
      return options.collect === undefined ? bundleOf([]) : options.collect(input);
    },
    writeZip: async (entries, target, writeOptions) => {
      writes.push({ entries, outputPath: target, options: writeOptions });
      return write(entries, target, writeOptions);
    },
  };

  return { deps, events, saves, boxes, writes, collected, outputPath };
}

async function context(): Promise<DiagnosticsExportContext> {
  const root = await tempDir();

  return {
    userData: path.join(root, "userData"),
    logsDir: path.join(root, "logs"),
    crashDumpsDir: path.join(root, "crash-dumps"),
    appVersion: "0.1.0",
    commit: null,
    electron: "45.3.2",
    chrome: "156.0.0.0",
    node: "24.22.3",
    platform: "win32",
    arch: "x64",
    release: "10.0",
    locale: "en",
    theme: "light",
    settings: SETTINGS,
    engine: {
      version: null,
      protocolVersion: null,
      backend: null,
      watchdog: "unknown",
      degradations: [],
      expectedVersion: null,
      stderrTail: [],
    },
    crashes: [],
    sessionSource: null,
  };
}

function pathsOf(entries: readonly ZipEntry[]): string[] {
  return entries.map((entry) => entry.path);
}

function writtenPaths(harnessed: Harness, call = 0): string[] {
  const write = harnessed.writes[call];
  if (write === undefined) throw new Error(`no write call ${String(call)}`);
  return pathsOf(write.entries);
}

describe("runDiagnosticsExport", () => {
  it("defaults both options off and forwards checked ones unchanged", async () => {
    const off = await harness();
    const checked: DiagnosticsOptions = { includeSessionContent: true, includeMinidump: true };

    expect(
      (await runDiagnosticsExport({ options: DEFAULT_OPTIONS }, await context(), off.deps)).ok,
    ).toBe(true);
    expect(off.collected[0]?.options).toEqual(DEFAULT_OPTIONS);
    expect(writtenPaths(off)).not.toContain("content/conversation.json");

    const on = await harness();
    expect((await runDiagnosticsExport({ options: checked }, await context(), on.deps)).ok).toBe(
      true,
    );
    expect(on.collected[0]?.options).toEqual(checked);
  });

  it("returns cancelled and writes nothing when the dialog is dismissed", async () => {
    const harnessed = await harness({ save: () => Promise.resolve({ canceled: true }) });
    const result = await runDiagnosticsExport(
      { options: DEFAULT_OPTIONS },
      await context(),
      harnessed.deps,
    );

    expect(result).toMatchObject({ ok: false, code: "DIAGNOSTIC_EXPORT_CANCELLED" });
    expect(harnessed.collected).toHaveLength(0);
    expect(harnessed.writes).toHaveLength(0);
    expect(harnessed.events.filter((event) => event.kind !== "progress")).toEqual([
      { kind: "cancelled" },
    ]);
  });

  it("builds a safe default name and a zip filter", async () => {
    const harnessed = await harness();
    const unsafe = { ...(await context()), appVersion: "1.0.0-beta+build/2" };

    await runDiagnosticsExport({ options: DEFAULT_OPTIONS }, unsafe, harnessed.deps);

    const save = harnessed.saves[0];
    expect(save?.filters).toEqual([{ name: "zip", extensions: ["zip"] }]);
    expect(save?.defaultPath).toBe("haruyuki-diagnostics-1.0.0-beta-build-2-20261116T120000Z.zip");
    expect(diagnosticsFileName("0.1.0", NOW)).toBe(
      "haruyuki-diagnostics-0.1.0-20261116T120000Z.zip",
    );
    expect(diagnosticsFileName("0.1.0", NOW)).not.toMatch(/[:\\/]/);
  });

  it("puts the default save path in the Downloads directory", async () => {
    const harnessed = await harness();
    const withDownloads = {
      ...(await context()),
      downloadsDir: path.join("C:", "Users", "me", "Downloads"),
    };

    await runDiagnosticsExport({ options: DEFAULT_OPTIONS }, withDownloads, harnessed.deps);

    expect(harnessed.saves[0]?.defaultPath).toBe(
      path.join("C:", "Users", "me", "Downloads", diagnosticsFileName("0.1.0", NOW)),
    );
  });

  it("returns cancelled when aborted before the dialog", async () => {
    const harnessed = await harness();
    const controller = new AbortController();
    controller.abort();

    const result = await runDiagnosticsExport({ options: DEFAULT_OPTIONS }, await context(), {
      ...harnessed.deps,
      abortSignal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(harnessed.saves).toHaveLength(0);
    expect(harnessed.events).toEqual([{ kind: "cancelled" }]);
  });
});

describe("the 50 MB choice", () => {
  const CAP_PLUS = DIAGNOSTICS_MAX_BYTES + MB;

  it("saves the full bundle when the user chooses full", async () => {
    const harnessed = await harness({
      boxes: [0, 1],
      collect: () =>
        Promise.resolve(bundleOf([{ path: "logs/shell-2026-11-15.jsonl", bytes: CAP_PLUS }])),
    });

    expect(
      (await runDiagnosticsExport({ options: DEFAULT_OPTIONS }, await context(), harnessed.deps))
        .ok,
    ).toBe(true);
    expect(harnessed.boxes[0]?.buttons).toEqual(["full", "reduce", "cancel"]);
    expect(harnessed.writes).toHaveLength(1);
    expect(writtenPaths(harnessed)).toContain("logs/shell-2026-11-15.jsonl");
  });

  it("writes nothing when the user chooses cancel", async () => {
    const harnessed = await harness({
      boxes: [2],
      collect: () =>
        Promise.resolve(bundleOf([{ path: "logs/shell-2026-11-15.jsonl", bytes: CAP_PLUS }])),
    });
    const result = await runDiagnosticsExport(
      { options: DEFAULT_OPTIONS },
      await context(),
      harnessed.deps,
    );

    expect(result.ok).toBe(false);
    expect(harnessed.writes).toHaveLength(0);
    expect(harnessed.events.at(-1)).toEqual({ kind: "cancelled" });
  });

  it("drops content and minidumps before the oldest log", async () => {
    const harnessed = await harness({
      boxes: [1, 1],
      collect: () =>
        Promise.resolve(
          bundleOf([
            { path: "logs/shell-2026-11-10.jsonl", bytes: 30 * MB },
            { path: "logs/shell-2026-11-11.jsonl", bytes: 30 * MB },
            { path: "content/conversation.json", bytes: MB },
            { path: "crash/minidump-old.dmp", bytes: MB },
          ]),
        ),
    });
    const result = await runDiagnosticsExport(
      { options: DEFAULT_OPTIONS },
      await context(),
      harnessed.deps,
    );

    if (!result.ok) throw new Error("expected success");

    expect(result.omitted.map((item) => item.path).slice(0, 2)).toEqual([
      "content/conversation.json",
      "crash/minidump-old.dmp",
    ]);
    expect(result.omitted.map((item) => item.path)).toContain("logs/shell-2026-11-10.jsonl");
    expect(result.omitted.map((item) => item.path)).not.toContain("logs/shell-2026-11-11.jsonl");

    const summary = harnessed.writes
      .at(-1)
      ?.entries.find((entry) => entry.path === "summary.txt")
      ?.data.toString("utf8");

    expect(summary).toContain("content/conversation.json");
    expect(summary).toContain("crash/minidump-old.dmp");
  });

  it("does not claim there was no session when the chosen content was dropped", async () => {
    const harnessed = await harness({
      boxes: [1, 1],
      collect: () =>
        Promise.resolve(
          bundleOf([
            { path: "content/conversation.json", bytes: 4 * MB },
            { path: "logs/shell-2026-11-10.jsonl", bytes: 50 * MB },
          ]),
        ),
    });

    await runDiagnosticsExport(
      { options: { includeSessionContent: true, includeMinidump: false } },
      await context(),
      harnessed.deps,
    );

    const summary = harnessed.writes
      .at(-1)
      ?.entries.find((entry) => entry.path === "summary.txt")
      ?.data.toString("utf8");

    expect(summary).not.toContain("no active session");
    expect(summary).toContain("omitted to meet the size limit");
  });

  it("trims once more when the written archive is still over the cap", async () => {
    let calls = 0;
    const harnessed = await harness({
      boxes: [1, 1],
      collect: () =>
        Promise.resolve(
          bundleOf([
            { path: "content/conversation.json", bytes: 5 * MB },
            { path: "logs/shell-2026-11-10.jsonl", bytes: 25 * MB },
            { path: "logs/shell-2026-11-11.jsonl", bytes: 25 * MB },
          ]),
        ),
      write: (entries) => {
        calls += 1;
        return Promise.resolve({
          bytes: calls === 1 ? DIAGNOSTICS_MAX_BYTES + 1 : DIAGNOSTICS_MAX_BYTES - MB,
          entries: entries.length,
        });
      },
    });
    const result = await runDiagnosticsExport(
      { options: DEFAULT_OPTIONS },
      await context(),
      harnessed.deps,
    );

    expect(harnessed.writes).toHaveLength(2);
    if (!result.ok) throw new Error("expected success");
    expect(result.bytes).toBe(DIAGNOSTICS_MAX_BYTES - MB);
    expect(result.omitted.map((item) => item.path)).toContain("logs/shell-2026-11-10.jsonl");
  });
});

describe("failure and success", () => {
  it("leaves no partial archive when the writer fails", async () => {
    const harnessed = await harness();
    const failing: WriteFake = async (_entries, target) => {
      await writeFile(target, "half a zip", "utf8");
      throw new Error("disk full");
    };

    const result = await runDiagnosticsExport({ options: DEFAULT_OPTIONS }, await context(), {
      ...harnessed.deps,
      writeZip: failing,
    });

    expect(result).toEqual({ ok: false, code: "DIAGNOSTIC_EXPORT_FAILED", detail: "disk full" });
    expect(harnessed.events.at(-1)).toEqual({
      kind: "failed",
      code: "DIAGNOSTIC_EXPORT_FAILED",
      detail: "disk full",
    });
    await expect(stat(harnessed.outputPath)).rejects.toThrow();
  });

  it("does not delete a pre-existing archive when the writer fails before rename", async () => {
    const harnessed = await harness();
    const failing: WriteFake = async () => {
      throw new Error("disk full before rename");
    };

    await writeFile(harnessed.outputPath, "older bundle", "utf8");

    const result = await runDiagnosticsExport({ options: DEFAULT_OPTIONS }, await context(), {
      ...harnessed.deps,
      writeZip: failing,
    });

    expect(result.ok).toBe(false);
    expect(await readFile(harnessed.outputPath, "utf8")).toBe("older bundle");
  });

  it("opens the containing folder, and still succeeds when opening fails", async () => {
    const opened: string[] = [];
    const harnessed = await harness({
      boxes: [0],
      openPath: (target) => {
        opened.push(target);
        return Promise.resolve();
      },
    });

    expect(
      (await runDiagnosticsExport({ options: DEFAULT_OPTIONS }, await context(), harnessed.deps))
        .ok,
    ).toBe(true);
    expect(opened).toEqual([path.dirname(harnessed.outputPath)]);

    const refused = await harness({
      boxes: [0],
      openPath: () => Promise.reject(new Error("no file manager")),
    });
    expect(
      (await runDiagnosticsExport({ options: DEFAULT_OPTIONS }, await context(), refused.deps)).ok,
    ).toBe(true);
  });

  it("emits every phase and exactly one terminal event", async () => {
    const harnessed = await harness({
      write: (entries) => Promise.resolve({ bytes: 4096, entries: entries.length }),
    });

    await runDiagnosticsExport({ options: DEFAULT_OPTIONS }, await context(), harnessed.deps);

    const phases = harnessed.events
      .filter((event) => event.kind === "progress")
      .map((event) => (event.kind === "progress" ? event.phase : ""));
    expect(phases).toContain("collect");
    expect(phases).toContain("compress");
    expect(phases).toContain("write");
    expect(harnessed.events.filter((event) => event.kind !== "progress")).toEqual([
      { kind: "done", path: harnessed.outputPath, bytes: 4096, omitted: [] },
    ]);
  });
});
