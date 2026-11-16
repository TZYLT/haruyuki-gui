/**
 * The bundle's non-log files: env.json, manifest.json, summary.txt, README.txt
 * and the engine stderr header.
 *
 * Split out of `collect.ts` because those are prose and index building while the
 * rest is file selection, and one module holding both crossed the repository's
 * size ceiling. The split is internal to P6: `collect.ts` is still the entry
 * point, and nothing outside `diagnostics/` imports this file.
 *
 * Two rules are repeated from the module it was split from because they are the
 * reason these files exist: every string here is redacted later by the caller,
 * and the manifest never lists itself -- a file cannot contain its own hash.
 */

/*
 * eslint-disable haruyuki-i18n/no-cjk-in-source --
 * README.txt/summary.txt and the stderr header are bilingual by requirement
 * (`32` section 6.4): the bundle is read by whoever receives the archive, not by
 * this app's UI, and it has to be readable when the renderer or the catalogue is
 * already unavailable. There is no locale to key these strings to; routing them
 * through the catalogue would produce one language per export instead of the two
 * the requirement asks for. Same narrow exception as `bootstrap-error.ts`, kept
 * to this one file.
 */
/* eslint-disable haruyuki-i18n/no-cjk-in-source */

import { createHash } from "node:crypto";
import { totalmem } from "node:os";

import type {
  DiagnosticsDegradation,
  DiagnosticsEnv,
  DiagnosticsManifest,
  DiagnosticsOptions,
  OmittedItem,
} from "../../shared/diagnostics.js";
import { DEFAULT_CRASH_RETENTION, type CrashRecord } from "../crash/records.js";
import { DEFAULT_LOG_RETENTION, type ShellSettings } from "../settings.js";
import { redactDiagnosticText, type RedactOptions } from "./redact.js";
import { DEFAULT_MINIDUMP_RETENTION } from "./retention.js";

/** The engine facts the bundle reports, gathered by the caller from B1. */
export interface DiagnosticsEngineFacts {
  readonly version: string | null;
  readonly protocolVersion: number | null;
  readonly backend: "local" | "api" | null;
  readonly watchdog: "active" | "inactive" | "unknown";
  readonly degradations: readonly DiagnosticsDegradation[];
  readonly expectedVersion: string | null;
  /** Newest last, as `stderrTail()` returns them. */
  readonly stderrTail: readonly string[];
}

/** Everything the collector reads, injected so a test needs no Electron. */
export interface DiagnosticsCollectOptions {
  readonly userData: string;
  readonly logsDir: string;
  readonly crashDumpsDir: string;
  readonly appVersion: string;
  readonly commit?: string | null;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly locale: string;
  readonly theme: "light" | "dark";
  readonly packaged?: boolean;
  /** The engine's cwd; falls back to the process cwd when the caller has none. */
  readonly workspace?: string;
  readonly homeDir?: string;
  /** Known secret values (e.g. the engine run token), redacted as values. */
  readonly secrets?: readonly string[];
  readonly settings: ShellSettings;
  readonly engine: DiagnosticsEngineFacts;
  readonly crashes: readonly CrashRecord[];
  readonly options: DiagnosticsOptions;
  readonly now?: Date;
  readonly totalMemoryMb?: number | null;
}

/** The engine stderr tail's line budget (`32` section 6.4). */
const STDERR_LINES = 200;

/** The engine stderr header: what the lines are and what was done to them. */
const STDERR_HEADER =
  "# Engine stderr tail / 引擎 stderr 最近若干行\n" +
  "# Redacted: home paths -> ~, secrets -> [redacted] / 已脱敏：home 路径替换为 ~，密钥替换为 [redacted]\n";

/** What the builders index: bytes and a bundle-relative path. */
export type BundleFile = { readonly path: string; readonly data: Buffer };

/** SHA-256 as lower-case hex, the form a reader compares against. */
export function sha256Of(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Total physical memory in MiB, or `null` when the OS did not answer. */
function memoryMb(): number | null {
  try {
    return Math.round(totalmem() / (1024 * 1024));
  } catch {
    return null;
  }
}

/** The engine's recent stderr, header included, already redacted per line. */
export function buildStderrTail(lines: readonly string[], redact: RedactOptions): Buffer {
  const kept = lines.slice(-STDERR_LINES).map((line) => redactDiagnosticText(line, redact));
  const body =
    kept.length === 0
      ? "# (no engine stderr captured) / （未捕获到引擎 stderr）\n"
      : `${kept.join("\n")}\n`;

  return Buffer.from(STDERR_HEADER + body, "utf8");
}

/** `env.json` before redaction; paths and settings are scrubbed by the caller. */
export function buildEnv(options: DiagnosticsCollectOptions): DiagnosticsEnv {
  const { appVersion, electron, chrome, node, platform, arch, release, locale, theme } = options;

  return {
    schemaVersion: 1,
    versions: { app: appVersion, electron, chrome, node, platform, arch, release },
    engine: {
      version: options.engine.version,
      protocolVersion: options.engine.protocolVersion,
      backend: options.engine.backend,
      watchdog: options.engine.watchdog,
      degradations: [...options.engine.degradations],
      expectedVersion: options.engine.expectedVersion,
    },
    paths: {
      userData: options.userData,
      logs: options.logsDir,
      crashDumps: options.crashDumpsDir,
      workspace: options.workspace ?? process.cwd(),
    },
    theme,
    locale,
    settings: options.settings,
  };
}

/** The manifest, from the entries that precede it. */
export function buildManifest(
  options: DiagnosticsCollectOptions,
  now: Date,
  files: readonly BundleFile[],
  omitted: readonly OmittedItem[],
  homePathReplaced: boolean,
): DiagnosticsManifest {
  const logs = options.settings.logs ?? DEFAULT_LOG_RETENTION;
  const { engine } = options;

  return {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    app: {
      version: options.appVersion,
      commit: options.commit ?? null,
      electron: options.electron,
      chrome: options.chrome,
      node: options.node,
      packaged: options.packaged ?? false,
    },
    system: {
      platform: options.platform,
      arch: options.arch,
      release: options.release,
      locale: options.locale,
      totalMemoryMb: options.totalMemoryMb ?? memoryMb(),
    },
    engine: {
      version: engine.version,
      protocolVersion: engine.protocolVersion,
      backend: engine.backend,
      watchdog: engine.watchdog,
      expectedVersion: engine.expectedVersion,
    },
    retentions: {
      logsDays: logs.retentionDays,
      logsMb: logs.maxTotalMb,
      crashesDays: DEFAULT_CRASH_RETENTION.retentionDays,
      crashesMb: DEFAULT_CRASH_RETENTION.maxTotalMb,
      minidumpsDays: DEFAULT_MINIDUMP_RETENTION.retentionDays,
      minidumpsMb: DEFAULT_MINIDUMP_RETENTION.maxTotalMb,
    },
    options: { ...options.options },
    files: files.map((file) => ({
      path: file.path,
      bytes: file.data.length,
      sha256: sha256Of(file.data),
    })),
    omissions: [...omitted],
    redaction: { homePathReplaced, secretsStripped: true },
  };
}

/** Everything the summary says, in both languages. */
export function buildSummary(
  options: DiagnosticsCollectOptions,
  now: Date,
  included: number,
  omitted: readonly OmittedItem[],
  session: "absent" | "empty" | "included" | "dropped",
): string {
  const count = (reason: OmittedItem["reason"]): number =>
    omitted.filter((item) => item.reason === reason).length;
  const newest = [...options.crashes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).at(0);
  const engine = options.engine;
  const lines = omitted
    .slice(0, 20)
    .map((item) => `  - ${item.path} (${item.bytes} B, ${item.reason})`);
  const more =
    omitted.length > lines.length ? `\n  - ... ${omitted.length - lines.length} more` : "";
  const latest =
    newest === undefined ? "" : `; latest / 最近一条 ${newest.at} (${newest.kind}, ${newest.code})`;
  const omittedLine =
    omitted.length === 0
      ? "  none / 无"
      : `  ${omitted.length} item(s) / 共 ${omitted.length} 项 (cap / 超额度 ${count("cap")}, retention / 超保留期 ${count("retention")}, unreadable / 不可读 ${count("unreadable")})`;
  const sessionLine =
    session === "included"
      ? "  Included because it was chosen: the newest messages of the active conversation; keys and tokens are still stripped. / 因勾选而包含当前会话最近的消息；key 与 token 仍已移除。"
      : session === "empty"
        ? "  Requested, but no active session was available in this shell build; content/conversation.json is an empty placeholder with a note. / 已请求，但当前壳没有活动会话；content/conversation.json 是带说明的空占位。"
        : session === "dropped"
          ? "  Requested, but the selected session content (or its empty placeholder) was omitted to meet the size limit; see Omitted below. / 已请求，但所选会话内容（或空占位）因超出大小上限被省略；见下方省略项。"
          : "  Not included (default). / 未包含（默认）。";

  return `Haruyuki diagnostics summary / Haruyuki 诊断摘要
Created (UTC) / 创建时间: ${now.toISOString()}
App / 应用: ${options.appVersion} (electron ${options.electron}, node ${options.node}, ${options.platform} ${options.arch})
Locale / 语言: ${options.locale}; theme / 主题: ${options.theme}; packaged / 打包: ${options.packaged === true ? "yes" : "no"}
Engine / 引擎: version ${engine.version ?? "unknown"}, protocol ${engine.protocolVersion ?? "unknown"}, backend ${engine.backend ?? "unknown"}, watchdog ${engine.watchdog}
Degradations / 降级: ${engine.degradations.length === 0 ? "none / 无" : engine.degradations.map((entry) => entry.kind).join(", ")}
Crashes / 崩溃记录: ${options.crashes.length} in total / 共 ${options.crashes.length} 条${latest}
Files in bundle / 包内文件: ${included + 3} (including this summary and manifest.json / 含本摘要与 manifest.json)
Engine stderr lines in bundle / 包内引擎 stderr 行数: ${Math.min(engine.stderrTail.length, STDERR_LINES)}

Omitted / 省略项
${omittedLine}${lines.length === 0 ? "" : `\n${lines.join("\n")}${more}`}

Session content / 会话内容
${sessionLine}

Redaction / 脱敏
  Home directory paths are replaced with ~. Known secret values and the values of secret-named fields are replaced with [redacted]. / 用户主目录替换为 ~；已知密钥值与敏感字段值替换为 [redacted]。

Not run / 不要运行
  Before reading anything else: do not run anything from this archive. / 阅读其它内容前请注意：不要运行压缩包内的任何东西。

manifest.json and itself / manifest.json 与自身
  manifest.json is not listed in manifest.files: a file cannot contain its own hash. Every listed SHA-256 matches the file of that name. / manifest.json 不列在 manifest.files 中：文件无法包含自身的哈希；已列出的 SHA-256 与同名文件一致。
`;
}

/** The bilingual README: what is inside, how to send it, what not to do. */
export function buildReadme(appVersion: string): string {
  return `Haruyuki diagnostics bundle / Haruyuki 诊断包
Version / 版本: ${appVersion}

WHAT IS INSIDE / 包内有什么
  manifest.json  Size, SHA-256 and the list of every other file, plus versions, chosen options and omissions. It does not list itself, because a file cannot contain its own hash. / 其它每个文件的大小、SHA-256 与清单，以及版本、已选选项与省略项；它不列出自己，因为文件无法包含自身的哈希。
  summary.txt    The same facts as a short page, in Chinese and English. / 中英双语的简要说明。
  env.json       Versions, paths (home shown as ~), theme, locale, engine degradations and the redacted shell settings. / 版本、路径（home 显示为 ~）、主题、语言、引擎降级与脱敏后的设置。
  config/, logs/, engine/, crash/, content/  Settings, logs, engine stderr, crash records and (only when chosen) session content. / 设置、日志、引擎 stderr、崩溃记录，以及仅在勾选时出现的会话内容。

PRIVACY / 隐私
  No API keys, tokens, cookies or other credentials; no conversation content, tool arguments or results, attachment content, memory content or names unless "include session content" was chosen -- and even then keys and tokens are stripped. Home directories are replaced with ~. The bundle is not encrypted and is not uploaded anywhere: send the whole .zip to the developer or support contact who asked for it, through whatever channel they gave you. Do not publish it. / 没有 API key、token、cookie 或其它凭据；默认也没有会话正文、工具参数与结果、附件内容、记忆内容与名称；即使勾选「包含会话内容」，key 与 token 仍会被移除；用户主目录替换为 ~。诊断包未加密，也不会自动上传：请把整个 .zip 通过对方给你的渠道发给向你要包的开发者或支持者，不要公开发布。

HOW TO READ IT / 怎么看
  Start with summary.txt; use manifest.json to check that every file arrived intact. Rule: do not run anything from this archive. It contains text and binary data only, never an installer or a script you need to execute. / 先看 summary.txt；需要核对文件是否完整时看 manifest.json。规则：不要运行压缩包内的任何东西；包内只有文本与二进制数据，没有安装器，也没有需要你执行的脚本。
`;
}
