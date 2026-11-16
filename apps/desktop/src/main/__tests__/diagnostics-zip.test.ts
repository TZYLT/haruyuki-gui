import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { crc32, inflateRawSync } from "node:zlib";

import {
  ZipAbortedError,
  buildZipBuffer,
  isZipAborted,
  writeZip,
  type ZipEntry,
} from "../diagnostics/zip.js";

/** Directories this file made, removed pointwise after each test. */
const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-zip-"));

  created.push(dir);

  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

interface ParsedEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
  readonly data: Buffer;
}

interface ParsedArchive {
  readonly entries: ParsedEntry[];
  readonly totalEntries: number;
  readonly cdSize: number;
  readonly cdOffset: number;
}

/**
 * Walk the archive the way a reader does: EOCD, then every central record, then
 * each local header and data descriptor. Written out rather than using a library
 * so the test fails on the exact field that is wrong.
 */
function readArchive(zip: Buffer): ParsedArchive {
  const eocd = zip.length - 22;

  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error("no end-of-central-directory record");

  const totalEntries = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  const entries: ParsedEntry[] = [];
  let at = cdOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header at ${at}`);

    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const uncompressedSize = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");

    if (zip.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error(`bad local header for ${name}`);

    const localFlags = zip.readUInt16LE(localOffset + 6);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);

    if (localFlags !== flags) throw new Error(`flags differ for ${name}`);
    if (zip.readUInt32LE(localOffset + 14) !== 0)
      throw new Error(`local CRC not deferred for ${name}`);
    if (zip.readUInt32LE(localOffset + 18) !== 0)
      throw new Error(`local size not deferred for ${name}`);

    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(dataStart, dataStart + compressedSize);
    const descriptor = dataStart + compressedSize;

    if (zip.readUInt32LE(descriptor) !== 0x08074b50) {
      throw new Error(`no data descriptor for ${name}`);
    }
    if (zip.readUInt32LE(descriptor + 4) !== crc)
      throw new Error(`descriptor CRC differs for ${name}`);
    if (zip.readUInt32LE(descriptor + 8) !== compressedSize) {
      throw new Error(`descriptor compressed size differs for ${name}`);
    }
    if (zip.readUInt32LE(descriptor + 12) !== uncompressedSize) {
      throw new Error(`descriptor uncompressed size differs for ${name}`);
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

    at += 46 + nameLength + extraLength + commentLength;
  }

  if (at !== cdOffset + cdSize)
    throw new Error("central directory size does not match its records");

  return { entries, totalEntries, cdSize, cdOffset };
}

/** The entries of a small, known archive. */
function sampleEntries(): ZipEntry[] {
  return [
    { path: "summary.txt", data: Buffer.from("hello diagnostics\n".repeat(20), "utf8") },
    { path: "content/conversation.json", data: Buffer.from('{"schemaVersion":1}\n', "utf8") },
    { path: "empty.txt", data: Buffer.alloc(0) },
  ];
}

describe("buildZipBuffer", () => {
  it("round-trips every entry through local headers and the central directory", async () => {
    const zip = await buildZipBuffer(sampleEntries(), {
      date: new Date("2026-11-16T12:34:56.000Z"),
    });
    const archive = readArchive(zip);

    expect(archive.totalEntries).toBe(3);
    expect(archive.entries.map((entry) => entry.name)).toEqual([
      "summary.txt",
      "content/conversation.json",
      "empty.txt",
    ]);

    for (const entry of archive.entries) {
      const original = sampleEntries().find((candidate) => candidate.path === entry.name);

      expect(original).toBeDefined();
      expect(entry.data.equals(original?.data ?? Buffer.alloc(0))).toBe(true);
      expect(entry.crc).toBe(crc32(original?.data ?? Buffer.alloc(0)));
      expect(entry.uncompressedSize).toBe(original?.data.length);
      expect(entry.flags & 0x0008).toBe(0x0008);
      expect(entry.flags & 0x0800).toBe(0x0800);
    }

    // Empty input stays a store entry of size zero rather than a deflate stream.
    const empty = archive.entries.find((entry) => entry.name === "empty.txt");

    expect(empty?.method).toBe(0);
    expect(empty?.compressedSize).toBe(0);
  });

  it("stores incompressible bytes and deflates compressible ones", async () => {
    const noisy = randomBytes(4096);
    const repetitive = Buffer.from("diagnostic line\n".repeat(100_000), "utf8");
    const archive = readArchive(
      await buildZipBuffer([
        { path: "noise.bin", data: noisy },
        { path: "big.txt", data: repetitive },
      ]),
    );

    const stored = archive.entries.find((entry) => entry.name === "noise.bin");
    const deflated = archive.entries.find((entry) => entry.name === "big.txt");

    expect(stored?.method).toBe(0);
    expect(stored?.compressedSize).toBe(noisy.length);
    expect(stored?.data.equals(noisy)).toBe(true);

    expect(deflated?.method).toBe(8);
    expect(deflated?.compressedSize).toBeLessThan(repetitive.length);
    expect(deflated?.data.equals(repetitive)).toBe(true);
  });

  it("writes the DOS timestamp in UTC and clamps it to the format's range", async () => {
    const zip = await buildZipBuffer(sampleEntries(), {
      date: new Date("2026-11-16T12:34:56.000Z"),
    });
    const archive = readArchive(zip);
    const localOffset = archive.entries[0]?.localOffset ?? 0;
    const time = zip.readUInt16LE(localOffset + 10);
    const day = zip.readUInt16LE(localOffset + 12);

    expect(time).toBe((12 << 11) | (34 << 5) | (56 >> 1));
    expect(day).toBe(((2026 - 1980) << 9) | (11 << 5) | 16);
  });

  it("rejects duplicate, traversal and absolute names", async () => {
    const data = Buffer.from("x");
    const cases: [string, ZipEntry[]][] = [
      [
        "duplicate",
        [
          { path: "a.txt", data },
          { path: "a.txt", data },
        ],
      ],
      ["is not a plain relative path", [{ path: "../escape.txt", data }]],
      ["is not a plain relative path", [{ path: "logs/../../escape.txt", data }]],
      ["is absolute", [{ path: "/etc/passwd", data }]],
      ["has a drive", [{ path: "C:/Windows/system.ini", data }]],
      ["must use forward slashes", [{ path: "logs\\shell.jsonl", data }]],
      ["is not a plain relative path", [{ path: "logs//x.jsonl", data }]],
      ["is empty", [{ path: "", data }]],
    ];

    for (const [message, entries] of cases) {
      await expect(buildZipBuffer(entries)).rejects.toThrow(message);
    }
  });

  it("writes nothing for an archive with no entries", async () => {
    const archive = readArchive(await buildZipBuffer([]));

    expect(archive.totalEntries).toBe(0);
    expect(archive.cdSize).toBe(0);
    expect(archive.cdOffset).toBe(0);
  });
});

describe("writeZip", () => {
  it("writes a 1-2 MB archive and reports progress", async () => {
    const dir = await tempDir();
    const output = path.join(dir, "bundle.zip");
    const big = Buffer.from("a diagnostic archive line\n".repeat(60_000), "utf8");
    const progress: number[] = [];

    expect(big.length).toBeGreaterThan(1024 * 1024);

    const result = await writeZip(
      [
        { path: "README.txt", data: Buffer.from("read me\n") },
        { path: "logs/big.jsonl", data: big },
      ],
      output,
      { onProgress: (done) => progress.push(done) },
    );

    const written = await stat(output);

    expect(result.entries).toBe(2);
    expect(result.bytes).toBe(written.size);
    expect(progress.at(-1)).toBe(big.length + "read me\n".length);

    const archive = readArchive(await readFile(output));

    expect(archive.entries.find((entry) => entry.name === "logs/big.jsonl")?.data.equals(big)).toBe(
      true,
    );
  });

  it("leaves no file when an entry name is refused", async () => {
    const dir = await tempDir();
    const output = path.join(dir, "bundle.zip");

    await expect(
      writeZip([{ path: "../escape.txt", data: Buffer.from("x") }], output),
    ).rejects.toThrow();

    expect(await readdir(dir)).toEqual([]);
  });

  it("leaves no temp file when the target cannot be replaced", async () => {
    const dir = await tempDir();
    const output = path.join(dir, "bundle.zip");

    // A directory where the file should go makes the rename fail after the temp
    // file has been written; the cleanup must still remove it.
    await mkdir(output);

    await expect(
      writeZip([{ path: "README.txt", data: Buffer.from("x") }], output),
    ).rejects.toThrow();

    expect(await readdir(dir)).toEqual(["bundle.zip"]);
  });

  it("cancels before writing and leaves nothing behind", async () => {
    const dir = await tempDir();
    const output = path.join(dir, "bundle.zip");
    const controller = new AbortController();

    controller.abort();

    const error = await writeZip([{ path: "README.txt", data: Buffer.from("x") }], output, {
      signal: controller.signal,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ZipAbortedError);
    expect(isZipAborted(error)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });
});
