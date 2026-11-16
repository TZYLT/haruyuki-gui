/**
 * The zip writer: a standard archive from `node:zlib`, with no dependency.
 *
 * The route decided not to add a zip package (`RD-03`): it would be a new
 * dependency for one call site, and the format is small enough to write. What the
 * archive has to be is exactly "a zip Windows Explorer, bsdtar and PowerShell
 * Expand-Archive all open", so this file implements the three structures those
 * readers expect and nothing else:
 *
 *   Local header + compressed data + data descriptor. Bit 3 says "sizes and CRC
 *   come after the data", which is what lets an entry be written without knowing
 *   its compressed size first. The UTF-8 flag (bit 11) makes non-ASCII names
 *   survive; every name we ship is ASCII today, and a future one should not be
 *   mangled silently.
 *
 *   Central directory, then the end-of-central-directory record. Their offsets
 *   and counts are the only index a reader trusts.
 *
 *   Store (method 0) when deflate does not make the entry smaller, deflate
 *   (method 8) otherwise. A minidump that grows when compressed is a real case,
 *   and choosing store for it is the difference between "archive" and "archive
 *   pretending to compress".
 *
 * What is NOT here: the 50 MB package cap, the save dialog, progress phases and
 * opening the containing folder. Those belong to the export flow (`P7`); this
 * writer accepts bytes and either produces a file or leaves the directory clean.
 */

import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { crc32, deflateRaw } from "node:zlib";

/** One file to archive. Paths are bundle-relative and use forward slashes. */
export interface ZipEntry {
  readonly path: string;
  readonly data: Buffer;
}

/** How the caller watches and cancels a write. */
export interface ZipWriteOptions {
  /** Called after each entry, with bytes of input processed so far. */
  readonly onProgress?: (doneBytes: number, totalBytes: number) => void;
  /** Aborts between entries and before the rename. */
  readonly signal?: AbortSignal;
  /** Timestamp stored in the DOS fields; defaults to now. */
  readonly date?: Date;
}

/** Thrown when the caller's signal fired; the output path is left untouched. */
export class ZipAbortedError extends Error {
  constructor() {
    super("zip export was cancelled");
    this.name = "ZipAbortedError";
  }
}

/** Whether a thrown value is the cancellation this writer raises. */
export function isZipAborted(error: unknown): boolean {
  return error instanceof ZipAbortedError;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

/** Bit 3: sizes/CRC in a data descriptor. Bit 11: names are UTF-8. */
const FLAGS = 0x0008 | 0x0800;
const VERSION = 20;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

/** Deflate's default level; the package budget is bytes, not seconds. */
const DEFLATE_LEVEL = 6;

/** Compress one entry, as a promise so entries can be compressed one at a time. */
function deflate(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    deflateRaw(data, { level: DEFLATE_LEVEL }, (error, result) => {
      if (error !== null) reject(error);
      else resolve(result);
    });
  });
}

/**
 * Check a bundle path before it becomes a zip name.
 *
 * The archive is opened by a person on another machine, so a name that escapes
 * the extraction directory is not a cosmetic problem. Absolute paths, `..`,
 * `.`, empty segments and backslashes are all rejected: the first two are
 * traversal, and the last two would produce two spellings of one name depending
 * on the reader.
 */
function assertSafePath(entryPath: string): void {
  if (entryPath.length === 0) throw new Error("zip entry path is empty");
  if (entryPath.startsWith("/")) throw new Error(`zip entry path is absolute: ${entryPath}`);
  if (/^[A-Za-z]:/.test(entryPath)) throw new Error(`zip entry path has a drive: ${entryPath}`);
  if (entryPath.includes("\\")) {
    throw new Error(`zip entry path must use forward slashes: ${entryPath}`);
  }

  for (const segment of entryPath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`zip entry path is not a plain relative path: ${entryPath}`);
    }
  }
}

/**
 * MS-DOS date and time words for one instant.
 *
 * UTC, not local: the bundle is read on machines in other timezones, and a
 * timestamp that depends on who zipped it is worse than one that is off by a
 * known offset. The format starts in 1980 and has no second resolution.
 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day =
    ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | Math.max(date.getUTCDate(), 1);

  return { time, date: day };
}

/** Throw when the caller asked us to stop; checked at every entry boundary. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ZipAbortedError();
}

/**
 * Build the whole archive in memory.
 *
 * Entries are compressed sequentially rather than in parallel: a diagnostic
 * bundle is dominated by one or two large log files, and running every deflate
 * at once would multiply peak memory by the entry count for no wall-clock win.
 *
 * @param entries files to include, in archive order
 * @param options progress, cancellation and the timestamp
 * @returns the bytes of a complete `.zip`
 */
export async function buildZipBuffer(
  entries: readonly ZipEntry[],
  options: ZipWriteOptions = {},
): Promise<Buffer> {
  const seen = new Set<string>();
  const date = dosDateTime(options.date ?? new Date());
  const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let done = 0;

  throwIfAborted(options.signal);

  for (const entry of entries) {
    assertSafePath(entry.path);

    if (seen.has(entry.path)) throw new Error(`duplicate zip entry: ${entry.path}`);
    seen.add(entry.path);

    throwIfAborted(options.signal);

    const compressed = await deflate(entry.data);
    const stored = compressed.length >= entry.data.length;
    const body = stored ? entry.data : compressed;
    const method = stored ? METHOD_STORE : METHOD_DEFLATE;
    const name = Buffer.from(entry.path, "utf8");
    const checksum = crc32(entry.data);

    const header = Buffer.alloc(30);

    header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(date.time, 10);
    header.writeUInt16LE(date.date, 12);
    header.writeUInt32LE(0, 14); // CRC lives in the descriptor
    header.writeUInt32LE(0, 18); // compressed size, likewise
    header.writeUInt32LE(0, 22); // uncompressed size, likewise
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    const descriptor = Buffer.alloc(16);

    descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeUInt32LE(body.length, 8);
    descriptor.writeUInt32LE(entry.data.length, 12);

    locals.push(header, name, body, descriptor);

    const directory = Buffer.alloc(46);

    directory.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    directory.writeUInt16LE(VERSION, 4); // made by
    directory.writeUInt16LE(VERSION, 6); // needed
    directory.writeUInt16LE(FLAGS, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(date.time, 12);
    directory.writeUInt16LE(date.date, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30); // extra
    directory.writeUInt16LE(0, 32); // comment
    directory.writeUInt16LE(0, 34); // disk
    directory.writeUInt16LE(0, 36); // internal attributes
    directory.writeUInt32LE(0, 38); // external attributes
    directory.writeUInt32LE(offset, 42);

    central.push(directory, name);

    offset += header.length + name.length + body.length + descriptor.length;
    done += entry.data.length;

    if (offset > MAX_UINT32) throw new Error("zip archive exceeds 4 GiB; split the export");
    if (entries.length > MAX_UINT16) throw new Error("zip archive has too many entries");

    options.onProgress?.(done, total);
  }

  const directoryOffset = offset;
  const directorySize = central.reduce((sum, chunk) => sum + chunk.length, 0);

  if (directoryOffset + directorySize > MAX_UINT32) {
    throw new Error("zip central directory exceeds 4 GiB");
  }

  const end = Buffer.alloc(22);

  end.writeUInt32LE(END_OF_CENTRAL_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(directoryOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  throwIfAborted(options.signal);

  return Buffer.concat([...locals, ...central, end]);
}

/**
 * Write an archive to `outputPath`, atomically.
 *
 * The bytes are built first, then written to a uniquely named sibling and
 * renamed into place. A failure or a cancellation at any point leaves either the
 * previous file or no file, never a truncated `.zip` that a reader would report
 * as corrupt -- `32` section 4.2-7 requires exactly that ("不留下半包").
 *
 * @param entries files to include
 * @param outputPath the destination path, chosen by the save dialog
 * @param options progress, cancellation and timestamp
 * @returns the file's size and entry count
 */
export async function writeZip(
  entries: readonly ZipEntry[],
  outputPath: string,
  options: ZipWriteOptions = {},
): Promise<{ bytes: number; entries: number }> {
  const temporary = `${outputPath}.${randomUUID()}.part`;

  try {
    const buffer = await buildZipBuffer(entries, options);

    throwIfAborted(options.signal);

    await writeFile(temporary, buffer);

    throwIfAborted(options.signal);

    await rename(temporary, outputPath);

    return { bytes: buffer.length, entries: entries.length };
  } catch (error) {
    // Best effort: the rename may already have happened, and masking the real
    // failure with a cleanup error would hide why the export stopped.
    try {
      await unlink(temporary);
    } catch {
      // Nothing to remove, or nothing we can do about it.
    }

    throw error;
  }
}
