/**
 * 状态记忆（SKILL.state 模式）—— 纯逻辑的一半：执行状态的 schema、校验、渲染。
 *
 * 出处：Badhe / Tiwari / Chung, *SKILL.state: Scalable Long-Horizon Agent
 * Skills*（arXiv:2608.26263，EMNLP 2026）。论文把「只追加的对话历史」换成一份
 * **显式的、可变的执行状态** Σ：每一步模型只收到 [不变的技能说明, 当前结构化
 * 状态, 最新观察]，产出一份状态更新；更新由**运行时**按 schema 校验（字段类型、
 * 键成员）后提交或回滚，中间推理当场丢弃。于是每步的提示词是 O(1)、T 步累计
 * O(T)，而不是 O(T²)。设计与本项目的映射：docs/feature/agent/skill-state-memory-plan.md。
 *
 * 这个模块只负责三件事，全部纯函数：
 *
 *   1. **schema**（{@link SKILL_STATE_SCHEMA}）——既是发给模型的输出工具参数，也是
 *      校验的依据。字段是为写作协作者挑的：目标 / 作者定下的 / 查明的事实 /
 *      进展 / 涉及文件 / 待决 / 上一轮结果。
 *   2. **校验**（{@link validateSkillState}）——形状错就拒（模型会拿到错误重试一次），
 *      长度超就**裁**而不是拒：一条 230 字的事实不该让整轮状态作废，裁到上限
 *      是确定性的、模型下一轮看得见。裁剪同时也是「状态有上界」这条不变量的
 *      实现：有上界，每轮的提示词才是 O(1)。
 *   3. **渲染**（{@link renderStateBlock}）——进 wire 的那条消息。JSON 原样放进
 *      代码栏，外加一句说明字段含义、以及「细节用工具重读」。模型读到的和它
 *      上一轮写出的是同一份东西，不经过第二次改写。
 *
 * 全量替换而不是 patch：论文的运行时是「把 patch 应用到 Σ 再校验」。这里让
 * 模型每轮重发整份状态——状态本身有上界（≈ 1.5k token），重发的代价很小，而
 * patch 在小模型上最常见的失败是**打错目标**（改了一条不存在的 facts[7]），
 * 全量输出把这一类错误整个消掉，校验也只剩「这一份合不合 schema」一个问题。
 */

import type { ToolDefinition } from "../ai/types";

// ── 上界 ─────────────────────────────────────────────────────────────────────

/** 状态里每个列表的条数上限与每条的字符上限。合起来就是状态的大小上界。 */
export const STATE_CAPS = {
  goal: 300,
  decisions: { items: 12, chars: 200 },
  facts: { items: 20, chars: 240 },
  progress: { items: 12, chars: 140 },
  files: { items: 10, path: 200, note: 160 },
  open: { items: 8, chars: 200 },
  last: 400,
} as const;

/**
 * 状态模式下逐字保留的最近轮数。论文里是「最新观察」一份；这里保**上一轮**
 * 一整轮（问 + 答 + 工具往返），因为写作对话里下一句常常是「第二段再短点」——
 * 指的是助手刚写出来的那段原文，而 `last` 字段只装得下一句话的结果。
 */
export const STATE_KEEP_TURNS = 1;

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type StepStatus = "todo" | "doing" | "done";

export interface StateStep {
  step: string;
  status: StepStatus;
}

export interface StateFile {
  path: string;
  note: string;
}

/** 执行状态 Σ。字段全部必填——「没有」就是空串 / 空数组，不是缺席。 */
export interface SkillState {
  /** 作者当前在做什么，一句话。 */
  goal: string;
  /** 作者定下的：约束、口味、已拍板的选择。 */
  decisions: string[];
  /** 已查明的事实，带来源（文件路径 / 条目名）。 */
  facts: string[];
  /** 进行中的工作的步骤清单。 */
  progress: StateStep[];
  /** 涉及的文件（含笔记路径）与它们的状态。 */
  files: StateFile[];
  /** 悬而未决：等作者回答的、还没查清的。 */
  open: string[];
  /** 上一轮做了什么、结果如何，一句话。 */
  last: string;
}

export function emptySkillState(): SkillState {
  return { goal: "", decisions: [], facts: [], progress: [], files: [], open: [], last: "" };
}

// ── schema ───────────────────────────────────────────────────────────────────

const STEP_STATUSES: readonly StepStatus[] = ["todo", "doing", "done"];

/**
 * 发给模型的输出 schema（`runStructuredTask` 的伪工具参数）。描述用中文——它
 * 是给模型看的字段说明，随 `ai.instructions.stateUpdate` 的语言走会更好，但
 * schema 是常量而指令是 i18n 键；两处都写清楚含义，模型看哪一份都够。
 */
export const SKILL_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    goal: { type: "string", description: "作者当前在做什么，一句话" },
    decisions: {
      type: "array", items: { type: "string" },
      description: "作者定下的：约束、口味、已拍板的选择。每条一句话",
    },
    facts: {
      type: "array", items: { type: "string" },
      description: "已查明的事实，带来源（文件路径 / 条目名）。每条一句话",
    },
    progress: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "string" },
          status: { type: "string", enum: [...STEP_STATUSES] },
        },
        required: ["step", "status"],
      },
      description: "进行中的工作的步骤清单",
    },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, note: { type: "string" } },
        required: ["path", "note"],
      },
      description: "涉及的文件（含 .ai-writer/tasks/.../notes/ 下的笔记）与各自的状态",
    },
    open: {
      type: "array", items: { type: "string" },
      description: "悬而未决：等作者回答的、还没查清的",
    },
    last: { type: "string", description: "上一轮做了什么、结果如何，一句话" },
  },
  required: ["goal", "decisions", "facts", "progress", "files", "open", "last"],
};

export const STATE_UPDATE_TOOL_NAME = "update_state";

export function stateUpdateTool(description: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name: STATE_UPDATE_TOOL_NAME,
      description,
      parameters: SKILL_STATE_SCHEMA,
    },
  };
}

// ── 校验 ─────────────────────────────────────────────────────────────────────

export type StateValidation =
  | { ok: true; state: SkillState; clipped: boolean }
  | { ok: false; error: string };

function clipText(s: string, max: number, note: { clipped: boolean }): string {
  const t = s.trim();
  if (t.length <= max) return t;
  note.clipped = true;
  return t.slice(0, max - 1) + "…";
}

function stringList(
  raw: unknown, field: string, cap: { items: number; chars: number }, note: { clipped: boolean },
): string[] | string {
  if (!Array.isArray(raw)) return `${field} must be an array of strings`;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return `${field} must contain only strings`;
    const t = clipText(item, cap.chars, note);
    if (t) out.push(t);
  }
  if (out.length > cap.items) {
    note.clipped = true;
    // 保**后面**的：模型按时间顺序追加，最新的事实在尾部，而一条已过时的旧事实
    // 丢了代价最小——它要是还重要，下一轮的对话会再把它带回来。
    return out.slice(out.length - cap.items);
  }
  return out;
}

/**
 * 把模型交回的东西校验成一份 {@link SkillState}。
 *
 * 拒绝的只有**形状**错误——不是对象、字段类型不对、status 不在枚举里；这些是
 * 模型能读懂并改正的错误，调用方会带着错误文本重试一次。多出来的键静默丢弃
 * （论文的「键成员检查」——这里选丢弃而不是拒绝，因为多一个键不会让状态变
 * 错，而一次拒绝就是一次多付的请求）。缺席的列表当空数组，缺席的字符串当空
 * 串：strict json_schema 之外的模型常把空列表整个省掉。
 */
export function validateSkillState(raw: unknown): StateValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "state must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;
  const note = { clipped: false };

  const str = (field: "goal" | "last", max: number): string | { error: string } => {
    const v = r[field];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") return { error: `${field} must be a string` };
    return clipText(v, max, note);
  };
  const goal = str("goal", STATE_CAPS.goal);
  if (typeof goal !== "string") return { ok: false, error: goal.error };
  const last = str("last", STATE_CAPS.last);
  if (typeof last !== "string") return { ok: false, error: last.error };

  const decisions = stringList(r.decisions ?? [], "decisions", STATE_CAPS.decisions, note);
  if (typeof decisions === "string") return { ok: false, error: decisions };
  const facts = stringList(r.facts ?? [], "facts", STATE_CAPS.facts, note);
  if (typeof facts === "string") return { ok: false, error: facts };
  const open = stringList(r.open ?? [], "open", STATE_CAPS.open, note);
  if (typeof open === "string") return { ok: false, error: open };

  const rawProgress = r.progress ?? [];
  if (!Array.isArray(rawProgress)) return { ok: false, error: "progress must be an array" };
  const progress: StateStep[] = [];
  for (const item of rawProgress) {
    if (!item || typeof item !== "object") return { ok: false, error: "progress items must be objects" };
    const { step, status } = item as Record<string, unknown>;
    if (typeof step !== "string") return { ok: false, error: "progress[].step must be a string" };
    if (typeof status !== "string" || !STEP_STATUSES.includes(status as StepStatus)) {
      return { ok: false, error: `progress[].status must be one of ${STEP_STATUSES.join("/")}` };
    }
    const text = clipText(step, STATE_CAPS.progress.chars, note);
    if (text) progress.push({ step: text, status: status as StepStatus });
  }
  if (progress.length > STATE_CAPS.progress.items) {
    note.clipped = true;
    // 步骤保**前面**的——清单是有序的，尾部是还没开始的远期项。
    progress.length = STATE_CAPS.progress.items;
  }

  const rawFiles = r.files ?? [];
  if (!Array.isArray(rawFiles)) return { ok: false, error: "files must be an array" };
  const files: StateFile[] = [];
  for (const item of rawFiles) {
    if (!item || typeof item !== "object") return { ok: false, error: "files items must be objects" };
    const { path, note: fileNote } = item as Record<string, unknown>;
    if (typeof path !== "string") return { ok: false, error: "files[].path must be a string" };
    if (fileNote !== undefined && fileNote !== null && typeof fileNote !== "string") {
      return { ok: false, error: "files[].note must be a string" };
    }
    const p = clipText(path, STATE_CAPS.files.path, note);
    if (p) files.push({ path: p, note: clipText((fileNote as string | undefined) ?? "", STATE_CAPS.files.note, note) });
  }
  if (files.length > STATE_CAPS.files.items) {
    note.clipped = true;
    files.splice(0, files.length - STATE_CAPS.files.items);
  }

  return {
    ok: true,
    clipped: note.clipped,
    state: { goal, decisions, facts, progress, files, open, last },
  };
}

/** 解析 + 校验一步到位——`runStructuredTask` 交回的是字符串。 */
export function parseSkillState(json: string): StateValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  return validateSkillState(raw);
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────

/** 状态的 JSON 文本——发给更新器当「当前状态」、也是 wire 块里的正文。 */
export function stateJson(state: SkillState): string {
  return JSON.stringify(state, null, 1);
}

/**
 * 进 wire 的整条消息：`lead`（i18n 的说明句，讲字段含义和「细节用工具重读」）
 * + JSON 代码栏。调用方拿它当 `buildCompactedHistory` 的 summary 内容，所以它
 * 落在 system 之后、对话之前——和历史摘要同一个位置，稳定前缀因此最大。
 */
export function renderStateBlock(lead: string, state: SkillState): string {
  return `${lead}\n\`\`\`json\n${stateJson(state)}\n\`\`\``;
}

/** 状态为空（刚开、或模型什么都没记）——渲染前的判断，空状态不值得占一条消息。 */
export function isEmptyState(state: SkillState): boolean {
  return !state.goal && !state.last && state.decisions.length === 0 && state.facts.length === 0
    && state.progress.length === 0 && state.files.length === 0 && state.open.length === 0;
}
