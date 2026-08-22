/**
 * 日中翻译的 Beta 开关（设置 → 通用 → 实验功能）。
 *
 * 独立模块而不是 store 上的一个字段，理由和 `lib/pptx/flag` 一样：它被三个
 * 互不相干的地方读（设置面板、agent 的工具路由、翻译工具本身），其中两个在
 * React 之外。
 *
 * 它管的事：`translate` 工具**存不存在于模型的工具集里**（见
 * `lib/agent/routing.ts`）。默认关，而关掉的含义是工具**不装载**而不是调用
 * 被拒绝——一个模型看得见却永远失败的工具，作者读到的是"助手坏了"。
 *
 * 关掉时它同时省下每轮固定头部的那份 token：这个功能只对要翻日文素材的作者
 * 有意义，代价却是所有作者付的（见 00-sakura-feasibility.html §06 结尾）。
 */

import { readPref, writePref } from "../prefs";

const KEY = "app:translateBeta";

export function isTranslateEnabled(): boolean {
  return readPref(KEY) === "1";
}

export function setTranslateEnabled(enabled: boolean): void {
  writePref(KEY, enabled ? "1" : "0");
}

const LORE_KEY = "ai:translate:useLore";

/**
 * 翻译时要不要从知识库里抽术语表（设置 → 子代理 → 日中翻译）。
 *
 * 默认**开**：一个建了知识库的作者，本来就是想让译名保持一致的那种人；而没有
 * 知识库的项目里它自然什么都抽不到，走空术语表模板，代价为零。
 *
 * 可关，是因为它把翻译和 lore 绑在了一起：一个纯粹翻外部素材的项目可能根本
 * 没有知识库，作者也未必希望自己的条目名去覆盖原作的译名。
 */
export function isTranslateLoreEnabled(): boolean {
  return readPref(LORE_KEY) !== "0";
}

export function setTranslateLoreEnabled(enabled: boolean): void {
  writePref(LORE_KEY, enabled ? "1" : "0");
}
