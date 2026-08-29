/**
 * Dynamic tool routing based on active subagents.
 *
 * Rewrites the tool list and serverTools policy for the main agent:
 * - If search subagent is active: withhold serverTools from main agent
 * - If vision subagent is active: strip read_image and read_lore_image from main agent
 * - If the imagegen subagent is NOT active: strip the three image tools
 * - If an export Beta is off: strip its tools (pptx / docx / xlsx)
 * - If the translation Beta is on AND a translation model is bound: append translate
 * - If any delegate-capable subagent is active and workspace exists: append delegate tool
 * - If the surface opts in (it can render the question card): append ask_author
 * - If the surface opts in AND a usable writer is bound: finishPolicy → "handoff"
 */

import type { ToolId } from "./registry";
import type { FinishPolicy, TaskPreset } from "./presets";
import type { TaskWorkspaceHandle } from "./taskWorkspace";
import { subAgentModel, DELEGATE_KINDS, type SubAgentConfig, type SubAgentKind } from "./subagent";
import { isPptxExportEnabled } from "../pptx/flag";
import { isDocxExportEnabled } from "../docx/flag";
import { isXlsxExportEnabled } from "../xlsx/flag";
import { isTranslateEnabled } from "../translate/flag";
import type { Model } from "../ai/configDb";

export interface RoutedTools {
  tools: ToolId[];
  /** Whether the main model is still allowed server-side search. */
  serverTools: "final-round-off" | "off" | "always";
  /**
   * The preset's finish policy as routing leaves it — `"handoff"` when this
   * surface opted in and a usable writer is bound, the preset's own value
   * otherwise. Spread it like `tools`; a caller that ignores it silently keeps
   * the main model writing.
   */
  finishPolicy: FinishPolicy;
}

/**
 * Per-surface routing choices that are not derivable from the preset.
 *
 * `handoff` is one of these rather than a field on the preset because
 * `AGENT_ASSIST_PRESET` is shared: the chat assistant and the AiPanel's Agent
 * mode run the very same object, and only one of them is in scope today. A
 * surface opts in explicitly, which also makes "who has the writer" greppable
 * instead of inferred.
 */
export interface RouteOptions {
  /** May this surface end a run by handing off to the writer subagent? */
  handoff?: boolean;
  /**
   * Can this surface render the `ask_author` question card? Opt-in like
   * `handoff` and for the same reason: whether the card has anywhere to appear
   * is a property of the surface, unknowable where the presets are declared.
   * Off means the tool is *absent*, not refused — a batch run blocked on an
   * invisible card would hang the whole sweep.
   */
  askAuthor?: boolean;
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
  options?: RouteOptions,
): RoutedTools {
  return route(preset, subs, workspace !== undefined, models, options);
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
  options?: RouteOptions,
): RoutedTools {
  return route(preset, subs, true, models, options);
}

function route(
  preset: TaskPreset,
  subs: Record<SubAgentKind, SubAgentConfig>,
  hasWorkspace: boolean,
  models: Model[],
  options?: RouteOptions,
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
    const wordTools = new Set<ToolId>(["export_docx", "read_doc_format"]);
    tools = tools.filter((t) => !wordTools.has(t));
  }
  if (!isXlsxExportEnabled()) {
    tools = tools.filter((t) => t !== "export_xlsx");
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

  // Appended for the surfaces that can render the question card (chat, the
  // task panel outside a batch run) — same shape as `translate` above, and the
  // same consequence: the raw-preset ratchet in agentToolBudget.test.ts cannot
  // see it, so its cost is pinned in that file's routed-tools assertion.
  if (options?.askAuthor && !tools.includes("ask_author")) {
    tools.push("ask_author");
  }

  // Search subagent takes over web search: withhold serverTools from main agent.
  const serverToolsPolicy = live("search")
    ? "off"
    : (preset.serverTools ?? "final-round-off");

  // The writer takes over the final round rather than a tool: it is the one
  // subagent no model chooses to use, so there is nothing to strip and nothing
  // to append — only the run's ending changes. `live` matters for the usual
  // reason: an enabled-but-unbound writer would leave the main model with no
  // ending at all.
  const finishPolicy: FinishPolicy =
    options?.handoff && live("writer") ? "handoff" : preset.finishPolicy;

  return {
    tools,
    serverTools: serverToolsPolicy,
    finishPolicy,
  };
}
