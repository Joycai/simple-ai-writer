/**
 * 取材条的**取数**一侧：把一轮的原始取材事实（`TurnContextTrace`）折算成稿面
 * 上要显示的那些行和数字。
 *
 * 设计稿 13「本轮取材条」。纯函数、不 import 任何组件和 store，所以设计稿里那
 * 些「几条算一条」的规则可以逐条钉在测试里——而它们正是这个组件最容易悄悄算
 * 错的部分：收起行只报三个数，每个数都是一次聚合，聚合错了不会报错，只会让作
 * 者对着一个错的数字去改设定。
 *
 * ## 落在这里的四条口径（设计稿 TURN 2）
 *
 * 1. **「本轮」是三段之和**：知识库 + 记忆区 + 引用。收起行写「常驻 4 · 本轮 6」，
 *    展开是 3 + 2 + 1——两个数必须对得上，否则展开的那一刻整条就失去信任。
 * 2. **一律读「字」（chars），不读 tk**。数据层给的就是 chars；只有上下文构成条
 *    读 tk。同一个面板里两种单位靠位置分：条上是 tk，条下的账目是字。
 *    chars → tk 的换算只在构成条发生一次，取材条不做二次估算——**两处各说各的
 *    真实数据，比对齐成一个假数好**。
 * 3. **引用算一条，但不带字数**。`refs` 只有 name 和 dirPath，所以它计入
 *    `turnCount`（它确实在上下文里）而不计入 `turnChars`。将来 refs 带上字数，
 *    它应当计入而不是继续留白。
 * 4. **`null` 报告和空报告是两回事**。`null` = 这条路没跑过（重试轮，段头读
 *    「未检索」）；空报告 = 跑了、一条都没碰到（读「0」）。它们和「0 字」
 *    （coreResident）、「本轮 +0」（常驻）、「无记录」（重启前）一起，是五句
 *    **不能互相代替**的话。
 */

import type { LoreActivationReport, LoreEntityReport } from "../context/loreSelect";
import type { ResidentPiece, TurnContextTrace } from "./trace";

/** 设计稿 2e：关键字最多平铺三个，其余折成一个数。 */
export const KEYWORDS_INLINE_CAP = 3;

/** 设计稿 2i：窄档下命中超过这个数才折叠，按字数从大到小留前几条。 */
export const NARROW_HIT_CAP = 6;

// ─── 收起行 ──────────────────────────────────────────────────────────────────

export interface TraceSummary {
  residentCount: number;
  /** 知识库 + 记忆区 + 引用。 */
  turnCount: number;
  /** 本轮**新**注入的字符数。常驻不计（它一直在），引用也不计（它没有字数）。 */
  turnChars: number;
  /** 命中了却没进去的条数（含没装下的配图）。 */
  droppedCount: number;
  /** 失效的绑定条数。 */
  staleCount: number;
  /**
   * 绑定块里只进了标题、正文没进去的条数。
   *
   * **要报到收起行**：这是作者最容易误判的一种——清单里明明有它，角色却对它
   * 一无所知，而不展开就看不见。
   */
  unexpandedCount: number;
}

export function summarize(trace: TurnContextTrace): TraceSummary {
  const dropped = [...(trace.lore?.entities ?? []), ...(trace.area?.entities ?? [])]
    .reduce((n, e) => n + e.droppedFacets.length + (e.droppedImages ? 1 : 0), 0);
  return {
    residentCount: trace.resident.length,
    // 引用**算一条**（它确实在上下文里），但下面的字数不算它——`refs` 没有 chars。
    turnCount: hitRows(trace.lore).length + hitRows(trace.area).length + trace.refs.length,
    turnChars: (trace.lore?.usedChars ?? 0) + (trace.area?.usedChars ?? 0),
    droppedCount: dropped,
    staleCount: trace.stalePaths.length,
    unexpandedCount: trace.resident.filter((p) => p.unexpanded).length,
  };
}

// ─── 常驻段 ──────────────────────────────────────────────────────────────────

export interface ResidentRow extends ResidentPiece {
  /** 「沈砚」/「阿箬 · 外套」——特征绑定才带那一段的名字。 */
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
   * 没有任何关键字、也不是 pin——它是 `mode: "always"`，随条目一起进来的。
   *
   * 这一行必须存在（设计稿 2e）：留空会被读成「不知道为什么进来的」，而它恰恰
   * 是最确定的一类。
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
 * 这一轮选中的条目，按注入量从大到小。
 *
 * **`coreResident`（0 字）的那些也在里面**，尽管它们一个字都没贡献。设计稿把
 * 「0 字」列为五句不能互相代替的话之一：它的意思是「命中了，但正文已经在常驻
 * 段里，去重后不重复装」——把它滤掉，作者会以为这一句话没能唤起这个条目，然后
 * 去给一个工作正常的条目加关键字。
 *
 * 所以这里**不用** `contributingEntities`：那个过滤器是给日志里那句「注入了 N
 * 条」用的（报一个不存在的注入是另一种错），和这里要回答的问题不是同一个。
 *
 * 排序不是审美：窄栏下要折叠成「前 6 条 + 还有 N 条」，被折起来的应当是最小的
 * 那些，而 0 字的自然沉到最后。宽栏用同一个顺序，免得同一轮的两种宽度读出两个
 * 不同的故事。
 */
export function hitRows(report: LoreActivationReport | null): HitRow[] {
  if (!report) return [];
  return report.entities.map(toHitRow).sort((a, b) => b.chars - a.chars);
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

/** 有「超预算」这一类时才画预算条：预算没满就不该有个亮按钮劝你调它（设计稿 2f）。 */
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
 * 窄档下把命中折成「前 N 条 + 还有 M 条 · 700 字」。
 *
 * 20 条时展开的应当是一段名单，不是 20 张卡（设计稿 2i）——层与关键字只在留下
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
