/**
 * 「状态记忆」（SKILL.state 模式）的 Beta 开关 —— 设置 → AI 配置 → 实验室。
 *
 * 开着时对话助手的输入框多出一个「状态记忆」芯片；作者在**某一次对话里**点亮
 * 它，那次对话从此不再靠阈值触发的归纳保住上下文，而是每轮结束后把对话折进
 * 一份有 schema 的**执行状态**（lib/agent/skillState），下一轮只带
 * [system, 执行状态, 上一轮原文, 新问题]——论文 arXiv:2608.26263 的三元组。
 *
 * 独立小模块的理由同 `lib/pptx/flag` / `packFlag`：芯片、sendChat 和设置页三处
 * 都读它，其中两处在 React 之外。关掉开关不删任何东西：已开状态记忆的会话
 * 退回普通归纳，`meta.state` 留在会话里，重新打开开关就接着用。
 */

import { readPref, writePref } from "../prefs";

const KEY = "app:skillStateBeta";

export function isSkillStateEnabled(): boolean {
  return readPref(KEY) === "1";
}

export function setSkillStateEnabled(enabled: boolean): void {
  writePref(KEY, enabled ? "1" : "0");
}
