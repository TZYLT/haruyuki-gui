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
  "common.diagnostics.retry": "重试",
  "common.diagnostics.bridgeUnavailable": "诊断桥不可用，无法导出诊断包",

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

  // ------------------------------------------------------------------ a11y
  "a11y.action.delete": "删除",
} as const satisfies Record<keyof typeof en, string> & LocaleMessages;
