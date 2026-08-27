/**
 * 取材条的**取数**一侧：把一轮的原始取材事实（`TurnContextTrace`）折算成稿面
 * 上要显示的那些行和数字。
 *
 * 设计稿 13「本轮取材条」。纯函数、不 import 任何组件和 store，所以设计稿里那
 * 些「几条算一条」的规则可以逐条钉在测试里——而它们正是这个组件最容易悄悄算
 * 错的部分：收起行只报三个数，每个数都是一次聚合，聚合错了不会报错，只会让作
 * 者对着一个错的数字去改设定。
 *
 * ## 落在这里的三条口径
 *
 * 1. **「本轮」是三段之和**：知识库命中 + 记忆区 + 你 @ 的。收起行写「常驻 5 ·
 *    本轮 6」，展开是 3 + 2 + 1——两个数必须对得上，否则展开的那一刻整条就失
 *    去信任。
 * 2. **常驻不计 tk，只有本轮计**。常驻上一场就装订好了，这一轮不必重复计
 *    （段头写「本轮 +0 tk」）。把常驻的字数并进「本轮 3.8k」，作者每一轮都会
 *    看到一个虚高的数，并据此去调一个没问题的预算。
 * 3. **`null` 报告和空报告是两回事**。`null` = 这条路没跑过（重试轮）；空报告
 *    = 跑了、一条都没碰到。前者不该显示成「0」，后者必须显示成「0」——设计稿
 *    把这两句和「无记录」并列为「三句不能混的话」。
 */

import { contributingEntities, type LoreActivationReport, type LoreEntityReport }
  from "../context/loreSelect";
import type { ResidentPiece, TurnContextTrace } from "./trace";

/** 设计稿 1e：激活词最多平铺三个，其余折成一个数。 */
export const KEYWORDS_INLINE_CAP = 3;

/** 设计稿 1h：窄栏下命中超过这个数才折叠，按 tk 从大到小留前几条。 */
export const NARROW_HIT_CAP = 6;

// ─── 收起行 ──────────────────────────────────────────────────────────────────

export interface TraceSummary {
  residentCount: number;
  /** 知识库命中 + 记忆区 + 你 @ 的。 */
  turnCount: number;
  /** 本轮**新**注入的字符数；常驻不计（口径 2）。 */
  turnChars: number;
  /** 命中了却没进去的条数（含没装下的配图）。 */
  droppedCount: number;
  /** 失效的绑定条数。 */
  staleCount: number;
}

export function summarize(trace: TurnContextTrace): TraceSummary {
  const lore = trace.lore ? contributingEntities(trace.lore) : [];
  const area = trace.area ? contributingEntities(trace.area) : [];
  const dropped = [...(trace.lore?.entities ?? []), ...(trace.area?.entities ?? [])]
    .reduce((n, e) => n + e.droppedFacets.length + (e.droppedImages ? 1 : 0), 0);
  return {
    residentCount: trace.resident.length,
    turnCount: lore.length + area.length + trace.refs.length,
    turnChars: (trace.lore?.usedChars ?? 0) + (trace.area?.usedChars ?? 0),
    droppedCount: dropped,
    staleCount: trace.stalePaths.length,
  };
}

// ─── 常驻段 ──────────────────────────────────────────────────────────────────

export interface ResidentRow extends ResidentPiece {
  /** 「沈砚 · 人设」/「沈砚 · 外套」——名字加它是哪一层。 */
  label: string;
}

export function residentRows(trace: TurnContextTrace): ResidentRow[] {
  return trace.resident.map((p) => ({
    ...p,
    label: p.kind === "bound-facet" && p.facetTitle ? `${p.name} · ${p.facetTitle}` : p.name,
  }));
}

// ─── 本轮命中 / 记忆区 ───────────────────────────────────────────────────────

export interface LayerChip {
  kind: "summary" | "core" | "facet" | "gallery";
  /** 特征名（facet）；其余为 null。 */
  title: string | null;
  chars: number;
  /** core 被按段落截断过。 */
  truncated: boolean;
  /** 截断前的原字数（`truncated` 时才有）。 */
  sourceChars: number | null;
  /** 配图张数（gallery）。 */
  count: number | null;
  pinned: boolean;
}

export interface FacetRow {
  title: string;
  chars: number;
  matchedKeys: string[];
  /**
   * 没有任何关键词、也不是 pin——它是 `mode: "always"`，随条目一起进来的。
   *
   * 这一行必须存在（设计稿 1e）：留空会被读成「不知道为什么进来的」，而它恰恰
   * 是设定里最确定的一类。
   */
  ridesAlong: boolean;
}

export interface HitRow {
  name: string;
  aliases: string;
  dirPath: string;
  /** 这一条本轮一共注入了多少字符。 */
  chars: number;
  /** 把它选进来的那些名字/别名。pin 进来的为空——pin 不需要理由。 */
  matchedTerms: string[];
  pinned: boolean;
  /** 正文常驻、这一轮只补了特征。 */
  coreResident: boolean;
  /** 非特征的层（摘要 / 正文 / 配图清单）。 */
  chips: LayerChip[];
  /** 特征各自成行——它们各有各的激活理由。 */
  facets: FacetRow[];
}

function toHitRow(e: LoreEntityReport): HitRow {
  const chips: LayerChip[] = [];
  const facets: FacetRow[] = [];
  for (const l of e.layers) {
    if (l.kind === "facet") {
      facets.push({
        title: l.title ?? l.file ?? "",
        chars: l.chars,
        matchedKeys: l.matchedKeys ?? [],
        // pin 有自己的记号，不算「随条目进入」。
        ridesAlong: !(l.matchedKeys?.length) && !l.pinned,
      });
    } else {
      chips.push({
        kind: l.kind,
        title: l.title ?? null,
        chars: l.chars,
        truncated: !!l.truncated,
        sourceChars: l.sourceChars ?? null,
        count: l.count ?? null,
        pinned: !!l.pinned,
      });
    }
  }
  return {
    name: e.name,
    aliases: e.aliases,
    dirPath: e.dirPath,
    chars: e.layers.reduce((n, l) => n + l.chars, 0),
    matchedTerms: e.matchedTerms ?? [],
    pinned: e.reason === "pinned",
    coreResident: !!e.coreResident,
    chips,
    facets,
  };
}

/**
 * 真的贡献了文字的那些条目，按注入量从大到小。
 *
 * 排序不是审美：窄栏下要折叠成「前 6 条 + 还有 N 条」，而被折起来的应当是最小
 * 的那些。宽栏用同一个顺序，免得同一轮的两种宽度读出两个不同的故事。
 */
export function hitRows(report: LoreActivationReport | null): HitRow[] {
  if (!report) return [];
  return contributingEntities(report).map(toHitRow).sort((a, b) => b.chars - a.chars);
}

// ─── 没进去 ──────────────────────────────────────────────────────────────────

export interface DropRow {
  /** 「铁鳞甲 · 产地」——条目名 + 那一段。 */
  label: string;
  reason: "no-key" | "group-lost" | "budget" | "manual-only" | "resident";
  /** `group-lost`：赢的那一条。 */
  winner: string | null;
  /** `budget`：这一段需要多少字符——即提高预算能换回什么。 */
  neededChars: number | null;
}

export function dropRows(report: LoreActivationReport | null): DropRow[] {
  if (!report) return [];
  const rows: DropRow[] = [];
  for (const e of report.entities) {
    for (const d of e.droppedFacets) {
      rows.push({
        label: `${e.name} · ${d.title}`,
        reason: d.reason,
        winner: d.winner ?? null,
        neededChars: d.neededChars ?? null,
      });
    }
  }
  // 「超预算」排最前：它是五种里唯一有解的一种，而这一组的段底挂着预算入口。
  return rows.sort((a, b) => Number(b.reason === "budget") - Number(a.reason === "budget"));
}

/** 被挡下的合计字符——段头右端那个数，也是「提高预算能拿回多少」的估价。 */
export function blockedChars(rows: readonly DropRow[]): number {
  return rows.reduce((n, r) => n + (r.neededChars ?? 0), 0);
}

/** 有「超预算」这一类时才画预算条：预算没满就不该有个亮按钮劝你调它（设计稿 1f）。 */
export function budgetPressed(rows: readonly DropRow[]): boolean {
  return rows.some((r) => r.reason === "budget");
}

// ─── 激活词 ──────────────────────────────────────────────────────────────────

export interface KeywordLine {
  /** 平铺出来的前几个。 */
  shown: string[];
  /** 折起来的个数，0 = 没有折叠。 */
  rest: number;
}

export function keywordLine(keys: readonly string[], expanded = false): KeywordLine {
  if (expanded || keys.length <= KEYWORDS_INLINE_CAP) return { shown: [...keys], rest: 0 };
  return {
    shown: keys.slice(0, KEYWORDS_INLINE_CAP),
    rest: keys.length - KEYWORDS_INLINE_CAP,
  };
}

// ─── 窄栏折叠 ────────────────────────────────────────────────────────────────

export interface FoldedHits {
  shown: HitRow[];
  /** 折起来的条数，0 = 没有折叠。 */
  restCount: number;
  restChars: number;
}

/**
 * 窄栏下把命中折成「前 N 条 + 还有 M 条 · 0.7k」。
 *
 * 20 条时展开的应当是一段名单，不是 20 张卡（设计稿 1h）——层与激活词只在留下
 * 的那几条里展开。
 */
export function foldHits(rows: readonly HitRow[], cap = NARROW_HIT_CAP): FoldedHits {
  if (rows.length <= cap) return { shown: [...rows], restCount: 0, restChars: 0 };
  const rest = rows.slice(cap);
  return {
    shown: rows.slice(0, cap),
    restCount: rest.length,
    restChars: rest.reduce((n, r) => n + r.chars, 0),
  };
}
