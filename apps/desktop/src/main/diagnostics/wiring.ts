/**
 * The composition root's diagnostics glue: engine facts and native dialog copy.
 *
 * Kept out of `main.ts` so the root stays under the file-size gate. The facts are
 * read at export time, not cached: an engine that crashed a minute ago must still
 * contribute its version and stderr tail.
 */

import { createTranslator } from "@haruyuki/ui/i18n/core";

import type { EngineHost } from "../supervision/engine-host.js";
import type { DiagnosticsEngineFacts } from "./collect.js";
import type { DiagnosticsExportLabels } from "./export.js";

/** MiB with one decimal, for the two native dialogs. */
export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The engine facts a diagnostic bundle reports.
 *
 * `expectedVersion` is `null` because `engine-host` does not expose the expected
 * version; guessing one would put a fact in the bundle that the shell never
 * observed.
 *
 * @param host the current engine host, or null when no engine is running
 */
export function diagnosticsEngineFacts(host: EngineHost | null): DiagnosticsEngineFacts {
  const engine = host?.engine ?? null;
  const info = engine?.appServerInfo ?? null;

  return {
    version: info?.engineVersion ?? null,
    protocolVersion: info?.protocolVersion ?? null,
    backend: info?.backend ?? null,
    watchdog: host?.watchdog ?? "unknown",
    degradations: engine === null ? [] : [...engine.degradations],
    expectedVersion: null,
    stderrTail: engine?.stderrTail() ?? [],
  };
}

/**
 * The native dialogs' copy.
 *
 * Electron's dialogs are main-process APIs, so the labels live here rather than
 * in the renderer catalogue. The failure line and Cancel use catalogue keys; the
 * remaining labels are English placeholders until the diagnostics panel keys
 * land in the same catalogue wave (`33` section 5.3).
 *
 * @param locale the resolved shell locale
 */
export function diagnosticsLabels(locale: string): DiagnosticsExportLabels {
  const t = createTranslator(locale);
  const exportFailed = t("error.shell.diagnosticExportFailed");

  return {
    saveTitle: "Export diagnostics",
    zipFilterName: "Zip archive",
    capTitle: "Diagnostic bundle is larger than 50 MB",
    capMessage: (bytes, max) =>
      `The bundle would be ${formatMb(bytes)}, over the ${formatMb(max)} limit.`,
    capFull: "Save everything",
    capReduce: "Reduce to the limit",
    capCancel: t("common.action.cancel"),
    successTitle: "Diagnostics exported",
    successMessage: (file, bytes) => `Saved ${formatMb(bytes)} to ${file}`,
    openFolder: "Open folder",
    close: "Close",
    failureTitle: exportFailed,
    failureMessage: (detail) => `${exportFailed}: ${detail}`,
  };
}
