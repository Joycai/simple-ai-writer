/**
 * 合并各段的收集结果成一份报告。纯函数。
 *
 * 跨段去重：同一句引文只留段号最小的（段与段不重叠，重复只会来自模型把上一段
 * 尾巴——那是作为**前文提要**给它的——当成本段原文抄了一遍）；同一条目、同一标题
 * 而引文不同的**保留**（两处都错是两条）。通过项按「标签 + 条目」去重。
 *
 * 定位不在这里做：`anchor` 已经是绝对偏移（sink 记的时候就加了段的偏移），而真正
 * 的定位每次渲染时对着活文档重来（`model.locateIssue`）。
 */

import type { ConsistencyIssue, ConsistencyPass, WindowOutcome } from "./model";

export interface WindowResult {
  outcome: WindowOutcome;
  issues: ConsistencyIssue[];
  passed: ConsistencyPass[];
}

function foldQuote(q: string): string {
  return q.replace(/\s+/g, "").replace(/[“”„]/g, '"').replace(/[‘’]/g, "'");
}

export function mergeWindowResults(results: readonly WindowResult[]): {
  issues: ConsistencyIssue[];
  passed: ConsistencyPass[];
  windows: WindowOutcome[];
} {
  const ordered = [...results].sort((a, b) => a.outcome.index - b.outcome.index);

  const seenQuotes = new Set<string>();
  const issues: ConsistencyIssue[] = [];
  for (const r of ordered) {
    for (const issue of r.issues) {
      const key = foldQuote(issue.quote);
      if (seenQuotes.has(key)) continue;
      seenQuotes.add(key);
      issues.push(issue);
    }
  }
  // Document order inside the report — the author reads top to bottom.
  issues.sort((a, b) => (a.anchor?.from ?? 0) - (b.anchor?.from ?? 0));

  const seenPasses = new Set<string>();
  const passed: ConsistencyPass[] = [];
  for (const r of ordered) {
    for (const p of r.passed) {
      const key = `${p.label}\u0000${p.entityDirPath ?? ""}`;
      if (seenPasses.has(key)) continue;
      seenPasses.add(key);
      passed.push(p);
    }
  }

  return { issues, passed, windows: ordered.map((r) => r.outcome) };
}

/**
 * How far the check reached, in chars: the end of the last window that was
 * actually checked, taking failed / aborted / pending ones as gaps. Null when
 * every window was checked through to the document's end.
 */
type CoverageStatus = WindowOutcome["status"] | "unchecked";

interface CoverageSpan {
  from: number;
  to: number;
  status: CoverageStatus;
}

export function coverageOf(windows: readonly WindowOutcome[], docChars: number, uncheckedFrom: number | null): {
  checkedChars: number;
  /** [from, to) spans with a status, in order, plus the cap's tail when any. */
  spans: CoverageSpan[];
} {
  const spans: CoverageSpan[] = windows
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((w) => ({ from: w.from, to: w.to, status: w.status }));
  if (uncheckedFrom !== null && uncheckedFrom < docChars) {
    spans.push({ from: uncheckedFrom, to: docChars, status: "unchecked" });
  }
  const checkedChars = windows
    .filter((w) => w.status === "done")
    .reduce((n, w) => n + (w.to - w.from), 0);
  return { checkedChars, spans };
}
