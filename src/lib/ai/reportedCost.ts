/**
 * 上游报价——回包里「这次请求花了多少美元」的**唯一换算处**
 * （docs/feature/billing/01-fee-groups.md：把上游的字段翻译成中性键只写一处）。
 *
 * 报价一旦记上用量行，就压过整张计费组表（`feeGroup.ts` `costOf`），所以收不收它是
 * 信任问题，不是解析问题：只收平台表里声明过 `reportsCost` 的平台——测过它报的数等于
 * 它实际扣的钱（`platforms.ts`）。别的中转回包里起个同名字段，这里一律当没报。
 *
 * 「没报」是 `undefined`，不是 `0`：`0` 是上游说这次免费，会把整行记成 0。
 */
import { platformCostReport, type PlatformId } from "./platforms";
import type { ProtocolFamily } from "./types";

/** 各族回包里放花费的字段（OrcaRouter 实测，landscape.md §7 第十八个样本「再补测」）。 */
function rawCost(family: ProtocolFamily, u: Record<string, unknown>): unknown {
  switch (family) {
    case "anthropic":
      return u.cost_usd;
    case "gemini":
      return u.costUsd;
    case "openai":
      // 实测只有 `cost`；`cost_usd` 是同一网关 ④ 的拼法，先认它以防 ① 以后也换过去。
      return u.cost_usd ?? u.cost;
    case "responses":
      return u.cost;
  }
}

/**
 * 一段 usage 对象里的上游报价（美元），或 `undefined` = 没报 / 不收。
 *
 * `usage` 是该族放 token 数的那个对象原样：④ `message_delta.usage`、③ `usageMetadata`、
 * ① 末块 `usage`、② `response.usage`。
 */
export function reportedCostOf(platform: PlatformId | undefined, family: ProtocolFamily, usage: unknown): number | undefined {
  if (!platform || !platformCostReport(platform)) return undefined;
  if (!usage || typeof usage !== "object") return undefined;
  const v = rawCost(family, usage as Record<string, unknown>);
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** 要平台报花费就得带的请求头；平台没声明时为空对象。 */
export function costReportHeaders(platform: PlatformId | undefined): Record<string, string> {
  const header = platform ? platformCostReport(platform)?.header : undefined;
  return header ? { [header[0]]: header[1] } : {};
}

/**
 * 把几次请求的报价合成一行的：**每一次都报了才相加，有一次没报整行就是 `null`**。
 *
 * 报价压过整张计费组表——把没报的那几次当 0 加进去，那几次就白用了。`null` 让整行
 * 回落到计费组，算的是全部 token。
 *
 * `acc` 为 `undefined` = 还没有任何一次（第一次的值原样接过来，零次不会被记成 0）。
 */
export function addReportedCost(acc: number | null | undefined, next: number | undefined): number | null {
  if (acc === null || next === undefined) return null;
  return acc === undefined ? next : acc + next;
}
