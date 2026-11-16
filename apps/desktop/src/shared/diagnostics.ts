/**
 * Diagnostics: the shapes the main process writes and the panel reads.
 *
 * This module is reachable from the preload/renderer build, so it holds types and
 * nothing else: no Electron, no Node builtins, no `Buffer`. The bundle's actual
 * bytes are a main-process concern (see `main/diagnostics/collect.ts`); what the
 * two sides have to agree on is the option pair, the progress stream and the
 * manifest a support person opens first.
 *
 * The shapes are frozen by `32` section 6.1 and `33` section 4.4. Fields may be
 * added, never renamed or repurposed: a manifest is read by a tool that a later
 * build cannot fix, and an `OmittedItem` with a new spelling of `cap` is an
 * omission nobody can count.
 */

/** What the user chose in the export panel. Both default to `false`. */
export interface DiagnosticsOptions {
  includeSessionContent: boolean;
  includeMinidump: boolean;
}

/**
 * A file the bundle deliberately does not carry.
 *
 * `path` is the bundle-relative path the file would have had, so the reason and
 * a directory listing line up. `bytes` is what it would have cost.
 */
export interface OmittedItem {
  path: string;
  bytes: number;
  reason: "cap" | "unreadable" | "retention";
}

/** What an export attempt produced. Cancellation is a result, not a throw. */
export type DiagnosticsResult =
  | {
      ok: true;
      path: string;
      bytes: number;
      omitted: OmittedItem[];
    }
  | {
      ok: false;
      code: "DIAGNOSTIC_EXPORT_FAILED" | "DIAGNOSTIC_EXPORT_CANCELLED";
      detail: string;
    };

/**
 * The index of a bundle: what was captured, from which build, and what was left
 * out.
 *
 * `files` never lists `manifest.json` itself. A file cannot contain its own hash,
 * so the manifest is covered by the ZIP's CRC and by the reader noticing that the
 * one file not listed is the manifest; `README.txt` says so in plain words.
 */
export interface DiagnosticsManifest {
  schemaVersion: 1;
  /** ISO 8601 UTC. */
  createdAt: string;
  app: {
    version: string;
    commit: string | null;
    electron: string;
    chrome: string;
    node: string;
    packaged: boolean;
  };
  system: {
    platform: string;
    arch: string;
    release: string;
    locale: string;
    totalMemoryMb: number | null;
  };
  engine: {
    version: string | null;
    protocolVersion: number | null;
    backend: "local" | "api" | null;
    watchdog: "active" | "inactive" | "unknown";
    /** From B1's input; G1's runtime-lock is not parsed here. */
    expectedVersion: string | null;
  };
  retentions: {
    logsDays: number;
    logsMb: number;
    crashesDays: number;
    crashesMb: number;
    minidumpsDays: number;
    minidumpsMb: number;
  };
  options: DiagnosticsOptions;
  files: { path: string; bytes: number; sha256: string }[];
  omissions: OmittedItem[];
  redaction: { homePathReplaced: boolean; secretsStripped: true };
}

/** One safety or compatibility check that did not hold. */
export interface DiagnosticsDegradation {
  kind: "engine-version" | "protocol-version" | "token-acl" | "watchdog";
  detail: string;
}

/**
 * `env.json`: the facts that are too changeable for the manifest, plus the paths
 * and the redacted settings.
 *
 * `paths` are home-relative (`~`), never absolute; `settings` is the same
 * redacted snapshot the bundle carries as `config/shell-settings.json`.
 */
export interface DiagnosticsEnv {
  schemaVersion: 1;
  versions: {
    app: string;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
    arch: string;
    release: string;
  };
  engine: {
    version: string | null;
    protocolVersion: number | null;
    backend: "local" | "api" | null;
    watchdog: "active" | "inactive" | "unknown";
    degradations: DiagnosticsDegradation[];
    expectedVersion: string | null;
  };
  paths: { userData: string; logs: string; crashDumps: string; workspace: string };
  theme: "light" | "dark";
  locale: string;
  settings: unknown;
}

/**
 * The seam a later item (E1/E2) registers so "include session content" has
 * something to include.
 *
 * D4 owns redaction and truncation; the source owns storage and must not be
 * mutated by a reader. `getActiveSession` returns `null` when there is nothing to
 * hand over -- which is the normal state in this shell build, not an error.
 */
export interface SessionDiagnosticsSource {
  getActiveSession(): {
    conversationId: string | null;
    messages: readonly unknown[];
  } | null;
}

/**
 * The messages the panel and the main process exchange on
 * `bridge:control.diagnostics.export`.
 *
 * One channel, two directions, distinguished by `kind`: the panel sends `start`
 * and `cancel`, main sends `open` (menu/crash page asked for the panel), then
 * `progress` and exactly one terminal event.
 */
export type DiagnosticsRequest =
  | { kind: "open"; sessionAvailable: boolean }
  | { kind: "start"; options: DiagnosticsOptions }
  | { kind: "cancel" };

/** What main reports back while an export runs, and how it ends. */
export type DiagnosticsEvent =
  | {
      kind: "progress";
      phase: "collect" | "compress" | "write";
      done: number;
      total: number;
    }
  | { kind: "done"; path: string; bytes: number; omitted: OmittedItem[] }
  | { kind: "failed"; code: "DIAGNOSTIC_EXPORT_FAILED"; detail: string }
  | { kind: "cancelled" };
