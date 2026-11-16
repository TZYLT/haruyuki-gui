/**
 * The composition root's diagnostics glue: engine facts and native dialog copy.
 *
 * Kept out of `main.ts` so the root stays under the file-size gate. The facts are
 * read at export time, not cached: an engine that crashed a minute ago must still
 * contribute its version and stderr tail.
 */

import { createTranslator } from "@haruyuki/ui/i18n/core";
import { readFileSync } from "node:fs";

import type { EngineHost } from "../supervision/engine-host.js";
import type { DiagnosticsEngineFacts } from "./collect.js";
import type { DiagnosticsExportLabels } from "./export.js";

/** How much of a token file is plausibly a secret, to avoid reading a huge file. */
const MAX_SECRET_BYTES = 4096;

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
 * The secret values the shell can name without guessing.
 *
 * The engine's capability token lives in `<userData>/engine-token/engine-token`
 * while the host is running; reading it here is what makes the value-level
 * redaction rule real outside tests. A missing or unreadable file is not an
 * error: the token may already be gone, and the bundle's key-based redaction
 * still applies. Values shorter than four characters are ignored by the
 * redactor itself.
 *
 * @param host the live engine host, or null before start / after stop
 * @returns zero or one known secret value
 */
export function diagnosticsSecrets(host: EngineHost | null): readonly string[] {
  if (host === null) return [];

  try {
    const token = readFileSync(host.tokenFile, "utf8").slice(0, MAX_SECRET_BYTES).trim();

    return token === "" ? [] : [token];
  } catch {
    return [];
  }
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
    saveTitle: t("common.diagnostics.saveTitle"),
    zipFilterName: t("common.diagnostics.zipFilter"),
    capTitle: t("common.diagnostics.capTitle"),
    capMessage: (bytes, max) =>
      t("common.diagnostics.capMessage", { size: formatMb(bytes), limit: formatMb(max) }),
    capFull: t("common.diagnostics.capFull"),
    capReduce: t("common.diagnostics.capReduce"),
    capCancel: t("common.diagnostics.cancel"),
    successTitle: t("common.diagnostics.successTitle"),
    successMessage: (file, bytes) =>
      t("common.diagnostics.successMessage", { size: formatMb(bytes), path: file }),
    openFolder: t("common.diagnostics.openFolder"),
    close: t("common.diagnostics.close"),
    failureTitle: exportFailed,
    failureMessage: (detail) => `${exportFailed}: ${detail}`,
  };
}
