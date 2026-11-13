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
  "common.action.close": "关闭",
  "common.action.confirm": "确认",
  "common.action.delete": "删除",
  "common.action.edit": "编辑",
  "common.action.retry": "重试",
  "common.action.save": "保存",
  "common.action.copy": "复制",
  "common.action.search": "搜索",
  "common.action.dismiss": "忽略",
  "common.state.loading": "加载中",
  "common.state.empty": "暂无内容",
  "common.state.error": "出错了",

  // ------------------------------------------------------------- component
  "component.input.placeholder": "请输入",
  "component.select.placeholder": "请选择",
  "component.select.empty": "无匹配选项",
  "component.select.selectedCount": "{count, plural, other {已选 # 项}}",
  "component.dialog.title": "确认",
  "component.dialog.close": "关闭对话框",
  "component.tag.remove": "移除",
  "component.alert.dismiss": "关闭提示",
  "component.list.selectedCount": "{count, plural, other {已选 # 项}}",
  "component.form.required": "此项为必填",

  // ------------------------------------------------------------------ page
  "page.conversation.empty.title": "还没有对话",
  "page.conversation.empty.description": "开始输入以创建对话",
  "page.conversation.retryLater": "请稍后重试",
  "page.error.retry": "重试",

  // ----------------------------------------------------------------- error
  "error.network.unreachable": "无法连接到服务",
  "error.network.timeout": "请求超时",
  "error.unexpected": "发生了意外错误",
  "error.withCode": "出错了（{code}）",

  // ------------------------------------------------------------------ a11y
  "a11y.action.delete": "删除",
  "a11y.action.edit": "编辑",
  "a11y.action.copy": "复制到剪贴板",
  "a11y.action.close": "关闭",
  "a11y.action.search": "搜索",
  "a11y.action.retry": "重试",
  "a11y.action.expand": "展开",
  "a11y.action.collapse": "收起",
  "a11y.state.loading": "加载中",
  "a11y.state.selected": "已选中",
  "a11y.state.disabled": "已禁用",
  "a11y.field.required": "必填项",
  "a11y.dialog.open": "对话框已打开",
  "a11y.icon.decorative": "装饰性图标",
} as const satisfies Record<keyof typeof en, string> & LocaleMessages;
