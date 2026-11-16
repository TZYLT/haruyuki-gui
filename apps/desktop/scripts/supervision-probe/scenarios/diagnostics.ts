/**
 * Retention and redaction boundaries, then the exported bundle.
 *
 * Both are judged on temp directories only. The retention case uses real byte
 * sizes so the 50 MB cap is crossed by actual bytes; the bundle case reads the
 * back, so "the zip contains what the manifest claims" is checked against the zip
 * rather than against the writer's own list.
 */

import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  crashDirFor,
  writeCrashRecordSync,
  type CrashRecord,
  type CrashVersions,
} from "../../../src/main/crash/records.js";
import { runShellCleanup } from "../../../src/main/diagnostics/cleanup.js";
import { collectDiagnostics } from "../../../src/main/diagnostics/collect.js";
import {
  REDACTED,
  TOKEN_FILE_PLACEHOLDER,
  redactText,
} from "../../../src/main/diagnostics/redact.js";
import { cleanupLogs } from "../../../src/main/diagnostics/retention.js";
import { writeZip } from "../../../src/main/diagnostics/zip.js";
import { DEFAULT_LOG_RETENTION, type ShellSettings } from "../../../src/main/settings.js";
import { EXPECTED_ENGINE_VERSION, PROBE_APP_VERSION, TEMP_ROOT } from "../environment.js";
import { describe, record } from "../report.js";
import type { EngineObservation } from "./engine.js";

// ---------------------------------------------------------------------------
// Retention and redaction on temp directories
// ---------------------------------------------------------------------------

/**
 * The 7-day / 50 MB log boundary and the redaction corpus.
 *
 * The size case uses two real ~26 MB files (52 MB total) so the 50 MB cap is
 * crossed by actual bytes, not by a scaled-down configuration. The current UTC
 * day is excluded from both passes by construction; that is asserted.
 */
async function checkV07(): Promise<void> {
  // The configurable-retention row covers two halves; this check measures the
  // default half only, so it must not claim the docs id. The scenario keeps its
  // claiming the configured-override row that `checkV10V11` judges.
  const id = "log-retention-default";
  const logsDir = path.join(TEMP_ROOT, "v07-logs");
  const fakeHome = path.join(TEMP_ROOT, "fake-home", "alice");
  const dayMs = 24 * 60 * 60 * 1000;
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  mkdirSync(logsDir, { recursive: true });

  /** `shell-YYYY-MM-DD.jsonl` for a day offset from today. */
  const logName = (daysAgo: number): string => {
    const at = new Date(todayStart - daysAgo * dayMs);

    return `shell-${at.toISOString().slice(0, 10)}.jsonl`;
  };

  /** Write one log day file of a given size. */
  const writeLog = (daysAgo: number, bytes: number): string => {
    const file = path.join(logsDir, logName(daysAgo));

    writeFileSync(file, Buffer.alloc(bytes, 0x61));

    return file;
  };

  try {
    if (DEFAULT_LOG_RETENTION.retentionDays !== 7 || DEFAULT_LOG_RETENTION.maxTotalMb !== 50) {
      record(
        id,
        "FAIL",
        `defaults are ${JSON.stringify(DEFAULT_LOG_RETENTION)}, expected 7 days / 50 MB`,
      );
      return;
    }

    const todayFile = writeLog(0, 1024);
    const yesterday = writeLog(1, 1024);
    const twoDays = writeLog(2, 1024);
    const insideWindow = writeLog(4, 1024);
    const bigAge = writeLog(3, 26 * 1024 * 1024);
    const bigOldest = writeLog(5, 26 * 1024 * 1024);
    const sevenDays = writeLog(7, 1024);
    const thirtyDays = writeLog(30, 1024);
    const foreign = path.join(logsDir, "engine.log");

    writeFileSync(foreign, "not ours\n", "utf8");

    const sweep = await cleanupLogs(logsDir, DEFAULT_LOG_RETENTION, now);
    const problems: string[] = [];
    const exists = (file: string): boolean => existsSync(file);

    if (exists(sevenDays)) problems.push("a 7-day-old file survived the age pass");
    if (exists(thirtyDays)) problems.push("a 30-day-old file survived the age pass");
    if (!exists(todayFile)) problems.push("the current UTC day was deleted");
    if (!exists(yesterday)) problems.push("yesterday's file inside the window was deleted");
    if (!exists(twoDays)) problems.push("a 2-day-old file was deleted");
    if (!exists(insideWindow)) problems.push("a 4-day-old small file was deleted");
    if (!exists(foreign)) problems.push("a file this shell did not write was deleted");
    if (sweep.bytesAfter > DEFAULT_LOG_RETENTION.maxTotalMb * 1024 * 1024) {
      problems.push(`bytesAfter=${String(sweep.bytesAfter)} is still over the cap`);
    }
    if (sweep.overCap) problems.push("the sweep reported overCap after deleting enough bytes");
    if (exists(bigOldest)) problems.push("the oldest of the two oversized days survived");
    if (!exists(bigAge)) problems.push("the size pass deleted more than it needed");

    // The redaction corpus: a home path in both separator spellings, a known
    // secret value, a JSON secret-named key, and a token-file flag.
    const secret = "probe-secret-value-9c1b";
    const corpus = [
      `open ${fakeHome}\\AppData\\Roaming\\haruyuki\\runtime.json`,
      `open ${fakeHome.replaceAll("\\", "/")}/engine-token/engine-token`,
      `runToken=${secret}`,
      `{"runToken":"${secret}","notes":"kept"}`,
      `Authorization: Bearer ${secret}`,
      `--ws-token-file ${fakeHome}\\engine-token\\engine-token`,
      "tokenizer=fast should survive",
    ].join("\n");
    const redacted = redactText(corpus, { homeDir: fakeHome, secrets: [secret] });

    if (redacted.includes(fakeHome) || redacted.includes(fakeHome.replaceAll("\\", "/"))) {
      problems.push("the home path survived redaction");
    }
    if (redacted.includes(secret)) problems.push("the known secret survived redaction");
    if (!redacted.includes("~")) problems.push("the home path was not replaced with ~");
    if (!redacted.includes(REDACTED)) problems.push(`the secret was not replaced with ${REDACTED}`);
    if (!redacted.includes(TOKEN_FILE_PLACEHOLDER))
      problems.push("the token-file path was not replaced");
    if (!redacted.includes("tokenizer=fast")) problems.push("a non-secret key was over-redacted");

    if (problems.length > 0) {
      record(id, "FAIL", problems.join("; "));
      return;
    }

    record(
      id,
      "PASS",
      `window=7d/50MB deleted=${String(sweep.deleted.length)} ` +
        `bytesBefore=${mb(sweep.bytesBefore)}MB bytesAfter=${mb(sweep.bytesAfter)}MB ` +
        `currentDayKept=true foreignKept=true redactions=home+secret+tokenfile`,
    );
  } finally {
    await rm(logsDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Format bytes as MiB with one decimal. */
function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// ---------------------------------------------------------------------------
// The other two retention windows and the configured overrides
// ---------------------------------------------------------------------------

/** A crash record with only the fields the retention sweep reads. */
function crashAt(at: Date, versions: CrashVersions): CrashRecord {
  return {
    schemaVersion: 1,
    at: at.toISOString(),
    kind: "engine",
    code: "ENGINE_CRASHED",
    app: versions,
    engine: {
      exitCode: 1,
      signal: null,
      engineVersion: "0.6.0",
      protocolVersion: 1,
      watchdog: "unknown",
    },
  };
}

/**
 * Crash records and minidumps age/size out independently of logs, and the
 * configured `logs.retentionDays` / `logs.maxTotalMb` overrides win over the
 * over the defaults (and the production wrapper is what runs them).
 *
 * Both use temp trees. The crash-record case deliberately leaves the newest record
 * window: it must survive because it is the only evidence, which is RD-17.
 */
async function checkV10V11(): Promise<void> {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const root = path.join(TEMP_ROOT, "v10");
  const userData = path.join(root, "userData");
  const crashDir = crashDirFor(userData);
  const crashDumpsDir = path.join(root, "crash-dumps");
  const reports = path.join(crashDumpsDir, "reports");
  const metadata = path.join(crashDumpsDir, "metadata");
  const logsDir = path.join(root, "logs");
  const oldRecord = path.join(crashDir, "crash-old.json");
  const newRecord = path.join(crashDir, "crash-new.json");
  const oldDump = path.join(reports, "old.dmp");
  const newDump = path.join(reports, "new.dmp");
  const metadataFile = path.join(metadata, "settings.dat");
  const versions = probeVersions();

  try {
    mkdirSync(crashDir, { recursive: true });
    mkdirSync(reports, { recursive: true });
    mkdirSync(metadata, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    // Old and recent records. The newest is 31 days old and must survive.
    writeFileSync(
      oldRecord,
      JSON.stringify(crashAt(new Date(now.getTime() - 60 * dayMs), versions)),
    );
    writeFileSync(
      newRecord,
      JSON.stringify(crashAt(new Date(now.getTime() - 31 * dayMs), versions)),
    );

    writeFileSync(oldDump, Buffer.alloc(1024));
    writeFileSync(newDump, Buffer.alloc(1024));
    writeFileSync(metadataFile, "crashpad settings\n", "utf8");
    utimesSync(oldDump, new Date(now.getTime() - 8 * dayMs), new Date(now.getTime() - 8 * dayMs));

    const ten = await runShellCleanup({
      logsDir,
      crashDir,
      crashDumpsDir,
      now,
      onLog: () => undefined,
    });

    const tenProblems: string[] = [];

    if (ten.crashes === null) tenProblems.push("no crash sweep result");
    if (!ten.crashes?.deleted.includes(path.basename(oldRecord))) {
      tenProblems.push("the 60-day crash record survived");
    }
    if (!existsSync(newRecord)) tenProblems.push("the newest crash record was deleted");
    if (existsSync(oldDump)) tenProblems.push("the 8-day minidump survived");
    if (!existsSync(newDump)) tenProblems.push("the newest minidump was deleted");
    if (!existsSync(metadataFile)) tenProblems.push("a non-reports crashpad file was deleted");
    if (ten.failures.length > 0) tenProblems.push(`failures=${String(ten.failures.length)}`);

    if (tenProblems.length > 0) {
      record("crash-record-retention", "FAIL", tenProblems.join("; "));
    } else {
      record(
        "crash-record-retention",
        "PASS",
        `crashes=${String(ten.crashes?.deleted.length ?? 0)} minidumps=${String(
          ten.minidumps?.deleted.length ?? 0,
        )} newestKept=true metadataKept=true`,
      );
    }

    // The same log tree, but 3 days / 10 MB instead of 7 / 50.
    const v11Root = path.join(root, "v11");
    const v11Logs = path.join(v11Root, "logs");

    mkdirSync(v11Logs, { recursive: true });

    const logName = (daysAgo: number): string =>
      `shell-${new Date(now.getTime() - daysAgo * dayMs).toISOString().slice(0, 10)}.jsonl`;
    const writeLog = (daysAgo: number, bytes: number): string => {
      const file = path.join(v11Logs, logName(daysAgo));

      writeFileSync(file, Buffer.alloc(bytes, 0x62));

      return file;
    };

    const byAge = writeLog(4, 1024);
    const bySize = writeLog(2, 6 * 1024 * 1024);
    const oneDay = writeLog(1, 6 * 1024 * 1024);
    const today = writeLog(0, 1024 * 1024);

    const eleven = await runShellCleanup({
      logsDir: v11Logs,
      crashDir: path.join(v11Root, "crashes"),
      crashDumpsDir: path.join(v11Root, "crash-dumps"),
      logs: { retentionDays: 3, maxTotalMb: 10 },
      now,
      onLog: () => undefined,
    });
    const elevenProblems: string[] = [];

    if (existsSync(byAge)) elevenProblems.push("a 4-day file survived the 3-day override");
    if (existsSync(bySize)) elevenProblems.push("a 2-day/6 MB file survived the 10 MB override");
    if (!existsSync(oneDay)) elevenProblems.push("the 1-day file inside the override was deleted");
    if (!existsSync(today)) elevenProblems.push("today's file was deleted");
    if ((eleven.logs?.bytesAfter ?? 0) > 10 * 1024 * 1024) {
      elevenProblems.push(`bytesAfter=${String(eleven.logs?.bytesAfter)} is over 10 MB`);
    }

    if (elevenProblems.length > 0) {
      record("log-retention-configured", "FAIL", elevenProblems.join("; "));
    } else {
      record(
        "log-retention-configured",
        "PASS",
        `window=3d/10MB deleted=${String(eleven.logs?.deleted.length ?? 0)} ` +
          `bytesAfter=${mb(eleven.logs?.bytesAfter ?? 0)}MB currentDayKept=true`,
      );
    }
  } catch (error) {
    record("crash-record-retention", "FAIL", describe(error));
    record("log-retention-configured", "FAIL", describe(error));
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The exported bundle's structure
// ---------------------------------------------------------------------------

/**
 * Collect and zip a diagnostic bundle from temp sources, then read the
 * archive's central directory back.
 *
 * The inputs are synthetic (a temp logs directory, one temp crash record, a fake
 * secret in a log line) because the judgment is about structure and redaction,
 * not about this machine's user data.
 *
 * @param engine facts from the engine run, reusing the real stderr tail
 */
async function checkV12(engine: EngineObservation | null): Promise<void> {
  const id = "diagnostic-bundle-tree";
  const userData = path.join(TEMP_ROOT, "v12");
  const logsDir = path.join(userData, "logs");
  const crashDumpsDir = path.join(userData, "crash-dumps");
  const crashDir = crashDirFor(userData);
  const zipPath = path.join(TEMP_ROOT, "v12-bundle.zip");
  const secret = "probe-bundle-secret-7f3a";
  const today = new Date().toISOString().slice(0, 10);

  try {
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(crashDumpsDir, { recursive: true });
    mkdirSync(crashDir, { recursive: true });

    // A log line with the real home path and a known secret, so redaction is
    // judged on bytes that would otherwise leak.
    writeFileSync(
      path.join(logsDir, `shell-${today}.jsonl`),
      `${JSON.stringify({
        at: new Date().toISOString(),
        event: "probe.bundle",
        detail: {
          path: path.join(process.env["USERPROFILE"] ?? "C:\\Users\\probe", "secret.txt"),
          runToken: secret,
        },
      })}\n`,
      "utf8",
    );

    const crashedRecord: CrashRecord = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      kind: "engine",
      code: "ENGINE_CRASHED",
      app: probeVersions(),
      engine: {
        exitCode: 1,
        signal: null,
        engineVersion: engine?.version ?? null,
        protocolVersion: engine?.protocolVersion ?? null,
        watchdog: "unknown",
      },
    };

    writeCrashRecordSync(crashDir, crashedRecord);

    const settings: ShellSettings = {
      version: 1,
      theme: "light",
      contrast: "normal",
      locale: "zh-CN",
      window: null,
      logs: DEFAULT_LOG_RETENTION,
    };

    const bundle = await collectDiagnostics({
      userData,
      logsDir,
      crashDumpsDir,
      appVersion: PROBE_APP_VERSION,
      commit: null,
      electron: process.versions.electron ?? "unknown",
      chrome: process.versions.chrome ?? "unknown",
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      release: "probe",
      locale: "zh-CN",
      theme: "light",
      packaged: false,
      workspace: TEMP_ROOT,
      secrets: [secret],
      settings,
      engine: {
        version: engine?.version ?? null,
        protocolVersion: engine?.protocolVersion ?? null,
        backend: "local",
        watchdog: engine?.watchdog ?? "unknown",
        degradations: [],
        expectedVersion: EXPECTED_ENGINE_VERSION,
        stderrTail: engine?.stderrTail ?? [],
      },
      crashes: [crashedRecord],
      options: { includeSessionContent: false, includeMinidump: false },
    });

    const written = await writeZip(
      bundle.entries.map((entry) => ({ path: entry.path, data: entry.data })),
      zipPath,
    );

    const archive = readFileSync(zipPath);
    const names = listZipEntries(archive);
    const paths = new Set(names);
    const required = [
      "README.txt",
      "summary.txt",
      "manifest.json",
      "env.json",
      "config/shell-settings.json",
      "engine/stderr-tail.txt",
    ];
    const problems: string[] = [];

    for (const entry of required) {
      if (!paths.has(entry)) problems.push(`missing ${entry}`);
    }

    if (!names.some((name) => /^logs\/shell-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))) {
      problems.push("missing logs/shell-<utc-day>.jsonl");
    }

    if (!names.some((name) => /^crash\/crash-.*\.json$/.test(name))) {
      problems.push("missing crash/crash-*.json");
    }

    if (names.some((name) => name.startsWith("content/"))) {
      problems.push("content/ shipped although session content was not chosen");
    }

    const byPath = new Map(bundle.entries.map((entry) => [entry.path, entry]));

    for (const listed of bundle.manifest.files) {
      const entry = byPath.get(listed.path);

      if (entry === undefined) {
        problems.push(`manifest lists ${listed.path} which is not in the archive`);
        continue;
      }

      if (entry.sha256 !== listed.sha256 || entry.bytes !== listed.bytes) {
        problems.push(`manifest hash/size differs for ${listed.path}`);
      }
    }

    if (bundle.manifest.files.length !== bundle.entries.length - 1) {
      problems.push(
        `manifest.files=${String(bundle.manifest.files.length)} entries=${String(bundle.entries.length)}`,
      );
    }

    const readme = byPath.get("README.txt");
    const summary = byPath.get("summary.txt");

    if (readme === undefined || readme.data.length === 0) {
      problems.push("README.txt is empty");
    } else if (!readme.data.toString("utf8").includes("WHAT IS INSIDE")) {
      problems.push("README.txt is not the bundle README");
    }

    if (summary === undefined || summary.data.length === 0) {
      problems.push("summary.txt is empty");
    } else if (!summary.data.toString("utf8").includes("Not included (default).")) {
      problems.push("summary.txt does not state the session default");
    }

    const homeDir = homeDirectory();
    const leaks = bundle.entries
      .filter(
        (entry) =>
          entry.path.endsWith(".json") ||
          entry.path.endsWith(".txt") ||
          entry.path.endsWith(".jsonl"),
      )
      .filter((entry) => {
        const text = entry.data.toString("utf8");
        const lower = text.toLowerCase();

        return text.includes(secret) || (homeDir !== null && lower.includes(homeDir.toLowerCase()));
      });

    if (leaks.length > 0)
      problems.push(`redaction leaked in ${leaks.map((entry) => entry.path).join(",")}`);
    if (!bundle.manifest.redaction.homePathReplaced) {
      problems.push("manifest says the home path was not replaced");
    }
    if (written.entries !== bundle.entries.length) {
      problems.push(
        `writeZip reported ${String(written.entries)} entries of ${String(bundle.entries.length)}`,
      );
    }
    if (names.length !== bundle.entries.length) {
      problems.push(
        `archive lists ${String(names.length)} entries of ${String(bundle.entries.length)}`,
      );
    }

    if (problems.length > 0) {
      record(id, "FAIL", problems.join("; "));
      return;
    }

    record(
      id,
      "PASS",
      `bytes=${String(written.bytes)} entries=${String(names.length)} required=6/6 logs=1 crash=1 ` +
        `session=absent manifestSha=${String(bundle.manifest.files.length)}/${String(
          bundle.entries.length - 1,
        )} redaction=clean`,
    );
  } catch (error) {
    record(id, "FAIL", describe(error));
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined);
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The real home directory, or null when the platform does not expose one. */
function homeDirectory(): string | null {
  return process.env["USERPROFILE"] ?? process.env["HOME"] ?? null;
}

/** Versions a probe crash record carries. */
function probeVersions(): CrashVersions {
  return {
    version: PROBE_APP_VERSION,
    electron: process.versions.electron ?? "unknown",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * List the central-directory names of a zip buffer.
 *
 * Deliberately a reader, not the writer: comparing what the archive says about
 * itself against what was handed to `writeZip` is the check. Only the central
 * directory is read; no entry is decompressed.
 *
 * @param buffer the archive bytes
 * @returns entry paths in central-directory order
 */
function listZipEntries(buffer: Buffer): string[] {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  let eocd = -1;

  for (
    let offset = buffer.length - 22;
    offset >= Math.max(0, buffer.length - 22 - 65_535);
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocd = offset;
      break;
    }
  }

  if (eocd < 0) throw new Error("zip: end-of-central-directory record not found");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names: string[] = [];

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== centralSignature) {
      throw new Error(`zip: bad central-directory entry at ${String(offset)}`);
    }

    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    names.push(buffer.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

export { checkV07, checkV10V11, checkV12 };
