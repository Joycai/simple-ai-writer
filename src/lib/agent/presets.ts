/**
 * Task presets — the per-task configuration the unified agent runtime runs on.
 *
 * Each AI feature is expressed as a preset: which tools the model may call, how
 * many loop rounds it gets, and how the run must end. PR1 keeps presets thin —
 * prompt/seed-context assembly still lives with the callers (aiTaskStore); the
 * migration plan (docs/feature/agent/unified-agent-plan.md §3.3) moves systemPrompt and
 * seedContext in here as the lore-side entry points migrate (PR2/PR3).
 */

import i18n from "../../i18n";
import type { TaskTools } from "../profile/model";
import type { ToolId } from "./registry";

/**
 * How a run is allowed to finish:
 *   - "force-text"     — on the final round, tools are withheld and the model is
 *                        instructed to produce text (writing tasks must end in prose)
 *   - "allow-tool-end" — the run may end on a tool round (future write-back
 *                        tasks whose last action *is* the tool call)
 *   - "handoff"        — the final round is not written by this model at all: it
 *                        is forced to hand a brief to the writer subagent, whose
 *                        output becomes the run's output. See lib/agent/handoff.
 *
 * `handoff` is never declared on a preset literal. It is applied by `routeTools`
 * when the surface opts in AND a usable writer is bound — which is what makes
 * the settings switch mean something, and what makes turning it off restore
 * today's behaviour exactly (same argument as `scratchpad: "off"`).
 */
export type FinishPolicy = "force-text" | "allow-tool-end" | "handoff";

export interface TaskPreset {
  id: string;
  /** Tools this task may call, resolved through the registry. Empty = plain single-shot. */
  tools: readonly ToolId[];
  /** Cap on model↔tool rounds, preventing unbounded loops. */
  maxRounds: number;
  finishPolicy: FinishPolicy;
  /**
   * Whether this task uses the on-disk workspace (.ai-writer/tasks/).
   *  - "off" (default)  — no scratchpad tools; behavior identical to legacy
   *  - "offered"        — scratchpad tools available, no active checkpoint reminder
   *  - "required"       — scratchpad tools available + active checkpoint nudge before trimming
   */
  scratchpad?: "off" | "offered" | "required";
  /**
   * How this task permits provider/server-side tools (e.g. web_search):
   *  - "final-round-off" (default) — allowed, but withheld on the force-text final round
   *  - "off"                       — never allowed (e.g. structured JSON tasks)
   *  - "always"                    — allowed every round, including the final round (search subagent)
   */
  serverTools?: "final-round-off" | "off" | "always";
}

/** 续写 — the agentic continuation task (reads lore + prior chapters, then writes). */
export const CONTINUE_PRESET: TaskPreset = {
  id: "continue",
  tools: ["list_lore_entities", "read_lore_entity", "read_lore_image", "read_image", "list_files", "read_file", "read_slides", "read_document", "search_text"],
  maxRounds: 8,
  finishPolicy: "force-text",
};

/** 设定改进 — improve an entity's index.md/facet; may consult other lore first. */
export const LORE_IMPROVE_PRESET: TaskPreset = {
  id: "lore-improve",
  tools: ["list_lore_entities", "read_lore_entity", "read_lore_image"],
  maxRounds: 4,
  finishPolicy: "force-text",
};

/** 特征助手 — expand/restructure/key a single facet; may consult other lore. */
export const FACET_ASSIST_PRESET: TaskPreset = {
  id: "facet-assist",
  tools: ["list_lore_entities", "read_lore_entity", "read_lore_image"],
  maxRounds: 4,
  finishPolicy: "force-text",
};

/**
 * 设定提取 — structured-JSON extraction of a new entity. JSON response mode
 * conflicts with tool calling on several providers, so this stays single-shot;
 * tool-based structured output is the PR4/PR5 upgrade path.
 */
export const LORE_GENERATE_PRESET: TaskPreset = {
  id: "lore-generate",
  tools: [],
  maxRounds: 1,
  finishPolicy: "force-text",
  serverTools: "off",
};

/**
 * 特征拆解 — verbatim facet split, submitted one piece at a time.
 *
 * Not single-shot, and deliberately not JSON mode. Asking for the whole split
 * as one JSON object made the model hand-write a multi-thousand-character
 * string full of the author's own quotes and newlines, where one missed escape
 * — or an output cap landing mid-string — threw the entire run away with a
 * parse error. The split_* tools (agent/splitTools.ts) let the endpoint decode
 * the arguments against the schema instead, one facet per call, so the cap can
 * only ever cut one facet short and the runtime hands that back as a retryable
 * error.
 *
 * maxRounds is sized for the shape of the work: one core + one call per facet,
 * plus the closing prose round that carries the author-facing note, plus room
 * for a couple of truncation retries on a long facet. force-text is what ends
 * the run — the last round withholds the tools, so a plan that ran long still
 * arrives at the review list with everything submitted so far.
 */
export const LORE_SPLIT_PRESET: TaskPreset = {
  id: "lore-split",
  tools: ["split_core", "split_facet"],
  maxRounds: 16,
  finishPolicy: "force-text",
  serverTools: "off",
};

/**
 * Agent 模式（自定义任务）+ 对话助手 — the full toolset: read lore/chapters/
 * memory, maintain lore + memory (L1, auto+backup), and propose manuscript
 * edits (L2, blocks on the user's approval card).
 *
 * Lore writes are additionally gated on propose_lore_plan (lib/agent/plan.ts):
 * the author approves one card of steps, and the write tools refuse anything
 * outside it.
 *
 * maxRounds is generous because the headline job here is housekeeping over the
 * *whole* lore folder ("整理一下设定"), which costs one list + one read per
 * entity, then a plan round, before a single write happens. A cap that runs out
 * mid-sweep reads to the author as the agent refusing to act.
 *
 * Raised 20 → 40 once whole-document work became expressible: reformatting a
 * chapter means paging the file in through read_file (4000 chars a call), then
 * rewrite_document, and a long chapter spent most of a 20-round budget just
 * reading. The number is also what one 继续 press on the round-limit card grants
 * (agentStore passes maxRounds as the extension), so it sets the granularity of
 * "keep going" as much as the initial ceiling.
 */
export const AGENT_ASSIST_PRESET: TaskPreset = {
  id: "agent-assist",
  tools: [
    "list_lore_entities",
    "read_lore_entity",
    "read_lore_image",
    "read_image",
    "list_files",
    "read_file",
    "read_slides",
    "read_document",
    "inspect_html",
    "search_text",
    "read_memory",
    "read_workflow",
    "propose_lore_plan",
    "create_lore_entity",
    "create_lore_facet",
    "update_lore_file",
    "update_lore_meta",
    "append_lore_file",
    "edit_lore_file",
    "rewrite_lore_lines",
    "update_facet_meta",
    "delete_lore_file",
    "add_lore_image",
    "update_lore_image",
    "delete_lore_image",
    "manage_collection",
    "file_lore_entries",
    "create_lore_category",
    "set_lore_avatar",
    "copy_lore_file",
    "move_lore_entity",
    "delete_lore_entity",
    "update_memory",
    "propose_edit",
    "rewrite_document",
    "rewrite_lines",
    "insert_lines",
    "append_file",
    "create_chapter",
    "create_file",
    "create_directory",
    "move_chapter",
    "copy_file",
    "delete_chapter",
    "delete_directory",
    "generate_image",
    "edit_image",
    "redraw_lore_image",
    "export_pptx",
    "export_docx",
    "export_xlsx",
    "read_doc_format",
    "task_plan",
    "task_progress",
    "write_note",
    "read_note",
    "list_notes",
  ],
  maxRounds: 40,
  finishPolicy: "force-text",
  scratchpad: "required",
};

/**
 * `write` 档 —— **产出一份文档**的任务：查、写、验、交付，仅此。
 *
 * 为什么它该存在，而不是让 `htmlArtifact` 继续用 `full`：工具 schema 每一轮
 * 原样重发，而 `full` 是 15.3k。一个 32k 的本地模型上，那已经超过整个输入上限
 * （`contextForecast.test.ts` 钉着这条），知识库因此分到零——作者看到的是注入
 * 报告空白，然后去改一份本来没问题的条目。图示/宣传页恰恰是文件最长、轮数最多
 * 的那类任务，也就是最先撞上它的那个。
 *
 * 收窄的依据是**任务真的会调什么**，不是「什么看起来无害」：
 *   - 知识库只读不写。这条任务的指令原文是「必要时查{{kb}}」——查，不改。整套
 *     lore 写工具连同 `propose_lore_plan` 因此不在这里；它们对这条任务只是一条
 *     永远走不到的岔路。
 *   - 没有生图。页面里的图形是内联 SVG，这是这条产品线的前提（见
 *     html-artifact-plan D3），而 `generate_image` 是要花钱的。
 *   - 没有 memory、没有删除、没有 docx/xlsx 导出：产物是 .html，那两个导出吃
 *     的是 markdown。少掉 `export_docx` 也就少掉它随身的格式清单（见
 *     aiTaskStore 的 roster 分支）。
 *   - **留着 `inspect_html`**：这条任务是全应用最需要验证回路的那一个。
 *
 * `maxRounds` 24 而不是 40：一份页面的形状是「读几份材料 → 骨架 → 逐节追加 →
 * 量一遍 → 修」，不是 `full` 那种扫整个 lore 文件夹的活。
 */
export const WRITE_PRESET: TaskPreset = {
  id: "write",
  tools: [
    // 查
    "list_files",
    "read_file",
    "read_slides",
    "read_document",
    "search_text",
    "list_lore_entities",
    "read_lore_entity",
    "read_image",
    "read_workflow",
    // 验
    "inspect_html",
    // 写（L2，逐个过审批卡）
    "create_file",
    "append_file",
    "propose_edit",
    "rewrite_lines",
    "insert_lines",
    "rewrite_document",
    // 交付
    "export_pptx",
  ],
  maxRounds: 24,
  finishPolicy: "force-text",
};

/**
 * 写手子代理的子跑 preset —— 一次运行的**收尾**，不是一个可以被调用的任务。
 *
 * 只读工具，而且是**索引式**的那几个：交接单给的是路径，写手自己去读（材料本来
 * 就在任务工作区的 note 里，让主模型抄一遍花的是它最贵的那半 token）。没有任何
 * 写工具——落盘由运行时组提案、父 surface 审批，见 `handoff.deliverWriterOutput`。
 * 隔离因此是结构性的，不是提示词里的一句话。
 *
 * `serverTools: "off"`：写手是来成文的，不是来查资料的。真需要查，那是主模型在
 * 交接之前该做完的事——`search` 子代理就在它手边。
 *
 * maxRounds 是「读几个 note 再写」的量：真正的一轮是最后那次成文，前面几轮只用来
 * 把交接单点到的东西读进来。
 */
export const WRITER_PRESET: TaskPreset = {
  id: "writer",
  tools: ["read_note", "list_notes", "read_file", "list_lore_entities", "read_lore_entity", "search_text"],
  maxRounds: 6,
  finishPolicy: "force-text",
  serverTools: "off",
};

/**
 * Resolve a profile task's declared tool set to the preset that implements it.
 *
 * This indirection is what lets a profile say `tools: "read"` without naming a
 * preset object: `lib/profile` stays free of any dependency on the agent layer,
 * and a preset can be retuned here without touching a single profile.
 *
 * `none` maps to null rather than to an empty-toolset preset, because a task
 * without tools is a plain completion that never enters the tool loop at all —
 * the null is the caller's signal to take the simple streaming path.
 */
export function presetForTools(tools: TaskTools): TaskPreset | null {
  switch (tools) {
    case "none":
      return null;
    case "read":
      return CONTINUE_PRESET;
    case "write":
      return WRITE_PRESET;
    case "full":
      return AGENT_ASSIST_PRESET;
  }
}

/**
 * The tool briefing a task of this tier needs appended to its **system** layer,
 * or "" when it needs none.
 *
 * A read-tier task's prompt used to say nothing about tools at all: the task
 * instruction covers how to write, and the tool schemas rode on the wire alone,
 * where only a model that infers "these exist, so I should look things up" ever
 * acted on them. Frontier models do infer it. A smaller local one writes
 * straight from whatever RAG happened to inject — measured on gemma4:12b via
 * ollama, 2 of 4 identical 续写 runs called a lore tool and 2 wrote from the
 * seeded context alone, which reads to the author as the agent ignoring the
 * knowledge base at random.
 *
 * Only the read tier gets one. `write` and `full` tasks already carry their own
 * briefing in the *task* layer (`ai.instructions.htmlArtifact`,
 * `ai.instructions.agent`) — a task that declares one of those tiers is one
 * whose instruction is about using the tools — and `none` has nothing to brief:
 * a briefing there would be paid-for tokens describing tools the request never
 * sends.
 *
 * A function of the tier rather than of the task id, for the same reason
 * `presetForTools` is: a pack can declare any number of read-tool tasks and
 * every one of them has the same problem.
 */
export function toolBriefingFor(tools: TaskTools, params: Record<string, string>): string {
  return tools === "read" ? i18n.t("ai.instructions.toolsRead", params) : "";
}
