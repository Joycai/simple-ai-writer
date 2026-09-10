/**
 * 命令行（Beta）的开关（设置 → AI 配置 → 实验室）。
 *
 * 独立模块而不是 store 上的一个字段，理由和 `lib/asr/flag` 一样：设置面板、
 * agent 的工具路由、以及将来的卡片各自读它，其中两个在 React 之外。
 *
 * 开关管的是**入口存不存在**：关着时模型的工具集里没有 `run_command`——不是
 * 渲染成禁用、不是调用被拒（docs/reference/tool-presence.md「关掉时是缺席还是
 * 拒绝」）。默认关：它让助手能提议在作者的电脑上跑任意一条命令，这是一个作者该
 * 亲手打开的口子。见 docs/feature/agent/shell-command-plan.md §1 不变量 4。
 */

import { readPref, writePref } from "../prefs";

const KEY = "app:cliBeta";

export function isCliEnabled(): boolean {
  return readPref(KEY) === "1";
}

export function setCliEnabled(enabled: boolean): void {
  writePref(KEY, enabled ? "1" : "0");
}
