/**
 * What the agent toolset costs a request, in tokens.
 *
 * The tool schemas ride on **every** round of a run (runtime.ts sends them
 * unchanged each time), and for the assistant preset that is several thousand
 * tokens — more than most of the RAG layers the budget planner agonises over.
 * Yet until this module existed nothing that *planned* a request knew they were
 * there: `fixedContextChars` had no term for them, and `trimHistory` /
 * `planFold` measured messages against a ceiling that silently assumed a
 * toolless request. On a small local window that is the difference between
 * "trimmed to exactly the ceiling" and "several thousand tokens past it".
 *
 * Two numbers, because a run's toolset is not fixed for all time:
 *   - {@link plannedToolTokens} — what the *next* request will carry, for
 *     surfaces that budget before running.
 *   - {@link toolTokensOf} — what a concrete list costs, for the runtime
 *     reporting what it actually sent.
 */

import { estimateToolsTokens } from "../ai/tokenEstimate";
import type { Model } from "../ai/configDb";
import { loreCategoryIds } from "../profile/active";
import { inputCeilingFor } from "../context/budget";
import type { TaskPreset } from "./presets";
import { getToolDefinitions, type ToolId } from "./registry";
import { routePlannedTools } from "./routing";
import type { SubAgentConfig, SubAgentKind } from "./subagent";

/**
 * Memoised per (toolset × active lore categories).
 *
 * `getToolDefinitions` rebuilds every definition on each call — it has to, it
 * patches the active profile's category ids into the schemas — and the context
 * bar asks for this number on every render. The category ids belong in the key
 * for the same reason they are patched in the first place: opening a TTRPG
 * project after a novel changes the schemas, and a cache keyed on tool ids
 * alone would keep serving the novel's measurement.
 */
const cache = new Map<string, number>();

export function toolTokensOf(ids: readonly ToolId[]): number {
  if (ids.length === 0) return 0;
  const key = `${ids.join(",")}|${loreCategoryIds().join(",")}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const tokens = estimateToolsTokens(getToolDefinitions(ids));
  cache.set(key, tokens);
  return tokens;
}

/**
 * Tokens the next request under `preset` will spend on tool schemas.
 *
 * Measured off the *routed* toolset — what the run will actually put on the
 * wire — rather than the raw preset: routing strips the image tools when a
 * vision subagent is live, drops `export_pptx` / `export_docx` when their
 * Beta switches are off, and appends `delegate`. A budget taken from the unrouted preset describes a
 * request nobody sends.
 */
export function plannedToolTokens(
  preset: TaskPreset | null,
  subs: Record<SubAgentKind, SubAgentConfig>,
  models: Model[],
): number {
  if (!preset) return 0;
  return toolTokensOf(routePlannedTools(preset, subs, models).tools);
}

/**
 * The ceiling a run's **messages** must fit under: the input ceiling minus the
 * tool schemas.
 *
 * Every surface that starts a tool run needs this exact subtraction, and each
 * of them writing it out is how the last drift happened — the chat's compaction
 * trigger and its history trimming already disagreed once (see
 * `agent/contextBreakdown`). One function, one definition.
 *
 * Mirrors `ContextBudgetPlan.messageCeilingTokens` for the surfaces that don't
 * build a full context-budget plan (chat, roleplay).
 */
export function messageCeilingFor(
  contextSize: number | undefined,
  utilization: number,
  preset: TaskPreset | null,
  subs: Record<SubAgentKind, SubAgentConfig>,
  models: Model[],
): number {
  const ceiling = inputCeilingFor(contextSize, utilization);
  return Math.max(0, ceiling - plannedToolTokens(preset, subs, models));
}

/** Test seam — the memo is keyed on live profile state. */
export function __resetToolCostCache(): void {
  cache.clear();
}
