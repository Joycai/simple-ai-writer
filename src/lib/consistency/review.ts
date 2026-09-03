/**
 * 一致性检查 — the run: ① 取材（纯代码）② 核对（N 个完整的 agent 运行，并行）③ 合并。
 *
 * The checker is the assistant's loop, one thing short: `CONSISTENCY_PRESET` is
 * the read tier plus the two collectors and no write tool. Same `runAgent`,
 * same `routeTools` (subagents ride along on the author's settings and chips),
 * same lazily-created task workspace, same execution log. What the model plans
 * is *inside* a window — which entries to read, what to search, whether to
 * delegate; **windowing itself is code's**, because "the whole document was
 * read" is a guarantee of the check, not a plan the model gets to make
 * (docs/feature/consistency-review-plan.md §3 — the measured reasons).
 *
 * N = 1 is the common case and then this is one autonomous run whose events
 * land on the log directly. N > 1 wraps each window as a `check_window` tool
 * step on a synthetic parent run, with the window's own events nested under
 * it — the same seam `delegate` / `run_pack` use, so the log needs no new band.
 */

import { connOptions, type AiConn } from "../ai/conn";
import { extractJsonObject } from "../ai/json";
import type { Model } from "../ai/configDb";
import type { StreamMessage } from "../ai/types";
import type { AgentEvent } from "../agent/events";
import { CONSISTENCY_PRESET } from "../agent/presets";
import type { ToolContext } from "../agent/registry";
import { routeTools } from "../agent/routing";
import { runAgent } from "../agent/runtime";
import type { SubAgentConfig, SubAgentKind } from "../agent/subagent";
import { createTaskWorkspace } from "../agent/taskWorkspace";
import { messageCeilingForTools } from "../agent/toolCost";
import { contributingEntities, selectLore } from "../context/loreSelect";
import type { DocMemory } from "../context/memory";
import type { LoreIndex, LoreScope } from "../lore";
import { REVIEW_CONCURRENCY, WINDOW_TAIL_CHARS, type DocWindow, type ReviewPlan } from "./budget";
import type { WindowResult } from "./merge";
import type { ConsistencyIssue, ConsistencyPass, WindowOutcome } from "./model";
import { createReviewSink, reportIssueTool, reportPassTool } from "./reviewTools";
import { scopeForRun, type ReviewScope } from "./scope";

/** The synthetic step name each window rides under when N > 1. */
export const CHECK_WINDOW_STEP = "check_window";

const SYSTEM_PROMPT = [
  "You are a continuity editor for a long-form writing project.",
  "You are given one segment of a document, the knowledge-base entries that match it,",
  "and a recap of what comes before it. Find places where the segment contradicts",
  "that established material, and record what you verified.",
  "",
  "How to work:",
  "- Verify before you record. If an entry in the material is only listed by title, read it with read_lore_entity.",
  "  If a claim depends on earlier text, search_text / read_file the earlier document. Guesses are not findings.",
  "- Record EVERY finding with report_issue, one call per finding, as soon as it is verified. Record each fact",
  "  you checked and found consistent with report_pass. Never list findings in prose instead of calling the tools.",
  "- `quote` must be copied character-for-character from the segment and occur exactly once in it.",
  "  Prefer short quotes: one clause is easier to locate and safer to replace than a paragraph.",
  "- Report only what the material actually establishes. If the knowledge base is silent, it is not a conflict.",
  "- A deliberate-looking change (a character's mood, a nickname dropped once) is a warning, not a conflict.",
  "- Suggest a replacement only when a single local edit genuinely fixes the problem.",
  "- Style, pacing and word choice are not your business. Only facts, names, numbers and ordering.",
  "- When you are done, answer with one or two sentences summarising this segment — in the language the text is written in.",
].join("\n");

export interface ReviewRunArgs {
  conn: AiConn;
  projectPath: string;
  documentText: string;
  /** Project-relative path of the document, for the 【当前文档】 line the tools can act on. */
  documentRelPath: string | null;
  documentTitle: string;
  loreIndex: LoreIndex;
  /** The author's global 取材范围 — what the `all` scope follows. */
  fence: LoreScope;
  /** Already resolved: no stale items (lib/consistency/scope). */
  scope: ReviewScope;
  focus: string;
  categoryIds: readonly string[];
  memory: DocMemory | null;
  plan: ReviewPlan;
  windows: DocWindow[];
  subAgents: Record<SubAgentKind, SubAgentConfig>;
  models: Model[];
  contextUtilization: number;
  resolveSubAgent: ToolContext["resolveSubAgent"];
  /** The retrieval subagent's expansion of `focus` into knowledge-base terms; absent = none. */
  expandFocus?: (intent: string, signal: AbortSignal) => Promise<string[]>;
  signal: AbortSignal;
  runId: string;
  onEvent: (event: AgentEvent) => void;
  /** Every status change of a window, including the initial pending ones. */
  onWindow: (outcome: WindowOutcome) => void;
  onIssue: (issue: ConsistencyIssue) => void;
  onPass: (pass: ConsistencyPass) => void;
  concurrency?: number;
}

export interface ReviewRunResult {
  results: WindowResult[];
  /** What the retrieval subagent added to the match target, for the report head. */
  focusTerms: string[];
}

const isAbort = (e: unknown): boolean => (e as Error)?.name === "AbortError";

function pending(w: DocWindow): WindowOutcome {
  return {
    index: w.index, from: w.from, to: w.to, status: "pending",
    recorded: 0, rounds: 0, inputTokens: 0, outputTokens: 0, summary: "",
  };
}

/**
 * Run the check. Resolves with one result per window — failed and aborted
 * windows included, each saying so — and never throws for a window's own
 * error; only a top-level abort propagates as an AbortError.
 */
export async function runConsistencyReview(args: ReviewRunArgs): Promise<ReviewRunResult> {
  const { windows } = args;
  const nested = windows.length > 1;

  for (const w of windows) args.onWindow(pending(w));

  // ① 取材 — the retrieval layer's term expansion runs once, before any window.
  let focusTerms: string[] = [];
  if (args.focus.trim() && args.expandFocus) {
    try {
      focusTerms = await args.expandFocus(args.focus, args.signal);
    } catch {
      focusTerms = [];
    }
    if (args.signal.aborted) throw new DOMException("Aborted", "AbortError");
  }

  if (nested) {
    args.onEvent({
      kind: "run-start",
      task: "consistency",
      modelName: args.conn.model.name || args.conn.model.modelId,
      agentic: true,
      at: Date.now(),
    });
    args.onEvent({ kind: "round-start", round: 1, maxRounds: 1, estInputTokens: 0, toolTokens: 0, at: Date.now() });
  }

  // ② 核对 — a small worker pool; windows have no data dependency on each
  // other (the previous window's *text* is the tail carried forward, not its
  // result), so they genuinely run side by side.
  const results: WindowResult[] = new Array(windows.length);
  const queue = windows.map((w) => w.index);
  const workers = Array.from(
    { length: Math.max(1, Math.min(args.concurrency ?? REVIEW_CONCURRENCY, windows.length)) },
    async () => {
      while (queue.length > 0) {
        if (args.signal.aborted) return;
        const index = queue.shift()!;
        results[index] = await runWindow(args, windows[index], focusTerms, nested);
      }
    },
  );
  await Promise.all(workers);

  // A window never reached (the author stopped first) still needs an outcome.
  for (const w of windows) {
    if (!results[w.index]) {
      const outcome: WindowOutcome = { ...pending(w), status: "aborted" };
      args.onWindow(outcome);
      results[w.index] = { outcome, issues: [], passed: [] };
    }
  }

  if (nested) {
    const inputTokens = results.reduce((n, r) => n + r.outcome.inputTokens, 0);
    const outputTokens = results.reduce((n, r) => n + r.outcome.outputTokens, 0);
    args.onEvent({ kind: "run-done", inputTokens, outputTokens, at: Date.now() });
  }

  return { results, focusTerms };
}

/** Cut the recap to the plan's budget from the *end* — the latest segments are the ones a window needs. */
function recapText(memory: DocMemory | null, upTo: number, maxChars: number): string {
  if (!memory || maxChars <= 0) return "";
  // Only the segments that end before this window: a recap of the text being
  // checked would hand the model its own answer.
  const text = memory.segments
    .filter((s) => s.to <= upTo)
    .map((s) => s.summary)
    .join("\n")
    .trim();
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

async function runWindow(
  args: ReviewRunArgs,
  window: DocWindow,
  focusTerms: string[],
  nested: boolean,
): Promise<WindowResult> {
  const stepId = `${args.runId}-window-${window.index}`;
  const outcome: WindowOutcome = { ...pending(window), status: "running" };
  args.onWindow(outcome);

  // Each window's events sit under its own step when there are several
  // windows; the single-window run *is* the run, and writes to the log directly.
  const onEvent = nested
    ? (e: AgentEvent) => args.onEvent({ ...e, parentStep: stepId })
    : args.onEvent;
  const stepArgs = JSON.stringify({
    window: window.index + 1,
    of: args.windows.length,
    task: `${window.from + 1}–${window.to}`,
  });
  if (nested) {
    args.onEvent({
      kind: "tool-step",
      step: { round: 1, toolCallId: stepId, name: CHECK_WINDOW_STEP, argumentSummary: stepArgs, status: "running" },
      at: Date.now(),
    });
  }

  const settle = (status: WindowOutcome["status"], patch: Partial<WindowOutcome> = {}): WindowOutcome => {
    Object.assign(outcome, patch, { status });
    args.onWindow({ ...outcome });
    if (nested) {
      args.onEvent({
        kind: "tool-step",
        step: {
          round: 1, toolCallId: stepId, name: CHECK_WINDOW_STEP, argumentSummary: stepArgs,
          status: status === "done" ? "done" : "error",
          resultSummary: status === "done"
            ? `${outcome.recorded} recorded · ${outcome.rounds} rounds${outcome.summary ? ` · ${outcome.summary}` : ""}`
            : outcome.error ?? status,
        },
        at: Date.now(),
      });
    }
    return { ...outcome };
  };

  const { loreScope, pinPaths, autoDiscovery, allowedDirs } = scopeForRun(args.scope, args.fence);
  const sink = createReviewSink({
    windowIndex: window.index,
    windowFrom: window.from,
    windowText: window.text,
    docText: args.documentText,
    loreIndex: args.loreIndex,
    categoryIds: args.categoryIds,
    allowedDirs,
    runId: args.runId,
    onChange: (s, change) => {
      outcome.recorded = s.issues.length + s.passed.length;
      if (change.kind === "issue") args.onIssue(change.issue);
      else args.onPass(change.pass);
      args.onWindow({ ...outcome });
    },
  });

  try {
    // 取材 for this window: its own text (plus the focus and its expansion) is
    // the match target, so each window gets the entries *it* mentions rather
    // than one oversized block shared by all. Entries mode matches nothing —
    // the pins are the whole yardstick — and pins always pass the fence.
    const matchTarget = autoDiscovery
      ? [window.text, args.focus, ...focusTerms].filter(Boolean).join("\n")
      : "";
    const lore = await selectLore(matchTarget, args.loreIndex, pinPaths, args.plan.loreBudgetChars, {
      scope: loreScope,
    });
    if (args.signal.aborted) throw new DOMException("Aborted", "AbortError");

    const recap = recapText(args.memory, window.from, args.plan.recapChars);
    const tail = window.index > 0
      ? args.documentText.slice(Math.max(0, window.from - WINDOW_TAIL_CHARS), window.from)
      : "";
    const many = args.windows.length > 1;
    const listedOnly = lore.report.entities.filter((e) => !contributingEntities(lore.report).includes(e));

    const blocks: string[] = [
      [
        many
          ? `【${args.documentTitle} · 第 ${window.index + 1}/${args.windows.length} 段】`
          : `【${args.documentTitle}】`,
        args.documentRelPath
          ? `(file: ${args.documentRelPath}; this segment is characters ${window.from + 1}–${window.to})`
          : "",
        window.text || "(empty)",
      ].filter(Boolean).join("\n"),
    ];
    if (tail || recap) {
      blocks.push(["【前文提要 · BEFORE THIS SEGMENT】", recap, tail ? `…${tail}` : ""].filter(Boolean).join("\n"));
    }
    blocks.push(
      [
        "【知识库 · KNOWLEDGE BASE】",
        lore.text.trim()
          || (autoDiscovery
            ? "(no matching entries — use list_lore_entities / read_lore_entity to look things up)"
            : "(nothing pinned)"),
        listedOnly.length > 0
          ? `(listed by title only, read with read_lore_entity when needed: ${listedOnly.map((e) => e.name).join(", ")})`
          : "",
      ].filter(Boolean).join("\n"),
    );
    if (args.focus.trim()) {
      blocks.push(
        `【核对重点 · FOCUS】\n${args.focus.trim()}\nReport only findings related to this focus; do not record anything outside it, even if you notice it. Your report_pass labels should be the facts you checked for this focus.`,
      );
    }
    const userText = blocks.join("\n\n");

    onEvent({
      kind: "context-seeded",
      documentName: args.documentTitle,
      recentChars: window.text.length,
      memoryChars: recap.length + tail.length,
      loreEntities: contributingEntities(lore.report).length,
      loreChars: lore.text.length,
      at: Date.now(),
    });

    const messages: StreamMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ];

    const workspace = createTaskWorkspace(args.projectPath, args.conn.model.id);
    const routed = routeTools(CONSISTENCY_PRESET, args.subAgents, workspace, args.models);
    const preset = { ...CONSISTENCY_PRESET, tools: routed.tools, serverTools: routed.serverTools };

    const toolContext: ToolContext = {
      projectPath: args.projectPath,
      loreIndex: args.loreIndex,
      loreScope,
      multimodal: args.conn.model.type === "multimodal",
      reviewSink: sink,
      taskWorkspace: workspace,
      resolveSubAgent: args.resolveSubAgent,
      contextUtilization: args.contextUtilization,
    };

    let finalText = "";
    const run = await runAgent({
      ...connOptions(args.conn),
      inputCeilingTokens: messageCeilingForTools(args.conn.model.contextSize, args.contextUtilization, routed.tools),
      preset,
      messages,
      toolContext,
      signal: args.signal,
      onEvent,
      onOutputText: (text) => { finalText = text; },
    });

    // The cheap fallback (§6.4): a model that wrote its list in prose instead
    // of calling the collectors. One parse, no second request; anything that
    // does not validate against the segment is dropped like a bad tool call.
    if (sink.issues.length === 0 && sink.passed.length === 0 && finalText.trim()) {
      await salvageJson(finalText, toolContext);
    }

    const empty = sink.issues.length === 0 && sink.passed.length === 0;
    return {
      outcome: settle("done", {
        recorded: sink.issues.length + sink.passed.length,
        rounds: run.rounds,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        summary: empty ? "" : finalText.trim().slice(0, 400),
        empty,
      }),
      issues: [...sink.issues],
      passed: [...sink.passed],
    };
  } catch (e) {
    if (isAbort(e) || args.signal.aborted) {
      return {
        outcome: settle("aborted", { recorded: sink.issues.length + sink.passed.length }),
        issues: [...sink.issues],
        passed: [...sink.passed],
      };
    }
    return {
      outcome: settle("failed", {
        recorded: sink.issues.length + sink.passed.length,
        error: e instanceof Error ? e.message : String(e),
      }),
      issues: [...sink.issues],
      passed: [...sink.passed],
    };
  }
}

/** Feed a prose-embedded `{issues, passed}` object through the same validation the tools apply. */
async function salvageJson(text: string, ctx: ToolContext): Promise<void> {
  let parsed: { issues?: unknown; passed?: unknown };
  try {
    parsed = JSON.parse(extractJsonObject(text)) as { issues?: unknown; passed?: unknown };
  } catch {
    return;
  }
  const tag = (i: number) => `salvage-${i}`;
  if (Array.isArray(parsed.issues)) {
    for (const [i, raw] of parsed.issues.entries()) {
      if (raw && typeof raw === "object") await reportIssueTool(tag(i), raw as Record<string, unknown>, ctx);
    }
  }
  if (Array.isArray(parsed.passed)) {
    for (const [i, raw] of parsed.passed.entries()) {
      if (typeof raw === "string") await reportPassTool(tag(i), { label: raw }, ctx);
      else if (raw && typeof raw === "object") await reportPassTool(tag(i), raw as Record<string, unknown>, ctx);
    }
  }
}
