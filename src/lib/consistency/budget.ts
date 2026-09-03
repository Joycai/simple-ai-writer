/**
 * 一致性检查的预算与切段 —— 一次请求能装多少原文，文档因此要切成几段。
 *
 * 纯函数。它回答的是分配条上那句「本次 3 段 · 每段 ≤ 9.2k tk」，也决定运行时
 * 每一段的种子有多大。设计与常数的来历：docs/feature/consistency-review-plan.md §7.1。
 *
 *   ceiling  = 窗口 × 占用                              ← 与 AiPanel 同一个上限
 *   fixed    = 工具 schema + system + 指令
 *   growth   = ceiling × GROWTH_SHARE                    ← 留给工具结果长出来的部分
 *   usable   = ceiling − fixed − growth
 *   lore     = entries 档：pins 全文（上限 usable × 0.5）；否则 usable × 0.35
 *   recap    = min(前情, usable × 0.1)（k > 1 再加上一段尾巴）
 *   window   = usable − lore − recap                     ← 每段能装的原文
 *   N        = ceil(docChars / window)，上限 MAX_WINDOWS
 *
 * 不变量（测试守着）：**段的合计正好是上限**——和生成面板的分配条同一条规则
 * （docs/feature/agent/context-meters.md §5），因为它们穿的是同一件衣服。
 */

import { ASSUMED_INPUT_CEILING_TOKENS, inputCeilingFor } from "../context/budget";

/** Share of the ceiling held back for tool results the loop drags in. */
export const GROWTH_SHARE = 0.25;
/** Knowledge-base share of the usable window when discovery is automatic. */
export const LORE_SHARE = 0.35;
/** Entries mode: the pins may take up to this much, never more. */
export const PINNED_LORE_CAP = 0.5;
/** Recap (story memory) share, hard-capped. */
export const RECAP_SHARE = 0.1;
/** Tail of the previous window carried into the next, in chars. */
export const WINDOW_TAIL_CHARS = 600;
/** Beyond this the document is cut short and the report says so. */
export const MAX_WINDOWS = 12;
/** Parallel checker runs — same figure as the roleplay panel's semaphore. */
export const REVIEW_CONCURRENCY = 3;
/**
 * Smallest window worth sending. Below this the model is reading a paragraph
 * against a whole knowledge base, and the segment count explodes — which is the
 * symptom the author sees when the window setting is simply too small.
 */
const MIN_WINDOW_CHARS = 800;

export type ReviewSegmentKey = "system" | "input" | "lore" | "memory" | "free";

export interface ReviewPlanInput {
  /** The model's declared window; undefined/0 = unknown (assumed ceiling). */
  contextSize: number | undefined;
  /** Author's 窗口占用 (0–1). */
  utilization: number;
  /** Tool schemas on the wire, in tokens (`plannedToolTokens`). */
  toolTokens: number;
  /** System prompt + instruction, in chars. */
  fixedChars: number;
  charsPerToken: number;
  docChars: number;
  /** Story-memory recap available, in chars (0 when none). */
  recapChars: number;
  /**
   * Entries mode: the pinned entries' text, in chars — the knowledge-base
   * segment is *that*, capped, instead of a share. Null = automatic discovery.
   */
  pinnedChars: number | null;
}

export interface ReviewPlanSegment {
  key: ReviewSegmentKey;
  chars: number;
}

export interface ReviewPlan {
  /** In bar order; chars sum to the ceiling exactly. */
  segments: ReviewPlanSegment[];
  ceilingTokens: number;
  charsPerToken: number;
  /** True when the model declared no window and the assumed ceiling was used. */
  assumed: boolean;
  /** Original text one window carries. */
  windowChars: number;
  loreBudgetChars: number;
  recapChars: number;
  /** ceil(doc / window), capped. ≥ 1 even for an empty document. */
  windowCount: number;
  /** The cap bit: chars past the last window that will not be checked. */
  uncheckedChars: number;
  /** Tokens one window's request is planned at (everything but `free`). */
  perWindowTokens: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function planReview(input: ReviewPlanInput): ReviewPlan {
  const cpt = input.charsPerToken > 0 ? input.charsPerToken : 1;
  const assumed = !input.contextSize || input.contextSize <= 0;
  const ceilingTokens = assumed
    ? ASSUMED_INPUT_CEILING_TOKENS
    : inputCeilingFor(input.contextSize, input.utilization);
  const ceilingChars = Math.floor(ceilingTokens * cpt);

  const systemChars = Math.min(ceilingChars, Math.round(input.toolTokens * cpt) + input.fixedChars);
  const growthChars = Math.floor(ceilingChars * GROWTH_SHARE);
  const usable = Math.max(0, ceilingChars - systemChars - growthChars);

  const loreChars =
    input.pinnedChars !== null
      ? Math.min(Math.max(0, input.pinnedChars), Math.floor(usable * PINNED_LORE_CAP))
      : Math.floor(usable * LORE_SHARE);
  const recapChars = Math.min(Math.max(0, input.recapChars), Math.floor(usable * RECAP_SHARE));
  const windowChars = Math.max(MIN_WINDOW_CHARS, usable - loreChars - recapChars);

  const docChars = Math.max(0, input.docChars);
  const rawCount = docChars === 0 ? 1 : Math.ceil(docChars / windowChars);
  const windowCount = clamp(rawCount, 1, MAX_WINDOWS);
  const uncheckedChars = Math.max(0, docChars - windowCount * windowChars);

  // What one window actually carries — the first window has no tail and a
  // short document leaves most of its slot empty, so `input` is the smaller of
  // the slot and the document.
  const inputChars = Math.min(windowChars, docChars || windowChars);
  const used = systemChars + inputChars + loreChars + recapChars;
  const free = Math.max(0, ceilingChars - used);
  // Overflow (a fixed cost past the ceiling) is absorbed by `free` clamping to
  // 0 and the sum rule bending — the same thing forecast.ts does; the bar then
  // reads as full, which for this surface is the honest picture.
  const segments: ReviewPlanSegment[] = [
    { key: "system", chars: systemChars },
    { key: "input", chars: inputChars },
    { key: "lore", chars: loreChars },
    { key: "memory", chars: recapChars },
    { key: "free", chars: free },
  ];

  return {
    segments,
    ceilingTokens,
    charsPerToken: cpt,
    assumed,
    windowChars,
    loreBudgetChars: loreChars,
    recapChars,
    windowCount,
    uncheckedChars,
    perWindowTokens: Math.ceil(used / cpt),
  };
}

// ─── Splitting ────────────────────────────────────────────────────────────────

export interface DocWindow {
  /** 0-based. */
  index: number;
  /** [from, to) in the whole document. */
  from: number;
  to: number;
  text: string;
}

const HEADING_RE = /^#{1,6}\s/;

/**
 * Cut the document into windows of at most `windowChars`, on the best
 * boundary available: a heading line first, then a blank line, then any line
 * break, then a hard cut. The search window is the last 40% of each slot, so a
 * boundary is never so early that the next window is mostly a repeat.
 *
 * Windows tile [start, min(len, start + count × windowChars)) with no overlap;
 * the previous window's tail is carried as *context* by the caller, not as
 * text to check twice. Returns at least one window for a non-empty document,
 * and one empty window for an empty one.
 */
export function splitDocument(
  text: string,
  windowChars: number,
  opts?: { maxWindows?: number; start?: number },
): DocWindow[] {
  const max = opts?.maxWindows ?? MAX_WINDOWS;
  const size = Math.max(1, Math.floor(windowChars));
  const start = clamp(opts?.start ?? 0, 0, text.length);
  const windows: DocWindow[] = [];
  let pos = start;
  while (windows.length < max) {
    const remaining = text.length - pos;
    if (remaining <= size) {
      windows.push({ index: windows.length, from: pos, to: text.length, text: text.slice(pos) });
      break;
    }
    const cut = bestCut(text, pos, pos + size);
    windows.push({ index: windows.length, from: pos, to: cut, text: text.slice(pos, cut) });
    pos = cut;
  }
  return windows;
}

/** Where to end a window that must close by `limit`: the latest good boundary in the slot's last 40%. */
function bestCut(text: string, from: number, limit: number): number {
  const floor = from + Math.floor((limit - from) * 0.6);
  let heading = -1;
  let blank = -1;
  let newline = -1;
  // Walk the candidate zone once, remembering the latest of each kind. A
  // boundary is the position *after* a line break, so the next window begins
  // on a fresh line.
  for (let i = limit - 1; i >= floor; i--) {
    if (text[i] !== "\n") continue;
    const at = i + 1;
    if (newline === -1) newline = at;
    if (blank === -1 && i > 0 && text[i - 1] === "\n") blank = at;
    if (heading === -1 && HEADING_RE.test(text.slice(at, at + 8))) {
      heading = at;
      break;
    }
  }
  if (heading !== -1) return heading;
  if (blank !== -1) return blank;
  if (newline !== -1) return newline;
  return limit;
}

/** 1-based line number of a character offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
