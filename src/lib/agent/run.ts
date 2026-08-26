/**
 * UI-facing entry point for one-off agent tasks (the lore modals).
 *
 * Replaces lib/lore/aiTask's `streamLoreTask`: same call shape — resolve model
 * → build messages → stream accumulated text back — but the request now runs
 * through the unified agent runtime, so a preset with tools lets the model
 * consult other lore before answering, and every run reports AgentEvents for
 * the execution log. Presets with `tools: []` behave exactly like the old
 * single-shot streaming.
 */

import { connOptions, type AiConn } from "../ai/conn";
import type { ContentPart, StreamMessage } from "../ai/types";
import type { LoreIndex } from "../lore";
import type { AgentEvent } from "./events";
import type { TaskPreset } from "./presets";
import type { ToolContext } from "./registry";
import { runAgent } from "./runtime";

export interface LoreAgentTaskArgs extends AiConn {
  preset: TaskPreset;
  systemPrompt: string;
  userContent: string | ContentPart[];
  /** Project context for the preset's tools (ignored for tools: []). */
  projectPath: string;
  loreIndex: LoreIndex;
  /** Extra top-level request fields (JSON mode etc.) — single-shot presets only. */
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * 取材范围（见 lib/lore/collections）。这些模态也要认围栏：一次「改进条目」
   * 若把别的集合的材料织进本条，正是集合要解决的那个串味问题。
   */
  loreScope?: string | null;
  /** Called on every text chunk with the full accumulated text so far. */
  onText: (accumulated: string) => void;
  /** Structured progress for an execution-log display. */
  onEvent?: (event: AgentEvent) => void;
}

/** Run one agent task and resolve with the full accumulated text. */
export async function runLoreAgentTask(args: LoreAgentTaskArgs): Promise<string> {
  const messages: StreamMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userContent },
  ];
  const toolContext: ToolContext = {
    projectPath: args.projectPath,
    loreIndex: args.loreIndex,
    loreScope: args.loreScope,
    multimodal: args.model.type === "multimodal",
  };

  let accumulated = "";
  await runAgent({
    ...connOptions(args),
    extraBody: args.extraBody,
    preset: args.preset,
    messages,
    toolContext,
    signal: args.signal ?? new AbortController().signal,
    onEvent: args.onEvent ?? (() => {}),
    onOutputText: (text) => {
      accumulated = text;
      args.onText(accumulated);
    },
  });
  return accumulated;
}
