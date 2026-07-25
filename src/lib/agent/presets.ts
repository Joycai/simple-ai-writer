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
