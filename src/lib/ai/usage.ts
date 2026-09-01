/**
 * Reading the `token_usage` rows back out of a project's database.
 *
 * Four call sites write that table (a generative task, a chat turn, a memory
 * summarisation, an image run) and until now nothing read it — the numbers
 * accumulated with no way to see them and no way to clear them. This module is
 * the read side: two `GROUP BY` rollups over a time window, plus the delete
 * that gives the author a way to reset the count.
 *
 * The aggregation deliberately happens in SQL and the arithmetic across
 * buckets in TypeScript: `total` is derived from `byModel` rather than fetched
 * separately, so the headline figure can never disagree with the rows printed
 * underneath it.
 */

import { getDb } from "../project";

export type UsageWindow = "today" | "7d" | "30d" | "all";

export const USAGE_WINDOWS: UsageWindow[] = ["today", "7d", "30d", "all"];

export interface UsageBucket {
  /** A model id, a task id, or `"total"` for the rollup. */
  key: string;
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  window: UsageWindow;
  total: UsageBucket;
  byModel: UsageBucket[];
  byTask: UsageBucket[];
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
    costUsd: num(r.cost_usd),
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
      costUsd: acc.costUsd + b.costUsd,
    }),
    { key, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUsd: 0 },
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

export type UsageSortDir = "asc" | "desc";

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

// The grouped column is a literal in each statement, never interpolated: the
// only two rollups this module offers are the two written out here.
const BY_MODEL_SQL = `
  SELECT model_id AS key, COUNT(*) AS calls,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cost_usd) AS cost_usd
  FROM token_usage WHERE created_at >= ? GROUP BY model_id`;

const BY_TASK_SQL = `
  SELECT task AS key, COUNT(*) AS calls,
         SUM(prompt_tokens) AS prompt_tokens,
         SUM(cached_tokens) AS cached_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(cost_usd) AS cost_usd
  FROM token_usage WHERE created_at >= ? GROUP BY task`;

export async function loadUsage(
  projectPath: string,
  window: UsageWindow,
  nowMs: number = Date.now(),
): Promise<UsageSummary> {
  const db = await getDb(projectPath);
  const since = windowStartSeconds(window, nowMs);
  const [modelRows, taskRows] = await Promise.all([
    db.select<Record<string, unknown>[]>(BY_MODEL_SQL, [since]),
    db.select<Record<string, unknown>[]>(BY_TASK_SQL, [since]),
  ]);
  const byModel = sortBuckets(modelRows.map(rowToBucket));
  const byTask = sortBuckets(taskRows.map(rowToBucket));
  return { window, total: sumBuckets("total", byModel), byModel, byTask };
}

/** Drop every recorded run for this project. Not undoable — the caller confirms. */
export async function clearUsage(projectPath: string): Promise<void> {
  const db = await getDb(projectPath);
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
 * Record a single completed LLM call into the project's `token_usage` table.
 * Best-effort and non-critical (never throws).
 */
export async function persistUsage(
  projectPath: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
  task: string,
  cachedTokens = 0,
): Promise<void> {
  try {
    const db = await getDb(projectPath);
    await db.execute(
      `INSERT INTO token_usage (model_id, task, prompt_tokens, cached_tokens, completion_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [modelId, task, inputTokens, cachedTokens, outputTokens, cost, Math.floor(Date.now() / 1000)],
    );
  } catch {
    // non-critical: usage accounting must not crash the caller
  }
}

