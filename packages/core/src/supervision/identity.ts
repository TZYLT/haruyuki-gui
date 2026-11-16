/**
 * Platform-specific half of process evidence collection.
 *
 * Windows prefers wmic's CSV and falls back to `Get-Process` through PowerShell
 * (Win11 24H2 removes wmic). POSIX reads `/proc/<pid>/stat` field 22 plus btime
 * and `/proc/<pid>/exe`, falling back to `ps -o etimes=`/`ps -o comm=`. Commands
 * run directly; unparseable output drops a fact, never both.
 */

import { readFile, readlink } from "node:fs/promises";

/** Runs one external command and resolves with stdout. */
export type EvidenceCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

/** The two independent facts that can identify a process. */
export type ProcessIdentity = {
  imagePath: string | null;
  createdAt: string | null;
};

/** Identity fields that were not available for this PID. */
export const EMPTY_IDENTITY: ProcessIdentity = { imagePath: null, createdAt: null };

/** `/proc/<pid>/stat` start ticks are USER_HZ (100 on mainstream builds); ±120 s absorbs the rounding. */
const PROCESSOR_TICKS_PER_SECOND = 100;

/** `wmic /format:csv` dates look like `20261116134035.954870+480`. */
const WMIC_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{1,6})([+-])(\d{3})$/;

/** Dispatch to the platform reader; any failure means that identity is absent. */
export async function collectPlatformIdentity(
  pid: number,
  platform: NodeJS.Platform,
  run: EvidenceCommandRunner,
  timeoutMs: number,
): Promise<ProcessIdentity> {
  try {
    return platform === "win32"
      ? await collectWindowsIdentity(pid, run, timeoutMs)
      : await collectPosixIdentity(pid, run, timeoutMs);
  } catch {
    // Identity is optional: an unreadable process table must not become a
    // start-up exception or a confident decision.
    return EMPTY_IDENTITY;
  }
}

/** Windows: prefer wmic, then fill any missing field from `Get-Process`. */
async function collectWindowsIdentity(
  pid: number,
  run: EvidenceCommandRunner,
  timeoutMs: number,
): Promise<ProcessIdentity> {
  const wmic = await readWmicIdentity(pid, run, timeoutMs);
  if (wmic !== null && wmic.imagePath !== null && wmic.createdAt !== null) {
    return wmic;
  }
  const powershell = await readPowerShellIdentity(pid, run, timeoutMs);
  if (wmic === null) {
    return powershell ?? EMPTY_IDENTITY;
  }
  return mergeIdentity(wmic, powershell);
}

/** Parse one `wmic process ... /format:csv` response, or `null` when unusable. */
async function readWmicIdentity(
  pid: number,
  run: EvidenceCommandRunner,
  timeoutMs: number,
): Promise<ProcessIdentity | null> {
  const output = await tryCommand(
    run,
    "wmic",
    [
      "process",
      "where",
      `ProcessId=${pid}`,
      "get",
      "ProcessId,ExecutablePath,CreationDate",
      "/format:csv",
    ],
    timeoutMs,
  );

  return output === null ? null : parseWmicCsv(output, pid);
}

/**
 * Parse wmic's CSV. The header is located by column name because a blank line
 * precedes it and a "No Instance(s) Available." sentence can replace the row.
 */
function parseWmicCsv(output: string, pid: number): ProcessIdentity | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF/, ""))
    .filter((line) => line.trim() !== "");

  if (lines.length < 2) {
    return null;
  }

  const header = parseCsvLine(lines[0] ?? "").map((name) => name.trim().toLowerCase());
  const pathIndex = header.indexOf("executablepath");
  const dateIndex = header.indexOf("creationdate");
  const pidIndex = header.indexOf("processid");
  if (pathIndex < 0 || dateIndex < 0 || pidIndex < 0) {
    return null;
  }

  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    if ((fields[pidIndex] ?? "").trim() !== String(pid)) {
      continue;
    }

    const imagePath = (fields[pathIndex] ?? "").trim();
    return {
      imagePath: imagePath === "" ? null : imagePath,
      createdAt: parseWmicDate((fields[dateIndex] ?? "").trim()),
    };
  }

  return null;
}

/**
 * Parse `YYYYMMDDHHMMSS.ffffff±minutes` (offset in minutes, "local = UTC +
 * offset"). A malformed value becomes `null`, keeping the image path available.
 */
function parseWmicDate(value: string): string | null {
  const match = WMIC_DATE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milliseconds = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const offsetMinutes = Number(match[8] === "-" ? `-${match[9] ?? ""}` : match[9]);
  const instant =
    Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) - offsetMinutes * 60_000;

  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

/** Split one CSV line, honouring quotes and doubled quotes inside a field. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);

    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (line.charAt(index + 1) === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }

  fields.push(field);
  return fields;
}

/** Parse one `Get-Process | ConvertTo-Json` response, or `null` when unusable. */
async function readPowerShellIdentity(
  pid: number,
  run: EvidenceCommandRunner,
  timeoutMs: number,
): Promise<ProcessIdentity | null> {
  const script = `Get-Process -Id ${pid} | Select-Object Id,Path,StartTime | ConvertTo-Json -Compress`;
  const output = await tryCommand(
    run,
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    timeoutMs,
  );

  return output === null ? null : parsePowerShellJson(output, pid);
}

/** Parse the PowerShell object (or one-element array) into the identity pair. */
function parsePowerShellJson(output: string, pid: number): ProcessIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return null;
  }

  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(record)) {
    return null;
  }

  // `Get-Process -Id` should only return this PID; a mismatch means the command
  // printed something else (a proxy or a shell profile), so trust nothing.
  if (record.Id !== undefined && Number(record.Id) !== pid) {
    return null;
  }

  const rawPath = record.Path;
  const imagePath = typeof rawPath === "string" && rawPath.trim() !== "" ? rawPath : null;

  return { imagePath, createdAt: parsePowerShellDate(record.StartTime) };
}

/**
 * Parse the .NET `"/Date(<epoch ms>)/"` wrapper, an ISO string, or a number.
 */
function parsePowerShellDate(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const dotNetDate = /\/Date\((-?\d+)(?:[+-]\d+)?\)\//.exec(value);
  if (dotNetDate !== null) {
    const milliseconds = Number(dotNetDate[1]);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** POSIX: `/proc` first, then the documented `ps` fallback. */
async function collectPosixIdentity(
  pid: number,
  run: EvidenceCommandRunner,
  timeoutMs: number,
): Promise<ProcessIdentity> {
  const proc = await readProcIdentity(pid);
  if (proc !== null && proc.imagePath !== null && proc.createdAt !== null) {
    return proc;
  }

  const ps = await readPsIdentity(pid, run, timeoutMs);
  return proc === null ? ps : mergeIdentity(proc, ps);
}

/** Read `/proc/<pid>/stat` and `/proc/<pid>/exe`; `null` when procfs is absent. */
async function readProcIdentity(pid: number): Promise<ProcessIdentity | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    // No procfs (macOS) or the process vanished: let the ps fallback try.
    return null;
  }

  const startTicks = parseProcStartTicks(stat);
  const createdAt = startTicks === null ? null : await procCreatedAt(startTicks);

  let imagePath: string | null = null;
  try {
    const resolved = await readlink(`/proc/${pid}/exe`);
    // A replaced/deleted binary carries this suffix; it is not part of the path
    // and would never compare equal to the marker's exePath.
    imagePath = resolved.replace(/ \(deleted\)$/, "");
  } catch {
    // The stat read succeeded, so the process exists; the link can still be
    // unreadable for a process owned by another account.
  }

  return { imagePath, createdAt };
}

/**
 * Field 22 (starttime) from `/proc/<pid>/stat`. `comm` is parenthesized and may
 * contain spaces, so fields are split after the LAST `)`; field 22 is index 19.
 */
function parseProcStartTicks(stat: string): number | null {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd < 0) {
    return null;
  }

  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  const ticks = Number(fields[19]);

  return Number.isFinite(ticks) ? ticks : null;
}

/** Combine `btime` with the process start ticks into an ISO creation time. */
async function procCreatedAt(startTicks: number): Promise<string | null> {
  try {
    const bootSeconds = parseBtime(await readFile("/proc/stat", "utf8"));
    if (bootSeconds === null) {
      return null;
    }

    return new Date((bootSeconds + startTicks / PROCESSOR_TICKS_PER_SECOND) * 1000).toISOString();
  } catch {
    return null;
  }
}

/** Read the `btime <seconds>` line from `/proc/stat`. */
function parseBtime(systemStat: string): number | null {
  for (const line of systemStat.split("\n")) {
    if (!line.startsWith("btime ")) {
      continue;
    }

    const seconds = Number(line.slice("btime ".length).trim());
    return Number.isFinite(seconds) ? seconds : null;
  }

  return null;
}

/**
 * `ps` fallback: `etimes` gives elapsed seconds and `comm` the command name.
 * `comm` is often not a full path, so it usually will not match the marker's
 * `exePath`; the decision accepts that conservative outcome.
 */
async function readPsIdentity(
  pid: number,
  run: EvidenceCommandRunner,
  timeoutMs: number,
): Promise<ProcessIdentity> {
  const elapsedOutput = await tryCommand(
    run,
    "ps",
    ["-o", "etimes=", "-p", String(pid)],
    timeoutMs,
  );
  const commandOutput = await tryCommand(run, "ps", ["-o", "comm=", "-p", String(pid)], timeoutMs);

  let createdAt: string | null = null;
  const elapsedText = elapsedOutput?.trim() ?? "";
  if (elapsedText !== "") {
    const elapsedSeconds = Number(elapsedText);
    if (Number.isInteger(elapsedSeconds) && elapsedSeconds >= 0) {
      createdAt = new Date(Date.now() - elapsedSeconds * 1000).toISOString();
    }
  }

  const command = commandOutput?.trim() ?? "";
  return { imagePath: command === "" ? null : command, createdAt };
}

/** Keep the non-null fact from each identity; the primary source wins ties. */
function mergeIdentity(
  primary: ProcessIdentity,
  fallback: ProcessIdentity | null,
): ProcessIdentity {
  return {
    imagePath: primary.imagePath ?? fallback?.imagePath ?? null,
    createdAt: primary.createdAt ?? fallback?.createdAt ?? null,
  };
}

/** Run a command, turning any failure into "this fact is unavailable". */
async function tryCommand(
  run: EvidenceCommandRunner,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string | null> {
  try {
    return await run(command, args, timeoutMs);
  } catch {
    return null;
  }
}

/** Narrow an unknown JSON value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
