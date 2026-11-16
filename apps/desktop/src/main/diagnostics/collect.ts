/**
 * What goes into a diagnostic bundle: which files, from where, and what is said
 * about them.
 *
 * Files come only from the three places the shell already manages (logs, crash
 * records, minidumps), never from a disk scan; every path is relative because
 * the archive is meant to leave the machine.
 *
 * It deletes nothing: when a section budget is hit the file stays on disk and is
 * listed in `omitted`. It does not own the 50 MB package cap, the dialog or the
 * zip -- those are the export flow's (`P7`); this module returns entries and a
 * manifest so the cap can be judged on real bytes. Every string is redacted on
 * the way in, including the prose written by `bundle-parts.ts`.
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { DiagnosticsManifest, OmittedItem } from "../../shared/diagnostics.js";
import { crashRecordFileName, type CrashRecord } from "../crash/records.js";
import {
  buildEnv,
  buildManifest,
  buildReadme,
  buildStderrTail,
  buildSummary,
  sha256Of,
  type BundleFile,
  type DiagnosticsCollectOptions,
  type DiagnosticsEngineFacts,
} from "./bundle-parts.js";
import { redactDiagnosticText, redactValue, type RedactOptions } from "./redact.js";
import { readActiveSession, type ActiveSessionSnapshot } from "./session.js";

export type { DiagnosticsCollectOptions, DiagnosticsEngineFacts } from "./bundle-parts.js";

/** One file in the bundle, with the index data the manifest repeats. */
export interface DiagnosticsBundleEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly data: Buffer;
}

/** Everything an exporter needs before it starts compressing. */
export interface DiagnosticsBundle {
  readonly entries: readonly DiagnosticsBundleEntry[];
  readonly manifest: DiagnosticsManifest;
  readonly summary: string;
  readonly omitted: readonly OmittedItem[];
  /** What the collector did with session content; used when a trim rebuilds summary. */
  readonly session?: "absent" | "empty" | "included";
}

/** Anything a budget pass can choose from: a day file, a record, a dump. */
interface Candidate {
  readonly path: string;
  readonly source: string;
  readonly bytes: number;
  /** Ordering instant, or `null` when the source is unusable. */
  readonly at: number | null;
  /** Already-serialised bytes for sources that are not files (crash records). */
  readonly data?: Buffer;
}

/** Section budgets from `32` section 6.4; selection only, nothing is deleted. */
const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_DAYS = 7;
const LOG_MB = 50;
const CRASH_DAYS = 30;
const CRASH_MB = 10;
const MINIDUMP_DAYS = 7;
const MINIDUMP_MB = 200;
const LOG_FILE = /^shell-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const MINIDUMP_FILE = /\.dmp$/i;
const MINIDUMP_SUBDIR = "reports";

function textFile(contents: string): Buffer {
  return Buffer.from(contents, "utf8");
}

/** Newline-terminated pretty JSON, because a person may open the file by hand. */
function jsonFile(value: unknown): Buffer {
  return textFile(`${JSON.stringify(value, null, 2)}\n`);
}

function toEntry(file: BundleFile): DiagnosticsBundleEntry {
  return { path: file.path, bytes: file.data.length, sha256: sha256Of(file.data), data: file.data };
}

function utcDayStart(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/**
 * The UTC day a `shell-YYYY-MM-DD.jsonl` name claims, or `null`.
 *
 * Round-tripped through an ISO date string, so `shell-2026-02-30.jsonl` is
 * rejected rather than silently normalised into March.
 */
function logDayOf(name: string): number | null {
  const match = LOG_FILE.exec(name);

  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = Date.UTC(year, month - 1, day);

  return new Date(start).toISOString().slice(0, 10) === name.slice(6, 16) ? start : null;
}

/** A directory listing, with "missing" treated as "nothing to add". */
async function listDir(dir: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Size and mtime of a regular file, or `null` when it is not one. */
async function stampOf(file: string): Promise<{ bytes: number; mtimeMs: number } | null> {
  try {
    const info = await stat(file);

    return info.isFile() ? { bytes: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Newest-first files from one directory, or `[]` when the directory is absent. */
async function fileCandidates(
  dir: string,
  accept: (name: string) => boolean,
  bundlePath: (name: string) => string,
  at: (name: string, stamp: { bytes: number; mtimeMs: number }) => number | null,
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  for (const entry of await listDir(dir)) {
    if (!entry.isFile() || !accept(entry.name)) continue;

    const source = path.join(dir, entry.name);
    const stamp = await stampOf(source);

    candidates.push({
      path: bundlePath(entry.name),
      source,
      bytes: stamp?.bytes ?? 0,
      at: stamp === null ? null : at(entry.name, stamp),
    });
  }

  return candidates.sort(
    (a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || b.path.localeCompare(a.path),
  );
}

/**
 * Apply the day window and the byte budget to a newest-first candidate list.
 *
 * Selection stops at the first file that would overflow: taking a later, smaller
 * file would skip a day and keep an older one, which reads like a missing day
 * rather than a budget. `at === null` means untimestampable; `read` returning
 * `null` means unreadable.
 */
async function selectByBudget<T extends Candidate>(
  candidates: readonly T[],
  cutoff: number,
  budget: number,
  omitted: OmittedItem[],
  read: (candidate: T) => Promise<Buffer | null>,
): Promise<BundleFile[]> {
  const prepared: BundleFile[] = [];
  let spent = 0;
  let stopped = false;

  for (const candidate of candidates) {
    if (candidate.at === null || candidate.at < cutoff) {
      omitted.push({
        path: candidate.path,
        bytes: candidate.bytes,
        reason: candidate.at === null ? "unreadable" : "retention",
      });
      continue;
    }

    if (stopped || spent + candidate.bytes > budget) {
      omitted.push({ path: candidate.path, bytes: candidate.bytes, reason: "cap" });
      stopped = true;
      continue;
    }

    const data = await read(candidate);

    if (data === null) {
      omitted.push({ path: candidate.path, bytes: candidate.bytes, reason: "unreadable" });
      continue;
    }

    // Redaction changes the byte count; the budget follows what would ship.
    if (spent + data.length > budget) {
      omitted.push({ path: candidate.path, bytes: data.length, reason: "cap" });
      stopped = true;
      continue;
    }

    spent += data.length;
    prepared.push({ path: candidate.path, data });
  }

  return prepared;
}

/** The newest log day files that fit the day and byte budgets, redacted. */
async function selectLogs(
  options: DiagnosticsCollectOptions,
  now: Date,
  redact: RedactOptions,
  omitted: OmittedItem[],
): Promise<BundleFile[]> {
  const candidates = await fileCandidates(
    options.logsDir,
    (name) => logDayOf(name) !== null,
    (name) => `logs/${name}`,
    (name) => logDayOf(name),
  );

  return selectByBudget(
    candidates,
    utcDayStart(now) - (LOG_DAYS - 1) * DAY_MS,
    LOG_MB * MB,
    omitted,
    async (candidate) => {
      try {
        return textFile(redactDiagnosticText(await readFile(candidate.source, "utf8"), redact));
      } catch {
        return null;
      }
    },
  );
}

/** The newest crash records that fit the day and byte budgets, redacted. */
function selectCrashes(
  crashes: readonly CrashRecord[],
  now: Date,
  redact: RedactOptions,
  omitted: OmittedItem[],
): Promise<BundleFile[]> {
  const candidates = crashes
    .map((record, index): Candidate => {
      const data = jsonFile(redactValue(record, redact));
      const at = Date.parse(record.at);

      return {
        path: Number.isNaN(at)
          ? `crash/crash-unparsed-${index}.json`
          : `crash/${crashRecordFileName(new Date(at))}`,
        source: "",
        bytes: data.length,
        at: Number.isNaN(at) ? null : at,
        data,
      };
    })
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));

  return selectByBudget(
    candidates,
    now.getTime() - CRASH_DAYS * DAY_MS,
    CRASH_MB * MB,
    omitted,
    (candidate) => Promise.resolve(candidate.data ?? null),
  );
}

/** The newest `reports/*.dmp` files that fit the day and byte budgets. */
async function selectMinidumps(
  options: DiagnosticsCollectOptions,
  now: Date,
  omitted: OmittedItem[],
): Promise<BundleFile[]> {
  const candidates = await fileCandidates(
    path.join(options.crashDumpsDir, MINIDUMP_SUBDIR),
    (name) => MINIDUMP_FILE.test(name),
    // Renamed so a dump cannot collide with a bundle file of the same name.
    (name) => `crash/minidump-${name}`,
    (_name, stamp) => stamp.mtimeMs,
  );

  return selectByBudget(
    candidates,
    now.getTime() - MINIDUMP_DAYS * DAY_MS,
    MINIDUMP_MB * MB,
    omitted,
    async (candidate) => {
      try {
        return await readFile(candidate.source);
      } catch {
        return null;
      }
    },
  );
}

/** The conversation file, or the explicit placeholder when there is no source. */
function buildConversation(
  snapshot: ActiveSessionSnapshot | null,
  redact: RedactOptions,
): BundleFile {
  const payload =
    snapshot === null
      ? {
          schemaVersion: 1,
          session: null,
          messages: [],
          note: "no active session in this shell build",
        }
      : {
          schemaVersion: 1,
          conversationId: snapshot.conversationId,
          messages: snapshot.messages,
        };

  return { path: "content/conversation.json", data: jsonFile(redactValue(payload, redact)) };
}

/**
 * Build every file of a diagnostic bundle, plus its manifest.
 *
 * @param input the captured facts and the user's two options
 * @returns the entries to zip, the manifest and the summary text
 */
export async function collectDiagnostics(
  input: DiagnosticsCollectOptions,
): Promise<DiagnosticsBundle> {
  const now = input.now ?? new Date();
  const homeDir = input.homeDir ?? homedir();
  const redact: RedactOptions =
    input.secrets === undefined ? { homeDir } : { homeDir, secrets: input.secrets };
  const omitted: OmittedItem[] = [];
  const included: BundleFile[] = [];
  const readme = textFile(redactDiagnosticText(buildReadme(input.appVersion), redact));

  included.push({ path: "env.json", data: jsonFile(redactValue(buildEnv(input), redact)) });
  included.push({
    path: "config/shell-settings.json",
    data: jsonFile(redactValue(input.settings, redact)),
  });
  included.push(...(await selectLogs(input, now, redact, omitted)));
  included.push({
    path: "engine/stderr-tail.txt",
    data: buildStderrTail(input.engine.stderrTail, redact),
  });
  included.push(...(await selectCrashes(input.crashes, now, redact, omitted)));

  if (input.options.includeMinidump) {
    included.push(...(await selectMinidumps(input, now, omitted)));
  }

  let session: "absent" | "empty" | "included" = "absent";

  if (input.options.includeSessionContent) {
    const snapshot = readActiveSession();

    session = snapshot === null ? "empty" : "included";
    included.push(buildConversation(snapshot, redact));
  }

  const summary = redactDiagnosticText(
    buildSummary(input, now, included.length, omitted, session),
    redact,
  );
  // The manifest lists everything that ships, in the order the tree in `32`
  // section 6.4 reads; it is appended afterwards and excluded from `files`.
  const listed: BundleFile[] = [
    { path: "README.txt", data: readme },
    { path: "summary.txt", data: textFile(summary) },
    ...included,
  ];
  const manifest = buildManifest(input, now, listed, omitted, homeDir.length > 0);
  const manifestFile: BundleFile = { path: "manifest.json", data: jsonFile(manifest) };

  return { entries: [...listed, manifestFile].map(toEntry), manifest, summary, omitted, session };
}
