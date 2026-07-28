/**
 * Task presets — the per-task configuration the unified agent runtime runs on.
 *
 * Each AI feature is expressed as a preset: which tools the model may call, how
 * many loop rounds it gets, and how the run must end. PR1 keeps presets thin —
 * prompt/seed-context assembly still lives with the callers (aiTaskStore); the
 * migration plan (docs/unified-agent-plan.md §3.3) moves systemPrompt and
 * seedContext in here as the lore-side entry points migrate (PR2/PR3).
 */

import type { ToolId } from "./registry";

/**
 * How a run is allowed to finish:
 *   - "force-text"     — on the final round, tools are withheld and the model is
 *                        instructed to produce text (writing tasks must end in prose)
 *   - "allow-tool-end" — the run may end on a tool round (future write-back
 *                        tasks whose last action *is* the tool call)
 */
export type FinishPolicy = "force-text" | "allow-tool-end";

export interface TaskPreset {
  id: string;
  /** Tools this task may call, resolved through the registry. Empty = plain single-shot. */
  tools: readonly ToolId[];
  /** Cap on model↔tool rounds, preventing unbounded loops. */
  maxRounds: number;
  finishPolicy: FinishPolicy;
}

/** 续写 — the agentic continuation task (reads lore + prior chapters, then writes). */
export const CONTINUE_PRESET: TaskPreset = {
  id: "continue",
  tools: ["list_lore_entities", "read_lore_entity", "list_files", "read_file"],
  maxRounds: 8,
  finishPolicy: "force-text",
};

/** 设定改进 — improve an entity's index.md/facet; may consult other lore first. */
export const LORE_IMPROVE_PRESET: TaskPreset = {
  id: "lore-improve",
  tools: ["list_lore_entities", "read_lore_entity"],
  maxRounds: 4,
  finishPolicy: "force-text",
};

/** 特征助手 — expand/restructure/key a single facet; may consult other lore. */
export const FACET_ASSIST_PRESET: TaskPreset = {
  id: "facet-assist",
  tools: ["list_lore_entities", "read_lore_entity"],
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
};

/** 特征拆解 — verbatim facet split, structured JSON, single-shot (same JSON-mode constraint). */
export const LORE_SPLIT_PRESET: TaskPreset = {
  id: "lore-split",
  tools: [],
  maxRounds: 1,
  finishPolicy: "force-text",
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
 */
export const AGENT_ASSIST_PRESET: TaskPreset = {
  id: "agent-assist",
  tools: [
    "list_lore_entities",
    "read_lore_entity",
    "list_files",
    "read_file",
    "read_memory",
    "propose_lore_plan",
    "create_lore_entity",
    "update_lore_file",
    "update_facet_meta",
    "delete_lore_file",
    "move_lore_entity",
    "delete_lore_entity",
    "update_memory",
    "propose_edit",
  ],
  maxRounds: 20,
  finishPolicy: "force-text",
};
