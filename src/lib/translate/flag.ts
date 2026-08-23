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
import { DEFAULT_LINES_PER_CHUNK } from "./chunk";

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

const CHUNK_KEY = "ai:translate:linesPerChunk";

/**
 * 块大小的合法化：1–100 之间的整数，解析不出来就回默认。
 *
 * 独立出来是为了可测——pref 的读写在单测里碰不得，夹取规则可以。
 */
export function clampChunkLines(raw: string | number | undefined | null): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_LINES_PER_CHUNK;
  return Math.min(100, Math.max(1, n));
}

/**
 * 每块送多少行（设置 → 子代理 → 日中翻译）。
 *
 * 默认 50 是在一台 14B/LM Studio 上实测的安全区（chunk.ts 文件头第 3 条），但
 * 它只对那类部署成立——更小的模型或更小的上下文窗口在 50 行上会当场退化甚至
 * 挂掉，而这不是重试阶梯救得回来的（阶梯的前提是请求能回来）。所以它必须是
 * 作者可调的：模型不稳就调小，1 就是逐行翻。
 */
export function translateLinesPerChunk(): number {
  const raw = readPref(CHUNK_KEY);
  return raw === undefined || raw === null || raw === "" ? DEFAULT_LINES_PER_CHUNK : clampChunkLines(raw);
}

export function setTranslateLinesPerChunk(n: number): void {
  writePref(CHUNK_KEY, String(clampChunkLines(n)));
}
