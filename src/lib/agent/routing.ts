/**
 * Dynamic tool routing based on active subagents.
 *
 * Rewrites the tool list and serverTools policy for the main agent:
 * - If search subagent is active: withhold serverTools from main agent
 * - If vision subagent is active: strip read_image and read_lore_image from main agent
 * - If any subagent is active and workspace exists: append delegate tool
 */

import type { ToolId } from "./registry";
import type { TaskPreset } from "./presets";
import type { TaskWorkspaceHandle } from "./taskWorkspace";
import { SUBAGENT_KINDS, type SubAgentConfig, type SubAgentKind } from "./subagent";

export interface RoutedTools {
  tools: ToolId[];
  /** Whether the main model is still allowed server-side search. */
  serverTools: "final-round-off" | "off" | "always";
}

/**
 * @param workspace the run's task-workspace handle, or undefined on a surface
 *   that has none. Taken as the handle rather than a boolean because the
 *   callers construct one unconditionally — `Boolean(handle)` was always true,
 *   so the guard it looked like never actually guarded anything. A subagent's
 *   findings have to land somewhere, so a surface without a workspace does not
 *   get `delegate` at all.
 */
export function routeTools(
  preset: TaskPreset,
  subs: Record<SubAgentKind, SubAgentConfig>,
  workspace: TaskWorkspaceHandle | undefined,
): RoutedTools {
  let tools = [...preset.tools];
  const live = (k: SubAgentKind) => Boolean(subs[k]?.enabled) && Boolean(subs[k]?.modelId);

  // Vision takes over reading images: strip local image reading tools from main agent.
  if (live("vision")) {
    tools = tools.filter((t) => t !== "read_image" && t !== "read_lore_image");
  }

  // If any subagent is configured/enabled and we have an active/provisional workspace, provide delegate.
  if (SUBAGENT_KINDS.some(live) && workspace && !tools.includes("delegate")) {
    tools.push("delegate");
  }

  // Search subagent takes over web search: withhold serverTools from main agent.
  const serverToolsPolicy = live("search")
    ? "off"
    : (preset.serverTools ?? "final-round-off");

  return {
    tools,
    serverTools: serverToolsPolicy,
  };
}
