/**
 * 读 `token_usage`：把行卷成汇总，给用量页。
 *
 * 两个范围，两个库（lib/ai/usageRow.ts 写的那两处）：
 * - **本项目**读项目目录的 `.ai-writer/project.db`——那份账跟着项目文件夹走。
 * - **全部**读 appDataDir 的 `config.db`——项目删了、移走了，这一年花了多少还在，
 *   并且能按项目再分一层。
 *
 * 聚合在 SQL 里做、跨桶的加法在 TypeScript 里做：`total` 从 `byModel` 加出来
 * 而不是另发一条查询，所以抬头那个数不可能和它下面那几行对不上。
 *
 * **钱只有一个来源**：`cost_usd` 列，它是 `feeGroup.costOf()` 在记账那一刻
 * 写下来的结果。这里 `SUM` 它，不重算——重算就是第二套口径，而第二套口径
 * 记错钱的时候不报错。
 *
 * 「按计费组」这一层**不看行上的快照**，而是拿 `byModel` 去问模型**当前**
 * 绑在哪个组（`groupBuckets`）：重新分组之后历史跟着走，这是故意的。行上
 * 快照的是**价**，不是归属。
 */

import { getDb, getGlobalDb } from "../project";

export type UsageWindow = "today" | "7d" | "30d" | "all";

export const USAGE_WINDOWS: UsageWindow[] = ["today", "7d", "30d", "all"];

export interface UsageBucket {
  /** 模型 id、任务 id、项目路径、计费模式，或 `"total"`。空串 = 那一维没有值。 */
  key: string;
  calls: number;
  /** **全部** prompt token；`cachedTokens` 是它的子集（表的口径，见 usageSchema.ts）。 */
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  /** 按规格计费的量之和：张 / 秒 / 条。混在一个桶里时单位可能不同，只作参考。 */
  outputUnits: number;
  /** 按规格计费却没命中任何档位、上游也没报价的请求数——按 0 计的那些。 */
  uncovered: number;
  costUsd: number;
  /**
   * `costUsd` 按「钱花在哪一种量上」拆开的六份，用量页的计量条按它上色。
   *
   * 不是在这里算出来的：每一行记账时就把 `costOf()` 的结果折成六段抄在行上
   * （lib/ai/usageRow.ts），这里只 `SUM` 那几列。**不重算，就没有第二套口径。**
   */
  costInput: number;
  costCache: number;
  costOutput: number;
  costCount: number;
  costDuration: number;
  costOther: number;
  /**
   * 这个桶里**分不出段**的钱：来自分项列还是 NULL 的老行。
   *
   * 单独数成一份而不是摊进六段，也不是假装它不存在——`costInput + … +
   * costOther + costUnsplit` 必须等于 `costUsd`，条才不会比行尾那个金额短一截。
   */
  costUnsplit: number;
}

export interface UsageSummary {
  scope: UsageScope;
  window: UsageWindow;
  total: UsageBucket;
  byModel: UsageBucket[];
  byTask: UsageBucket[];
  /** 按计费模式（token / request / spec）。老行的 `billing_mode` 是空串。 */
  byMode: UsageBucket[];
  /** 按项目——只有总体那份有，项目库里这一维永远是空的。 */
  byProject: UsageBucket[];
}

const DAY_SECONDS = 86_400;

const WINDOW_DAYS: Record<UsageWindow, number | null> = {
  today: 0,
  "7d": 7,
  "30d": 30,
  all: null,
};

/**
 * Unix-second cutoff for a window, matching how `created_at` is written
 * (`Math.floor(Date.now() / 1000)` at every insert site).
 *
 * `all` returns 0 rather than a special case at each query, so both callers
 * can use the same `created_at >= ?` predicate. Clamped at 0 because a system
 * clock set before 1970 would otherwise produce a negative cutoff, which reads
 * as "everything" anyway but only by accident.
 *
 * `today` is the one window that snaps to a calendar boundary rather than
 * counting back a fixed span: the author means "since local midnight", not
 * "the last 24 hours", so it is derived from the local day rather than
 * subtracted from `nowMs`.
 */
export function windowStartSeconds(window: UsageWindow, nowMs: number): number {
  const days = WINDOW_DAYS[window];
  if (days == null) return 0;
  if (window === "today") {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return Math.max(0, Math.floor(d.getTime() / 1000));
  }
  return Math.max(0, Math.floor(nowMs / 1000) - days * DAY_SECONDS);
}

/**
 * `SUM()` over an empty group is NULL, and the driver hands NULL through as
 * `null` — which then propagates through every later addition as `NaN` and
 * renders as "NaN tokens". Coerce at the boundary instead.
 */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function rowToBucket(r: Record<string, unknown>): UsageBucket {
  return {
    key: typeof r.key === "string" && r.key ? r.key : "",
    calls: num(r.calls),
    promptTokens: num(r.prompt_tokens),
    cachedTokens: num(r.cached_tokens),
    completionTokens: num(r.completion_tokens),
    outputUnits: num(r.output_units),
    uncovered: num(r.uncovered),
    costUsd: num(r.cost_usd),
    costInput: num(r.cost_input),
    costCache: num(r.cost_cache),
    costOutput: num(r.cost_output),
    costCount: num(r.cost_count),
    costDuration: num(r.cost_duration),
    costOther: num(r.cost_other),
    costUnsplit: num(r.cost_unsplit),
  };
}

export function sumBuckets(key: string, buckets: UsageBucket[]): UsageBucket {
  return buckets.reduce<UsageBucket>(
    (acc, b) => ({
      key,
      calls: acc.calls + b.calls,
      promptTokens: acc.promptTokens + b.promptTokens,
      cachedTokens: acc.cachedTokens + b.cachedTokens,
      completionTokens: acc.completionTokens + b.completionTokens,
      outputUnits: acc.outputUnits + b.outputUnits,
      uncovered: acc.uncovered + b.uncovered,
      costUsd: acc.costUsd + b.costUsd,
      costInput: acc.costInput + b.costInput,
      costCache: acc.costCache + b.costCache,
      costOutput: acc.costOutput + b.costOutput,
      costCount: acc.costCount + b.costCount,
      costDuration: acc.costDuration + b.costDuration,
      costOther: acc.costOther + b.costOther,
      costUnsplit: acc.costUnsplit + b.costUnsplit,
    }),
    {
      key, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, outputUnits: 0,
      uncovered: 0, costUsd: 0,
      costInput: 0, costCache: 0, costOutput: 0, costCount: 0, costDuration: 0, costOther: 0,
      costUnsplit: 0,
    },
  );
}

/**
 * Most expensive first. Sorted here rather than with `ORDER BY SUM(cost_usd)`
 * because a provider whose pricing the author never filled in reports zero
 * cost for real traffic — falling back to output tokens keeps those rows in a
 * useful order instead of grouping them arbitrarily at the bottom. The final
 * key comparison only exists to make the order total, so the same data always
 * renders the same way.
 */
export function sortBuckets(buckets: UsageBucket[]): UsageBucket[] {
  return [...buckets].sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      b.completionTokens - a.completionTokens ||
      a.key.localeCompare(b.key),
  );
}

/** The detail table's sortable columns. `name` is the row label, the rest map
 *  one-to-one onto the figures printed in that row. */
export type UsageSortKey =
  | "name"
  | "calls"
  | "input"
  | "cached"
  | "output"
  | "hitRate"
  | "cost";

type UsageSortDir = "asc" | "desc";

/** Uncached ("fresh") input — `cachedTokens` is a subset of `promptTokens`,
 *  so the input column is the difference, not the raw prompt figure. */
function freshInput(b: UsageBucket): number {
  return Math.max(0, b.promptTokens - b.cachedTokens);
}

/** A group with no prompt tokens has no meaningful hit rate; -1 sorts those
 *  rows below every real ratio in descending order (where they read as "—"). */
function cacheHitRatio(b: UsageBucket): number {
  return b.promptTokens > 0 ? b.cachedTokens / b.promptTokens : -1;
}

/**
 * Order the detail rows by a chosen column and direction.
 *
 * The `name` column sorts by the *resolved* display name — a model or task id
 * means nothing to the reader — so the caller passes a resolver rather than
 * this module reaching into the active profile. Cost ties break on output
 * tokens: a provider whose pricing the author never filled in bills $0 for
 * real traffic, and this keeps those rows in a useful order instead of
 * collapsing them onto the id comparison. The final id comparison exists only
 * to make the order total, so identical data always renders the same way
 * regardless of direction.
 */
export function sortUsageBuckets(
  buckets: UsageBucket[],
  key: UsageSortKey,
  dir: UsageSortDir,
  nameOf: (bucketKey: string) => string,
): UsageBucket[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...buckets].sort((a, b) => {
    let primary = 0;
    switch (key) {
      case "name":
        primary = nameOf(a.key).localeCompare(nameOf(b.key));
        break;
      case "calls":
        primary = a.calls - b.calls;
        break;
      case "input":
        primary = freshInput(a) - freshInput(b);
        break;
      case "cached":
        primary = a.cachedTokens - b.cachedTokens;
        break;
      case "output":
        primary = a.completionTokens - b.completionTokens;
        break;
      case "hitRate":
        primary = cacheHitRatio(a) - cacheHitRatio(b);
        break;
      case "cost":
        primary = a.costUsd - b.costUsd || a.completionTokens - b.completionTokens;
        break;
    }
    if (primary !== 0) return mul * primary;
    return a.key.localeCompare(b.key);
  });
}

/**
 * 哪一份账。`project` = 这个项目目录里的，`global` = appDataDir 里的全部。
 *
 * 不是同一张表的两个过滤条件，是两个库：项目那份跟着项目文件夹走（复制一份
 * 项目过去，账也过去），总体那份比任何一个项目活得久。
 */
export type UsageScope = "project" | "global";

/**
 * 分组的那一列是每条语句里的**字面量**，从不拼接：这个模块只提供写在
 * 这里的这几种卷法。
 *
 * `uncovered` 数的是「按规格计费却没命中任何档位、上游也没报价」的请求——
 * 那些请求按 0 计，用量页据此提醒用户去补档位表。`spec_matched IS NULL` 的
 * 老行不算：它们记下来的时候还没有档位表这回事。
 *
 * 六条 `cost_*` 是计量条的分段，`cost_unsplit` 是这个桶里分不出段的钱。
 * 它们**一样是 `SUM` 一个落了盘的结果**，不是在 SQL 里把 `costOf()` 的分支
 * 重写一遍——那会是第二套口径，而第二套口径记错钱的时候不报错。
 *
 * `cost_input IS NULL` 就是「这一行没有分项快照」的判据：新行六列必写（哪怕
 * 是 0），老行六列全空。所以拿第一列判一次就够，不必六列都查。
 */
export const ROLLUP_SELECT = `COUNT(*) AS calls,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(COALESCE(output_units, 0)) AS output_units,
         SUM(CASE WHEN spec_matched = 0 AND reported_cost IS NULL THEN 1 ELSE 0 END) AS uncovered,
         SUM(cost_usd) AS cost_usd,
         SUM(COALESCE(cost_input, 0)) AS cost_input,
         SUM(COALESCE(cost_cache, 0)) AS cost_cache,
         SUM(COALESCE(cost_output, 0)) AS cost_output,
         SUM(COALESCE(cost_count, 0)) AS cost_count,
         SUM(COALESCE(cost_duration, 0)) AS cost_duration,
         SUM(COALESCE(cost_other, 0)) AS cost_other,
         SUM(CASE WHEN cost_input IS NULL THEN cost_usd ELSE 0 END) AS cost_unsplit`;

const rollupSql = (column: "model_id" | "task" | "project" | "billing_mode") =>
  `SELECT COALESCE(${column}, '') AS key, ${ROLLUP_SELECT}
   FROM token_usage WHERE created_at >= ? GROUP BY ${column}`;

async function dbFor(scope: UsageScope, projectPath: string | null) {
  if (scope === "global") return getGlobalDb();
  if (!projectPath) throw new Error("project usage needs an open project");
  return getDb(projectPath);
}

export async function loadUsage(
  scope: UsageScope,
  projectPath: string | null,
  window: UsageWindow,
  nowMs: number = Date.now(),
): Promise<UsageSummary> {
  const db = await dbFor(scope, projectPath);
  const since = windowStartSeconds(window, nowMs);
  const q = (col: Parameters<typeof rollupSql>[0]) =>
    db.select<Record<string, unknown>[]>(rollupSql(col), [since]);
  // 按项目只在总体那份里有意义——项目库里每一行都是这个项目的。
  const [modelRows, taskRows, modeRows, projectRows] = await Promise.all([
    q("model_id"), q("task"), q("billing_mode"),
    scope === "global" ? q("project") : Promise.resolve([]),
  ]);
  const byModel = sortBuckets(modelRows.map(rowToBucket));
  return {
    scope,
    window,
    total: sumBuckets("total", byModel),
    byModel,
    byTask: sortBuckets(taskRows.map(rowToBucket)),
    byMode: sortBuckets(modeRows.map(rowToBucket)),
    byProject: sortBuckets(projectRows.map(rowToBucket)),
  };
}

/**
 * 把按模型的桶折成按**当前**计费组的桶。
 *
 * 归属取自模型现在绑着的组，不是行上的快照——重新分组之后历史跟着走。
 * 没绑组的模型（以及已经删掉的模型）落进 `key: ""` 那个桶，界面写「未绑定」。
 */
export function groupBuckets(
  byModel: UsageBucket[],
  feeGroupIdOf: (modelId: string) => string | undefined,
): UsageBucket[] {
  const acc = new Map<string, UsageBucket[]>();
  for (const b of byModel) {
    const key = feeGroupIdOf(b.key) ?? "";
    const list = acc.get(key);
    if (list) list.push(b);
    else acc.set(key, [b]);
  }
  return sortBuckets([...acc].map(([key, list]) => sumBuckets(key, list)));
}

/**
 * 清掉一份账。不可撤销——调用方先确认。
 *
 * 清「本项目」只动项目库：总体那份是另一本账，作者清掉一个项目的记录不是
 * 在说「这半年我没花过钱」。要清总体的得在总体范围里再清一次，那是另一次
 * 确认（`scope: "global"` + `projectPath: null`）。
 * 在总体范围里带上 `projectPath` 则只清这个项目在总账里的那些行。
 */
export async function clearUsage(scope: UsageScope, projectPath: string | null): Promise<void> {
  const db = await dbFor(scope, projectPath);
  if (scope === "global" && projectPath) {
    await db.execute("DELETE FROM token_usage WHERE project = ?", [projectPath]);
    return;
  }
  await db.execute("DELETE FROM token_usage");
}

/**
 * Compact token counts. These run to millions over a project's life and the
 * exact digit is never the question being asked — "how much did last month
 * cost" is.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/**
 * Sub-cent totals are the normal case for a single session, so two decimals
 * would render most real usage as "$0.00" and read as "this feature is
 * broken". Below a dollar the figure keeps four places instead.
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/**
 * 把合并掉的模型 id 指向留下来的那个（lib/ai/channelMerge.ts）。
 *
 * 两个库都改：总体那份里别的项目的行也在同一张表里，不跟着改就会显示成
 * 「已删除的模型」。尽力而为——配置那一侧的合并已经落地了，这一步失败
 * 只是历史少了个名字。
 */
export async function remapUsageModelIds(
  projectPath: string | null,
  remap: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(remap);
  if (entries.length === 0) return;
  const run = async (db: Awaited<ReturnType<typeof getGlobalDb>>) => {
    for (const [from, to] of entries) {
      await db.execute("UPDATE token_usage SET model_id = ? WHERE model_id = ?", [to, from]);
    }
  };
  await Promise.all([
    projectPath
      ? getDb(projectPath).then(run).catch((e) => console.warn("[usage] 项目用量的模型 id 未改写：", e))
      : Promise.resolve(),
    getGlobalDb().then(run).catch((e) => console.warn("[usage] 总体用量的模型 id 未改写：", e)),
  ]);
}
