/**
 * 用量计量条的分段：一个桶该画成哪几段、每段多长。
 *
 * 条上有两个各自独立的读法——**长度**回答「这一行用得多不多」
 * （`calls / maxCalls`，由 UsagePane 自己算），**颜色**回答「钱花在哪儿」
 * （这个模块）。两个问题各占一个视觉通道，互不挤占。
 *
 * 顺序、key、label 只在这里定义一次，条与 tooltip 都读它，三者不会互相打架
 * （`lib/agent/contextBreakdown` 的 `CONTEXT_SEGMENT_ORDER` 是同一条办法）。
 */

import type { UsageBucket } from "./usage";

/**
 * 条**读什么**——窄成 `Pick` 而不是收整个桶，是为了让编译器替这条不变量站岗：
 * 条不看 `calls`（那是长度的事，UsagePane 自己算）、不看 `uncovered`
 * （那是条下面那行提示的事）、不看 `outputUnits`（量不是钱）。写成注释的话，
 * 下一个人加一行 `b.uncovered` 编译器不会吭声。
 */
type MeterInput = Pick<
  UsageBucket,
  | "costUsd" | "costInput" | "costCache" | "costOutput"
  | "costCount" | "costDuration" | "costOther" | "costUnsplit"
  | "promptTokens" | "cachedTokens" | "completionTokens"
>;

export type UsageSegKey =
  | "input" | "cache" | "output" | "count" | "duration" | "other" | "unsplit";

/** Ordered once here so the bar and its tooltips can't disagree. */
export const USAGE_SEGMENT_ORDER: readonly UsageSegKey[] = [
  "input", "cache", "output", "count", "duration", "other", "unsplit",
];

/**
 * 条按什么画的。
 *
 * - `cost`：这一行有钱可分，段长是费用占比。
 * - `token`：这一行**一分钱都没有**（没配价的模型），退回按 token 占比——
 *   否则条上什么都没有，而这一行其实有实实在在的用量。
 * - `none`：既没钱也没 token。整条画成中性的一段，不留一条空轨。
 */
type UsageMeterMode = "cost" | "token" | "none";

interface UsageMeterSegment {
  key: UsageSegKey;
  /** 这一段的量：`cost` 模式下是美元，`token` 模式下是 token 数。 */
  value: number;
  /** 占整条的比例，0–1。零值段不会出现在结果里，所以它恒 > 0。 */
  share: number;
}

export interface UsageMeter {
  /** 取 `UsageMeter["mode"]` 就够，所以这两个附属类型不导出。 */
  mode: UsageMeterMode;
  /** 只含非零段，按 `USAGE_SEGMENT_ORDER` 排。 */
  segments: UsageMeterSegment[];
  /** 这一行的钱里有多少是分不出段的——tooltip 据此决定要不要多说一句。 */
  hasUnsplit: boolean;
}

/** 未缓存（「新鲜」）输入：`cachedTokens` 是 `promptTokens` 的子集，所以是差。 */
function freshInput(b: MeterInput): number {
  return Math.max(0, b.promptTokens - b.cachedTokens);
}

/**
 * @param fallback 段全空、但这一行**确实有钱**时，整笔归「未分项」的那个数。
 *   没有它的话，`costUsd > 0` 而七段全 0 的桶会被画成「没有可以分项的费用」
 *   ——同一行的行尾却正印着一个真实金额，条和数字当场互相打脸。这种桶今天
 *   到不了（写入口六列同写、回填六列同 SET 且过对账闸门、`cost_unsplit` 在
 *   SQL 那侧兜底），但那是**三处互不相邻的东西**共同保证的，这个模块一个字
 *   都管不着。与其依赖远处的三条不变量，不如在这里给一个说得通的退路。
 */
function build(mode: UsageMeterMode, raw: [UsageSegKey, number][], fallback = 0): UsageMeter {
  const nonZero = raw.filter(([, v]) => v > 0);
  const total = nonZero.reduce((a, [, v]) => a + v, 0);
  if (total <= 0 && fallback > 0) {
    return { mode, segments: [{ key: "unsplit", value: fallback, share: 1 }], hasUnsplit: true };
  }
  if (total <= 0) return { mode: "none", segments: [{ key: "unsplit", value: 0, share: 1 }], hasUnsplit: false };
  const order = (k: UsageSegKey) => USAGE_SEGMENT_ORDER.indexOf(k);
  return {
    mode,
    segments: nonZero
      .sort((a, b) => order(a[0]) - order(b[0]))
      .map(([key, value]) => ({ key, value, share: value / total })),
    hasUnsplit: nonZero.some(([k]) => k === "unsplit"),
  };
}

/**
 * 一个桶画成哪几段。
 *
 * 退化的判定用 **`costUsd === 0`**，不是「六段全 0」：一行的钱**全在
 * `costUnsplit` 里**（升级前记下的老行）时，费用是**有**的，只是分不出来——
 * 那属于「整条未分项」，不该被误判成「没花钱」而去画 token 占比。
 */
export function meterSegments(b: MeterInput): UsageMeter {
  if (b.costUsd > 0) {
    return build("cost", [
      ["input", b.costInput],
      ["cache", b.costCache],
      ["output", b.costOutput],
      ["count", b.costCount],
      ["duration", b.costDuration],
      ["other", b.costOther],
      ["unsplit", b.costUnsplit],
    ], b.costUsd);
  }
  return build("token", [
    ["input", freshInput(b)],
    ["cache", b.cachedTokens],
    ["output", b.completionTokens],
  ]);
}
