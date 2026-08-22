/**
 * 上一块的尾巴，作为这一块的上下文。
 *
 * 四条：
 *
 * 1. **原文和译文都带**（作者拍板，执行方案 §0 第 2 条）。回带译文让人称和译名
 *    在块之间保持一致，回带原文让这一轮更贴近模型的训练分布——两者是不同的
 *    作用，取其一都会丢掉另一半。
 * 2. **形态是一对合成的 user/assistant 消息，不是塞进 user 正文的一段"上文"。**
 *    这样两侧都带上了，而且**这一轮的 user 消息仍然逐字是官方模板** —— 往模板
 *    里插一段"以下是上文"会让这一轮的输入不再是它训练时见过的形状。
 * 3. **只带尾部几行，不随块大小放大。** 官方建议是"前 3–5 句"，不是"上一整块"。
 *    带满一块会把窗口用在一件边际收益极低的事上，还会推高退化的概率。
 * 4. **两侧对不齐就一行都不带。** 错位的上下文比没有上下文坏：它会教模型把
 *    A 句译成 B 句的样子，而且没有任何信号说这件事发生了。
 */

import type { StreamMessage } from "../ai/types";
import { buildUserMessage } from "./sakura";

/** 回带几行。见文件头第 3 条；用一章真实文本 A/B 一次可以定死这个数。 */
export const CARRY_LINES = 4;

export interface CarrySource {
  /** 上一块送出去的行。 */
  source: readonly string[];
  /** 上一块收回来的行，与 `source` 一一对应。 */
  translated: readonly string[];
}

/**
 * 上一块的尾巴，作为 prelude 里的一对消息。
 *
 * 没有上一块、上一块为空、或者两侧长度不等时返回空数组 —— 调用方无条件展开
 * 它即可，不必自己判断有没有上文。
 */
export function buildCarry(prev: CarrySource | null | undefined, lines = CARRY_LINES): StreamMessage[] {
  if (!prev) return [];
  const { source, translated } = prev;
  if (!source.length || source.length !== translated.length) return [];

  const n = Math.min(lines, source.length);
  const src = source.slice(-n).join("\n");
  const dst = translated.slice(-n).join("\n");
  if (!src.trim() || !dst.trim()) return [];

  // 术语表不进回带：这一对是给模型看"上一轮我是怎么译的"，不是重新提一次要求。
  return [
    { role: "user", content: buildUserMessage(src) },
    { role: "assistant", content: dst },
  ];
}
