/**
 * 状态记忆（SKILL.state 模式）—— 不纯的一半：跑更新请求、校验、换入新历史。
 *
 * 和 `compactRun` 是同一个形状（plan → 请求 → 原子换入），刻意复用它底下的
 * `planFold` / `buildCompactedHistory`：状态模式**就是**一次 force 折叠——只留
 * {@link STATE_KEEP_TURNS} 轮、每轮都折、摘要换成一份有 schema 的状态。折叠
 * 的不变量（不切开 tool 配对、注入账本随载体驱逐、种子块首折即弃）一条都
 * 不用重新证明。
 *
 * 失败语义沿用归纳的：更新请求失败、或两次都交不出合 schema 的状态 → 返回
 * null，历史与 meta 原封不动——调用方退回普通的阈值归纳当后备（论文的
 * rollback：状态没提交，Σ 还是上一份）。只有中止会向上抛。
 *
 * 论文里状态更新是主循环的同一次调用产出的；这里拆成**轮与轮之间**的一次
 * 独立结构化请求（`runStructuredTask`，强制 tool_choice + JSON 回退），理由
 * 两条：主循环的 preset 不必多背一份常驻 schema（工具 token 每轮重发，见
 * agent-tool-context.md），而且写作助手一轮里有多次工具往返，「本轮的观察」
 * 只有轮结束后才知道全貌。代价是每轮多一次小请求——输入 = 上一份状态 +
 * 本轮渲染，输出 ≤ 1.5k token。
 */

import i18n from "../../i18n";
import type { ConnOptions } from "../ai/conn";
import { estimateMessagesTokens } from "../ai/tokenEstimate";
import type { StreamMessage } from "../ai/types";
import {
  buildCompactedHistory,
  injectionCarriers,
  planFold,
  renderTurnsForSummary,
  type ChatSessionMeta,
} from "./compact";
import type { CompactOutcome } from "./compactRun";
import {
  parseSkillState,
  renderStateBlock,
  stateJson,
  stateUpdateTool,
  STATE_KEEP_TURNS,
  type SkillState,
} from "./skillState";
import { runStructuredTask } from "./structured";

/** 更新器的输入：上一份状态（或接手时的散文摘要）+ 要折进去的轮次。 */
export interface StateUpdateInput {
  /** 上一份已提交的状态；null = 这次对话还没有过状态。 */
  prevState: SkillState | null;
  /**
   * 普通归纳留下的散文摘要——状态模式在一段已经归纳过的对话里被打开时，它
   * 是唯一记着更早对话的东西，第一份状态要从它里面长出来。
   */
  prevSummary: string | null;
  /** 折叠轮次的渲染文本（`renderTurnsForSummary`）。 */
  rendered: string;
  /** 上一次交回的东西为什么被拒——重试那一次带上，模型才知道改什么。 */
  retryError?: string;
}

/**
 * 每轮的折叠：上一轮之前的全部轮次 → 状态。`update` 交回 JSON 字符串，这里
 * 校验；形状错重试**一次**，再错就放弃这一轮（返回 null）。
 *
 * 只有 `planFold` 说有得折时才发请求：第二轮时只有一轮历史、无可折叠，静默
 * 返回 null，一次请求都不发。
 */
export async function updateSkillState(opts: {
  history: StreamMessage[];
  meta: ChatSessionMeta;
  ceilingTokens: number;
  update: (input: StateUpdateInput) => Promise<string>;
}): Promise<CompactOutcome | null> {
  const { history, meta } = opts;
  const plan = planFold(history, meta, opts.ceilingTokens, {
    force: true, keepTurns: STATE_KEEP_TURNS,
  });
  if (!plan) return null;

  const fromTokens = estimateMessagesTokens(history);
  const base: StateUpdateInput = {
    prevState: meta.state,
    // A prose summary is only "previous" while no state has been committed
    // over it; once one has, summaryText IS the state's JSON (see below).
    prevSummary: meta.state ? null : meta.summaryText,
    rendered: renderTurnsForSummary(plan.fold, injectionCarriers(meta)),
  };

  let state: SkillState | null = null;
  let input = base;
  for (let attempt = 0; attempt < 2 && !state; attempt++) {
    let raw: string;
    try {
      raw = await opts.update(input);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      return null;
    }
    const checked = parseSkillState(raw);
    if (checked.ok) state = checked.state;
    else input = { ...base, retryError: checked.error };
  }
  if (!state) return null;

  const block = renderStateBlock(i18n.t("ai.instructions.stateBlock"), state);
  const next = buildCompactedHistory(history, meta, plan, block);
  meta.state = state;
  // summaryText carries the state's JSON so a later *prose* compaction — the
  // Beta switched off mid-conversation — receives it as the existing summary
  // and merges rather than forgets.
  meta.summaryText = stateJson(state);
  return {
    history: next,
    event: {
      kind: "context-compacted",
      mode: "state",
      foldedTurns: plan.fold.length,
      fromTokens,
      toTokens: estimateMessagesTokens(next),
      summary: stateJson(state),
      at: Date.now(),
    },
  };
}

/**
 * 真正的更新请求：会话自己的模型上跑一次 `runStructuredTask`。和
 * `summarizeForCompaction` 一样与流程分开，测试注入假的、将来可换专用模型。
 */
export async function requestStateUpdate(
  config: ConnOptions,
  input: StateUpdateInput,
  signal: AbortSignal,
): Promise<string> {
  const parts: string[] = [];
  if (input.prevState) {
    parts.push(`${i18n.t("ai.instructions.stateUpdatePrev")}\n${stateJson(input.prevState)}`);
  } else if (input.prevSummary) {
    parts.push(`${i18n.t("ai.instructions.stateUpdatePrevSummary")}\n${input.prevSummary}`);
  }
  parts.push(`${i18n.t("ai.instructions.stateUpdateFold")}\n${input.rendered}`);
  if (input.retryError) {
    parts.push(i18n.t("ai.instructions.stateUpdateRetry", { error: input.retryError }));
  }
  return runStructuredTask({
    ...config,
    systemPrompt: i18n.t("ai.instructions.stateUpdate"),
    toolInstruction: i18n.t("ai.instructions.stateUpdateTool"),
    jsonInstruction: i18n.t("ai.instructions.stateUpdateJson"),
    outputTool: stateUpdateTool(i18n.t("ai.instructions.stateUpdateToolDesc")),
    userContent: parts.join("\n\n"),
    signal,
  });
}
