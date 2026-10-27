/**
 * 用量行：一次计费请求记下来的那一行，以及**唯一的那个写入口**。
 *
 * 两件事在这里定下来：
 *
 * **1. 行自带价格。** 每一行都抄下计费时的模式、单价、数量与规格。改组、
 * 删组、把模型换到另一个组，历史一分不动——价格只存在模型 / 组上、算钱时
 * 回头查当前价，是这次改动之前的做法，它的后果是「改一次价，上个月的账单
 * 跟着变」。
 *
 * **2. 一次请求记两处。**
 * - **项目用量**写进项目目录的 `.ai-writer/project.db`：它跟着项目文件夹走，
 *   复制一份项目过去，那份项目的账也跟过去。
 * - **总体用量**写进 appDataDir 的 `config.db`（多一列 `project`）：它比任何
 *   单个项目活得久，项目删了、移走了，这一年到底花了多少还在。
 *
 * 两处分别由持久收据重试：先保存价格 / 数量 / 时间快照，再投递两本账。
 * 一处写失败不影响另一处，失败状态在用量页可见，不遮蔽已经取得的结果。
 *
 * 读那一侧在 `usage.ts`；组与算式在 `feeGroup.ts`。
 */

import { enqueueUsage } from "./usageOutbox";
import { billedForSpec, feeOf, type Model } from "./configDb";
import {
  costOf, segmentsOf, totalOf, hasReportedCost,
  type Billed, type CostSegments, type OutputSpec, type PricedSpec,
} from "./feeGroup";

// ── 记一行 ───────────────────────────────────────────────────────────────────

/**
 * 一次计费请求交给记账的全部事实。
 *
 * 只有事实，没有钱：单价来自模型绑定的组，金额由 `costOf()` 算——调用点
 * 自己算一遍再传进来，就是第二套口径的开始。
 */
export interface RecordUsageInput {
  /** Stable for one physical attempt; new retries always get a new id. */
  requestId?: string;
  /** Absent fields remain unknown even though legacy aggregate columns use zero. */
  usageEvidence?: {
    outcome: "complete" | "failed" | "cancelled";
    source: "reported" | "unreported";
    fields: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; reportedCost?: number };
  };
  model: Pick<Model, "id" | "fee">;
  /** 任务标签：一个 profile 任务 id，或 `chat` / `memory` / `image` 这类种类名。 */
  task: string;
  /** **全部** prompt token（缓存是它的子集，与表的口径一致）。 */
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  /** 按规格的组数出来的量：响应真的带回来几张图 / 请求了多少秒。 */
  outputUnits?: number;
  /** 这次请求的规格，未归一化——`priceSpec` 负责归一化与匹配。 */
  spec?: { size?: unknown; quality?: unknown; seconds?: unknown };
  /** **实际发出**的参考图张数。免费额度在 `priceSpec` 里扣。 */
  inputImages?: number;
  /** 上游自己报的金额。空 = 没报；`0` = 上游说免费。 */
  reportedCost?: number | null;
  /** 按次计费时这次算几次请求。默认 1。 */
  requests?: number;
}

/**
 * 写入口收的那份：`reportedCost` **必须写出来**，没有就写 `null`。
 *
 * 漏传不报错——那一行只是按计费组算，没绑组的 OrcaRouter 模型就静默记成 $0。
 * 让类型检查逼每个调用点表态，比扫源码可靠（参数对象可以先在别处组好）。
 */
export type RecordedUsage = RecordUsageInput & { reportedCost: number | null | undefined };

/** 写进库之前的一整行。导出是为了测试能不碰库就钉住它。 */
export interface UsageRowValues {
  /** Bit mask: input = 1, cache = 2, output = 4. */
  usageKnown: number;
  usageIncomplete: boolean;
  costIncomplete: boolean;
  modelId: string;
  task: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
  /** 这笔钱分别花在哪一种量上。`costUsd` 是它六段之和，同一次 `costOf()` 的结果。 */
  segments: CostSegments;
  billed: Billed;
  priced: PricedSpec;
  createdAt: number;
}

/**
 * 纯函数：把一次请求的事实 + 模型绑定的价，变成要写下去的那一行。
 *
 * 三条到达路径（同步、流式、长任务）都经过它，所以一条测试钉住的是
 * 三条路径共同的行为。
 */
export function buildUsageRow(input: RecordUsageInput, nowMs: number = Date.now()): UsageRowValues {
  const fee = feeOf(input.model);
  const known = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const fields = input.usageEvidence?.fields;
  const inputCount = fields ? fields.inputTokens : input.promptTokens;
  const cacheCount = fields ? fields.cachedTokens : input.cachedTokens;
  const outputCount = fields ? fields.outputTokens : input.completionTokens;
  const count = (n: number | undefined) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  const prompt = count(inputCount);
  const cached = known(inputCount) ? Math.min(count(cacheCount), prompt) : count(cacheCount);
  const completion = count(outputCount);
  const { billed, priced } = billedForSpec(
    fee,
    { outputUnits: input.outputUnits ?? 0, inputImages: input.inputImages ?? 0 },
    input.spec ?? {},
    // With no total input report, only the cache bucket is priceable. Keep the
    // ledger total unknown; this subtotal supplies no invented fresh tokens.
    { inputTokens: Math.max(prompt, cached), outputTokens: completion, cachedTokens: cached },
    input.reportedCost ?? null,
  );
  const withRequests: Billed = { ...billed, requests: Math.max(0, input.requests ?? 1) };
  // `costOf()` 只调一次，总额与分项都从这一次的结果来——调两次就有了两个
  // 可能不一致的数，而它们不一致的时候没有任何东西会报错。
  const parts = costOf(withRequests);
  const usageKnown = (known(fields ? fields.inputTokens : input.promptTokens) ? 1 : 0)
    | (known(fields ? fields.cachedTokens : input.cachedTokens) ? 2 : 0)
    | (known(fields ? fields.outputTokens : input.completionTokens) ? 4 : 0);
  const usageIncomplete = usageKnown !== 7;
  const interrupted = input.usageEvidence && input.usageEvidence.outcome !== "complete";
  const costIncomplete = !hasReportedCost(input.reportedCost) && (
    !input.model.fee || !!interrupted || (fee.billingMode === "token"
      ? !known(fields ? fields.inputTokens : input.promptTokens)
        || !known(fields ? fields.outputTokens : input.completionTokens)
        || (fee.cachePrice !== fee.inputPrice && !known(fields ? fields.cachedTokens : input.cachedTokens))
      : fee.billingMode === "spec" ? !known(input.outputUnits) || !priced.matched : false)
    || (fee.billingMode !== "token" && fee.inputUnitPrice > 0 && !known(input.inputImages))
  );
  return {
    usageKnown, usageIncomplete, costIncomplete,
    modelId: input.model.id,
    task: input.task,
    promptTokens: prompt,
    cachedTokens: cached,
    completionTokens: completion,
    costUsd: totalOf(parts),
    segments: segmentsOf(parts, priced.outputUnit),
    billed: withRequests,
    priced,
    createdAt: Math.floor(nowMs / 1000),
  };
}

function insertValues(r: UsageRowValues): unknown[] {
  const b = r.billed;
  const s = r.segments;
  // 规格快照只在 `matched` 之外还带上规格本身：没命中的行正是用户该抄进
  // 档位表的那一行，把它丢掉等于让用户去猜要补什么。
  const spec: OutputSpec & { matched: boolean } = { ...r.priced.spec, matched: r.priced.matched };
  return [
    r.modelId, r.task, r.promptTokens, r.cachedTokens, r.completionTokens, r.costUsd, r.createdAt,
    b.billingMode, b.inputPrice, b.cachePrice, b.outputPrice, b.requestPrice, b.requests,
    b.outputUnits, b.outputUnitPrice, r.priced.outputUnit, JSON.stringify(spec), r.priced.matched ? 1 : 0,
    r.priced.inputImages, b.inputUnits, b.inputUnitPrice, b.reportedCost,
    s.input, s.cache, s.output, s.count, s.duration, s.other, 1,
  ];
}

/**
 * 记一次请求——**全应用唯一的写入口**。
 *
 * 永不抛错：记账排在「取消检查」「内容拦截」「写进会话」之前是因为上游
 * 已经生成并收费了，而一个锁住的库不该把已经交付的东西变成失败。两处
 * sink 各自 try，所以项目库正被另一个窗口占着也不会让总体账少一行。
 */
export async function recordUsage(
  projectPath: string | null,
  input: RecordedUsage,
): Promise<void> {
  const row = buildUsageRow(input);
  const values = [...insertValues(row), input.requestId ?? crypto.randomUUID(), input.usageEvidence ? JSON.stringify(input.usageEvidence) : null,
    row.usageIncomplete ? 1 : 0, row.costIncomplete ? 1 : 0, row.usageKnown];
  await enqueueUsage(projectPath, values);
}
