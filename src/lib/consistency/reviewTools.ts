/**
 * 一致性检查的收集器工具 —— `report_issue` / `report_pass`。
 *
 * 照 `agent/splitTools.ts` 的先例：**不写盘，只往 sink 里追加**。存在的理由同样是
 * 传输——一条发现一次调用，参数由端点按 schema 解码，输出上限只能砍掉一条而不是
 * 整份报告；而且已经记进 sink 的发现在轮数到顶、作者中止时一条都不丢。
 *
 * handler 做三件从前留到渲染时才做的事（docs/feature/consistency-review-plan.md §6.2）：
 *
 *   · `quote` 在**本段**原文里逐字出现且**恰好一次** —— 不然退回给模型改。
 *     渲染时才发现就只剩「找不到」；这里发现模型现在就能重抄。
 *   · `entity` 解析到索引里的一条（名字 / 别名）—— 「更新条目」要落到真目录上。
 *   · entries 档：`entity` ∈ pins，否则不入 sink —— §4 的归属规则，结构性地执行。
 *
 * `editApply.ts`「find 的出现次数变了就拒写」是同一条哲学：把校验放在它能被纠正
 * 的那一刻。
 */

import type { LoreEntity, LoreIndex } from "../lore";
import type { ToolContext } from "../agent/registry";
import type { ToolCall, ToolResult } from "../agent/tools";
import { lineOf } from "./budget";
import { locateQuote, type ConsistencyIssue, type ConsistencyPass, type IssueSeverity } from "./model";

export interface ReviewSink {
  /** Which window of the document this sink collects for (0-based). */
  windowIndex: number;
  /** The window's offset in the whole document — anchors are absolute. */
  windowFrom: number;
  windowText: string;
  /** The whole document, for line numbers. */
  docText: string;
  loreIndex: LoreIndex;
  /** Category ids the active profile knows; anything else lands on `timeline`. */
  categoryIds: readonly string[];
  /** Entries mode: the only entities findings may be about. Null = anyone. */
  allowedDirs: ReadonlySet<string> | null;
  /** Prefix for issue ids, unique per run. */
  runId: string;
  issues: ConsistencyIssue[];
  passed: ConsistencyPass[];
  /** Fired after every accepted call, for the live findings stream. */
  onChange?: (sink: ReviewSink, change: { kind: "issue"; issue: ConsistencyIssue } | { kind: "pass"; pass: ConsistencyPass }) => void;
}

export function createReviewSink(init: Omit<ReviewSink, "issues" | "passed">): ReviewSink {
  return { ...init, issues: [], passed: [] };
}

const NO_SINK =
  "Error: this run cannot record findings (no sink). Do not call report_issue / report_pass here.";

const TIMELINE = "timeline";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Name / alias lookup, case-insensitive. Local so the sink stays testable without the fs-backed tool module. */
function findEntity(index: LoreIndex, name: string): LoreEntity | undefined {
  const lower = name.toLowerCase();
  for (const entities of Object.values(index)) {
    const hit = (entities ?? []).find(
      (e) => e.name.toLowerCase() === lower || e.aliases?.some((a) => a.toLowerCase() === lower),
    );
    if (hit) return hit;
  }
  return undefined;
}

function allowedNames(sink: ReviewSink): string {
  if (!sink.allowedDirs) return "";
  const names: string[] = [];
  for (const entities of Object.values(sink.loreIndex)) {
    for (const e of entities ?? []) if (sink.allowedDirs.has(e.dirPath)) names.push(e.name);
  }
  return names.join(", ");
}

function countExact(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    n++;
    at = hay.indexOf(needle, at + 1);
  }
  return n;
}

/** Anchor a quote in the window, or the sentence to send back. */
function anchorQuote(
  sink: ReviewSink,
  quote: string,
): { from: number; to: number; line: number } | { error: string } {
  const range = locateQuote(sink.windowText, quote);
  if (range) {
    const from = sink.windowFrom + range.from;
    return { from, to: sink.windowFrom + range.to, line: lineOf(sink.docText, from) };
  }
  const n = countExact(sink.windowText, quote);
  if (n === 0) {
    return {
      error:
        `Error: 'quote' was not found verbatim in this segment. Copy the span character-for-character from the text you were given — punctuation and quotation marks included — and keep it to one clause. Do not paraphrase.`,
    };
  }
  return {
    error:
      `Error: 'quote' occurs ${n} times in this segment, so it cannot be pointed at. Extend it (a few words before or after) until it is unique, then resend.`,
  };
}

/**
 * Resolve the `entity` argument, or explain. Returns `{}` when none was given.
 */
function resolveEntity(
  sink: ReviewSink,
  raw: string,
): { entityName?: string; entityDirPath?: string } | { error: string } {
  if (!raw) return {};
  const found = findEntity(sink.loreIndex, raw);
  if (!found) {
    return {
      error:
        `Error: no knowledge-base entry is called "${raw}". Use the entry's name exactly as the 【知识库】 material or list_lore_entities gives it, or omit 'entity' for a finding about ordering/continuity.`,
    };
  }
  if (sink.allowedDirs && !sink.allowedDirs.has(found.dirPath)) {
    return {
      error:
        `Error: "${found.name}" is outside this check's scope. Record only findings about: ${allowedNames(sink)}. This one was not recorded.`,
    };
  }
  return { entityName: found.name, entityDirPath: found.dirPath };
}

function severityOf(v: unknown): IssueSeverity {
  return v === "warning" ? "warning" : "conflict";
}

/** report_issue — one inconsistency, verified against the segment before it lands. */
export async function reportIssueTool(
  toolCallId: string,
  args: {
    severity?: unknown;
    category?: unknown;
    title?: unknown;
    quote?: unknown;
    reference?: unknown;
    suggestion?: unknown;
    entity?: unknown;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const sink = ctx.reviewSink;
  if (!sink) return { toolCallId, content: NO_SINK };

  const title = str(args.title);
  const quote = str(args.quote);
  const reference = str(args.reference);
  if (!title || !quote || !reference) {
    return {
      toolCallId,
      content:
        "Error: 'title', 'quote' and 'reference' are all required — a finding with nothing to point at, or nothing it contradicts, is not verifiable.",
    };
  }

  const anchored = anchorQuote(sink, quote);
  if ("error" in anchored) return { toolCallId, content: anchored.error };

  const entity = resolveEntity(sink, str(args.entity));
  if ("error" in entity) return { toolCallId, content: entity.error };

  const rawCategory = str(args.category);
  const category = rawCategory && sink.categoryIds.includes(rawCategory) ? rawCategory : TIMELINE;
  const suggestion = str(args.suggestion);

  const issue: ConsistencyIssue = {
    id: `${sink.runId}-w${sink.windowIndex}-i${sink.issues.length}`,
    severity: severityOf(args.severity),
    category,
    title,
    quote,
    reference,
    suggestion: suggestion && suggestion !== quote ? suggestion : undefined,
    ...entity,
    window: sink.windowIndex,
    anchor: { from: anchored.from, to: anchored.to },
    line: anchored.line,
  };

  // Resending the same quote replaces the earlier record: that is the retry
  // path after a truncated call, and two cards for one passage would be noise.
  const existing = sink.issues.findIndex((i) => i.quote === quote);
  if (existing !== -1) {
    issue.id = sink.issues[existing].id;
    sink.issues[existing] = issue;
  } else {
    sink.issues.push(issue);
  }
  sink.onChange?.(sink, { kind: "issue", issue });

  const sev = issue.severity === "conflict" ? "conflict" : "warning";
  return {
    toolCallId,
    content:
      `Recorded #${sink.issues.length} (${sev} · ${title} · L${anchored.line})${existing !== -1 ? ", replacing the earlier record for this passage" : ""}.` +
      (rawCategory && category === TIMELINE && rawCategory !== TIMELINE
        ? ` Category "${rawCategory}" is not one of this project's; filed under timeline.`
        : ""),
  };
}

/** report_pass — one fact checked and found consistent. */
export async function reportPassTool(
  toolCallId: string,
  args: { label?: unknown; entity?: unknown; quote?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const sink = ctx.reviewSink;
  if (!sink) return { toolCallId, content: NO_SINK };

  const label = str(args.label);
  if (!label) return { toolCallId, content: "Error: 'label' is required — name the fact you verified, e.g. \"林辰阵营\"." };

  const entity = resolveEntity(sink, str(args.entity));
  if ("error" in entity) return { toolCallId, content: entity.error };

  const quote = str(args.quote);
  let line: number | undefined;
  if (quote) {
    const anchored = anchorQuote(sink, quote);
    // A pass's quote is a courtesy anchor, not the record: an unlocatable one
    // drops the line number rather than refusing the pass.
    if (!("error" in anchored)) line = anchored.line;
  }

  const pass: ConsistencyPass = { label, ...entity, window: sink.windowIndex, line };
  const dupe = sink.passed.findIndex(
    (p) => p.label === label && (p.entityDirPath ?? "") === (pass.entityDirPath ?? ""),
  );
  if (dupe !== -1) sink.passed[dupe] = pass;
  else sink.passed.push(pass);
  sink.onChange?.(sink, { kind: "pass", pass });

  return { toolCallId, content: `Recorded pass #${sink.passed.length} (${label}).` };
}

// ─── Registry adapters ────────────────────────────────────────────────────────

export function reportIssueCall(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  return reportIssueTool(call.id, JSON.parse(call.arguments || "{}"), ctx);
}
export function reportPassCall(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  return reportPassTool(call.id, JSON.parse(call.arguments || "{}"), ctx);
}
