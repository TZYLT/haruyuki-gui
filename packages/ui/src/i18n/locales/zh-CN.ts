/**
 * The Chinese catalogue.
 *
 * Typed against the English catalogue's key set, so a missing or invented key is
 * a compile error here rather than a runtime fallback. That is the cheapest
 * possible enforcement of "the two key sets must be exactly equal": it happens
 * before any gate runs.
 *
 * Chinese plurals use `other` only. That is measured, not assumed:
 * `new Intl.PluralRules("zh").select(1)` returns `other`, so a `one` branch would
 * be dead code that a translator could still fill in and a reviewer could still
 * approve.
 */

import type { en } from "./en.js";
import type { LocaleMessages } from "../types.js";

/** The Chinese catalogue, keyed exactly like the English one. */
export const zhCN = {
  // ---------------------------------------------------------------- common
  "common.action.cancel": "取消",
  "common.action.confirm": "确认",
  "common.action.delete": "删除",
  "common.action.save": "保存",
  "common.state.loading": "加载中",
  "common.state.empty": "暂无内容",
  "common.state.error": "出错了",

  // ----------------------------------------------------------------- crash
  "common.crash.engineTitle": "引擎意外停止",
  "common.crash.rendererTitle": "界面已停止",
  "common.crash.description": "某个依赖进程意外结束，应用已停止。导出诊断包是反馈问题的最好方式。",
  "common.crash.engineDetails": "引擎已退出，退出码 {code}（信号 {signal}）。详情见诊断包。",
  "common.crash.rendererDetails":
    "界面进程已停止（原因 {reason}，退出码 {exitCode}）。详情见诊断包。",
  "common.crash.export": "导出诊断",
  "common.crash.restart": "重启应用",
  "common.crash.quit": "退出应用",
  "common.crash.bridgeUnavailable": "诊断桥不可用，无法执行该操作",
  "common.crash.notAvailable": "未记录",
  "common.crash.watchdogNotActive": "引擎看门狗未被确认生效（{state}）；详情见诊断包。",

  // ------------------------------------------------------------ diagnostics
  "common.diagnostics.title": "导出诊断",
  "common.diagnostics.sessionContent":
    "包含当前会话最近 200 条消息（含工具名、参数与结果；不含 API key 或 token）",
  "common.diagnostics.minidump": "包含崩溃转储（minidump）；其中可能含有内存中的敏感数据",
  "common.diagnostics.export": "导出",
  "common.diagnostics.cancel": "取消",
  "common.diagnostics.close": "关闭",
  "common.diagnostics.noSession": "当前没有活动会话",
  "common.diagnostics.emptySessionNote":
    "当前构建没有会话来源，诊断包中会写入一个空占位文件并注明这一点",
  "common.diagnostics.phaseCollect": "正在收集文件",
  "common.diagnostics.phaseCompress": "正在压缩诊断包",
  "common.diagnostics.phaseWrite": "正在写入压缩包",
  "common.diagnostics.progress": "正在处理：{done}/{total}",
  "common.diagnostics.exported": "已导出到 {path}（{size} 字节）",
  "common.diagnostics.failed": "导出失败",
  "common.diagnostics.saveTitle": "保存诊断包",
  "common.diagnostics.zipFilter": "Zip 压缩包",
  "common.diagnostics.capTitle": "诊断包超过 50 MB",
  "common.diagnostics.capMessage": "诊断包为 {size}，超过 {limit} 上限。",
  "common.diagnostics.capFull": "保存全部内容",
  "common.diagnostics.capReduce": "精简到上限以内",
  "common.diagnostics.successTitle": "诊断包已导出",
  "common.diagnostics.successMessage": "已保存 {size} 到 {path}",
  "common.diagnostics.openFolder": "打开文件夹",
  "common.diagnostics.retry": "重试",
  "common.diagnostics.bridgeUnavailable": "诊断桥不可用，无法导出诊断包",

  // ------------------------------------------------------------------ menu
  "common.menu.title": "帮助",
  "common.menu.exportDiagnostics": "导出诊断…",
  "common.menu.openLogs": "打开日志目录",
  "common.menu.restart": "重启应用",
  "common.menu.cleanupStale": "清理遗留引擎…",
  "common.menu.cleanupStaleCount": "清理遗留引擎（{count}）…",
  "common.menu.cleanupTitle": "遗留的引擎进程",
  "common.menu.cleanupMessage":
    "上次运行留下了 {count} 个无法确认身份的引擎进程。请逐个核对后再结束：\n\n{details}",
  "common.menu.cleanupConfirm": "结束进程",
  "common.menu.cleanupCancel": "取消",
  "common.menu.cleanupDone": "已结束 {count} 个遗留引擎进程。",
  "common.menu.cleanupFailed": "部分遗留进程无法结束。",
  "common.menu.openLogsFailed": "无法打开日志目录。",

  // ------------------------------------------------------------- component
  "component.input.placeholder": "请输入",
  "component.select.placeholder": "请选择",
  "component.select.empty": "无匹配选项",
  "component.dialog.title": "确认",
  "component.dialog.close": "关闭对话框",
  "component.tag.remove": "移除",
  "component.alert.dismiss": "关闭提示",
  "component.form.required": "此项为必填",

  // ------------------------------------------------------------------ page
  "page.conversation.empty.title": "还没有对话",
  "page.conversation.empty.description": "开始输入以创建对话",
  "page.conversation.retryLater": "请稍后重试",
  "page.error.retry": "重试",

  // ----------------------------------------------------------------- error
  "error.network.unreachable": "无法连接到服务",
  "error.unexpected": "发生了意外错误",
  "error.withCode": "出错了（{code}）",
  "error.shell.resourceDenied": "应用试图读取一个它无权访问的文件",
  "error.shell.resourceMissing": "应用找不到需要的一个文件",
  "error.shell.bridgeDenied": "应用请求了一项它没有的能力",
  "error.shell.settingsCorrupt": "设置文件无法读取，已改用默认值",
  "error.shell.engineUnavailable": "引擎未能启动",
  "error.shell.engineCrashed": "引擎意外停止",
  "error.shell.diagnosticExportFailed": "诊断包导出失败",
  "error.shell.staleEngineFound": "上次运行留下的引擎进程仍在运行",
  "error.shell.staleEngineCleanFailed": "无法结束上次留下的引擎进程",
  "error.shell.unsupportedType": "这种文件无法预览",

  // ------------------------------------------------------------------ a11y
  "a11y.action.delete": "删除",
} as const satisfies Record<keyof typeof en, string> & LocaleMessages;
