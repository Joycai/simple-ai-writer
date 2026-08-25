/**
 * Dynamic tool routing based on active subagents.
 *
 * Rewrites the tool list and serverTools policy for the main agent:
 * - If search subagent is active: withhold serverTools from main agent
 * - If vision subagent is active: strip read_image and read_lore_image from main agent
 * - If the imagegen subagent is NOT active: strip the three image tools
 * - If the PPTX export Beta is off: strip export_pptx
 * - If the translation Beta is on AND a translation model is bound: append translate
 * - If any delegate-capable subagent is active and workspace exists: append delegate tool
 */

import type { ToolId } from "./registry";
import type { TaskPreset } from "./presets";
import type { TaskWorkspaceHandle } from "./taskWorkspace";
import { subAgentModel, DELEGATE_KINDS, type SubAgentConfig, type SubAgentKind } from "./subagent";
import { isPptxExportEnabled } from "../pptx/flag";
import { isDocxExportEnabled } from "../docx/flag";
import { isTranslateEnabled } from "../translate/flag";
import type { Model } from "../ai/configDb";

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
  models: Model[],
): RoutedTools {
  return route(preset, subs, workspace !== undefined, models);
}

/**
 * The toolset the next request *will* carry, for surfaces that estimate before
 * running. The chat store creates its task workspace at run start
 * (stores/agentStore taskWorkspace()), so an estimate taken while idle must
 * predict `delegate` present — asking for the real handle from a component
 * would create the workspace as a side effect of rendering a meter.
 */
export function routePlannedTools(
  preset: TaskPreset,
  subs: Record<SubAgentKind, SubAgentConfig>,
  models: Model[],
): RoutedTools {
  return route(preset, subs, true, models);
}

function route(
  preset: TaskPreset,
  subs: Record<SubAgentKind, SubAgentConfig>,
  hasWorkspace: boolean,
  models: Model[],
): RoutedTools {
  let tools = [...preset.tools];
  // Usable, not merely enabled. A search subagent bound to a model without
  // web_search would otherwise take the main model's own browsing away
  // (serverTools: "off") and give nothing back — strictly worse than leaving
  // the switch alone.
  const live = (k: SubAgentKind) => subAgentModel(k, models, subs) !== null;

  // Vision takes over reading images: strip local image reading tools from main agent.
  if (live("vision")) {
    tools = tools.filter((t) => t !== "read_image" && t !== "read_lore_image");
  }

  // The image tools exist only while the imagegen subagent can serve them —
  // this is what makes the settings switch *mean* something. Unlike vision,
  // which takes a capability away from a model that has its own, the main
  // model cannot draw at all: with no usable image binding the tools could
  // only collect an error, and a tool the model can see but that always fails
  // reads to the author as the assistant being broken rather than a feature
  // being off.
  if (!live("imagegen")) {
    const drawing = new Set<ToolId>(["generate_image", "edit_image", "redraw_lore_image"]);
    tools = tools.filter((t) => !drawing.has(t));
  }

  // A Beta feature is off by default, and off means *absent* rather than
  // refused: a tool the model can see but that answers "the author has not
  // enabled this" reads to the author as the assistant being broken, and
  // wastes a round finding out. Same argument as the image tools above.
  if (!isPptxExportEnabled()) {
    tools = tools.filter((t) => t !== "export_pptx");
  }
  if (!isDocxExportEnabled()) {
    tools = tools.filter((t) => t !== "export_docx");
  }

  // If any delegate-capable subagent is enabled and we have an
  // active/provisional workspace, provide delegate. `imagegen` must not count:
  // it cannot hold the conversational sub-run `delegate` dispatches, so alone
  // it would add a tool with no valid kind to call.
  if (DELEGATE_KINDS.some(live) && hasWorkspace && !tools.includes("delegate")) {
    tools.push("delegate");
  }

  // Appended rather than stripped from a preset, like `delegate` above and
  // unlike `export_pptx`: it needs BOTH a Beta flag and a bound model, and
  // neither is knowable where the presets are declared. Two consequences worth
  // naming — a preset that lists it explicitly would still get it withheld
  // here, and `agentToolBudget.test.ts` (which measures the raw preset) cannot
  // see it, which is why that file gains its own assertion on the routed set.
  if (isTranslateEnabled() && live("translate") && !tools.includes("translate")) {
    tools.push("translate");
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
