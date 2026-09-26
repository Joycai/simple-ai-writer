/**
 * 上游报价——回包里「这次请求花了多少美元」的**唯一换算处**
 * （docs/feature/billing/01-fee-groups.md：把上游的字段翻译成中性键只写一处）。
 *
 * 报价一旦记上用量行，就压过整张计费组表（`feeGroup.ts` `costOf`），所以收不收它是
 * 信任问题，不是解析问题：只收平台表里声明过 `reportsCost` 的平台——测过它报的数等于
 * 它实际扣的钱（`platforms.ts`）——而且请求的地址本身也得指向它
 * （{@link costReportingPlatform}）。别的中转回包里起个同名字段，这里一律当没报。
 *
 * 「没报」是 `undefined`，不是 `0`：`0` 是上游说这次免费，会把整行记成 0。
 */
import { inferPlatform, platformCostReport, wireOf, type PlatformId } from "./platforms";
import type { ApiStandard, ProtocolFamily } from "./types";

/**
 * 这次请求的报价归哪个平台：标签和地址都得是它，否则 `undefined`（不发头、不收数）。
 *
 * 平台标签作者可以给任何主机贴——抽屉里选了 OrcaRouter 再改地址，标签不跟着变。别处
 * 信标签是对的（能力表问的就是作者说这是谁），但报价压过整张计费组表：一个贴错标签的
 * OpenRouter 形中转在 ① 上本来就回 `usage.cost`，它的数不能拿来定账。
 */
export function costReportingPlatform(o: { platform?: PlatformId; baseUrl: string; standard: ApiStandard }): PlatformId | undefined {
  const { platform } = wireOf(o);
  return platformCostReport(platform) && inferPlatform(o.baseUrl, o.standard) === platform ? platform : undefined;
}

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
 * ① 末块 `usage`、② `response.usage`。`platform` 取 {@link costReportingPlatform}。
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
