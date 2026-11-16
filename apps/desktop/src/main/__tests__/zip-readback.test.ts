/**
 * The archive a reader actually gets: written to a file, then read back with
 * nothing but `node:zlib`.
 *
 * `diagnostics-zip` already checks the writer's byte layout in memory. This file
 * checks the promise the *bundle* makes: the file on disk opens, every entry in
 * `manifest.files[]` hashes to the bytes that come out of it, `manifest.json`
 * ships without listing itself, both storage methods survive the round trip, and
 * a non-ASCII name is still the same name.
 *
 * The reader below is deliberately independent of the writer: it starts at the
 * end-of-central-directory record, trusts only the central directory for names
 * and sizes, and walks the local headers and data descriptors afterwards. A
 * parser that reused the writer's offsets would agree with a broken archive.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { collectDiagnostics } from "../diagnostics/collect.js";
import type { DiagnosticsBundle } from "../diagnostics/collect.js";
import {
  runDiagnosticsExport,
  type DiagnosticsExportContext,
  type DiagnosticsExportDeps,
  type DiagnosticsExportLabels,
} from "../diagnostics/export.js";
import { writeZip } from "../diagnostics/zip.js";
import type { ZipEntry } from "../diagnostics/zip.js";
import type { CrashRecord } from "../crash/records.js";
import type { ShellSettings } from "../settings.js";

/** Directories this file made, removed pointwise after each test. */
const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-readback-"));

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

/** One entry of a parsed archive, as a reader sees it. */
interface ReadEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
  readonly data: Buffer;
}

/** Everything the archive's three structures said. */
interface ReadArchive {
  readonly entries: readonly ReadEntry[];
  readonly entriesOnDisk: number;
  readonly totalEntries: number;
  readonly cdSize: number;
  readonly cdOffset: number;
  /** Absolute offset just past the last entry's data descriptor. */
  readonly dataEnd: number;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

function expectSignature(actual: number, expected: number, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `${what} has signature 0x${actual.toString(16)} instead of 0x${expected.toString(16)}`,
    );
  }
}

/**
 * Read a `.zip` the way a third-party reader does.
 *
 * No assumptions from the writer: the central directory is the index, the local
 * header is where the bytes start, and every field the writer deferred is taken
 * from the data descriptor and compared.
 *
 * @param zip the archive bytes, as read from disk
 * @returns the parsed entries and the end-of-central-directory numbers
 */
function readArchive(zip: Buffer): ReadArchive {
  const eocd = zip.length - 22;

  expectSignature(zip.readUInt32LE(eocd), END_OF_CENTRAL_SIGNATURE, "end of central directory");

  const entriesOnDisk = zip.readUInt16LE(eocd + 8);
  const totalEntries = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  const commentLength = zip.readUInt16LE(eocd + 20);

  if (commentLength !== 0) throw new Error("archive has a comment; the writer writes none");
  if (zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0) {
    throw new Error("archive claims a split disk");
  }

  const entries: ReadEntry[] = [];
  let at = cdOffset;
  let dataEnd = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    expectSignature(zip.readUInt32LE(at), CENTRAL_HEADER_SIGNATURE, `central header ${index}`);

    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const uncompressedSize = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const entryCommentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");

    expectSignature(zip.readUInt32LE(localOffset), LOCAL_HEADER_SIGNATURE, `local header ${name}`);

    const localFlags = zip.readUInt16LE(localOffset + 6);
    const localMethod = zip.readUInt16LE(localOffset + 8);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const localName = zip
      .subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .toString("utf8");

    if (localFlags !== flags) throw new Error(`flags differ between headers for ${name}`);
    if (localMethod !== method) throw new Error(`methods differ between headers for ${name}`);
    if (localName !== name) throw new Error(`names differ between headers: ${localName} / ${name}`);

    // Bit 3 is the writer's promise that sizes came later; the local header
    // must therefore carry zeroes, not stale values.
    if (zip.readUInt32LE(localOffset + 14) !== 0) throw new Error(`${name}: local crc is not zero`);
    if (zip.readUInt32LE(localOffset + 18) !== 0) {
      throw new Error(`${name}: local compressed size is not zero`);
    }
    if (zip.readUInt32LE(localOffset + 22) !== 0) {
      throw new Error(`${name}: local size is not zero`);
    }

    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(dataStart, dataStart + compressedSize);
    const descriptor = dataStart + compressedSize;

    expectSignature(
      zip.readUInt32LE(descriptor),
      DATA_DESCRIPTOR_SIGNATURE,
      `data descriptor ${name}`,
    );
    if (zip.readUInt32LE(descriptor + 4) !== crc) {
      throw new Error(`${name}: descriptor crc differs from the central directory`);
    }
    if (zip.readUInt32LE(descriptor + 8) !== compressedSize) {
      throw new Error(`${name}: descriptor compressed size differs`);
    }
    if (zip.readUInt32LE(descriptor + 12) !== uncompressedSize) {
      throw new Error(`${name}: descriptor size differs`);
    }

    entries.push({
      name,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      data: method === 0 ? Buffer.from(body) : inflateRawSync(body),
    });

    dataEnd = descriptor + 16;
    at += 46 + nameLength + extraLength + entryCommentLength;
  }

  if (at !== cdOffset + cdSize) {
    throw new Error("central directory size does not match the records it contains");
  }

  return { entries, entriesOnDisk, totalEntries, cdSize, cdOffset, dataEnd };
}

/** A crash record the collector considers usable. */
function crashRecord(at: string): CrashRecord {
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
  };
}

/**
 * A real bundle: a compressible log with a home path, a crash record, and a
 * minidump of random bytes (which deflate cannot shrink, so it is stored).
 */
async function buildBundle(): Promise<{ bundle: DiagnosticsBundle; home: string }> {
  const home = await tempDir();
  const userData = path.join(home, "userData");
  const logsDir = path.join(home, "logs");
  const crashDumpsDir = path.join(home, "crash-dumps");
  const reports = path.join(crashDumpsDir, "reports");
  const day = NOW.toISOString().slice(0, 10);

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
    mkdir(reports, { recursive: true }),
  ]);

  await writeFile(
    path.join(logsDir, `shell-${day}.jsonl`),
    `${JSON.stringify({ event: "diagnostics.export.start", path: path.join(home, "proj", "a.ts") })}\n`.repeat(
      64,
    ),
    "utf8",
  );
  // Random, not zero-filled: a run of one byte deflates to almost nothing, and
  // then the archive would contain no stored entry at all.
  await writeFile(path.join(reports, "abcd1234.dmp"), randomBytes(4096));

  const bundle = await collectDiagnostics({
    userData,
    logsDir,
    crashDumpsDir,
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
    workspace: path.join(home, "workspace"),
    homeDir: home,
    settings: SETTINGS,
    engine: {
      version: "0.6.0",
      protocolVersion: 1,
      backend: "local",
      watchdog: "active",
      degradations: [],
      expectedVersion: "0.6.0",
      stderrTail: ["engine ready"],
    },
    crashes: [crashRecord("2026-11-16T10:00:00.000Z")],
    options: { includeSessionContent: false, includeMinidump: true },
    now: NOW,
    totalMemoryMb: 16_384,
  });

  return { bundle, home };
}

describe("a real diagnostic archive, written and read back", () => {
  it("round-trips every entry, hash and count through a file on disk", async () => {
    const { bundle, home } = await buildBundle();
    const output = path.join(home, "diagnostics.zip");
    const entries: ZipEntry[] = bundle.entries.map((entry) => ({
      path: entry.path,
      data: entry.data,
    }));

    const written = await writeZip(entries, output, { date: NOW });
    const archive = readArchive(await readFile(output));

    // The end-of-central-directory record is the only count a reader trusts.
    expect(written.entries).toBe(entries.length);
    expect(archive.totalEntries).toBe(entries.length);
    expect(archive.entriesOnDisk).toBe(entries.length);
    expect(archive.entries.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.path));
    expect(archive.dataEnd).toBe(archive.cdOffset);

    // Every entry's bytes, size and checksum agree with what the bundle held.
    for (const entry of archive.entries) {
      const original = entries.find((candidate) => candidate.path === entry.name);

      expect(original, entry.name).toBeDefined();
      expect(entry.data.equals(original?.data ?? Buffer.alloc(0)), entry.name).toBe(true);
      expect(entry.uncompressedSize).toBe(original?.data.length);
      expect(entry.crc).toBe(crc32(original?.data ?? Buffer.alloc(0)));
    }

    // Both storage methods appear in a real bundle, and both read back.
    const methods = new Set(archive.entries.map((entry) => entry.method));

    expect(methods.has(0)).toBe(true);
    expect(methods.has(8)).toBe(true);

    // A log is compressible, a random-byte dump is not: the writer must have
    // chosen per entry rather than one method for the whole archive.
    const log = archive.entries.find((entry) => entry.name.startsWith("logs/"));
    const dump = archive.entries.find((entry) => entry.name.startsWith("crash/minidump-"));

    expect(log?.method).toBe(8);
    expect(dump?.method).toBe(0);
    expect(dump?.compressedSize).toBe(dump?.uncompressedSize);
  });

  it("matches every manifest.files[] hash against the decompressed bytes", async () => {
    const { bundle, home } = await buildBundle();
    const output = path.join(home, "diagnostics.zip");

    await writeZip(
      bundle.entries.map((entry) => ({ path: entry.path, data: entry.data })),
      output,
      { date: NOW },
    );

    const archive = readArchive(await readFile(output));
    const byName = new Map(archive.entries.map((entry) => [entry.name, entry]));
    const manifestEntry = byName.get("manifest.json");

    expect(manifestEntry).toBeDefined();

    const manifest = JSON.parse(manifestEntry?.data.toString("utf8") ?? "null") as {
      files: { path: string; bytes: number; sha256: string }[];
      createdAt: string;
    };

    expect(manifest.createdAt).toBe(NOW.toISOString());
    expect(manifest.files.length).toBeGreaterThan(0);

    for (const file of manifest.files) {
      const entry = byName.get(file.path);

      expect(entry, file.path).toBeDefined();
      // The hash a recipient checks is over the bytes that come out of the
      // archive, not over the bytes the writer held before compressing.
      expect(
        createHash("sha256")
          .update(entry?.data ?? Buffer.alloc(0))
          .digest("hex"),
      ).toBe(file.sha256);
      expect(entry?.uncompressedSize).toBe(file.bytes);
    }

    // The manifest cannot contain its own hash: it is present in the archive and
    // deliberately absent from its own file list.
    expect(manifest.files.map((file) => file.path)).not.toContain("manifest.json");
    expect(archive.entries.filter((entry) => entry.name === "manifest.json")).toHaveLength(1);
  });

  it("round-trips a UTF-8 entry name", async () => {
    const home = await tempDir();
    const output = path.join(home, "utf8.zip");
    const name = "logs/日志-2026-11-16.jsonl";
    const other = "内容/附件说明.txt";
    const entries: ZipEntry[] = [
      { path: name, data: Buffer.from("第一行\n", "utf8") },
      { path: other, data: Buffer.from("附件\n", "utf8") },
      { path: "README.txt", data: Buffer.from("plain\n", "utf8") },
    ];

    await writeZip(entries, output, { date: NOW });

    const archive = readArchive(await readFile(output));

    expect(archive.entries.map((entry) => entry.name)).toEqual([name, other, "README.txt"]);

    for (const entry of archive.entries) {
      const original = entries.find((candidate) => candidate.path === entry.name);

      // Bit 11 is the flag that tells the reader the bytes are UTF-8 rather than
      // the legacy code page; without it a Chinese name becomes mojibake.
      expect(entry.flags & 0x0800).toBe(0x0800);
      expect(entry.data.equals(original?.data ?? Buffer.alloc(0))).toBe(true);
    }
  });

  it("keeps a 1 MiB deflated entry byte-exact through the file", async () => {
    // Large enough that a size field truncated to 16 bits would be caught, small
    // enough to stay inside the suite's budget.
    const home = await tempDir();
    const output = path.join(home, "large.zip");
    const body = Buffer.from("diagnostic line\n".repeat(64 * 1024), "utf8");
    const entries: ZipEntry[] = [{ path: "logs/shell-large.jsonl", data: body }];

    await writeZip(entries, output, { date: NOW });

    const archive = readArchive(await readFile(output));
    const entry = archive.entries[0];

    expect(body.length).toBeGreaterThan(MB / 2);
    expect(entry?.uncompressedSize).toBe(body.length);
    expect(entry?.method).toBe(8);
    expect(entry?.data.equals(body)).toBe(true);
  });
});

describe("the archive the export flow actually produces", () => {
  const labels: DiagnosticsExportLabels = {
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

  it("reads back the file the flow reports as written", async () => {
    const home = await tempDir();
    const logsDir = path.join(home, "logs");
    const crashDumpsDir = path.join(home, "crash-dumps");
    const output = path.join(home, "haruyuki-diagnostics-0.1.0.zip");

    await Promise.all([
      mkdir(logsDir, { recursive: true }),
      mkdir(path.join(crashDumpsDir, "reports"), { recursive: true }),
    ]);
    await writeFile(
      path.join(logsDir, `shell-${NOW.toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify({ event: "diagnostics.export.start", token: "tok-live-9999" })}\n`,
      "utf8",
    );

    const context: DiagnosticsExportContext = {
      userData: path.join(home, "userData"),
      logsDir,
      crashDumpsDir,
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
      settings: SETTINGS,
      engine: {
        version: "0.6.0",
        protocolVersion: 1,
        backend: "local",
        watchdog: "active",
        degradations: [],
        expectedVersion: "0.6.0",
        stderrTail: [],
      },
      crashes: [crashRecord("2026-11-16T10:00:00.000Z")],
      sessionSource: null,
    };
    const events: { kind: string; path?: string; bytes?: number }[] = [];
    const deps: DiagnosticsExportDeps = {
      now: () => NOW,
      onEvent: (event) => {
        events.push({
          kind: event.kind,
          ...(event.kind === "done" ? { path: event.path, bytes: event.bytes } : {}),
        });
      },
      showSaveDialog: async () => ({ canceled: false, filePath: output }),
      // `close`, not `open folder`: the flow must still finish the export.
      showMessageBox: async () => ({ response: 1 }),
      openPath: async () => {
        throw new Error("the close button must not open a folder");
      },
      collect: (input) => collectDiagnostics(input),
      writeZip,
      labels,
    };

    const result = await runDiagnosticsExport(
      { options: { includeSessionContent: false, includeMinidump: false } },
      context,
      deps,
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.ok ? result.path : "").toBe(output);

    const onDisk = await stat(output);

    expect(result.ok ? result.bytes : 0).toBe(onDisk.size);

    const done = events.find((event) => event.kind === "done");

    expect(done?.path).toBe(output);
    expect(done?.bytes).toBe(onDisk.size);

    const archive = readArchive(await readFile(output));
    const byName = new Map(archive.entries.map((entry) => [entry.name, entry]));
    const names = archive.entries.map((entry) => entry.name);

    // The tree from `32` section 6.4, written by the flow rather than by the
    // collector in memory.
    expect(names).toEqual(
      expect.arrayContaining([
        "README.txt",
        "summary.txt",
        "manifest.json",
        "env.json",
        "config/shell-settings.json",
        `logs/shell-${NOW.toISOString().slice(0, 10)}.jsonl`,
        "engine/stderr-tail.txt",
        "crash/crash-2026-11-16T10-00-00-000Z.json",
      ]),
    );

    // The exported manifest describes the bytes in the same file, so a recipient
    // can verify what they received without trusting the sender's tooling.
    const manifest = JSON.parse(byName.get("manifest.json")?.data.toString("utf8") ?? "null") as {
      files: { path: string; bytes: number; sha256: string }[];
    };

    expect(manifest.files.map((file) => file.path)).toEqual(
      names.filter((name) => name !== "manifest.json"),
    );

    for (const file of manifest.files) {
      const entry = byName.get(file.path);

      expect(entry, file.path).toBeDefined();
      expect(
        createHash("sha256")
          .update(entry?.data ?? Buffer.alloc(0))
          .digest("hex"),
      ).toBe(file.sha256);
      expect(entry?.uncompressedSize).toBe(file.bytes);
    }

    // The log shipped with its secret already replaced: redaction happens before
    // the writer, and reading the archive back is the only way to see the bytes.
    expect(
      byName.get(`logs/shell-${NOW.toISOString().slice(0, 10)}.jsonl`)?.data.toString("utf8"),
    ).not.toContain("tok-live-9999");
  });
});
