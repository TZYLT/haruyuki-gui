/**
 * The export flow: save dialog, the 50 MB decision, progress, open folder.
 * Policy layer above P6's collector/writer. It owns what the user sees and the
 * promise that a failed or cancelled run leaves no half archive; file selection
 * and byte format are injected so the flow is testable without Electron.
 * The cap is checked twice. Before writing, entries are estimated from their
 * real bytes (`RD-14`); writing 200 MB first would break the time budget. After
 * the write, the archive size is known, so a *reduced* export that is still over
 * the line is trimmed once more using the measured ratio. "Full" is never
 * trimmed: the user was told it would exceed 50 MB and chose it anyway.
 * Dialog copy is injected as {@link DiagnosticsExportLabels}; `main.ts` decides
 * which catalogue/fallback supplies it. This file holds no user-visible prose.
 */

import { access, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DiagnosticsEvent,
  DiagnosticsManifest,
  DiagnosticsOptions,
  DiagnosticsResult,
  OmittedItem,
  SessionDiagnosticsSource,
} from "../../shared/diagnostics.js";
import { buildSummary, sha256Of } from "./bundle-parts.js";
import { redactDiagnosticText } from "./redact.js";
import type {
  DiagnosticsBundle,
  DiagnosticsBundleEntry,
  DiagnosticsCollectOptions,
  DiagnosticsEngineFacts,
} from "./collect.js";
import type { CrashRecord } from "../crash/records.js";
import type { ShellSettings } from "../settings.js";
import { isZipAborted, type ZipEntry, type ZipWriteOptions } from "./zip.js";

/** The cap from `32` section 4.2: 50 MiB, not 50 MB decimal. */
export const DIAGNOSTICS_MAX_BYTES = 50 * 1024 * 1024;

export type DiagnosticsCollectInput = DiagnosticsCollectOptions & {
  readonly sessionSource: SessionDiagnosticsSource | null;
};

/**
 * The facts an export needs beyond the user's two choices.
 * Paths are already resolved by `main.ts`; nothing here guesses at Electron's
 * directories, and a test points the flow at a temp tree.
 */
export interface DiagnosticsExportContext {
  readonly userData: string;
  readonly logsDir: string;
  readonly crashDumpsDir: string;
  /** The save dialog's default directory; Electron's Downloads path in production. */
  readonly downloadsDir?: string;
  readonly appVersion: string;
  readonly commit: string | null;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly locale: string;
  readonly theme: "light" | "dark";
  readonly settings: ShellSettings;
  readonly engine: DiagnosticsEngineFacts;
  readonly crashes: readonly CrashRecord[];
  readonly sessionSource: SessionDiagnosticsSource | null;
  /** Values the shell already knows are secret (for example the engine token). */
  readonly secrets?: readonly string[];
}

export interface DiagnosticsExportRequest {
  /** Present when the caller forwards the channel message unchanged. */
  readonly kind?: "start";
  readonly options: DiagnosticsOptions;
}

export interface DiagnosticsSaveDialogOptions {
  title: string;
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
}

export interface DiagnosticsSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface DiagnosticsMessageBoxOptions {
  type: "info" | "warning" | "error";
  title: string;
  message: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
}

export interface DiagnosticsMessageBoxResult {
  response: number;
}

export interface DiagnosticsExportLabels {
  readonly saveTitle: string;
  readonly zipFilterName: string;
  readonly capTitle: string;
  readonly capMessage: (bytes: number, maxBytes: number) => string;
  readonly capFull: string;
  readonly capReduce: string;
  readonly capCancel: string;
  readonly successTitle: string;
  readonly successMessage: (path: string, bytes: number) => string;
  readonly openFolder: string;
  readonly close: string;
  readonly failureTitle: string;
  readonly failureMessage: (detail: string) => string;
}

export interface DiagnosticsExportDeps {
  readonly now: () => Date;
  readonly onEvent: (event: DiagnosticsEvent) => void;
  readonly showSaveDialog: (
    options: DiagnosticsSaveDialogOptions,
  ) => Promise<DiagnosticsSaveDialogResult>;
  readonly showMessageBox: (
    options: DiagnosticsMessageBoxOptions,
  ) => Promise<DiagnosticsMessageBoxResult>;
  readonly openPath: (target: string) => Promise<void>;
  readonly collect: (input: DiagnosticsCollectInput) => Promise<DiagnosticsBundle>;
  readonly writeZip: (
    entries: readonly ZipEntry[],
    outputPath: string,
    options: ZipWriteOptions,
  ) => Promise<{ bytes: number; entries: number }>;
  readonly labels: DiagnosticsExportLabels;
  readonly abortSignal?: AbortSignal;
}

interface TrimResult {
  readonly entries: DiagnosticsBundleEntry[];
  readonly dropped: OmittedItem[];
}

function totalBytes(entries: readonly DiagnosticsBundleEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

function safeVersion(appVersion: string): string {
  const cleaned = appVersion.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");

  return cleaned === "" ? "unknown" : cleaned;
}

function utcStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

export function diagnosticsFileName(appVersion: string, at: Date): string {
  return `haruyuki-diagnostics-${safeVersion(appVersion)}-${utcStamp(at)}.zip`;
}

/**
 * Drop optional material until the estimated entries fit `cap`.
 *
 * Session content and minidumps are opt-in extras, so they go before evidence;
 * logs go oldest-first because the newest day describes the failure reported.
 */
function trimEntries(entries: readonly DiagnosticsBundleEntry[], cap: number): TrimResult {
  let kept = [...entries];
  let total = totalBytes(kept);
  const dropped: OmittedItem[] = [];

  if (total <= cap) return { entries: kept, dropped };

  const dropWhere = (predicate: (entry: DiagnosticsBundleEntry) => boolean): void => {
    const removed = kept.filter(predicate);

    for (const entry of removed) {
      dropped.push({ path: entry.path, bytes: entry.bytes, reason: "cap" });
      total -= entry.bytes;
    }

    kept = kept.filter((entry) => !predicate(entry));
  };

  dropWhere((entry) => entry.path.startsWith("content/"));
  dropWhere((entry) => entry.path.startsWith("crash/minidump-"));

  // Name order makes "oldest" explicit instead of relying on collection order.
  const logs = kept
    .filter((entry) => entry.path.startsWith("logs/"))
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const log of logs) {
    if (total <= cap) break;

    dropWhere((entry) => entry.path === log.path);
  }

  return { entries: kept, dropped };
}

/**
 * Trim once more using the archive size the writer actually produced.
 *
 * The estimate was uncompressed bytes; deflate may not beat an already-compressed
 * dump. Scaling the target by the measured ratio keeps "oldest optional first",
 * and forcing one byte below the estimate makes a just-over archive shed at least
 * one optional entry instead of retrying unchanged.
 */
function trimForActual(
  entries: readonly DiagnosticsBundleEntry[],
  actualBytes: number,
  cap: number,
): TrimResult {
  const total = totalBytes(entries);

  if (actualBytes <= cap || total === 0) return { entries: [...entries], dropped: [] };

  const scaled = Math.floor((total * cap) / actualBytes);

  return trimEntries(entries, Math.max(0, Math.min(scaled, total - 1)));
}

/**
 * Rebuild `manifest.json` so it lists exactly what ships after a trim.
 *
 * Export-level trimming happens after the collector wrote its index; an index
 * that still names dropped files would be worse than none. `summary.txt` keeps
 * the collector's own omission prose; this manifest is the machine-readable truth.
 */
function withManifest(
  bundle: DiagnosticsBundle,
  entries: readonly DiagnosticsBundleEntry[],
  dropped: readonly OmittedItem[],
): DiagnosticsBundleEntry[] {
  if (dropped.length === 0) return [...entries];

  const omissions = [...bundle.omitted, ...dropped];
  const manifest: DiagnosticsManifest = {
    ...bundle.manifest,
    files: entries
      .filter((entry) => entry.path !== "manifest.json")
      .map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })),
    omissions,
  };
  const data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const replacement: DiagnosticsBundleEntry = {
    path: "manifest.json",
    bytes: data.length,
    sha256: sha256Of(data),
    data,
  };

  return entries.map((entry) => (entry.path === "manifest.json" ? replacement : entry));
}

/**
 * Rebuild `summary.txt` after an export-level trim.
 *
 * The collector writes the summary before the exporter knows the archive size;
 * a cap-driven drop that leaves the old summary in place would tell a support
 * reader that files are present when they are not. The manifest is rewritten
 * after this helper, so its `files` list carries the new summary hash too.
 *
 * @param bundle the collector's result
 * @param context the facts the summary was originally built from
 * @param request the user's two choices
 * @param now the export instant
 * @param entries the current entry list
 * @param dropped files removed by the cap pass
 */
function withSummary(
  bundle: DiagnosticsBundle,
  context: DiagnosticsExportContext,
  request: DiagnosticsExportRequest,
  now: Date,
  entries: readonly DiagnosticsBundleEntry[],
  dropped: readonly OmittedItem[],
): DiagnosticsBundleEntry[] {
  if (dropped.length === 0) return [...entries];

  const options: DiagnosticsCollectOptions = {
    userData: context.userData,
    logsDir: context.logsDir,
    crashDumpsDir: context.crashDumpsDir,
    appVersion: context.appVersion,
    commit: context.commit,
    electron: context.electron,
    chrome: context.chrome,
    node: context.node,
    platform: context.platform,
    arch: context.arch,
    release: context.release,
    locale: context.locale,
    theme: context.theme,
    settings: context.settings,
    engine: context.engine,
    crashes: context.crashes,
    options: request.options,
    now,
  };
  const hasContent = entries.some((entry) => entry.path === "content/conversation.json");
  const session = !request.options.includeSessionContent
    ? "absent"
    : hasContent
      ? "included"
      : bundle.session === "absent"
        ? "absent"
        : "dropped";
  const summary = redactDiagnosticText(
    buildSummary(
      options,
      now,
      Math.max(0, entries.length - 3),
      [...bundle.omitted, ...dropped],
      session,
    ),
    { homeDir: homedir() },
  );
  const data = Buffer.from(summary, "utf8");
  const replacement: DiagnosticsBundleEntry = {
    path: "summary.txt",
    bytes: data.length,
    sha256: sha256Of(data),
    data,
  };

  return entries.map((entry) => (entry.path === "summary.txt" ? replacement : entry));
}

function detailOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

async function removeArtifact(outputPath: string): Promise<void> {
  try {
    await rm(outputPath, { force: true });
  } catch {
    // The writer's temp/rename path is the primary guard; this is the backstop.
  }
}

/** Whether the save target already exists; used to avoid deleting user data. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
}

/**
 * Run one export from the save dialog to the final result.
 *
 * Events: `collect`, `compress` (writer progress), one `write`, and exactly one
 * terminal event (`done`/`failed`/`cancelled`) even when a dialog throws.
 *
 * @param request the user's two choices
 * @param context resolved paths and the facts the bundle reports
 * @param deps dialogs, collector, writer and the abort signal
 */
export async function runDiagnosticsExport(
  request: DiagnosticsExportRequest,
  context: DiagnosticsExportContext,
  deps: DiagnosticsExportDeps,
): Promise<DiagnosticsResult> {
  const now = deps.now();
  const signal = deps.abortSignal;
  const labels = deps.labels;
  const cap = DIAGNOSTICS_MAX_BYTES;
  let terminal: DiagnosticsEvent["kind"] | null = null;

  // A function call, not a repeated property read: TS narrows a property to
  // `false` after an early return, but a live signal can abort later.
  const isAborted = (): boolean => signal?.aborted === true;

  const emit = (event: DiagnosticsEvent): void => {
    if (terminal !== null) return;

    if (event.kind !== "progress") terminal = event.kind;

    try {
      deps.onEvent(event);
    } catch {
      // A listener must not turn an export into a failure; the archive is the evidence.
    }
  };

  const cancelled = (detail: string): DiagnosticsResult => {
    emit({ kind: "cancelled" });

    return { ok: false, code: "DIAGNOSTIC_EXPORT_CANCELLED", detail };
  };

  const failed = async (detail: string): Promise<DiagnosticsResult> => {
    emit({ kind: "failed", code: "DIAGNOSTIC_EXPORT_FAILED", detail });

    try {
      await deps.showMessageBox({
        type: "error",
        title: labels.failureTitle,
        message: labels.failureMessage(detail),
        buttons: [labels.close],
        defaultId: 0,
        cancelId: 0,
      });
    } catch {
      // The result and the `failed` event already carry the reason.
    }

    return { ok: false, code: "DIAGNOSTIC_EXPORT_FAILED", detail };
  };

  if (isAborted()) return cancelled("cancelled before the save dialog opened");

  let outputPath: string;

  try {
    const saved = await deps.showSaveDialog({
      title: labels.saveTitle,
      defaultPath:
        context.downloadsDir === undefined
          ? diagnosticsFileName(context.appVersion, now)
          : join(context.downloadsDir, diagnosticsFileName(context.appVersion, now)),
      filters: [{ name: labels.zipFilterName, extensions: ["zip"] }],
    });

    if (saved.canceled || (saved.filePath ?? "").trim() === "") {
      return cancelled("the save dialog was cancelled");
    }

    outputPath = saved.filePath ?? "";
  } catch (error) {
    return failed(detailOf(error));
  }

  // A pre-existing archive is the user's file until the writer's rename
  // succeeds. `writeZip` is atomic; the backstop below must not turn a failed
  // export into a deletion of the previous bundle.
  const existedBefore = await fileExists(outputPath);
  let wroteSuccessfully = false;

  emit({ kind: "progress", phase: "collect", done: 0, total: 1 });

  let bundle: DiagnosticsBundle;

  try {
    bundle = await deps.collect({
      userData: context.userData,
      logsDir: context.logsDir,
      crashDumpsDir: context.crashDumpsDir,
      appVersion: context.appVersion,
      commit: context.commit,
      electron: context.electron,
      chrome: context.chrome,
      node: context.node,
      platform: context.platform,
      arch: context.arch,
      release: context.release,
      locale: context.locale,
      theme: context.theme,
      settings: context.settings,
      engine: context.engine,
      crashes: context.crashes,
      options: request.options,
      now,
      ...(context.secrets === undefined ? {} : { secrets: context.secrets }),
      sessionSource: context.sessionSource,
    });
  } catch (error) {
    return failed(detailOf(error));
  }

  if (isAborted()) return cancelled("cancelled during collection");

  emit({ kind: "progress", phase: "collect", done: 1, total: 1 });

  let entries = [...bundle.entries];
  let dropped: OmittedItem[] = [];
  let reduced = false;

  if (totalBytes(entries) > cap) {
    let response: number;

    try {
      response = (
        await deps.showMessageBox({
          type: "warning",
          title: labels.capTitle,
          message: labels.capMessage(totalBytes(entries), cap),
          buttons: [labels.capFull, labels.capReduce, labels.capCancel],
          defaultId: 1,
          cancelId: 2,
        })
      ).response;
    } catch (error) {
      return failed(detailOf(error));
    }

    if (response !== 0 && response !== 1) return cancelled("the user chose not to export");

    if (response === 1) {
      reduced = true;
      const trimmed = trimEntries(entries, cap);

      entries = trimmed.entries;
      dropped = trimmed.dropped;
    }
  }

  let written: { bytes: number; entries: number };
  let writeAttempted = false;

  const write = (
    items: readonly DiagnosticsBundleEntry[],
  ): Promise<{ bytes: number; entries: number }> => {
    const total = totalBytes(items);

    emit({ kind: "progress", phase: "compress", done: 0, total });
    writeAttempted = true;

    return deps.writeZip(items, outputPath, {
      date: now,
      ...(signal === undefined ? {} : { signal }),
      onProgress: (done) => emit({ kind: "progress", phase: "compress", done, total }),
    });
  };

  try {
    entries = withSummary(bundle, context, request, now, entries, dropped);
    entries = withManifest(bundle, entries, dropped);
    written = await write(entries);
    wroteSuccessfully = true;

    if (isAborted()) {
      await removeArtifact(outputPath);

      return cancelled("cancelled while writing the archive");
    }

    if (reduced && written.bytes > cap) {
      const retrim = trimForActual(entries, written.bytes, cap);

      if (retrim.dropped.length > 0) {
        const nextDropped = [...dropped, ...retrim.dropped];

        entries = withSummary(bundle, context, request, now, retrim.entries, nextDropped);
        entries = withManifest(bundle, entries, nextDropped);
        dropped = nextDropped;
        written = await write(entries);
      }
    }
  } catch (error) {
    if (writeAttempted && (!existedBefore || wroteSuccessfully)) {
      await removeArtifact(outputPath);
    }

    if (isAborted() || isZipAborted(error)) {
      return cancelled("cancelled while writing the archive");
    }

    return failed(detailOf(error));
  }

  emit({ kind: "progress", phase: "write", done: written.bytes, total: written.bytes });

  const omitted = [...bundle.omitted, ...dropped];

  emit({ kind: "done", path: outputPath, bytes: written.bytes, omitted });

  try {
    const answer = await deps.showMessageBox({
      type: "info",
      title: labels.successTitle,
      message: labels.successMessage(outputPath, written.bytes),
      buttons: [labels.openFolder, labels.close],
      defaultId: 0,
      cancelId: 1,
    });

    if (answer.response === 0) {
      try {
        await deps.openPath(dirname(outputPath));
      } catch {
        // The export succeeded; a file manager that refused to open does not
        // turn a saved archive into a failed export.
      }
    }
  } catch {
    // The success event and result already carry the path.
  }

  return { ok: true, path: outputPath, bytes: written.bytes, omitted };
}
